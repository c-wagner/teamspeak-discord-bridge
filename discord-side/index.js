// TeamSpeak <-> Discord bridge, Discord side.
//
// Every TS user in a bridged channel is shown by its own Discord bot (renamed to
// the TS nickname) that plays that user's voice, posts their channel messages and
// carries their private messages as DMs. Every Discord user who joins a bridged
// voice channel gets an own TS client that speaks and writes for them.
//
// One Rust process ("ts-side") runs per configured TeamSpeak server.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { Client, GatewayIntentBits, Events, Partials, ChannelType } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  StreamType,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  EndBehaviorType,
} = require('@discordjs/voice');
const { TsProcess } = require('./ts-process');
const { bbcodeToDiscord, clip, strings } = require('./text');

// ---------- Config ----------
const configPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'config.json'));
const dataDir = path.dirname(configPath);
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const dc = cfg.discord;
const suffix = dc?.dcNameSuffix ?? ' (DC)';
const placeholderName = dc?.placeholderName ?? 'TeamSpeak';
const relayChat = dc?.relayChat !== false; // channel chat + private messages
const t = strings(dc?.language);
const tsBinary =
  process.env.TS_BINARY ||
  (cfg.tsBinary
    ? path.resolve(dataDir, cfg.tsBinary)
    : path.resolve(__dirname, '..', 'ts-side', 'target', 'release', 'ts-bridge'));

if (!dc?.guildId || !Array.isArray(dc.tokens) || dc.tokens.length === 0) {
  throw new Error('config.json: discord.guildId and discord.tokens are required');
}

/**
 * Servers: either `servers: [{ name, address, ... }]` or the single-server form `ts: { address, ... }`.
 * Channels refer to a server by `server: "<name>"`, the first server is the default.
 */
function loadServers() {
  let list;
  if (Array.isArray(cfg.servers) && cfg.servers.length) {
    list = cfg.servers.map((s, i) => ({ ...s, name: s.name || `server${i + 1}` }));
    for (const s of list) if (!s.identityDir) s.identityDir = path.join('identities', s.name);
  } else if (cfg.ts) {
    list = [{ ...cfg.ts, name: 'default', identityDir: cfg.ts.identityDir || 'identities' }];
  } else {
    throw new Error('config.json: "servers" (or "ts") is required');
  }
  const names = new Set();
  for (const s of list) {
    if (!s.address) throw new Error(`config.json: server "${s.name}" has no address`);
    if (names.has(s.name)) throw new Error(`config.json: server name "${s.name}" is used twice`);
    names.add(s.name);
  }
  return list;
}

const serverList = loadServers();
if (!Array.isArray(cfg.channels) || cfg.channels.length === 0 || cfg.channels.length > 50) {
  throw new Error('config.json: channels needs 1 to 50 entries');
}
/** Global channel list: { ts, tsPassword, discord, server, local } */
const channels = cfg.channels.map((c) => {
  const server = c.server || serverList[0].name;
  if (!serverList.some((s) => s.name === server)) throw new Error(`config.json: channel "${c.ts}" uses unknown server "${server}"`);
  return { ...c, server };
});
/** name -> { cfg, proc, channels: [global index by local index] } */
const servers = new Map(serverList.map((s) => [s.name, { cfg: s, proc: null, channels: [] }]));
channels.forEach((c, i) => {
  const srv = servers.get(c.server);
  c.local = srv.channels.length;
  srv.channels.push(i);
});

function log(tag, msg) {
  console.log(`${new Date().toISOString()} [${tag}] ${msg}`);
}

// ---------- State ----------
/** TS view per bridged channel: { connected, name, clients: [{id, name}] } */
const tsState = channels.map(() => ({ connected: false, name: '', clients: [] }));
/** Discord user id -> channel index, for users that have a TS client */
const joinedHumans = new Map();
/** Discord user ids whose TS connection failed recently -> retry timestamp */
const retryAfter = new Map();
const botIds = new Set();
/** Discord user id -> last TS client that wrote privately: { server, id, name, chan } */
const lastPrivate = new Map();
/** "server:tsClientId" -> Discord user id, for replies to messages the listener relayed */
const listenerReplies = new Map();
/** Last "active" state sent per channel */
const lastActive = channels.map(() => null);
let bots = [];
let manager = null;

