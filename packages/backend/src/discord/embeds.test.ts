import { describe, it, expect } from 'vitest';
import {
  clientConnectedEmbed,
  clientDisconnectedEmbed,
  nowPlayingEmbed,
  statsEmbed,
  queueEmbed,
  formatDuration,
  formatUptime,
  formatBytes,
} from './embeds.js';

describe('discord embeds', () => {
  it('connect/disconnect embeds carry the nickname', () => {
    expect(clientConnectedEmbed('Guillaume').description).toContain('**Guillaume**');
    expect(clientDisconnectedEmbed('Guillaume').description).toContain('**Guillaume**');
  });

  it('now-playing embed hides an unknown artist', () => {
    const withArtist = nowPlayingEmbed('DJ Bot', { title: 'Song', artist: 'Artist', duration: 65 });
    expect(withArtist.description).toContain('Artist — ');
    expect(withArtist.description).toContain('[1:05]');

    const noArtist = nowPlayingEmbed('DJ Bot', { title: 'Song', artist: 'Unknown' });
    expect(noArtist.description).not.toContain('Unknown');
  });

  it('stats embed exposes the four fields', () => {
    const embed = statsEmbed({
      serverName: 'My TS', onlineUsers: 5, maxClients: 32, channelCount: 12,
      uptime: 90061, bandwidthIn: 2048, bandwidthOut: 1048576,
    });
    expect(embed.title).toContain('My TS');
    expect(embed.fields.map((f) => f.value)).toEqual(
      expect.arrayContaining(['5 / 32', '12', '1j 1h 1m', '↓ 2.0 Ko/s  ↑ 1.0 Mo/s'])
    );
  });

  it('queue embed marks the current track and truncates at 15', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      id: String(i), title: `Track ${i}`, filePath: '', source: 'youtube' as const,
    }));
    const embed = queueEmbed(items, 2);
    expect(embed.description).toContain('▶ **3.** Track 2');
    expect(embed.description).toContain('… et 5 de plus');
  });

  it('formatters', () => {
    expect(formatDuration(125)).toBe('2:05');
    expect(formatUptime(3660)).toBe('1h 1m');
    expect(formatBytes(512)).toBe('512 o');
  });
});
