# Discord voice relay — design

**Date:** 2026-06-13
**Goal:** The music bot's audio plays simultaneously in TeamSpeak and in a
Discord voice channel. Extends the Discord integration
(`2026-06-13-discord-integration-design.md`).

## Principle

TS and Discord both consume Opus 48 kHz stereo in 20 ms frames — exactly
what the playback loop already produces. A frame sink is added at
`VoiceBot.sendVoiceFrame()`: every encoded opus frame goes to TS and, when a
relay is attached, to Discord. No re-encoding, no extra decode, works for
files, YouTube and radios alike. Pausing TS playback pauses Discord too
(same flow, by design).

## Components

- `VoiceBot.setFrameSink(fn | null)` — optional tap, the bot knows nothing
  about Discord.
- `discord/discord-voice.ts` — `DiscordVoiceRelay`: joins/leaves voice
  channels (`@discordjs/voice`), one `AudioPlayer`; a new object-mode
  PassThrough + `AudioResource` (`StreamType.Opus`) per track, started on
  `nowPlaying` and ended on stop/track end; pause/resume mirrored from the
  bot's `statusChange`.
- Bridge: `GuildVoiceStates` intent; on ready, joins the configured fixed
  channel (`voiceChannelId`, new `DiscordSettings` column). `/join` switches
  to the invoker's current voice channel, `/leave` disconnects; the fixed
  channel is re-joined on the next bridge reload.
- Relay follows the configured default music bot, re-attaching when the bot
  instance is recreated (`onBotCreated`).
- Settings UI: voice-channel dropdown — `/api/discord/channels` now returns
  `{ text, voice }`.

## Error handling

- No default music bot → relay joins and stays silent, warning in status.
- `/join` while the user is not in a voice channel → ephemeral error.
- Voice connection drops → destroy and log; next reload or /join recovers.

## Testing

Existing suites must stay green; the relay itself is validated live (voice
connections are not unit-testable meaningfully).
