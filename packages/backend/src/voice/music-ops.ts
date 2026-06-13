import type { PrismaClient } from '../../generated/prisma/index.js';
import type { VoiceBot } from './voice-bot.js';
import type { QueueItem } from './playlist/queue.js';
import { downloadYouTube, searchYouTube } from './audio/youtube.js';

export const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';

/**
 * Transport-agnostic music operations shared by the TS chat commands
 * (!play) and the Discord slash commands (/play).
 */

/** URL passthrough, or YouTube search → URL of the first result. */
export async function resolvePlayQuery(query: string): Promise<string> {
  const q = query.trim();
  if (q.startsWith('http://') || q.startsWith('https://')) return q;
  const results = await searchYouTube(q, 1);
  if (results.length === 0 || !results[0].id) {
    throw new Error(`No YouTube result for "${q}"`);
  }
  return `https://www.youtube.com/watch?v=${results[0].id}`;
}

export interface PlayResult {
  item: QueueItem;
  /** true: added behind the current track; false: started playing right away */
  queued: boolean;
}

/**
 * Download a YouTube URL, enqueue it, persist the request history, and start
 * playback unless something is already playing.
 */
export async function downloadAndEnqueue(prisma: PrismaClient, bot: VoiceBot, url: string): Promise<PlayResult> {
  const { filePath, info } = await downloadYouTube(url, MUSIC_DIR);

  const item: QueueItem = {
    id: `yt_${info.id}`,
    title: info.title,
    artist: info.artist,
    duration: info.duration,
    filePath,
    source: 'youtube',
    sourceUrl: url,
  };

  bot.queue.add(item);
  saveMusicRequest(prisma, bot, item);

  if (bot.status === 'playing' || bot.status === 'paused') {
    return { item, queued: true };
  }

  bot.queue.playAt(bot.queue.length - 1);
  await bot.play(item);
  return { item, queued: false };
}

/** Fire-and-forget history entry (one row per server+url, refreshed on replay). */
export function saveMusicRequest(prisma: PrismaClient, bot: VoiceBot, item: QueueItem): void {
  if (!item.sourceUrl || !bot.currentConfig.serverConfigId) return;
  prisma.musicRequest.upsert({
    where: {
      serverConfigId_url: {
        serverConfigId: bot.currentConfig.serverConfigId,
        url: item.sourceUrl,
      },
    },
    update: {
      requestedAt: new Date(),
      title: item.title || 'Unknown Title',
    },
    create: {
      serverConfigId: bot.currentConfig.serverConfigId,
      url: item.sourceUrl,
      title: item.title || 'Unknown Title',
      requestedAt: new Date(),
    },
  }).catch((err: any) => {
    console.error('[MusicOps] Failed to save music request history:', err.message);
  });
}
