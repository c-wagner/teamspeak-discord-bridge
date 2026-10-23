// TeamSpeak <-> Discord voice bridge, Discord side.
//
// Every TS user in a bridged channel is shown by its own Discord bot (renamed to
// the TS nickname) that plays that user's voice. Every Discord user who joins a
// bridged voice channel gets an own TS client that speaks for them.
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
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const dc = cfg.discord;
const channels = cfg.channels;
const suffix = dc.dcNameSuffix ?? ' (DC)';
const placeholderName = dc.placeholderName ?? 'TeamSpeak';
const relayChat = dc.relayChat !== false; // channel chat + private messages
const t = strings(dc.language);
const tsBinary =
  process.env.TS_BINARY ||
  (cfg.tsBinary
    ? path.resolve(path.dirname(configPath), cfg.tsBinary)
    : path.resolve(__dirname, '..', 'ts-side', 'target', 'release', 'ts-bridge'));

if (!dc?.guildId || !Array.isArray(dc.tokens) || dc.tokens.length === 0) {
  throw new Error('config.json: discord.guildId and discord.tokens are required');
}
if (!Array.isArray(channels) || channels.length === 0 || channels.length > 10) {
  throw new Error('config.json: channels needs 1 to 10 entries');
}

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
/** Discord user id -> last TS client that wrote privately: { id, name } */
const lastPrivate = new Map();
/** Last "active" state sent to the TS process per channel */
let lastActive = channels.map(() => null);
let bots = [];
let manager = null;

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
const CHAT_INTENTS = [GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages];

function makeClient(idx, withMessageContent) {
  // Only the first bot ("manager") handles text: voice channel chat and DMs.
  if (idx !== 0 || !relayChat) return new Client({ intents: BASE_INTENTS });
  const intents = [...BASE_INTENTS, ...CHAT_INTENTS];
  if (withMessageContent) intents.push(GatewayIntentBits.MessageContent);
  return new Client({ intents, partials: [Partials.Channel] });
}

function makeBot(token, idx) {
  const client = makeClient(idx, true);
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 15 },
  });
  player.on('error', (e) => log(`Bot${idx}`, `Player error: ${e.message}`));
  const bot = {
    idx,
    token,
    client,
    player,
    pipe: new SpeakerPipe(player),
    guild: null,
    connection: null,
    channelIdx: null, // which bridged channel the bot sits in
    role: null, // null | 'speaker' | 'placeholder'
    tsClientId: null,
    nickname: undefined,
  };
  return bot;
}

async function loginBot(bot) {
  try {
    const ready = new Promise((resolve) => bot.client.once(Events.ClientReady, resolve));
    await bot.client.login(bot.token);
    await ready;
  } catch (e) {
    if (bot.idx !== 0 || !relayChat || !/disallowed intents/i.test(e.message)) throw e;
    // Message Content Intent is not enabled for the first bot: run without channel chat.
    log('DC', 'Message Content Intent is not enabled for the first bot, Discord -> TS channel chat is off. Enable it in the Developer Portal (Bot > Privileged Gateway Intents).');
    bot.client.destroy();
    bot.client = makeClient(0, false);
    const ready = new Promise((resolve) => bot.client.once(Events.ClientReady, resolve));
    await bot.client.login(bot.token);
    await ready;
  }
  botIds.add(bot.client.user.id);
  bot.guild = await bot.client.guilds.fetch(dc.guildId).catch(() => null);
  if (!bot.guild) throw new Error(`Bot ${bot.client.user.tag} is not a member of Discord server ${dc.guildId}, invite it first`);
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
    sub.on('data', (opus) => ts.sendAudio(userId, opus));
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
  return bots.find(
    (b) =>
      b.role &&
      b.channelIdx === chanIdx &&
      b.connection &&
      b.connection.state.status === VoiceConnectionStatus.Ready,
  ) || bots.find((b) => b.role && b.channelIdx === chanIdx && b.connection);
}

// ---------- Discord humans -> TS clients ----------
function humansIn(chanIdx) {
  const ch = manager.guild.channels.cache.get(channels[chanIdx].discord);
  if (!ch || !ch.members) return [];
  return [...ch.members.values()].filter((m) => !m.user.bot);
}

