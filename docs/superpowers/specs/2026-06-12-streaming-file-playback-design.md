# Streaming file playback — design

**Date:** 2026-06-12
**Problem:** Music bot playback stutters and starts slowly. Root cause analysis showed
`play()` decodes the entire file to PCM in RAM before the first frame
(`AudioPipeline.toPcm`): a 5-minute song allocates ~57 MB, a 1-hour mix ~690 MB,
causing long start delays and GC/memory-pressure stutter on a small VM. Two
secondary contributors: opus encoding runs in pure WASM (`opusscript`) every
20 ms, and yt-dlp/ffmpeg download processes compete with playback for CPU.

The originally requested fix (store MP3 instead of opus) was rejected during
brainstorming: the playback path always decodes the stored file to PCM via
ffmpeg, so the stored format is irrelevant to playback cost, and MP3 files are
larger than opus at equal quality.

## 1. Stream file playback (core change)

- `AudioPipeline.toPcmFileStream(filePath, startSeconds = 0)` — synchronous
  spawn of ffmpeg decoding the local file to s16le 48 kHz stereo on stdout,
  with `-ss <startSeconds>` placed before `-i` for instant seeks. Mirror of the
  existing radio path `toPcmStream`, minus URL validation (local paths from our
  own DB).
- `VoiceBot.play()` no longer calls `toPcm`/`splitFrames`. It spawns the file
  stream and consumes stdout in 20 ms frames using a paced loop modeled on the
  proven radio loop, plus the existing end-of-track logic (track repeat, queue
  advance, nickname reset). First audio in ~200 ms regardless of file length;
  memory stays at a few MB.
- Two epochs guard async callbacks: the existing `loopEpoch` (tick loop
  lifetime, bumped by `clearTimer`) and a new `streamEpoch` (ffmpeg process
  lifetime, bumped when a stream is replaced/stopped). This lets pause kill the
  tick loop without orphaning the stdout data handler.
- **Position:** `seekOffsetSec + framesSent × 0.02`; duration comes from
  `QueueItem.duration` (DB value). API shape unchanged.
- **Pause:** stop the tick loop, `stdout.pause()` (pipe backpressure idles
  ffmpeg at 0 CPU), `sendVoiceStop()`. **Resume:** `stdout.resume()` + new tick
  loop.
- **Seek:** kill the current ffmpeg, clear buffers, respawn with
  `-ss <target>`, set `seekOffsetSec`. Works while playing or paused (paused:
  respawn with stdout paused, loop starts on resume).
- **End of track:** ffmpeg close sets `fileDecodeDone`; the loop drains the
  remaining buffer (last partial frame zero-padded), then runs the existing
  end-of-track sequence.
- **Stop/skip/previous:** `stopPlayback()` already kills via `streamKill`;
  file playback registers its kill there too.
- The radio path (`playStream`) is untouched.

## 2. Native opus encoder

- Add `@discordjs/opus` (native libopus bindings, prebuilt for linux x64 /
  node 22). `AudioPipeline` loads it via `createRequire`; on any failure it
  falls back to the current `opusscript` WASM encoder. One log line states the
  active encoder.
- Same tuning in both paths: 96 kbps, hard CBR, signal=music (identical CTL
  constants — both wrap libopus).

## 3. Low-priority downloads

- `runYtDlp` (youtube.ts) spawns through `nice -n 19` on non-Windows
  platforms. The conversion ffmpeg spawned by yt-dlp inherits the niceness.
  The playback ffmpeg keeps normal priority (it has the realtime constraint).
- `resolveVideoUrl` (video streaming) stays at normal priority: it is
  latency-sensitive and lightweight.

## Error handling

- Native encoder init failure → WASM fallback, behavior identical to today.
- ffmpeg spawn/runtime error during file playback → bot returns to
  `connected`, error event emitted (same contract as the radio path).
- Buffer underrun mid-track (decode slower than playback, unlikely for local
  files) → silent gap, loop keeps pacing — same behavior as radio.

## Validation

- Typecheck + existing test suite.
- Docker image build must show the native encoder log line on linux x64.
- Manual on the VM: instant start of a long file, pause/resume/seek, queue
  advance, `docker stats` memory drop during playback.
