import { describe, it, expect, vi } from 'vitest';

vi.mock('./audio/youtube.js', () => {
  const idFromUrl = (url: string): string => {
    const v = url.match(/[?&]v=([^&#]+)/);
    if (v) return v[1];
    const y = url.match(/youtu\.be\/([^?&]+)/);
    return y ? y[1] : 'abc123';
  };

  return {
    downloadYouTube: vi.fn(async (url: string) => {
      const id = idFromUrl(url);
      return {
        filePath: `/music/${id}.opus`,
        info: { id, title: `Song ${id}`, artist: 'Test Artist', duration: 180, thumbnail: '', url },
      };
    }),
    searchYouTube: vi.fn(async () => [
      { id: 'vid456', title: 'Found Song', artist: 'Someone', duration: 120, thumbnail: '' },
    ]),
    isYouTubePlaylistUrl: vi.fn((url: string) => url.includes('list=')),
    getYouTubePlaylistVideos: vi.fn(async () => [
      { id: 'vid1', title: 'Song vid1', artist: 'Test Artist', duration: 100, thumbnail: '' },
      { id: 'vid2', title: 'Song vid2', artist: 'Test Artist', duration: 110, thumbnail: '' },
    ]),
  };
});

import { resolvePlayQuery, downloadAndEnqueue } from './music-ops.js';
import { PlayQueue } from './playlist/queue.js';

function fakeBot(status: string = 'connected') {
  return {
    queue: new PlayQueue(),
    status,
    play: vi.fn(async () => { }),
    currentConfig: { serverConfigId: null },
  } as any;
}

const prisma = {} as any; // history save is skipped without a serverConfigId

describe('resolvePlayQuery', () => {
  it('passes URLs through untouched', async () => {
    expect(await resolvePlayQuery('https://youtu.be/xyz')).toBe('https://youtu.be/xyz');
  });

  it('turns search terms into the first YouTube result URL', async () => {
    expect(await resolvePlayQuery('some song')).toBe('https://www.youtube.com/watch?v=vid456');
  });
});

describe('downloadAndEnqueue', () => {
  it('starts playing immediately when the bot is idle', async () => {
    const bot = fakeBot('connected');
    const { item, queued } = await downloadAndEnqueue(prisma, bot, 'https://youtu.be/abc123');
    expect(queued).toBe(false);
    expect(bot.play).toHaveBeenCalledWith(expect.objectContaining({ id: 'yt_abc123' }));
    expect(item.title).toBe('Song abc123');
    expect(bot.queue.length).toBe(1);
  });

  it('queues behind the current track when something is playing', async () => {
    const bot = fakeBot('playing');
    const { queued } = await downloadAndEnqueue(prisma, bot, 'https://youtu.be/abc123');
    expect(queued).toBe(true);
    expect(bot.play).not.toHaveBeenCalled();
    expect(bot.queue.length).toBe(1);
  });

  it('expands a playlist URL and starts the first track when idle', async () => {
    const bot = fakeBot('connected');
    const { item, queued, playlist } = await downloadAndEnqueue(
      prisma, bot, 'https://www.youtube.com/watch?v=abc123&list=PL123',
    );
    expect(queued).toBe(false);
    expect(playlist).toEqual({ added: 2, failed: [], total: 2 });
    expect(item.id).toBe('yt_vid1');
    expect(bot.queue.length).toBe(2);
    expect(bot.play).toHaveBeenCalledWith(expect.objectContaining({ id: 'yt_vid1' }));
  });

  it('queues all playlist tracks behind the current track when playing', async () => {
    const bot = fakeBot('playing');
    const { item, queued, playlist } = await downloadAndEnqueue(
      prisma, bot, 'https://www.youtube.com/watch?v=abc123&list=PL123',
    );
    expect(queued).toBe(true);
    expect(item.id).toBe('yt_vid1');
    expect(playlist?.added).toBe(2);
    expect(bot.play).not.toHaveBeenCalled();
    expect(bot.queue.length).toBe(2);
  });

  it('force-starts a playlist even when the bot is already playing', async () => {
    const bot = fakeBot('playing');
    const { queued } = await downloadAndEnqueue(
      prisma, bot, 'https://www.youtube.com/watch?v=abc123&list=PL123', { forceStart: true },
    );
    expect(queued).toBe(false);
    expect(bot.play).toHaveBeenCalledWith(expect.objectContaining({ id: 'yt_vid1' }));
  });
});
