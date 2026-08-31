import type { PrismaClient } from '../../generated/prisma/index.js';
import type { QueueItem } from './playlist/queue.js';

export interface SavedPlaylistSummary {
  id: number;
  name: string;
  songCount: number;
  createdAt: Date;
}

async function uniquePlaylistName(prisma: PrismaClient, botId: number, baseName: string): Promise<string> {
  let candidate = baseName;
  let counter = 1;
  for (;;) {
    const existing = await prisma.playlist.findFirst({ where: { musicBotId: botId, name: candidate } });
    if (!existing) return candidate;
    candidate = `${baseName} ${counter}`;
    counter++;
  }
}

/**
 * Persist downloaded queue items as a saved playlist for later playback.
 */
export async function saveQueueItemsAsPlaylist(
  prisma: PrismaClient,
  botId: number,
  serverConfigId: number,
  userName: string,
  sourceName: string | null,
  items: QueueItem[],
): Promise<SavedPlaylistSummary | null> {
  const savable = items.filter((item) => item.filePath || item.downloadUrl);
  if (savable.length === 0) return null;

  const musicName =
    savable.find((item) => item.title && item.title !== 'Unknown')?.title ||
    savable[0]?.title ||
    'Music';

  const baseName = sourceName?.trim()
    ? `${sourceName.trim()} - ${userName}`
    : `${musicName} - playlist - ${userName}`;

  const name = await uniquePlaylistName(prisma, botId, baseName);

  const playlist = await prisma.playlist.create({
    data: { name, musicBotId: botId },
  });

  for (let i = 0; i < savable.length; i++) {
    const item = savable[i];
    const song = await prisma.song.create({
      data: {
        title: item.title,
        artist: item.artist ?? null,
        duration: item.duration ?? null,
        filePath: item.filePath || '',
        source: item.source,
        sourceUrl: item.sourceUrl ?? null,
        downloadUrl: item.downloadUrl ?? null,
        fileSize: null,
        serverConfigId,
      },
    });
    await prisma.playlistSong.create({
      data: { playlistId: playlist.id, songId: song.id, position: i },
    });
  }

  return { id: playlist.id, name: playlist.name, songCount: savable.length, createdAt: playlist.createdAt };
}

export async function listSavedPlaylists(prisma: PrismaClient, botId: number): Promise<SavedPlaylistSummary[]> {
  const playlists = await prisma.playlist.findMany({
    where: { musicBotId: botId },
    include: { _count: { select: { songs: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return playlists.map((p: any) => ({
    id: p.id,
    name: p.name,
    songCount: p._count.songs,
    createdAt: p.createdAt,
  }));
}

export async function loadSavedPlaylist(prisma: PrismaClient, playlistId: number): Promise<QueueItem[]> {
  const playlist = await prisma.playlist.findUnique({
    where: { id: playlistId },
    include: {
      songs: {
        include: { song: true },
        orderBy: { position: 'asc' },
      },
    },
  });

  if (!playlist) return [];

  return playlist.songs.map((ps: any) => ({
    id: `saved_${ps.song.id}`,
    title: ps.song.title,
    artist: ps.song.artist ?? undefined,
    duration: ps.song.duration ?? undefined,
    filePath: ps.song.filePath,
    source: (ps.song.source as QueueItem['source']) || 'local',
    sourceUrl: ps.song.sourceUrl ?? undefined,
    downloadUrl: ps.song.downloadUrl ?? undefined,
  }));
}