import type { PrismaClient } from '../../generated/prisma/index.js';
import type { VoiceBot } from './voice-bot.js';
import type { QueueItem } from './playlist/queue.js';
import { downloadYouTube, searchYouTube, getYouTubePlaylistVideos, isYouTubePlaylistUrl, type YouTubeInfo } from './audio/youtube.js';
import { decrypt } from '../utils/crypto.js';
import {
  resolveSpotifyInput,
  type SpotifyConfig,
} from './audio/spotify.js';

export { isSpotifyUrl } from './audio/spotify.js';

export const MUSIC_DIR = process.env.MUSIC_DIR || '/data/music';

const SPOTIFY_REQUEST_TIMEOUT_MS = 10000;

/** Default number of tracks pulled from each playlist when no count is given. */
let defaultPlaylistLimit = 10;

export function setDefaultPlaylistLimit(value: number): void {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    defaultPlaylistLimit = Math.floor(value);
  }
}

function normalizePlaylistLimit(value?: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return defaultPlaylistLimit;
}

/** Active download cancellation controllers, keyed by music bot id. */
const downloadAbortControllers = new Map<number, AbortController>();

export function cancelDownloadsForBot(botId: number): boolean {
  const controller = downloadAbortControllers.get(botId);
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  downloadAbortControllers.delete(botId);
  return true;
}

function createDownloadController(botId: number): AbortController {
  const existing = downloadAbortControllers.get(botId);
  if (existing && !existing.signal.aborted) existing.abort();
  const controller = new AbortController();
  downloadAbortControllers.set(botId, controller);
  return controller;
}

function clearDownloadController(botId: number, controller: AbortController): void {
  if (downloadAbortControllers.get(botId) === controller) {
    downloadAbortControllers.delete(botId);
  }
}

export interface DownloadStatus {
  active: boolean;
  message: string;
  completed: number;
  total: number;
  failed: number;
  cancelled: boolean;
}

let downloadStatus: DownloadStatus = {
  active: false,
  message: 'Idle',
  completed: 0,
  total: 0,
  failed: 0,
  cancelled: false,
};

export function getDownloadStatus(): DownloadStatus {
  return { ...downloadStatus };
}

function setDownloadStatus(partial: Partial<DownloadStatus>): void {
  downloadStatus = { ...downloadStatus, ...partial };
}

function notify(onProgress: ((msg: string) => void) | undefined, message: string): void {
  if (onProgress) onProgress(message);
  console.log(`[MusicOps] ${message}`);
}

