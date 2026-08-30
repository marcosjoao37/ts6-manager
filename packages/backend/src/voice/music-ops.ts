import type { PrismaClient } from '../../generated/prisma/index.js';
import type { VoiceBot } from './voice-bot.js';
import type { QueueItem } from './playlist/queue.js';
import { downloadYouTube, searchYouTube, getYouTubePlaylistVideos, isYouTubePlaylistUrl, type YouTubeInfo } from './audio/youtube.js';
import { decrypt } from '../utils/crypto.js';
import {
  resolveSpotifyInput,
  findBestYouTubeForSpotify,
  type SpotifyConfig,
} from './audio/spotify.js';

export { isSpotifyUrl } from './audio/spotify.js';

export const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';

const SPOTIFY_REQUEST_TIMEOUT_MS = 10000;

/** Default number of tracks pulled from each playlist when no count is given. */
export const DEFAULT_PLAYLIST_LIMIT = 50;

function normalizePlaylistLimit(value?: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return DEFAULT_PLAYLIST_LIMIT;
}

/** Load Spotify credentials from the DB, or null if disabled / not set. */
export async function loadSpotifyConfig(prisma: PrismaClient): Promise<(SpotifyConfig & { maxAlbumTracks: number }) | null> {
  const s = await prisma.spotifySettings.findFirst();
  if (!s?.enabled || !s.clientId || !s.clientSecret) return null;
  let clientSecret: string;
  try {
    clientSecret = decrypt(s.clientSecret);
  } catch {
    return null;
  }
  return {
    clientId: s.clientId,
    clientSecret,
    requestTimeoutMs: SPOTIFY_REQUEST_TIMEOUT_MS,
    maxAlbumTracks: Math.max(1, s.maxAlbumTracks || 50),
  };
}

export interface SpotifyEnqueueResult {
  type: 'track' | 'album' | 'playlist';
  name: string;
  added: number;
  total: number;
  failed: string[];
  firstStarted: boolean;
}

/**
 * Resolve a Spotify track/album/playlist link to metadata, match each track
 * on YouTube, and enqueue. The first track plays if the bot is idle; the rest
 * queue. Per-track failures are collected, not fatal.
 */
export async function enqueueSpotify(
  prisma: PrismaClient,
  bot: VoiceBot,
  config: SpotifyConfig & { maxAlbumTracks: number },
  url: string,
  playlistLimit?: number,
): Promise<SpotifyEnqueueResult> {
  const resolved = await resolveSpotifyInput(url, config);
  let tracks = resolved.tracks;
  if (resolved.type === 'album') {
    tracks = tracks.slice(0, config.maxAlbumTracks);
  } else if (resolved.type === 'playlist') {
    tracks = tracks.slice(0, normalizePlaylistLimit(playlistLimit));
  }

  const failed: string[] = [];
  let added = 0;
  let firstStarted = false;

  for (const track of tracks) {
    try {
      const yt = await findBestYouTubeForSpotify(track);
      const { filePath } = await downloadYouTube(`https://www.youtube.com/watch?v=${yt.id}`, MUSIC_DIR);

      const item: QueueItem = {
        id: `sp_${track.id}_${yt.id}`,
        title: track.title,
        artist: track.artist,
        duration: track.durationMs ? Math.round(track.durationMs / 1000) : undefined,
        filePath,
        source: 'youtube',
        sourceUrl: track.spotifyUrl,
      };

      bot.queue.add(item);
      saveMusicRequest(prisma, bot, item);

      if (!firstStarted && bot.status !== 'playing' && bot.status !== 'paused') {
        bot.queue.playAt(bot.queue.length - 1);
        await bot.play(item);
        firstStarted = true;
      }
      added++;
    } catch (err: any) {
      failed.push(`${track.artist} - ${track.title}: ${err.message}`);
    }
  }

  return { type: resolved.type, name: resolved.name, added, total: tracks.length, failed, firstStarted };
}

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

export interface PlaylistEnqueueInfo {
  /** Tracks that were downloaded and enqueued successfully. */
  added: number;
  /** Per-track failure descriptions for tracks that could not be added. */
  failed: string[];
  /** Total number of tracks found in the playlist. */
  total: number;
}

export interface PlayResult {
  item: QueueItem;
  /** true: added behind the current track; false: started playing right away */
  queued: boolean;
  /** Set when the URL was expanded into a YouTube playlist. */
  playlist?: PlaylistEnqueueInfo;
}

function makeYouTubeQueueItem(info: YouTubeInfo, filePath: string, url: string): QueueItem {
  return {
    id: `yt_${info.id}`,
    title: info.title,
    artist: info.artist,
    duration: info.duration,
    filePath,
    source: 'youtube',
    sourceUrl: url,
  };
}

/**
 * Download a YouTube URL, enqueue it, persist the request history, and start
 * playback unless something is already playing.
 *
 * When `url` points at a playlist (`list=` parameter), it is expanded and
 * every track is downloaded/enqueued. `forceStart` makes the first track
 * start immediately even if the bot is already playing.
 */
export type DownloadEnqueueOptions = {
  forceStart?: boolean;
  playlistLimit?: number;
};

export async function downloadAndEnqueue(
  prisma: PrismaClient,
  bot: VoiceBot,
  url: string,
  options: DownloadEnqueueOptions = {},
): Promise<PlayResult> {
  if (isYouTubePlaylistUrl(url)) {
    return enqueueYouTubePlaylist(prisma, bot, url, options);
  }

  const { filePath, info } = await downloadYouTube(url, MUSIC_DIR);
  const item = makeYouTubeQueueItem(info, filePath, url);

  bot.queue.add(item);
  saveMusicRequest(prisma, bot, item);

  const shouldStart = options.forceStart || (bot.status !== 'playing' && bot.status !== 'paused');
  if (!shouldStart) return { item, queued: true };

  bot.queue.playAt(bot.queue.length - 1);
  await bot.play(item);
  return { item, queued: false };
}

async function enqueueYouTubePlaylist(
  prisma: PrismaClient,
  bot: VoiceBot,
  url: string,
  options: DownloadEnqueueOptions,
): Promise<PlayResult> {
  const videos = (await getYouTubePlaylistVideos(url)).slice(0, normalizePlaylistLimit(options.playlistLimit));
  if (videos.length === 0) {
    throw new Error('Could not read YouTube playlist');
  }

  const firstIndex = bot.queue.length;
  const failed: string[] = [];
  let firstItem: QueueItem | null = null;
  let added = 0;

  for (const video of videos) {
    try {
      const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
      const { filePath, info } = await downloadYouTube(videoUrl, MUSIC_DIR);
      const item = makeYouTubeQueueItem(info, filePath, videoUrl);
      bot.queue.add(item);
      saveMusicRequest(prisma, bot, item);
      if (!firstItem) firstItem = item;
      added++;
    } catch (err: any) {
      failed.push(`${video.title || video.id}: ${err.message}`);
    }
  }

  if (!firstItem) {
    throw new Error(`No tracks from playlist could be downloaded${failed.length ? ` (${failed.length} failed)` : ''}`);
  }

  const playlist: PlaylistEnqueueInfo = { added, failed, total: videos.length };
  const shouldStart = options.forceStart || (bot.status !== 'playing' && bot.status !== 'paused');
  if (!shouldStart) return { item: firstItem, queued: true, playlist };

  bot.queue.playAt(firstIndex);
  await bot.play(firstItem);
  return { item: firstItem, queued: false, playlist };
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
