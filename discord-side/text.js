// Text helpers: TeamSpeak BBCode -> Discord markdown, and user facing strings.
'use strict';

const { escapeMarkdown } = require('discord.js');

/** Converts the BBCode TeamSpeak uses in chat to plain Discord text. */
function bbcodeToDiscord(text) {
  return String(text)
    .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_, url, label) =>
      label && label !== url ? `${label} (${url})` : url,
    )
    .replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '$1')
    .replace(/\[\/?(b|i|u|s|img|quote|code|center|left|right|list|\*|color(=[^\]]*)?|size(=[^\]]*)?)\]/gi, '')
    .trim();
}

/** Discord limits messages to 2000 characters. */
function clip(text, max = 1900) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const name = (n) => `**${escapeMarkdown(n || '?')}**`;

const STRINGS = {
  en: {
    channelChat: (from, text) => `${name(from)} (TS): ${text}`,
    privateMessage: (from, text) =>
      `💬 ${name(from)} sent you a private message on TeamSpeak:\n${text}\n-# Reply here and your answer goes privately to ${escapeMarkdown(from)}.`,
    poke: (from, text) => `👉 ${name(from)} poked you on TeamSpeak${text ? `: ${text}` : ''}\n-# Reply here to answer privately.`,
    whisper: (from) => `🤫 ${name(from)} is whispering to you on TeamSpeak. Whispers are voice only and cannot be heard on Discord.\n-# Reply here to answer privately.`,
    noReplyTarget: 'Nobody has messaged you privately on TeamSpeak yet, so I do not know who to send this to.',
    not_connected: 'You are not connected to TeamSpeak right now. Join a bridged voice channel first.',
    target_gone: 'That person is no longer on the TeamSpeak server.',
    placeholderEmpty: 'empty',
    placeholderOffline: 'offline',
  },
  de: {
    channelChat: (from, text) => `${name(from)} (TS): ${text}`,
    privateMessage: (from, text) =>
      `💬 ${name(from)} schreibt dir privat auf TeamSpeak:\n${text}\n-# Antworte hier, dann geht deine Nachricht privat an ${escapeMarkdown(from)}.`,
    poke: (from, text) => `👉 ${name(from)} hat dich auf TeamSpeak angestupst${text ? `: ${text}` : ''}\n-# Antworte hier, um privat zu antworten.`,
    whisper: (from) => `🤫 ${name(from)} flüstert dir auf TeamSpeak zu. Flüstern ist nur Sprache und kommt in Discord nicht an.\n-# Antworte hier, um privat zu antworten.`,
    noReplyTarget: 'Dir hat auf TeamSpeak noch niemand privat geschrieben, ich weiß also nicht, an wen das gehen soll.',
    not_connected: 'Du bist gerade nicht mit TeamSpeak verbunden. Geh zuerst in einen Bridge Voice Channel.',
    target_gone: 'Die Person ist nicht mehr auf dem TeamSpeak Server.',
    placeholderEmpty: 'leer',
    placeholderOffline: 'offline',
  },
};

function strings(language) {
  return STRINGS[language] || STRINGS.en;
}

module.exports = { bbcodeToDiscord, clip, strings };
