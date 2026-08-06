import { randomUUID } from 'crypto';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { getYouTubeUrlInfo, downloadYouTube } from './audio/youtube.js';
import { validateUrl } from '../utils/url-validator.js';
import { planImport, youtubeWatchUrl, type PlanEntry } from './playlist-import-plan.js';
import { parseImportCap, MAX_PLAYLIST_IMPORT_KEY } from '../utils/app-settings.js';
import { MUSIC_DIR } from './music-ops.js';

export interface ImportFailure {
  videoId: string;
  title: string;
  reason: string;
}

export interface ImportJob {
  jobId: string;
  status: 'running' | 'done' | 'error';
  playlistId: number | null;
  playlistName: string;
  total: number;
  done: number;
  skipped: number;
  truncated: number;
  failures: ImportFailure[];
  error: string | null;
}

export interface ImportedSong {
  id: number;
  title: string;
  artist: string | null;
  duration: number | null;
  filePath: string;
  sourceUrl: string;
}

export interface ImportRequest {
  url: string;
  serverConfigId: number;
  musicBotId?: number | null;
  /** Called after each track lands, in playlist order. Used by !play to enqueue progressively. */
  onTrack?: (song: ImportedSong, index: number) => Promise<void> | void;
}

export type StartResult =
  | { kind: 'started'; job: ImportJob }
  | { kind: 'not-a-playlist' }
  | { kind: 'busy' };

/** Jobs are kept for an hour after finishing so a slow poller still sees the result. */
const JOB_RETENTION_MS = 60 * 60 * 1000;

export class PlaylistImporter {
  private jobs = new Map<string, { job: ImportJob; finishedAt: number | null }>();
  /** One import at a time per server config — they share MUSIC_DIR and one yt-dlp rate limit. */
  private active = new Set<number>();

  constructor(private prisma: PrismaClient) {}

  get(jobId: string): ImportJob | undefined {
    this.sweep();
    return this.jobs.get(jobId)?.job;
  }

  async start(req: ImportRequest): Promise<StartResult> {
    // Bound this.jobs regardless of whether any caller ever polls get(): every
    // new import sweeps out finished jobs older than JOB_RETENTION_MS.
    this.sweep();

    if (this.active.has(req.serverConfigId)) return { kind: 'busy' };
    // Acquire the slot synchronously, before the first await. Every await
    // below yields to the event loop, and a second start() for the same
    // server config racing in during one of them must see the slot already
    // taken — checking this.active again after an await would be too late.
    this.active.add(req.serverConfigId);

    // Released on every exit path except a successful hand-off to run(),
    // which releases it itself once the background work finishes.
    let handedOff = false;
    try {
      const check = await validateUrl(req.url, { allowedProtocols: ['http:', 'https:'] });
      if (!check.valid) throw new Error(`URL blocked: ${check.error}`);

      const info = await getYouTubeUrlInfo(req.url);
      if (info.type !== 'playlist' || !info.sourceId) return { kind: 'not-a-playlist' };

      const playlist = await this.findOrCreatePlaylist(
        req.serverConfigId, info.sourceId, info.title, req.musicBotId ?? null,
      );

      const attached = await this.attachedUrls(playlist.id);
      const cap = await this.cap();
      const entries: PlanEntry[] = info.items.map((i) => ({
        id: i.id, title: i.title, url: youtubeWatchUrl(i.id),
      }));
      const plan = planImport(entries, attached, cap);

      const job: ImportJob = {
        jobId: randomUUID(),
        status: 'running',
        playlistId: playlist.id,
        playlistName: playlist.name,
        total: plan.toImport.length,
        done: 0,
        skipped: plan.alreadyPresent.length,
        truncated: plan.truncated,
        failures: [],
        error: null,
      };
      this.jobs.set(job.jobId, { job, finishedAt: null });

      // Background: the caller already has the name and the count. Handing
      // off keeps the slot held until run() (and its own error handling)
      // finishes, so the finally below must not release it too.
      handedOff = true;
      void this.run(job, plan.toImport, req)
        .catch((err: any) => {
          // run()'s per-entry try/catch already shields every track, so this
          // only fires if a future edit adds unguarded work to run(). Without
          // it the job would freeze at 'running' forever with no trace for a
          // poller — surface it instead.
          job.status = 'error';
          job.error = err?.message ? String(err.message).slice(0, 500) : 'Unknown error';
          console.error(`[PlaylistImport] job ${job.jobId} failed: ${err?.message}`, err);
        })
        .finally(() => {
          this.active.delete(req.serverConfigId);
          const entry = this.jobs.get(job.jobId);
          if (entry) entry.finishedAt = Date.now();
        });

      return { kind: 'started', job };
    } finally {
      if (!handedOff) this.active.delete(req.serverConfigId);
    }
  }