/** Load Spotify credentials from the DB, or null if disabled / not set. */
export async function loadSpotifyConfig(prisma: PrismaClient): Promise<(SpotifyConfig & { maxAlbumTracks: number }) | null> {
  const s = await prisma.spotifySettings.findFirst();
  if (!s?.enabled || !s.clientId || !s.clientSecret) {
    console.log('[MusicOps] Spotify not configured: missing enabled/clientId/clientSecret');
    return null;
  }
  let clientSecret: string;
  try {
    clientSecret = decrypt(s.clientSecret);
  } catch (err: any) {
    console.error(`[MusicOps] Failed to decrypt Spotify client secret: ${err.message}`);
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
  cancelled?: boolean;
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
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<SpotifyEnqueueResult> {
  const controller = createDownloadController(bot.id);
  const activeSignal = signal ?? controller.signal;

  setDownloadStatus({ active: true, message: 'Resolving Spotify link...', completed: 0, total: 0, failed: 0, cancelled: false });

  try {
    notify(onProgress, 'Resolving Spotify link...');
    const resolved = await resolveSpotifyInput(url, config);
    let tracks = resolved.tracks;
    if (resolved.type === 'album') {
      tracks = tracks.slice(0, config.maxAlbumTracks);
    } else if (resolved.type === 'playlist') {
      tracks = tracks.slice(0, normalizePlaylistLimit(playlistLimit));
    }

    notify(onProgress, `Spotify ${resolved.type}: ${resolved.name} (${tracks.length} tracks)`);
    setDownloadStatus({ message: `Spotify ${resolved.type}: ${resolved.name}`, total: tracks.length });

    const failed: string[] = [];
    const items: QueueItem[] = [];

    // Queue Spotify tracks lazily: metadata only. The YouTube search + audio
    // download happen when VoiceBot starts (or prefetches) each track.
    for (const track of tracks) {
      if (activeSignal.aborted) break;
      items.push({
        id: `sp_${track.id}`,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.durationMs ? Math.round(track.durationMs / 1000) : undefined,
        filePath: '',
        source: 'spotify',
        sourceUrl: track.spotifyUrl,
      });
    }

    if (items.length === 0) {
      throw new Error(`No tracks from Spotify playlist could be resolved${failed.length ? ` (${failed.length} failed)` : ''}`);
    }

    const firstIndex = bot.queue.length;
    bot.queue.addMany(items);
    items.forEach((item) => saveMusicRequest(prisma, bot, item));

    const firstItem = items[0];
    const shouldStart = bot.status !== 'playing' && bot.status !== 'paused';
    if (shouldStart) {
      bot.queue.playAt(firstIndex);
      await bot.playAdvancingOnError(firstItem);
    }

    setDownloadStatus({
      active: false,
      message: `Queued ${items.length} tracks (download on playback)`,
      completed: 0,
      total: items.length,
      failed: failed.length,
      cancelled: activeSignal.aborted,
    });

    return {
      type: resolved.type,
      name: resolved.name,
      added: items.length,
      total: items.length,
      failed,
      firstStarted: shouldStart,
      cancelled: activeSignal.aborted,
    };
  } finally {
    clearDownloadController(bot.id, controller);
  }
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
  /** True when the user stopped the operation before it finished. */
  cancelled?: boolean;
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
  onProgress?: (message: string) => void;
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

  const controller = createDownloadController(bot.id);
  try {
    notify(options.onProgress, `Downloading: ${url}`);
    const { filePath, info } = await downloadYouTube(url, MUSIC_DIR, controller.signal);
    const item = makeYouTubeQueueItem(info, filePath, url);

    bot.queue.add(item);
    saveMusicRequest(prisma, bot, item);

    const shouldStart = options.forceStart || (bot.status !== 'playing' && bot.status !== 'paused');
    if (!shouldStart) return { item, queued: true };

    bot.queue.playAt(bot.queue.length - 1);
    await bot.play(item);
    return { item, queued: false };
  } finally {
    clearDownloadController(bot.id, controller);
  }
}

async function enqueueYouTubePlaylist(
  prisma: PrismaClient,
  bot: VoiceBot,
  url: string,
  options: DownloadEnqueueOptions,
): Promise<PlayResult> {
  const controller = createDownloadController(bot.id);
  setDownloadStatus({ active: true, message: 'Resolving YouTube playlist...', completed: 0, total: 0, failed: 0, cancelled: false });
  try {
    notify(options.onProgress, 'Resolving YouTube playlist...');
    const videos = (await getYouTubePlaylistVideos(url, controller.signal)).slice(0, normalizePlaylistLimit(options.playlistLimit));
    if (videos.length === 0) {
      throw new Error('Could not read YouTube playlist');
    }

    notify(options.onProgress, `YouTube playlist has ${videos.length} tracks to download`);
    setDownloadStatus({ message: 'YouTube playlist', total: videos.length });

    const firstIndex = bot.queue.length;
    const failed: string[] = [];
    const items: QueueItem[] = [];

    for (const video of videos) {
      if (controller.signal.aborted) break;

      const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;
      items.push({
        id: `yt_${video.id}`,
        title: video.title || 'Unknown',
        artist: video.artist || 'Unknown',
        duration: video.duration || undefined,
        filePath: '',
        source: 'youtube',
        sourceUrl: videoUrl,
        downloadUrl: videoUrl,
      });
    }

    if (items.length === 0) {
      throw new Error('Could not read YouTube playlist');
    }

    bot.queue.addMany(items);
    items.forEach((item) => saveMusicRequest(prisma, bot, item));

    const firstItem = items[0];
    const shouldStart = options.forceStart || (bot.status !== 'playing' && bot.status !== 'paused');
    if (shouldStart) {
      bot.queue.playAt(firstIndex);
      await bot.playAdvancingOnError(firstItem);
    }

    const playlist: PlaylistEnqueueInfo = { added: items.length, failed, total: items.length };
    setDownloadStatus({
      active: false,
      message: `Queued ${items.length} tracks (download on playback)`,
      completed: 0,
      total: items.length,
      failed: failed.length,
      cancelled: controller.signal.aborted,
    });
    return { item: firstItem, queued: !shouldStart, playlist, cancelled: controller.signal.aborted };
  } finally {
    clearDownloadController(bot.id, controller);
    setDownloadStatus({ active: false });
  }
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
