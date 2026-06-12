# Streaming file playback — implementation plan

Spec: `docs/superpowers/specs/2026-06-12-streaming-file-playback-design.md`

## Task 1 — pipeline.ts: file stream + native encoder

1. Add `toPcmFileStream(filePath, startSeconds = 0)` returning
   `{ stdout, process, kill }` (sync; mirrors `toPcmStream` without URL
   validation; `-ss` before `-i` when `startSeconds > 0`).
2. Load `@discordjs/opus` via `createRequire` at module scope (try/catch →
   null). In the constructor, build an internal `encodeFn`:
   - native: `new OpusEncoder(48000, 2)`, `setBitrate(96000)`,
     `applyEncoderCTL` VBR=0, VBR_CONSTRAINT=1, SIGNAL=MUSIC; wrap init in
     try/catch → fallback.
   - fallback: current opusscript path, unchanged.
   `encodeFrame` calls `encodeFn` after the existing volume scaling.
3. Add `@discordjs/opus` to backend dependencies; `pnpm install`.

## Task 2 — voice-bot.ts: streamed file playback

1. New fields: `streamEpoch`, `fileStdout`, `fileDecodeDone`, `framesSent`,
   `seekOffsetSec`. Remove `pcmFrames`, `frameIndex`, `pausedAtFrame` and
   `startPlaybackLoop()` (dead after this change).
2. `play(item)` → `startFileStream(item, 0)`:
   - bump `streamEpoch`, spawn `toPcmFileStream`, register
     `streamKill`/`fileStdout`, reset buffers/counters,
     `seekOffsetSec = start`.
   - stdout `data` → append to `streamChunks` (guarded by `streamEpoch`).
   - process `close` → `fileDecodeDone = true` (guarded). `error` → emit,
     status `connected`.
   - start the file tick loop.
3. File tick loop (modeled on the radio loop, guarded by `loopEpoch`):
   paced 20 ms slots, one frame per slot from `takeFromStreamChunks`;
   when `fileDecodeDone` and buffer < one frame: flush last partial frame
   zero-padded, then existing end-of-track sequence (sendVoiceStop, trackEnd,
   repeat-track, queue next / resetNickname).
4. `pause()`: clearTimer + `fileStdout?.pause()` + sendVoiceStop + status.
   `resume()`: status + `fileStdout?.resume()` + restart file tick loop.
5. `seek(seconds)`: guard playing/paused + `_nowPlaying` + not radio. Kill
   current stream (bump `streamEpoch`, `streamKill`, clear buffers), respawn
   at target via `startFileStream(item, seconds)`; if paused, leave stdout
   paused and don't start the loop.
6. `playbackProgress`: file mode returns
   `{ position: seekOffsetSec + framesSent * 0.02, duration: item.duration ?? 0 }`.

## Task 3 — youtube.ts: low-priority downloads

In `runYtDlp`, on `process.platform !== 'win32'` spawn
`nice ['-n','19','yt-dlp',...args]`, otherwise spawn `yt-dlp` directly.

## Task 4 — validation

`pnpm --filter @ts6/backend run typecheck && run test`; frontend untouched.
Commit, push. User validates on the VM (start latency, pause/seek, memory).