  private async run(job: ImportJob, toImport: PlanEntry[], req: ImportRequest): Promise<void> {
    for (const entry of toImport) {
      try {
        const song = await this.importOne(entry, req.serverConfigId, job.playlistId!);
        job.done++;
        if (req.onTrack) await req.onTrack(song, job.done - 1);
      } catch (err: any) {
        // Deleted, private and geo-blocked videos are routine in real
        // playlists; one of them must never abort the rest.
        job.failures.push({
          videoId: entry.id,
          title: entry.title,
          reason: err?.message ? String(err.message).slice(0, 200) : 'Unknown error',
        });
        console.warn(`[PlaylistImport] ${entry.id} failed: ${err?.message}`);
      }
    }
    job.status = 'done';
  }

  private async importOne(entry: PlanEntry, serverConfigId: number, playlistId: number): Promise<ImportedSong> {
    const { filePath, info } = await downloadYouTube(entry.url, MUSIC_DIR);

    // Reuse the library row when this URL is already known for this server, so
    // a track shared by two playlists is stored once. Not an upsert keyed on a
    // sentinel id — sourceUrl has no unique constraint, so there is no compound
    // key to upsert against.
    const existing = await this.prisma.song.findFirst({
      where: { sourceUrl: entry.url, serverConfigId },
    });
    const song = existing ?? (await this.prisma.song.create({
      data: {
        title: info.title,
        artist: info.artist,
        duration: info.duration,
        filePath,
        source: 'youtube',
        sourceUrl: entry.url,
        serverConfigId,
      },
    }));

    const maxPos = await this.prisma.playlistSong.aggregate({
      where: { playlistId },
      _max: { position: true },
    });
    await this.prisma.playlistSong.upsert({
      where: { playlistId_songId: { playlistId, songId: song.id } },
      update: {},
      create: { playlistId, songId: song.id, position: (maxPos._max.position ?? -1) + 1 },
    });

    return {
      id: song.id,
      title: song.title,
      artist: song.artist,
      duration: song.duration,
      filePath: song.filePath,
      sourceUrl: entry.url,
    };
  }

  private async findOrCreatePlaylist(
    serverConfigId: number, sourceId: string, title: string, musicBotId: number | null,
  ) {
    const existing = await this.prisma.playlist.findUnique({
      where: { serverConfigId_sourceId: { serverConfigId, sourceId } },
    });
    // An existing playlist keeps its local name: renaming it in the UI must not
    // be undone by the next import.
    if (existing) return existing;

    return this.prisma.playlist.create({
      data: { name: title, sourceId, serverConfigId, musicBotId },
    });
  }

  private async attachedUrls(playlistId: number): Promise<Set<string>> {
    const rows = await this.prisma.playlistSong.findMany({
      where: { playlistId },
      select: { song: { select: { sourceUrl: true } } },
    });
    return new Set(rows.map((r: any) => r.song.sourceUrl).filter(Boolean));
  }

  private async cap(): Promise<number> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: MAX_PLAYLIST_IMPORT_KEY } });
    return parseImportCap(row?.value);
  }

  private sweep(): void {
    const cutoff = Date.now() - JOB_RETENTION_MS;
    for (const [id, entry] of this.jobs) {
      if (entry.finishedAt !== null && entry.finishedAt < cutoff) this.jobs.delete(id);
    }
  }
}
