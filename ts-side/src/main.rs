//! TeamSpeak side of the TS <-> Discord bridge.
//!
//! Spawned by the Node.js Discord process. Communication runs over stdin/stdout
//! with simple frames: [u8 type][u32 BE length][payload]. Logs go to stderr.
//!
//! Frame types Rust -> Node:
//!   1 JSON event
//!   2 TS audio: [u8 channel index][u16 BE TS client id][opus bytes]
//! Frame types Node -> Rust:
//!   1 JSON command
//!   2 Discord audio: [u8 key length][key utf8][opus bytes]

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures::prelude::*;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, watch};
use tracing::{debug, error, info, warn};
use tsclientlib::prelude::*;
use tsclientlib::{ChannelId, Connection, DisconnectOptions, Identity, InMessage, StreamItem, TextMessageTargetMode};
use tsproto_packets::packets::{AudioData, CodecType, OutAudio};

const FRAME_JSON: u8 = 1;
const FRAME_AUDIO: u8 = 2;
/// TeamSpeak limits nicknames to 30 characters.
const TS_NAME_MAX: usize = 30;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Config {
	ts: TsConfig,
	channels: Vec<ChannelConfig>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TsConfig {
	address: String,
	#[serde(default)]
	server_password: String,
	#[serde(default = "default_listener_name")]
	listener_name: String,
	#[serde(default = "default_identity_dir")]
	identity_dir: String,
	/// Where the listener waits while nobody is in the Discord channel, e.g. "AFK".
	#[serde(default)]
	idle_channel: Option<String>,
}

fn default_listener_name() -> String { "Discord Bridge".into() }
fn default_identity_dir() -> String { "identities".into() }

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChannelConfig {
	/// TeamSpeak channel path, e.g. "Gaming/Raum 1", or "/<id>" for a channel id.
	ts: String,
	#[serde(default)]
	ts_password: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Command {
	/// A Discord user joined a bridged voice channel.
	Join { key: String, name: String, channel: usize },
	/// A Discord user left.
	Leave { key: String },
	/// Whether Discord users are in the bridged channel (listener joins) or not (listener waits in AFK).
	Active { channel: usize, active: bool },
	/// Discord text chat of a bridged voice channel -> TS channel chat. Sent by the user's own
	/// TS client if `key` has one, otherwise by the listener as "name: text".
	Chat { channel: usize, key: Option<String>, name: String, text: String },
	/// Discord DM reply -> TS private message from the user's TS client.
	Private { key: String, to: u16, text: String },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Event<'a> {
	/// Who is in the bridged TS channel (excluding our own bridge clients).
	Channel { index: usize, connected: bool, name: &'a str, clients: Vec<TsClient> },
	/// Status of a Discord user's TS client.
	User { key: &'a str, status: &'a str, detail: Option<String> },
	/// TS channel chat message.
	Chat { index: usize, from: &'a str, text: &'a str },
	/// Something private for a Discord user: kind is "message", "poke" or "whisper".
	Private { key: &'a str, kind: &'a str, from_id: u16, from_name: &'a str, text: &'a str },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TsClient {
	id: u16,
	name: String,
	uid: Option<String>,
}

enum UserCmd {
	Audio(Vec<u8>),
	Chat(String),
	Private { to: u16, text: String },
	Leave,
}

enum ListenerCmd {
	Chat(String),
}

/// TeamSpeak text messages are limited to 1024 characters.
const TS_TEXT_MAX: usize = 1000;

fn split_text(text: &str) -> Vec<String> {
	let chars: Vec<char> = text.chars().collect();
	chars.chunks(TS_TEXT_MAX).map(|c| c.iter().collect()).collect()
}

fn is_own_uid(own: &OwnUids, uid: Option<&tsclientlib::UidBuf>) -> bool {
	uid.map(|u| own.lock().unwrap().contains(&u.as_ref().0.to_vec())).unwrap_or(false)
}

/// Unique ids of all TS clients this bridge runs, so we never mirror our own clients.
type OwnUids = Arc<Mutex<HashSet<Vec<u8>>>>;

#[derive(Clone)]
struct Out(mpsc::UnboundedSender<Vec<u8>>);

impl Out {
	fn frame(&self, kind: u8, payload: &[u8]) {
		let mut buf = Vec::with_capacity(5 + payload.len());
		buf.push(kind);
		buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
		buf.extend_from_slice(payload);
		let _ = self.0.send(buf);
	}
	fn event(&self, e: &Event) {
		if let Ok(json) = serde_json::to_vec(e) {
			self.frame(FRAME_JSON, &json);
		}
	}
}

#[tokio::main]
async fn main() -> Result<()> {
	tracing_subscriber::fmt()
		.with_writer(std::io::stderr)
		.with_ansi(false)
		.with_env_filter(
			tracing_subscriber::EnvFilter::try_from_default_env()
				.unwrap_or_else(|_| "info,tsproto=error,tsclientlib=warn".into()),
		)
		.init();

	let path = std::env::args().nth(1).unwrap_or_else(|| "config.json".into());
	let cfg: Config = serde_json::from_str(
		&std::fs::read_to_string(&path).with_context(|| format!("Cannot read {}", path))?,
	)
	.context("Invalid config")?;
	std::fs::create_dir_all(&cfg.ts.identity_dir)?;

	// stdout writer
	let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
	tokio::spawn(async move {
		let mut stdout = tokio::io::stdout();
		while let Some(buf) = out_rx.recv().await {
			if stdout.write_all(&buf).await.is_err() {
				break;
			}
			let _ = stdout.flush().await;
		}
	});
	let out = Out(out_tx);
	let own: OwnUids = Default::default();

	// One listener per bridged channel: shows who is there and receives their voice.
	let mut active_tx = Vec::new();
	let mut listener_tx = Vec::new();
	for (index, ch) in cfg.channels.iter().enumerate() {
		let identity = load_identity(&cfg.ts.identity_dir, &format!("listener-{}", index));
		own.lock().unwrap().insert(uid_of(&identity));
		let (tx, rx) = watch::channel(false);
		active_tx.push(tx);
		let (ltx, lrx) = mpsc::unbounded_channel();
		listener_tx.push(ltx);
		tokio::spawn(listener_task(cfg.clone(), index, ch.clone(), identity, out.clone(), own.clone(), rx, lrx));
	}

	// Read commands from Node
	let mut users: HashMap<String, mpsc::UnboundedSender<UserCmd>> = HashMap::new();
	let mut stdin = tokio::io::stdin();
	loop {
		let mut head = [0u8; 5];
		if stdin.read_exact(&mut head).await.is_err() {
			info!("stdin closed, shutting down");
			break;
		}
		let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
		let mut payload = vec![0u8; len];
		if stdin.read_exact(&mut payload).await.is_err() {
			break;
		}
		match head[0] {
			FRAME_JSON => match serde_json::from_slice::<Command>(&payload) {
				Ok(Command::Join { key, name, channel }) => {
					let Some(ch) = cfg.channels.get(channel) else {
						warn!(channel, "Join for unknown channel index");
						continue;
					};
					if let Some(old) = users.remove(&key) {
						let _ = old.send(UserCmd::Leave);
					}
					let identity = load_identity(&cfg.ts.identity_dir, &format!("user-{}", key));
					own.lock().unwrap().insert(uid_of(&identity));
					let (tx, rx) = mpsc::unbounded_channel();
					users.insert(key.clone(), tx);
					tokio::spawn(user_task(cfg.clone(), key, truncate(&name), ch.clone(), identity, rx, out.clone(), own.clone()));
				}
				Ok(Command::Leave { key }) => {
					if let Some(tx) = users.remove(&key) {
						let _ = tx.send(UserCmd::Leave);
					}
				}
				Ok(Command::Active { channel, active }) => {
					if let Some(tx) = active_tx.get(channel) {
						tx.send_if_modified(|v| std::mem::replace(v, active) != active);
					}
				}
				Ok(Command::Chat { channel, key, name, text }) => {
					if let Some(tx) = key.as_ref().and_then(|k| users.get(k)) {
						let _ = tx.send(UserCmd::Chat(text));
					} else if let Some(tx) = listener_tx.get(channel) {
						let _ = tx.send(ListenerCmd::Chat(format!("[b]{}:[/b] {}", name, text)));
					}
				}
				Ok(Command::Private { key, to, text }) => {
					if let Some(tx) = users.get(&key) {
						let _ = tx.send(UserCmd::Private { to, text });
					} else {
						out.event(&Event::User {
							key: &key,
							status: "notice",
							detail: Some("not_connected".into()),
						});
					}
				}
				Err(e) => warn!(%e, "Bad command"),
			},
			FRAME_AUDIO => {
				if payload.is_empty() {
					continue;
				}
				let klen = payload[0] as usize;
				if payload.len() < 1 + klen {
					continue;
				}
				let key = String::from_utf8_lossy(&payload[1..1 + klen]);
				if let Some(tx) = users.get(key.as_ref()) {
					let _ = tx.send(UserCmd::Audio(payload[1 + klen..].to_vec()));
				}
			}
			t => warn!(t, "Unknown frame type"),
		}
	}

	for (_, tx) in users.drain() {
		let _ = tx.send(UserCmd::Leave);
	}
	tokio::time::sleep(Duration::from_millis(500)).await;
	Ok(())
}

fn truncate(name: &str) -> String { name.chars().take(TS_NAME_MAX).collect() }

fn uid_of(identity: &Identity) -> Vec<u8> { identity.key().to_pub().get_uid_no_base64() }

fn identity_path(dir: &str, name: &str) -> PathBuf {
	let safe: String =
		name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
	PathBuf::from(dir).join(format!("{}.json", safe))
}

/// Load a stored identity or create a new one. Persistent identities mean TS
/// admins can give bridge users permanent server groups.
fn load_identity(dir: &str, name: &str) -> Identity {
	let path = identity_path(dir, name);
	if let Ok(s) = std::fs::read_to_string(&path) {
		if let Ok(id) = serde_json::from_str::<Identity>(&s) {
			return id;
		}
		warn!(?path, "Identity file broken, creating a new one");
	}
	let id = Identity::create();
	save_identity(dir, name, &id);
	id
}

fn save_identity(dir: &str, name: &str, id: &Identity) {
	let path = identity_path(dir, name);
	match serde_json::to_string_pretty(id) {
		Ok(s) => {
			if let Err(e) = std::fs::write(&path, s) {
				error!(%e, ?path, "Cannot save identity");
			}
		}
		Err(e) => error!(%e, "Cannot serialize identity"),
	}
}

fn build_options(cfg: &Config, name: String, ch: &ChannelConfig, identity: Identity) -> tsclientlib::ConnectOptions {
	let mut opts = Connection::build(cfg.ts.address.clone()).name(name).identity(identity);
	if ch.ts.starts_with('/') && ch.ts[1..].chars().all(|c| c.is_ascii_digit()) {
		opts = opts.channel(ch.ts.clone());
	} else {
		opts = opts.channel(ch.ts.trim_start_matches('/').to_string());
	}
	if !ch.ts_password.is_empty() {
		opts = opts.channel_password(ch.ts_password.clone());
	}
	if !cfg.ts.server_password.is_empty() {
		opts = opts.password(cfg.ts.server_password.clone());
	}
	opts
}

/// Wait until the connection is established (first BookEvents).
async fn wait_connected(con: &mut Connection) -> Result<()> {
	let r = con
		.events()
		.try_filter(|e| future::ready(matches!(e, StreamItem::BookEvents(_))))
		.next()
		.await;
	match r {
		Some(Ok(_)) => Ok(()),
		Some(Err(e)) => Err(e.into()),
		None => bail!("Connection closed"),
	}
}

/// Find a channel by config path: "/42" (id) or "Parent/Child" (names).
fn find_channel(state: &tsclientlib::data::Connection, path: &str) -> Option<ChannelId> {
	if let Some(id) = path.strip_prefix('/').and_then(|r| r.parse::<u64>().ok()) {
		let id = ChannelId(id);
		return state.channels.contains_key(&id).then_some(id);
	}
	let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
	// Exact path from the root, e.g. "Gaming/Raum 1"
	let mut parent = ChannelId(0);
	let mut found = None;
	for part in &parts {
		match state.channels.values().find(|c| c.parent == parent && c.name.trim() == part.trim()) {
			Some(ch) => {
				parent = ch.id;
				found = Some(ch.id);
			}
			None => {
				found = None;
				break;
			}
		}
	}
	if found.is_some() {
		return found;
	}
	// Otherwise the channel name anywhere in the tree, if it is unique (ignoring case)
	let last = parts.last()?.trim().to_lowercase();
	let mut hits = state.channels.values().filter(|c| c.name.trim().to_lowercase() == last);
	match (hits.next(), hits.next()) {
		(Some(ch), None) => Some(ch.id),
		_ => None,
	}
}

/// All channel names, for a helpful error message.
fn channel_names(state: &tsclientlib::data::Connection) -> String {
	let mut names: Vec<&str> = state.channels.values().map(|c| c.name.as_str()).collect();
	names.sort();
	names.join(", ")
}

/// Process events for a moment until the channel list has arrived and the paths can be found.
async fn resolve_channels(
	con: &mut Connection, target_path: &str, idle_path: Option<&str>,
) -> Result<(ChannelId, Option<ChannelId>)> {
	let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
	loop {
		{
			let state = con.get_state()?;
			if let Some(target) = find_channel(state, target_path) {
				let idle = idle_path.and_then(|p| find_channel(state, p));
				// Give the AFK channel the same chance to show up, unless time is over.
				if idle.is_some() || idle_path.is_none() || tokio::time::Instant::now() >= deadline {
					return Ok((target, idle));
				}
			} else if tokio::time::Instant::now() >= deadline {
				bail!("TS channel '{}' not found. Channels on the server: {}", target_path, channel_names(state));
			}
		}
		match tokio::time::timeout_at(deadline, con.events().next()).await {
			Ok(None) => bail!("Connection closed"),
			Ok(Some(Err(e))) => return Err(e.into()),
			Ok(Some(Ok(_))) | Err(_) => {}
		}
	}
}

fn report_channel(out: &Out, index: usize, con: &Connection, own: &OwnUids, target: ChannelId) {
	let Ok(state) = con.get_state() else { return };
	let chan_name = state.channels.get(&target).map(|c| c.name.clone()).unwrap_or_default();
	let own = own.lock().unwrap();
	let mut clients: Vec<TsClient> = state
		.clients
		.values()
		.filter(|c| c.channel == target && c.id != state.own_client)
		.filter(|c| c.uid.as_ref().map(|u| !own.contains(&u.as_ref().0.to_vec())).unwrap_or(true))
		.map(|c| TsClient { id: c.id.0, name: c.name.clone(), uid: c.uid.as_ref().map(|u| B64.encode(&u.as_ref().0)) })
		.collect();
	clients.sort_by_key(|c| c.id);
	out.event(&Event::Channel { index, connected: true, name: &chan_name, clients });
}

async fn listener_task(
	cfg: Config, index: usize, ch: ChannelConfig, mut identity: Identity, out: Out, own: OwnUids,
	mut active: watch::Receiver<bool>, mut chat: mpsc::UnboundedReceiver<ListenerCmd>,
) {
	let id_name = format!("listener-{}", index);
	let idle = cfg.ts.idle_channel.clone().filter(|s| !s.trim().is_empty());
	loop {
		let name = truncate(&cfg.ts.listener_name);
		// Start in the AFK channel while nobody is in the Discord channel.
		let start = match (&idle, *active.borrow()) {
			(Some(idle), false) => ChannelConfig { ts: idle.clone(), ts_password: String::new() },
			_ => ch.clone(),
		};
		info!(index, channel = %start.ts, "Listener connecting");
		match build_options(&cfg, name, &start, identity.clone()).connect() {
			Ok(mut con) => {
				match wait_connected(&mut con).await {
					Ok(()) => {
						info!(index, "Listener connected");
						if let Some(id) = con.get_options().get_identity() {
							identity = id.clone();
							save_identity(&cfg.ts.identity_dir, &id_name, &identity);
						}
						if let Err(e) = listener_loop(&mut con, index, &ch, idle.as_deref(), &out, &own, &mut active, &mut chat).await {
							warn!(index, %e, "Listener disconnected");
						}
					}
					Err(e) => error!(index, %e, "Listener could not connect"),
				}
				// Disconnect properly, otherwise the old session stays on the server as a "clone".
				let _ = con.disconnect(DisconnectOptions::new());
				let _ = tokio::time::timeout(Duration::from_secs(3), con.events().for_each(|_| future::ready(()))).await;
			}
			Err(e) => error!(index, %e, "Listener connect failed"),
		}
		out.event(&Event::Channel { index, connected: false, name: "", clients: vec![] });
		tokio::time::sleep(Duration::from_secs(15)).await;
	}
}

/// Move the listener to the bridged channel (active) or to the AFK channel.
fn place_listener(
	con: &mut Connection, index: usize, ch: &ChannelConfig, target: ChannelId, idle: Option<ChannelId>, active: bool,
) {
	let want = if active { target } else { idle.unwrap_or(target) };
	let Ok(state) = con.get_state() else { return };
	let Some(me) = state.clients.get(&state.own_client) else { return };
	if me.channel == want {
		return;
	}
	let mut part = me.client_move(want);
	if want == target && !ch.ts_password.is_empty() {
		part = part.set_password(&ch.ts_password);
	}
	let packet = part.to_packet();
	info!(index, active, "Listener moves {}", if want == target { "into bridged channel" } else { "to AFK channel" });
	if let Err(e) = packet.send(con) {
		warn!(index, %e, "Move failed");
	}
}

async fn listener_loop(
	con: &mut Connection, index: usize, ch: &ChannelConfig, idle_path: Option<&str>, out: &Out, own: &OwnUids,
	active: &mut watch::Receiver<bool>, chat: &mut mpsc::UnboundedReceiver<ListenerCmd>,
) -> Result<()> {
	let (target, idle) = resolve_channels(con, &ch.ts, idle_path).await?;
	if let (Some(p), None) = (idle_path, idle) {
		warn!(index, path = p, "AFK channel not found, staying in bridged channel");
	}
	// Keep seeing the bridged channel's clients while sitting in the AFK channel.
	let sub = con.get_state()?.channels.get(&target).map(|c| c.set_subscribed(true));
	if let Some(sub) = sub {
		let _ = sub.send(con);
	}
	place_listener(con, index, ch, target, idle, *active.borrow());
	report_channel(out, index, con, own, target);

	loop {
		let next_event = async { con.events().next().await };
		let item = tokio::select! {
			item = next_event => item,
			r = active.changed() => {
				if r.is_err() { bail!("Shutdown") }
				let is_active = *active.borrow();
				place_listener(con, index, ch, target, idle, is_active);
				continue;
			}
			cmd = chat.recv() => {
				if let Some(ListenerCmd::Chat(text)) = cmd {
					let in_target = con.get_state().ok()
						.and_then(|s| s.clients.get(&s.own_client).map(|me| me.channel == target))
						.unwrap_or(false);
					if in_target {
						for part in split_text(&text) {
							let packet = con.get_state()?.send_message(tsclientlib::MessageTarget::Channel, &part);
							let _ = packet.send(con);
						}
					} else {
						debug!(index, "Chat dropped, listener is not in the bridged channel");
					}
				}
				continue;
			}
		};
		match item {
			None => bail!("Connection closed"),
			Some(Err(e)) => return Err(e.into()),
			Some(Ok(StreamItem::BookEvents(_))) => report_channel(out, index, con, own, target),
			Some(Ok(StreamItem::DisconnectedTemporarily(reason))) => {
				warn!(index, ?reason, "Temporarily disconnected, reconnecting");
				out.event(&Event::Channel { index, connected: false, name: "", clients: vec![] });
			}
			Some(Ok(StreamItem::Audio(packet))) => {
				if let AudioData::S2C { from, codec, data, .. } = packet.data().data() {
					if !matches!(codec, CodecType::OpusVoice | CodecType::OpusMusic) || data.is_empty() {
						continue;
					}
					// Only relay voice from the bridged channel, never from the AFK channel.
					let in_target = con
						.get_state()
						.ok()
						.and_then(|s| s.clients.get(&s.own_client).map(|me| me.channel == target))
						.unwrap_or(false);
					if !in_target {
						continue;
					}
					// Skip our own clients (Discord users) to avoid echo.
					let is_own = con
						.get_state()
						.ok()
						.and_then(|s| s.clients.get(&tsclientlib::ClientId(*from)))
						.and_then(|c| c.uid.as_ref())
						.map(|u| own.lock().unwrap().contains(&u.as_ref().0.to_vec()))
						.unwrap_or(false);
					if is_own {
						continue;
					}
					let mut buf = Vec::with_capacity(3 + data.len());
					buf.push(index as u8);
					buf.extend_from_slice(&from.to_be_bytes());
					buf.extend_from_slice(data);
					out.frame(FRAME_AUDIO, &buf);
				}
			}
			Some(Ok(StreamItem::MessageEvent(InMessage::TextMessage(msg)))) => {
				let own_client = con.get_state().ok().map(|s| s.own_client);
				for m in msg.iter() {
					if !matches!(m.target, TextMessageTargetMode::Channel) || Some(m.invoker_id) == own_client {
						continue;
					}
					// Messages written on Discord come back from our own clients, skip them.
					if is_own_uid(own, m.invoker_uid.as_ref()) {
						continue;
					}
					out.event(&Event::Chat { index, from: &m.invoker_name, text: &m.message });
				}
			}
			Some(Ok(other)) => debug!(index, ?other, "Event"),
		}
	}
}

async fn user_task(
	cfg: Config, key: String, name: String, ch: ChannelConfig, identity: Identity,
	mut rx: mpsc::UnboundedReceiver<UserCmd>, out: Out, own: OwnUids,
) {
	let id_name = format!("user-{}", key);
	info!(%key, %name, channel = %ch.ts, "User connecting to TS");
	let mut con = match build_options(&cfg, name, &ch, identity).connect() {
		Ok(c) => c,
		Err(e) => {
			out.event(&Event::User { key: &key, status: "error", detail: Some(e.to_string()) });
			return;
		}
	};
	// Connect, but give up if the user leaves Discord before we are done.
	let connected = tokio::select! {
		r = wait_connected(&mut con) => r,
		_ = wait_leave(&mut rx) => {
			let _ = con.disconnect(DisconnectOptions::new());
			return;
		}
	};
	if let Err(e) = connected {
		error!(%key, %e, "User could not connect");
		out.event(&Event::User { key: &key, status: "error", detail: Some(e.to_string()) });
		return;
	}
	if let Some(id) = con.get_options().get_identity() {
		save_identity(&cfg.ts.identity_dir, &id_name, id);
	}
	out.event(&Event::User { key: &key, status: "connected", detail: None });

	// Avoid flooding Discord DMs: one whisper notice per speaker every 30 seconds.
	let mut whisper_seen: HashMap<u16, std::time::Instant> = HashMap::new();
	let result: Result<()> = async {
		loop {
			let next_event = async { con.events().next().await };
			tokio::select! {
				cmd = rx.recv() => match cmd {
					Some(UserCmd::Audio(opus)) => {
						// Discord sends 48 kHz stereo Opus, TeamSpeak can play it directly as OpusMusic.
						let packet = OutAudio::new(&AudioData::C2S { id: 0, codec: CodecType::OpusMusic, data: &opus });
						if let Err(e) = con.send_audio(packet) {
							debug!(%e, "send_audio failed");
						}
					}
					Some(UserCmd::Chat(text)) => {
						for part in split_text(&text) {
							let packet = con.get_state()?.send_message(tsclientlib::MessageTarget::Channel, &part);
							let _ = packet.send(&mut con);
						}
					}
					Some(UserCmd::Private { to, text }) => {
						let exists = con.get_state()?.clients.contains_key(&tsclientlib::ClientId(to));
						if !exists {
							out.event(&Event::User { key: &key, status: "notice", detail: Some("target_gone".into()) });
							continue;
						}
						for part in split_text(&text) {
							let packet = con.get_state()?.send_message(tsclientlib::MessageTarget::Client(tsclientlib::ClientId(to)), &part);
							let _ = packet.send(&mut con);
						}
					}
					Some(UserCmd::Leave) | None => return Ok(()),
				},
				item = next_event => match item {
					None => bail!("Connection closed"),
					Some(Err(e)) => return Err(e.into()),
					Some(Ok(StreamItem::MessageEvent(InMessage::TextMessage(msg)))) => {
						let own_client = con.get_state().ok().map(|s| s.own_client);
						for m in msg.iter() {
							if matches!(m.target, TextMessageTargetMode::Client) && Some(m.invoker_id) != own_client
								&& !is_own_uid(&own, m.invoker_uid.as_ref())
							{
								out.event(&Event::Private { key: &key, kind: "message", from_id: m.invoker_id.0, from_name: &m.invoker_name, text: &m.message });
							}
						}
					}
					Some(Ok(StreamItem::MessageEvent(InMessage::ClientPoke(msg)))) => {
						for m in msg.iter() {
							out.event(&Event::Private { key: &key, kind: "poke", from_id: m.invoker_id.0, from_name: &m.invoker_name, text: &m.message });
						}
					}
					Some(Ok(StreamItem::Audio(packet))) => {
						if let AudioData::S2CWhisper { from, .. } = packet.data().data() {
							let now = std::time::Instant::now();
							let fresh = whisper_seen.get(from).map(|t| now.duration_since(*t) > Duration::from_secs(30)).unwrap_or(true);
							if fresh {
								whisper_seen.insert(*from, now);
								let name = con.get_state().ok()
									.and_then(|s| s.clients.get(&tsclientlib::ClientId(*from)).map(|c| c.name.clone()))
									.unwrap_or_else(|| "?".into());
								out.event(&Event::Private { key: &key, kind: "whisper", from_id: *from, from_name: &name, text: "" });
							}
						}
					}
					Some(Ok(_)) => {}
				},
			}
		}
	}
	.await;

	if let Err(e) = &result {
		warn!(%key, %e, "User TS connection lost");
		out.event(&Event::User { key: &key, status: "error", detail: Some(e.to_string()) });
	}
	let _ = con.disconnect(DisconnectOptions::new());
	// Drive the connection until the disconnect is acknowledged (max 2 s).
	let _ = tokio::time::timeout(Duration::from_secs(2), con.events().for_each(|_| future::ready(()))).await;
	out.event(&Event::User { key: &key, status: "disconnected", detail: None });
}

async fn wait_leave(rx: &mut mpsc::UnboundedReceiver<UserCmd>) {
	loop {
		match rx.recv().await {
			Some(UserCmd::Leave) | None => return,
			Some(_) => {}
		}
	}
}