function sendTs(serverName, obj) {
  const srv = servers.get(serverName);
  if (srv?.proc) srv.proc.send(obj);
}

function serverRunning(serverName) {
  return !!servers.get(serverName)?.proc?.proc;
}

// ---------- Audio playback per bot ----------
// Plays incoming TS Opus packets. A new resource is started per talk burst so
// the green "speaking" ring in Discord matches the real TS speaker.
class SpeakerPipe {
  constructor(player) {
    this.player = player;
    this.stream = null;
    this.timer = null;
  }
  push(opus) {
    if (!this.stream) {
      this.stream = new Readable({ objectMode: true, highWaterMark: 64, read() {} });
      this.player.play(createAudioResource(this.stream, { inputType: StreamType.Opus }));
    }
    // Keep latency low: drop the oldest packet if too much piles up.
    if (this.stream.readableLength > 8) this.stream.read();
    this.stream.push(opus);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.end(), 300);
  }
  end() {
    clearTimeout(this.timer);
    if (this.stream) {
      this.stream.push(null);
      this.stream = null;
    }
  }
}

// ---------- Discord bots ----------
const BASE_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];

function makeClient(idx, withMessageContent) {
  if (!relayChat) return new Client({ intents: BASE_INTENTS });
  // Every bot receives DMs (private messages to "its" TS user). Only the first one
  // ("manager") reads the voice channel chat, which needs the Message Content Intent.
  const intents = [...BASE_INTENTS, GatewayIntentBits.DirectMessages];
  if (idx === 0) {
    intents.push(GatewayIntentBits.GuildMessages);
    if (withMessageContent) intents.push(GatewayIntentBits.MessageContent);
  }
  return new Client({ intents, partials: [Partials.Channel] });
}

function makeBot(token, idx) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 15 },
  });
  player.on('error', (e) => log(`Bot${idx}`, `Player error: ${e.message}`));
  return {
    idx,
    token,
    client: makeClient(idx, true),
    player,
    pipe: new SpeakerPipe(player),
    guild: null,
    connection: null,
    channelIdx: null, // which bridged channel the bot sits in
    role: null, // null | 'speaker' | 'placeholder'
    tsClientId: null,
    tsName: null,
    nickname: undefined,
  };
}

async function loginBot(bot) {
  const login = async () => {
    const ready = new Promise((resolve) => bot.client.once(Events.ClientReady, resolve));
    await bot.client.login(bot.token);
    await ready;
  };
  try {
    await login();
  } catch (e) {
    if (bot.idx !== 0 || !relayChat || !/disallowed intents/i.test(e.message)) throw e;
    log('DC', 'Message Content Intent is not enabled for the first bot, Discord -> TS channel chat is off. Enable it in the Developer Portal (Bot > Privileged Gateway Intents).');
    bot.client.destroy();
    bot.client = makeClient(0, false);
    await login();
  }
  botIds.add(bot.client.user.id);
  bot.guild = await bot.client.guilds.fetch(dc.guildId).catch(() => null);
  if (!bot.guild) throw new Error(`Bot ${bot.client.user.tag} is not a member of Discord server ${dc.guildId}, invite it first`);
  if (relayChat) bot.client.on(Events.MessageCreate, (msg) => onDiscordMessage(bot, msg));
  log(`Bot${bot.idx}`, `Logged in as ${bot.client.user.tag}`);
}

function discordName(name) {
  const n = (name || '').trim() || '?';
  return n.length > 32 ? n.slice(0, 32) : n;
}

async function setNick(bot, name) {
  const nick = discordName(name);
  if (bot.nickname === nick) return;
  bot.nickname = nick;
  try {
    await bot.guild.members.me.setNickname(nick);
  } catch (e) {
    bot.nickname = undefined;
    log(`Bot${bot.idx}`, `Could not set nickname (missing "Change Nickname" permission?): ${e.message}`);
  }
}

function sendAudioFor(userId, opus) {
  const idx = joinedHumans.get(userId);
  if (idx === undefined) return;
  servers.get(channels[idx].server)?.proc?.sendAudio(userId, opus);
}

