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
const withHint = (text, hint) => (hint ? `${text}\n-# ${hint}` : text);

const STRINGS = {
  en: {
    channelChat: (from, text) => `${name(from)} (TS): ${text}`,
    privateMessage: (from, text, hint) => withHint(`💬 ${name(from)}: ${text}`, hint),
    poke: (from, text, hint) => withHint(`👉 ${name(from)} poked you${text ? `: ${text}` : ''}`, hint),
    whisper: (from, hint) =>
      withHint(`🤫 ${name(from)} is whispering to you on TeamSpeak. Whispers are voice only and cannot be heard on Discord.`, hint),
    replyHint: (from) => `Reply here and your answer goes privately to ${escapeMarkdown(from)} on TeamSpeak.`,
    noReplyTarget:
      'Nobody has messaged you privately on TeamSpeak yet. To write to someone, send a DM to the bot that carries their name.',
    botIdle: 'This bot does not represent anyone on TeamSpeak right now.',
    not_connected: 'You are not connected to TeamSpeak right now. Join a bridged voice channel first.',
    target_gone: 'That person is no longer on the TeamSpeak server.',
    placeholderEmpty: 'empty',
    placeholderOffline: 'offline',
  },
  de: {
    channelChat: (from, text) => `${name(from)} (TS): ${text}`,
    privateMessage: (from, text, hint) => withHint(`💬 ${name(from)}: ${text}`, hint),
    poke: (from, text, hint) => withHint(`👉 ${name(from)} hat dich angestupst${text ? `: ${text}` : ''}`, hint),
    whisper: (from, hint) =>
      withHint(`🤫 ${name(from)} flüstert dir auf TeamSpeak zu. Flüstern ist nur Sprache und kommt in Discord nicht an.`, hint),
    replyHint: (from) => `Antworte hier, dann geht deine Nachricht privat an ${escapeMarkdown(from)} auf TeamSpeak.`,
    noReplyTarget:
      'Dir hat auf TeamSpeak noch niemand privat geschrieben. Um jemandem zu schreiben, schick dem Bot mit seinem Namen eine DM.',
    botIdle: 'Dieser Bot stellt gerade niemanden auf TeamSpeak dar.',
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