function syncHumans() {
  if (!ts.proc) return; // TS process is restarting, 'started' triggers a new sync
  const wanted = new Map();
  channels.forEach((_, i) => {
    for (const m of humansIn(i)) wanted.set(m.id, { idx: i, member: m });
  });
  for (const [uid, idx] of joinedHumans) {
    const w = wanted.get(uid);
    if (!w || w.idx !== idx) {
      ts.send({ type: 'leave', key: uid });
      joinedHumans.delete(uid);
      log('DC', `${uid} left bridge channel ${idx}`);
    }
  }
  // Listener in TS: in the bridged channel only while Discord users are there, else in the AFK channel.
  channels.forEach((_, i) => {
    const active = [...wanted.values()].some((w) => w.idx === i);
    if (lastActive[i] !== active) {
      lastActive[i] = active;
      ts.send({ type: 'active', channel: i, active });
    }
  });
  const now = Date.now();
  for (const [uid, { idx, member }] of wanted) {
    if (joinedHumans.has(uid)) continue;
    if ((retryAfter.get(uid) || 0) > now) continue;
    const name = `${member.displayName}${suffix}`.slice(0, 30);
    joinedHumans.set(uid, idx);
    ts.send({ type: 'join', key: uid, name, channel: idx });
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

function pickFreeBot(chanIdx) {
  const free = bots.filter((b) => !b.role);
  return (
    free.find((b) => b.channelIdx === chanIdx && b.connection) ||
    free.find((b) => !b.connection) ||
    free[0]
  );
}

let poolWarned = false;
async function reconcile() {
  // 1. Release bots whose TS user is gone, placeholders are re-decided below.
  for (const b of bots) {
    if (b.role === 'placeholder') b.role = null;
    if (b.role === 'speaker') {
      const st = tsState[b.channelIdx];
      if (!st || !st.clients.some((c) => c.id === b.tsClientId)) {
        b.role = null;
        b.tsClientId = null;
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
        bot = pickFreeBot(i);
        if (!bot) {
          missing++;
          continue;
        }
        bot.role = 'speaker';
        bot.tsClientId = c.id;
        connectBot(bot, i);
      }
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
    const bot = pickFreeBot(i);
    if (!bot) continue;
    bot.role = 'placeholder';
    connectBot(bot, i);
    await setNick(bot, tsState[i].connected ? `${placeholderName}: ${t.placeholderEmpty}` : `${placeholderName}: ${t.placeholderOffline}`);
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

// ---------- TS process ----------
const ts = new TsProcess(tsBinary, configPath, log);

ts.on('event', (ev) => {
  if (ev.type === 'channel') {
    const before = JSON.stringify(tsState[ev.index]);
    tsState[ev.index] = { connected: ev.connected, name: ev.name, clients: ev.clients || [] };
    if (before !== JSON.stringify(tsState[ev.index])) {
      const names = tsState[ev.index].clients.map((c) => c.name).join(', ') || 'nobody';
      log('TS', `Channel ${ev.index} (${ev.name || channels[ev.index].ts}): ${names}`);
      scheduleReconcile();
    }
  } else if (ev.type === 'chat') {
    onTsChat(ev);
  } else if (ev.type === 'private') {
    onTsPrivate(ev);
  } else if (ev.type === 'user' && ev.status === 'notice') {
    sendDm(ev.key, t[ev.detail] || ev.detail);
  } else if (ev.type === 'user') {
    log('TS', `Discord user ${ev.key}: ${ev.status}${ev.detail ? ` (${ev.detail})` : ''}`);
    if (ev.status === 'error' && joinedHumans.has(ev.key)) {
      joinedHumans.delete(ev.key);
      retryAfter.set(ev.key, Date.now() + 15000);
      setTimeout(syncHumans, 15500);
    }
  }
});

ts.on('audio', (chanIdx, clientId, opus) => {
  const bot = bots.find((b) => b.role === 'speaker' && b.channelIdx === chanIdx && b.tsClientId === clientId);
  if (!bot || !bot.connection) return;
  if (humansIn(chanIdx).length === 0) return; // nobody listening on Discord
  bot.pipe.push(opus);
});

ts.on('restart', () => {
  // The TS process lost all clients, re-announce Discord users once it is back.
  joinedHumans.clear();
  tsState.forEach((_, i) => (tsState[i] = { connected: false, name: '', clients: [] }));
  scheduleReconcile();
});
ts.on('started', () => {
  lastActive = channels.map(() => null);
  setTimeout(syncHumans, 1000);
});

// ---------- Text: channel chat and private messages ----------
async function onTsChat(ev) {
  if (!relayChat || !manager) return;
  const text = bbcodeToDiscord(ev.text);
  if (!text) return;
  try {
    const ch = await manager.client.channels.fetch(channels[ev.index].discord);
    await ch.send({ content: clip(t.channelChat(ev.from, text)), allowedMentions: { parse: [] } });
  } catch (e) {
    log('DC', `Could not post TS chat to Discord: ${e.message}`);
  }
}

async function sendDm(userId, content) {
  if (!manager) return;
  try {
    const user = await manager.client.users.fetch(userId);
    await user.send({ content: clip(content), allowedMentions: { parse: [] } });
  } catch (e) {
    log('DC', `Could not DM ${userId} (DMs from server members disabled?): ${e.message}`);
  }
}

function onTsPrivate(ev) {
  if (!relayChat) return;
  lastPrivate.set(ev.key, { id: ev.from_id, name: ev.from_name });
  const text = bbcodeToDiscord(ev.text || '');
  if (ev.kind === 'poke') sendDm(ev.key, t.poke(ev.from_name, text));
  else if (ev.kind === 'whisper') sendDm(ev.key, t.whisper(ev.from_name));
  else sendDm(ev.key, t.privateMessage(ev.from_name, text));
}

function messageText(msg) {
  const parts = [msg.cleanContent?.trim(), ...[...msg.attachments.values()].map((a) => a.url)];
  return parts.filter(Boolean).join(' ');
}

function onDiscordMessage(msg) {
  if (msg.author.bot || botIds.has(msg.author.id)) return;
  const text = messageText(msg);
  if (!text) return;

  // DM to the bot -> private message to whoever last wrote on TS
  if (msg.channel.type === ChannelType.DM) {
    const target = lastPrivate.get(msg.author.id);
    if (!target) return void msg.reply(t.noReplyTarget).catch(() => {});
    if (!joinedHumans.has(msg.author.id)) return void msg.reply(t.not_connected).catch(() => {});
    ts.send({ type: 'private', key: msg.author.id, to: target.id, text });
    msg.react('✅').catch(() => {});
    return;
  }

  // Text chat of a bridged voice channel -> TS channel chat
  const idx = channels.findIndex((c) => c.discord === msg.channelId);
  if (idx < 0) return;
  const key = joinedHumans.get(msg.author.id) === idx ? msg.author.id : null;
  if (!key && !lastActive[idx]) {
    // Nobody from Discord in the channel: the TS listener waits in the AFK channel and cannot post.
    msg.react('💤').catch(() => {});
    return;
  }
  const name = msg.member?.displayName || msg.author.username;
  ts.send({ type: 'chat', channel: idx, key, name, text });
}

// ---------- Start ----------
async function main() {
  // Placeholders like "TOKEN_BOT_2" are skipped, so the bridge runs with the bots filled in so far.
  const tokens = dc.tokens.filter((t) => typeof t === 'string' && t.length > 50 && !/^(HIER_|TOKEN_)/.test(t));
  if (tokens.length === 0) throw new Error('config.json: no valid bot token found');
  if (tokens.length < dc.tokens.length) log('DC', `Skipped ${dc.tokens.length - tokens.length} token placeholder(s)`);
  bots = tokens.map((t, i) => makeBot(t, i));
  for (const b of bots) await loginBot(b);
  manager = bots[0];
  manager.guild = await manager.client.guilds.fetch(dc.guildId);

  for (const c of channels) {
    const ch = await manager.guild.channels.fetch(c.discord).catch(() => null);
    if (!ch || !ch.isVoiceBased()) throw new Error(`Discord channel ${c.discord} not found or not a voice channel`);
    log('DC', `Bridge: TS "${c.ts}" <-> Discord "${ch.name}"`);
  }

  if (relayChat) manager.client.on(Events.MessageCreate, onDiscordMessage);

  manager.client.on(Events.VoiceStateUpdate, (oldS, newS) => {
    if (newS.member?.user.bot) return;
    syncHumans();
    scheduleReconcile();
  });

  ts.start();
  scheduleReconcile();
  log('DC', `Bridge running with ${bots.length} bots`);
}

function shutdown() {
  log('DC', 'Shutting down bridge');
  for (const b of bots) disconnectBot(b);
  ts.stop();
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => log('DC', `Unhandled: ${e?.stack || e}`));

main().catch((e) => {
  log('DC', `Startup failed: ${e.message}`);
  ts.stop();
  process.exit(1);
});