function connectBot(bot, chanIdx) {
  if (bot.connection && bot.channelIdx === chanIdx) return;
  disconnectBot(bot);
  bot.channelIdx = chanIdx;
  const connection = joinVoiceChannel({
    channelId: channels[chanIdx].discord,
    guildId: dc.guildId,
    adapterCreator: bot.guild.voiceAdapterCreator,
    group: bot.client.user.id, // several bots in one process
    selfDeaf: false, // any bot may become the receiver of its channel
    selfMute: false,
  });
  bot.connection = connection;
  connection.subscribe(bot.player);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      if (bot.connection === connection) {
        log(`Bot${bot.idx}`, 'Voice connection lost');
        disconnectBot(bot);
        scheduleReconcile();
      }
    }
  });
  connection.on('error', (e) => log(`Bot${bot.idx}`, `Voice error: ${e.message}`));

  // Discord -> TS: the receiver bot of a channel picks up every human speaker.
  connection.receiver.speaking.on('start', (userId) => {
    if (receiverOf(bot.channelIdx) !== bot) return;
    if (botIds.has(userId) || joinedHumans.get(userId) !== bot.channelIdx) return;
    const receiver = connection.receiver;
    if (receiver.subscriptions.has(userId)) return;
    const sub = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 500 } });
    sub.on('data', (opus) => sendAudioFor(userId, opus));
    sub.on('error', () => {});
  });
}

function disconnectBot(bot) {
  bot.pipe.end();
  if (bot.connection) {
    try {
      bot.connection.destroy();
    } catch {}
  }
  bot.connection = null;
  bot.channelIdx = null;
}

/** The bot that records Discord users in a channel: the first ready bot in it. */
function receiverOf(chanIdx) {
  return (
    bots.find((b) => b.role && b.channelIdx === chanIdx && b.connection?.state.status === VoiceConnectionStatus.Ready) ||
    bots.find((b) => b.role && b.channelIdx === chanIdx && b.connection)
  );
}

/** The bot that currently shows TS client `id` of `server`, if any. */
function speakerBotFor(server, id) {
  return bots.find(
    (b) => b.role === 'speaker' && b.channelIdx !== null && channels[b.channelIdx].server === server && b.tsClientId === id,
  );
}

// ---------- Discord humans -> TS clients ----------
function humansIn(chanIdx) {
  const ch = manager?.guild.channels.cache.get(channels[chanIdx].discord);
  if (!ch || !ch.members) return [];
  return [...ch.members.values()].filter((m) => !m.user.bot);
}

function syncHumans() {
  if (!manager) return;
  const wanted = new Map();
  channels.forEach((_, i) => {
    for (const m of humansIn(i)) wanted.set(m.id, { idx: i, member: m });
  });
  for (const [uid, idx] of joinedHumans) {
    const w = wanted.get(uid);
    if (!w || w.idx !== idx) {
      sendTs(channels[idx].server, { type: 'leave', key: uid });
      joinedHumans.delete(uid);
      log('DC', `${uid} left bridge channel ${idx}`);
    }
  }
  // Listener in TS: in the bridged channel only while Discord users are there, else in the AFK channel.
  channels.forEach((c, i) => {
    if (!serverRunning(c.server)) return;
    const active = [...wanted.values()].some((w) => w.idx === i);
    if (lastActive[i] !== active) {
      lastActive[i] = active;
      sendTs(c.server, { type: 'active', channel: c.local, active });
    }
  });
  const now = Date.now();
  for (const [uid, { idx, member }] of wanted) {
    if (joinedHumans.has(uid)) continue;
    if ((retryAfter.get(uid) || 0) > now) continue;
    const c = channels[idx];
    if (!serverRunning(c.server)) continue; // the 'started' event triggers a new sync
    const name = `${member.displayName}${suffix}`.slice(0, 30);
    joinedHumans.set(uid, idx);
    sendTs(c.server, { type: 'join', key: uid, name, channel: c.local });
    log('DC', `${member.displayName} joined bridge channel ${idx}, connecting "${name}" to TS`);
  }
}

// ---------- Mirror TS users as bots ----------
let reconcileTimer = null;
let reconciling = false;
function scheduleReconcile() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(runReconcile, 250);
}

