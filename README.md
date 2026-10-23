# TeamSpeak ⇄ Discord Bridge

Hang out on Discord while your friends stay on TeamSpeak 3. This bridge mirrors TeamSpeak channels into Discord voice channels, both ways, with voice and text.

* **Every TeamSpeak user shows up as their own Discord bot**, renamed to their TS nickname. You see who is in the TS channel, the bot lights up green when they talk, and you can change each person's volume in Discord.
* **Join the Discord voice channel and you are on TeamSpeak.** The bridge connects a TS client for you (e.g. `Chris (DC)`) and everything you say is played there.
* **Channel chat is mirrored.** TS channel messages are posted in the text chat of the Discord voice channel by the bot of whoever wrote them, and messages written there are posted to the TS channel under your name.
* **Private stays private.** Want to write to Max? DM the bot called Max and it arrives as a TS private message. Max's private messages and pokes come back as DMs from that bot.
* **Several TeamSpeak servers**, several Discord users at once, automatic reconnects, Discord voice encryption (DAVE) supported.

```
TeamSpeak server                     Bridge host                              Discord server
┌──────────────┐        ┌──────────────────────────────────┐        ┌──────────────────────┐
│ Lobby        │◀──────▶│ ts-side (Rust, tsclientlib)      │        │ 🔊 TS Lobby          │
│  Max         │ voice  │  • "Discord Bridge" per channel  │ stdin/ │   Max   (bot 1)      │
│  Lena        │ + text │  • one TS client per Discord user│ stdout │   Lena  (bot 2)      │
│  Chris (DC)  │        ├──────────────────────────────────┤◀──────▶│   Chris (human)      │
└──────────────┘        │ discord-side (Node.js)           │        │   💬 channel chat    │
                        │  • bot pool, one bot per TS user │        └──────────────────────┘
                        └──────────────────────────────────┘
```

Audio is passed through as Opus without transcoding. Expect roughly 100 to 250 ms of extra latency.

## How it works

* For every bridged channel there is one TS client called `Discord Bridge`. While nobody is in the Discord channel it waits in an idle channel (e.g. `AFK`) and still sees who is in the bridged channel. As soon as someone joins on Discord, it moves into the bridged channel and relays voice and chat.
* For every TS user in a bridged channel, a free bot from the pool joins the Discord channel and takes their nickname. When they leave, the bot leaves too.
* The **first bot** is reserved for text: it reads the voice channel chats and handles private messages from TS users that have no bot of their own (e.g. people in channels that are not bridged). It never represents a TS user, so a DM to it is always a reply to whoever wrote you last.
* One TeamSpeak process runs per configured server, so channels from different TS servers can be bridged into the same Discord server.
* For every Discord user in a bridged voice channel, the bridge opens a TeamSpeak connection with a persistent identity, so TS admins can give it server groups.

## Requirements

* A machine that is always on: a small VPS, a home server or a Raspberry Pi 4 (1 GB RAM is enough to run it, building is more comfortable with 2 GB)
* Docker with Docker Compose (recommended), or Node.js 20+ and Rust
* Outgoing UDP to the TeamSpeak server (usually port 9987). No incoming ports needed.
* A TeamSpeak 3 server you are allowed to connect bots to. ServerQuery access is **not** needed.

## 1. Create the Discord bots

A Discord bot can only send **one** audio stream at a time, so every TeamSpeak user that is in a bridged channel at the same time needs their own bot.

**How many?** The maximum number of TS users in all bridged channels together, plus one for text (the first bot), plus one spare. If the pool runs out, extra TS users are not shown and not heard, and the log tells you.

For every bot:

