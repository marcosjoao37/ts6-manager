import { describe, it, expect } from 'vitest';
import { pickDownloadedFile, isYouTubePlaylistUrl, isYouTubeUrl } from './youtube.js';

const ID = 'dQw4w9WgXcQ';

describe('isYouTubePlaylistUrl', () => {
  it('detects watch URLs carrying a list parameter', () => {
    expect(isYouTubePlaylistUrl('https://www.youtube.com/watch?v=abc123&list=PL123')).toBe(true);
  });

  it('detects playlist URLs', () => {
    expect(isYouTubePlaylistUrl('https://www.youtube.com/playlist?list=PL123')).toBe(true);
    expect(isYouTubePlaylistUrl('https://music.youtube.com/playlist?list=PL123')).toBe(true);
  });

  it('detects YouTube Music watch URLs carrying a list parameter', () => {
    expect(isYouTubePlaylistUrl('https://music.youtube.com/watch?v=abc123&list=PL123')).toBe(true);
  });

  it('detects youtu.be share URLs carrying a list parameter', () => {
    expect(isYouTubePlaylistUrl('https://youtu.be/abc123?list=PL123')).toBe(true);
  });

  it('ignores plain single-video URLs', () => {
    expect(isYouTubePlaylistUrl('https://www.youtube.com/watch?v=abc123')).toBe(false);
    expect(isYouTubePlaylistUrl('https://youtu.be/abc123')).toBe(false);
    expect(isYouTubePlaylistUrl('https://music.youtube.com/watch?v=abc123')).toBe(false);
  });

  it('ignores non-YouTube hosts even with a list parameter', () => {
    expect(isYouTubePlaylistUrl('https://example.com/watch?v=abc123&list=PL123')).toBe(false);
  });
});

describe('isYouTubeUrl', () => {
  it('recognises YouTube hosts', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=abc123')).toBe(true);
    expect(isYouTubeUrl('https://youtu.be/abc123')).toBe(true);
    expect(isYouTubeUrl('https://music.youtube.com/playlist?list=PL123')).toBe(true);
    expect(isYouTubeUrl('https://music.youtube.com/watch?v=abc123')).toBe(true);
  });

  it('rejects other hosts', () => {
    expect(isYouTubeUrl('https://example.com/watch?v=abc123')).toBe(false);
    expect(isYouTubeUrl('not-a-url')).toBe(false);
  });
});

describe('pickDownloadedFile', () => {
  it('picks the expected opus file', () => {
    expect(pickDownloadedFile([`${ID}.opus`], ID)).toBe(`${ID}.opus`);
  });

  it('ignores a stale .part file left by an interrupted download', () => {
    // Regression: the old code picked the alphabetically last match, so a
    // leftover "<id>.webm.part" beat the freshly converted "<id>.opus" and a
    // corrupt path was stored in the library.
    expect(pickDownloadedFile([`${ID}.opus`, `${ID}.webm.part`], ID)).toBe(`${ID}.opus`);
  });

  it('ignores temp and metadata artifacts', () => {
    expect(
      pickDownloadedFile([`${ID}.webm.ytdl`, `${ID}.temp.opus`, `${ID}.webp`, `${ID}.info.json`], ID)
    ).toBeNull();
  });

  it('falls back to another audio extension when opus is absent', () => {
    expect(pickDownloadedFile([`${ID}.m4a`], ID)).toBe(`${ID}.m4a`);
  });

  it('prefers opus over other audio files', () => {
    expect(pickDownloadedFile([`${ID}.m4a`, `${ID}.opus`], ID)).toBe(`${ID}.opus`);
  });

  it('returns null when only temp files exist', () => {
    expect(pickDownloadedFile([`${ID}.webm.part`], ID)).toBeNull();
  });

  it('returns null for an empty directory', () => {
    expect(pickDownloadedFile([], ID)).toBeNull();
  });
});