async function runReconcile() {
  if (reconciling) return scheduleReconcile();
  reconciling = true;
  try {
    await reconcile();
  } catch (e) {
    log('DC', `Reconcile error: ${e.stack || e.message}`);
  } finally {
    reconciling = false;
  }
}

function pickFreeBot(chanIdx, forSpeaker) {
  // With text relay on, the first bot never shows a TS user: its DMs are the fallback for
  // private messages, so a DM to it must not be mistaken for a message to "its" TS user.
  const reserveManager = forSpeaker && relayChat && bots.length > 1;
  const free = bots.filter((b) => !b.role && !(reserveManager && b === manager));
  return free.find((b) => b.channelIdx === chanIdx && b.connection) || free.find((b) => !b.connection) || free[0];
}

let poolWarned = false;
async function reconcile() {
  if (!manager) return;
  // 1. Release bots whose TS user is gone, placeholders are re-decided below.
  for (const b of bots) {
    if (b.role === 'placeholder') b.role = null;
    if (b.role === 'speaker') {
      const st = tsState[b.channelIdx];
      if (!st || !st.clients.some((c) => c.id === b.tsClientId)) {
        b.role = null;
        b.tsClientId = null;
        b.tsName = null;
        b.pipe.end();
      }
    }
  }

  // 2. One bot per TS user.
  let missing = 0;
  for (let i = 0; i < channels.length; i++) {
    for (const c of tsState[i].clients) {
      let bot = bots.find((b) => b.role === 'speaker' && b.channelIdx === i && b.tsClientId === c.id);
      if (!bot) {
        bot = pickFreeBot(i, true);
        if (!bot) {
          missing++;
          continue;
        }
        bot.role = 'speaker';
        bot.tsClientId = c.id;
        connectBot(bot, i);
      }
      bot.tsName = c.name;
      await setNick(bot, c.name);
    }
  }
  if (missing && !poolWarned) {
    log('DC', `Not enough bots: ${missing} TS users have no bot. Add more tokens to config.json.`);
    poolWarned = true;
  } else if (!missing) poolWarned = false;

  // 3. Channels with Discord users but no TS users still need one bot to record them.
  for (let i = 0; i < channels.length; i++) {
    if (humansIn(i).length === 0) continue;
    if (bots.some((b) => b.role && b.channelIdx === i)) continue;
    const bot = pickFreeBot(i, false);
    if (!bot) continue;
    bot.role = 'placeholder';
    connectBot(bot, i);
    await setNick(bot, `${placeholderName}: ${tsState[i].connected ? t.placeholderEmpty : t.placeholderOffline}`);
  }

  // 4. Unused bots leave voice.
  for (const b of bots) {
    if (b.role) continue;
    if (b.connection) disconnectBot(b);
    if (b.nickname !== null) {
      b.nickname = null; // back to the bot's own name in the member list
      b.guild.members.me.setNickname(null).catch(() => {});
    }
  }
}