1. Open https://discord.com/developers/applications and click **New Application**, e.g. `TS Bridge 1`, `TS Bridge 2`, …
2. Go to **Bot**, click **Reset Token** and copy the token for `config.json`.
3. Invite the bot with this link (replace `CLIENT_ID` with the Application ID from **General Information**):
   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot&permissions=103877696`
   It grants *View Channels*, *Connect*, *Speak*, *Use Voice Activity*, *Change Nickname*, *Send Messages*, *Add Reactions* and *Read Message History*. Opening the link again for a bot that is already on the server just updates its permissions.

**Only for the first bot** (the first token in the list): under **Bot → Privileged Gateway Intents** turn on **Message Content Intent**. Without it, voice and private messages still work, but messages written in the Discord channel chat are not sent to TeamSpeak.

Tip: give all bots the same avatar (e.g. a TeamSpeak icon), so it is obvious who is on TS.

## 2. Collect the IDs

In Discord, enable **Settings → Advanced → Developer Mode**. Then:

* Right click your server → **Copy Server ID** → `guildId`
* Right click every voice channel you want to bridge → **Copy Channel ID** → `discord` of that channel

Create dedicated voice channels such as `🔊 TS Lobby` and do **not** set a user limit, the bots count as users.

## 3. Configure

```bash
cp data/config.example.json data/config.json
nano data/config.json
```

```jsonc
{
  "servers": [
    {
      "name": "main",                  // used by the channels below
      "address": "ts.example.com",     // IP, domain or TeamSpeak server nickname, port optional
      "serverPassword": "",
      "listenerName": "Discord Bridge",// name of the per channel listener on TS
      "idleChannel": "AFK"             // where the listener waits while nobody is on Discord (optional)
    },
    { "name": "friends", "address": "ts.friends.example" }
  ],
  "discord": {
    "guildId": "123…",
    "tokens": ["…", "…"],              // all bot tokens, the first one is reserved for text
    "language": "en",                  // "en" or "de", for DMs and bot names
    "relayChat": true,                 // channel chat, private messages and pokes
    "dcNameSuffix": " (DC)",           // appended to Discord names on TS
    "placeholderName": "TeamSpeak"     // bot name when nobody is in the TS channel
  },
  "channels": [
    { "server": "main", "ts": "Lobby", "tsPassword": "", "discord": "987…" },
    { "server": "main", "ts": "Gaming/Room 1", "tsPassword": "", "discord": "654…" },
    { "server": "friends", "ts": "Hangout", "discord": "321…" }
  ]
}
```

With only one TeamSpeak server you can also write `"ts": { "address": … }` instead of `"servers"` and leave out `"server"` in the channels. TS identities are stored in `data/identities/<server name>/` (single server form: `data/identities/`).

`ts` is the channel path as shown in TeamSpeak, with sub channels separated by `/`. A plain name also works if it is unique on the server, and `"/42"` selects a channel by ID. If a channel cannot be found, the log lists all channel names on the server.

Token entries that still contain a placeholder like `TOKEN_BOT_5` are skipped, so you can start with a few bots and add more later.

## 4. Run with Docker (recommended)

```bash
docker compose up -d --build   # first build takes 5 to 10 minutes because of the Rust part
docker compose logs -f
```

* The container restarts automatically after a reboot.
* `data/` is the only folder outside the container. It holds `config.json` and the TS identities.
* After changing the config: `docker compose restart`
* After updating the code: `docker compose up -d --build`

### Without Docker

```bash
./install.sh                   # Ubuntu/Debian: installs Node.js 22 and Rust, builds everything
cd discord-side && npm start
```

To keep it running, use the included systemd unit:

```bash
sed "s/BRIDGE_USER/$USER/g" ts-discord-bridge.service | sudo tee /etc/systemd/system/ts-discord-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now ts-discord-bridge
journalctl -u ts-discord-bridge -f
```

## Text and private messages

| From | To | How |
|---|---|---|
| TS channel chat | Discord voice channel chat | Posted by the bot that shows the writer |
| Discord voice channel chat | TS channel chat | Sent by your own TS client. If you are not in voice, the listener posts it as `Name (DC): …` |
| DM to the bot "Max" | Private TS message to Max | From your TS client, or from the listener with your name in front if you are not in voice |
| Private TS message or poke from Max | DM from the bot "Max" | Reply in that DM to answer Max |
| Private TS message from someone without a bot | DM from the first bot | Reply there to answer whoever wrote you last |
| Voice whisper to `Chris (DC)` | DM "… is whispering to you" | Whispers are voice only and cannot be played on Discord |

A 💤 reaction on a channel message means nobody from Discord is in that voice channel, so the listener is idle and cannot post.

## Good to know

* **Tell the people on TeamSpeak.** Their voices and messages are relayed to Discord. The visible `Discord Bridge` client makes this transparent, but ask the server owner whether bots are fine.
* **Identities** live in `data/identities/`. Every Discord user has a fixed TS identity. Do not delete the folder, otherwise everyone gets new identities and loses their server groups.
* **Security level:** new identities start at level 8. If the server requires more, the bridge computes a higher level on the first connect, which can take a moment once.
* Only TeamSpeak 3 servers are supported. TeamSpeak 5/6 clients work fine on a TS3 server.

## Troubleshooting

| Log message | Fix |
|---|---|
| `Bot … is not a member of Discord server …` | Open the invite link for that bot |
| `Could not set nickname` | The bot role needs *Change Nickname* |
| `Not enough bots` | Add more tokens to `config.json` |
| `Message Content Intent is not enabled` | Enable it for the first bot in the Developer Portal |
| `Could not post to the voice channel chat` | Open the invite link with `permissions=103877696` again for that bot |
| `Could not DM …` | The user has DMs from server members turned off |
| `TS channel '…' not found` | Check the channel name against the list in the log |
| `Failed to connect to server at "…": []` | The address could not be resolved. Use the IP or domain instead of a bookmark name |
| `ClientTooManyClonesConnected` | Another bridge instance with the same identity is still connected. Stop it and wait a minute |
| TS users cannot hear Discord users | The TS channel may need talk power. Assign the identity a server group |

For a verbose TeamSpeak log, set `RUST_LOG=debug,tsproto=warn` (see `docker-compose.yml`).

## Project layout

```
ts-side/        Rust: TeamSpeak connections (listener per channel, client per Discord user)
discord-side/   Node.js: Discord bot pool, voice receive/playback, text relay
data/           config.json and identities (not in git)
```

The Node.js part starts one `ts-bridge` process per TeamSpeak server (with a generated `data/.runtime-<name>.json`). They talk over stdin/stdout with a small framed protocol (`[u8 type][u32 length][payload]`, JSON for control, raw Opus for audio). See the top of `ts-side/src/main.rs`.

## Credits

* [tsclientlib](https://github.com/ReSpeak/tsclientlib) for the TeamSpeak client protocol
* [discord.js](https://discord.js.org) and [@discordjs/voice](https://github.com/discordjs/voice)

Not affiliated with TeamSpeak Systems GmbH or Discord Inc.

## License

[MIT](LICENSE)