// ---------- TS processes ----------
function startServer(name) {
  const srv = servers.get(name);
  const runtimePath = path.join(dataDir, `.runtime-${name.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  const runtime = {
    ts: srv.cfg,
    channels: srv.channels.map((g) => ({ ts: channels[g].ts, tsPassword: channels[g].tsPassword || '' })),
  };
  fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2));
  const tag = servers.size > 1 ? `TS:${name}` : 'TS';
  const proc = new TsProcess(tsBinary, runtimePath, (_, msg) => log(tag, msg));
  srv.proc = proc;
  const global = (local) => srv.channels[local];

  proc.on('event', (ev) => {
    if (ev.type === 'channel') {
      const g = global(ev.index);
      if (g === undefined) return;
      const before = JSON.stringify(tsState[g]);
      tsState[g] = { connected: ev.connected, name: ev.name, clients: ev.clients || [] };
      if (before !== JSON.stringify(tsState[g])) {
        const names = tsState[g].clients.map((c) => c.name).join(', ') || 'nobody';
        log(tag, `Channel ${g} (${ev.name || channels[g].ts}): ${names}`);
        scheduleReconcile();
      }
    } else if (ev.type === 'chat') {
      onTsChat(name, global(ev.index), ev);
    } else if (ev.type === 'private') {
      onTsPrivate(name, joinedHumans.get(ev.key), ev);
    } else if (ev.type === 'listenerPrivate') {
      const uid = listenerReplies.get(`${name}:${ev.from_id}`);
      if (uid) onTsPrivate(name, global(ev.index), { ...ev, key: uid });
      else log(tag, `Private message from ${ev.from_name} to the listener, nobody to forward it to`);
    } else if (ev.type === 'user' && ev.status === 'notice') {
      sendDm(manager, ev.key, t[ev.detail] || ev.detail);
    } else if (ev.type === 'user') {
      log(tag, `Discord user ${ev.key}: ${ev.status}${ev.detail ? ` (${ev.detail})` : ''}`);
      if (ev.status === 'error' && joinedHumans.has(ev.key)) {
        joinedHumans.delete(ev.key);
        retryAfter.set(ev.key, Date.now() + 15000);
        setTimeout(syncHumans, 15500);
      }
    }
  });

  proc.on('audio', (local, clientId, opus) => {
    const g = global(local);
    const bot = bots.find((b) => b.role === 'speaker' && b.channelIdx === g && b.tsClientId === clientId);
    if (!bot || !bot.connection) return;
    if (humansIn(g).length === 0) return; // nobody listening on Discord
    bot.pipe.push(opus);
  });

  proc.on('restart', () => {
    // The TS process lost all its clients, re-announce Discord users once it is back.
    for (const [uid, idx] of joinedHumans) if (channels[idx].server === name) joinedHumans.delete(uid);
    for (const g of srv.channels) tsState[g] = { connected: false, name: '', clients: [] };
    scheduleReconcile();
  });
  proc.on('started', () => {
    for (const g of srv.channels) lastActive[g] = null;
    setTimeout(syncHumans, 1000);
  });
  proc.start();
}

// ---------- Text: channel chat and private messages ----------
async function postToChannel(bot, chanIdx, content) {
  const ch = await bot.client.channels.fetch(channels[chanIdx].discord);
  await ch.send({ content: clip(content), allowedMentions: { parse: [] } });
}

async function onTsChat(server, chanIdx, ev) {
  if (!relayChat || !manager || chanIdx === undefined) return;
  const text = bbcodeToDiscord(ev.text);
  if (!text) return;
  // Posted by the bot that shows the writer, so it reads like a normal chat.
  const bot = speakerBotFor(server, ev.from_id);
  if (bot && bot !== manager) {
    try {
      return await postToChannel(bot, chanIdx, text);
    } catch (e) {
      log(`Bot${bot.idx}`, `Could not post to the voice channel chat (missing "Send Messages"?), using the first bot: ${e.message}`);
    }
  }
  try {
    await postToChannel(manager, chanIdx, t.channelChat(ev.from, text));
  } catch (e) {
    log('DC', `Could not post TS chat to Discord: ${e.message}`);
  }
}

async function sendDm(bot, userId, content) {
  if (!bot) return;
  try {
    const user = await bot.client.users.fetch(userId);
    await user.send({ content: clip(content), allowedMentions: { parse: [] } });
  } catch (e) {
    log(`Bot${bot.idx}`, `Could not DM ${userId} (DMs from server members disabled?): ${e.message}`);
  }
}

/** TS -> Discord DM. Sent by the bot of the TS user if they have one, else by the first bot. */
function onTsPrivate(server, chanIdx, ev) {
  if (!relayChat) return;
  const own = speakerBotFor(server, ev.from_id);
  const bot = own || manager;
  lastPrivate.set(ev.key, { server, id: ev.from_id, name: ev.from_name, chan: chanIdx });
  // In the first bot's DMs the reply target is "whoever wrote last", so say so.
  const hint = own ? null : t.replyHint(ev.from_name);
  const text = bbcodeToDiscord(ev.text || '');
  if (ev.kind === 'poke') sendDm(bot, ev.key, t.poke(ev.from_name, text, hint));
  else if (ev.kind === 'whisper') sendDm(bot, ev.key, t.whisper(ev.from_name, hint));
  else sendDm(bot, ev.key, t.privateMessage(ev.from_name, text, hint));
}

function messageText(msg) {
  const parts = [msg.cleanContent?.trim(), ...[...msg.attachments.values()].map((a) => a.url)];
  return parts.filter(Boolean).join(' ');
}

/** Discord DM -> TS private message, from the user's own TS client or, without one, from the listener. */
function sendPrivate(msg, target, text) {
  const uid = msg.author.id;
  const joined = joinedHumans.get(uid);
  if (joined !== undefined && channels[joined].server === target.server) {
    sendTs(target.server, { type: 'private', key: uid, to: target.id, text });
  } else {
    const srv = servers.get(target.server);
    const chan = target.chan !== undefined && channels[target.chan]?.server === target.server ? target.chan : srv.channels[0];
    const name = (msg.author.globalName || msg.author.username) + suffix;
    sendTs(target.server, { type: 'listenerPrivate', channel: channels[chan].local, to: target.id, text: `[b]${name}:[/b] ${text}` });
    listenerReplies.set(`${target.server}:${target.id}`, uid);
  }
  msg.react('✅').catch(() => {});
}

function onDiscordMessage(bot, msg) {
  if (msg.author.bot || botIds.has(msg.author.id)) return;
  const text = messageText(msg);
  if (!text) return;

  if (msg.channel.type === ChannelType.DM) {
    let target;
    if (bot.role === 'speaker') {
      // DM to the bot "Max" goes to Max.
      target = { server: channels[bot.channelIdx].server, id: bot.tsClientId, name: bot.tsName, chan: bot.channelIdx };
    } else if (bot === manager) {
      target = lastPrivate.get(msg.author.id);
      if (!target) return void msg.reply(t.noReplyTarget).catch(() => {});
    } else {
      return void msg.reply(t.botIdle).catch(() => {});
    }
    return sendPrivate(msg, target, text);
  }

  // Text chat of a bridged voice channel -> TS channel chat (read by the first bot only)
  if (bot !== manager) return;
  const idx = channels.findIndex((c) => c.discord === msg.channelId);
  if (idx < 0) return;
  const c = channels[idx];
  const key = joinedHumans.get(msg.author.id) === idx ? msg.author.id : null;
  if (!key && !lastActive[idx]) {
    // Nobody from Discord in the channel: the TS listener waits in the AFK channel and cannot post.
    msg.react('💤').catch(() => {});
    return;
  }
  const name = msg.member?.displayName || msg.author.username;
  sendTs(c.server, { type: 'chat', channel: c.local, key, name, text });
}

// ---------- Start ----------
async function main() {
  // Placeholders like "TOKEN_BOT_2" are skipped, so the bridge runs with the bots filled in so far.
  const tokens = dc.tokens.filter((tok) => typeof tok === 'string' && tok.length > 50 && !/^(HIER_|TOKEN_)/.test(tok));
  if (tokens.length === 0) throw new Error('config.json: no valid bot token found');
  if (tokens.length < dc.tokens.length) log('DC', `Skipped ${dc.tokens.length - tokens.length} token placeholder(s)`);
  bots = tokens.map((tok, i) => makeBot(tok, i));
  for (const b of bots) await loginBot(b);
  manager = bots[0];

  for (const c of channels) {
    const ch = await manager.guild.channels.fetch(c.discord).catch(() => null);
    if (!ch || !ch.isVoiceBased()) throw new Error(`Discord channel ${c.discord} not found or not a voice channel`);
    log('DC', `Bridge: TS "${c.ts}"${servers.size > 1 ? ` on ${c.server}` : ''} <-> Discord "${ch.name}"`);
  }

  manager.client.on(Events.VoiceStateUpdate, (oldS, newS) => {
    if (newS.member?.user.bot) return;
    syncHumans();
    scheduleReconcile();
  });

  for (const name of servers.keys()) startServer(name);
  scheduleReconcile();
  log('DC', `Bridge running with ${bots.length} bots and ${servers.size} TeamSpeak server(s)`);
}

function shutdown() {
  log('DC', 'Shutting down bridge');
  for (const b of bots) disconnectBot(b);
  for (const srv of servers.values()) srv.proc?.stop();
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => log('DC', `Unhandled: ${e?.stack || e}`));

main().catch((e) => {
  log('DC', `Startup failed: ${e.message}`);
  for (const srv of servers.values()) srv.proc?.stop();
  process.exit(1);
});
