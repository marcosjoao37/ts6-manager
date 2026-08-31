import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { setYtDlpRateLimit } from '../voice/audio/youtube.js';
import { setDefaultPlaylistLimit } from '../voice/music-ops.js';

export const musicCommandSettingsRoutes: Router = Router();

musicCommandSettingsRoutes.use(requireRole('admin'));

async function getOrCreate(prisma: any) {
  const existing = await prisma.musicCommandSettings.findFirst();
  if (existing) return existing;
  return prisma.musicCommandSettings.create({ data: {} });
}

/** Normalise an incoming sgid value: '', null, 0 -> null; else a positive int. */
function normSgid(v: any): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// GET /api/music-command-settings
musicCommandSettingsRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const s = await getOrCreate(req.app.locals.prisma);
    setYtDlpRateLimit(s.downloadRateLimitKbps ?? null);
    setDefaultPlaylistLimit(s.defaultPlaylistSize ?? 10);
    res.json({
      musicCommandSgid: s.musicCommandSgid,
      adminCommandSgid: s.adminCommandSgid,
      notifyNowPlaying: s.notifyNowPlaying,
      botLanguage: s.botLanguage ?? 'en',
      moveBotToRequesterChannel: s.moveBotToRequesterChannel ?? false,
      audioQuality: s.audioQuality ?? 'normal',
      downloadRateLimitKbps: s.downloadRateLimitKbps ?? null,
      defaultPlaylistSize: s.defaultPlaylistSize ?? 10,
      downloadProgressEnabled: s.downloadProgressEnabled ?? false,
    });
  } catch (err) { next(err); }
});

// PUT /api/music-command-settings
musicCommandSettingsRoutes.put('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await getOrCreate(prisma);
    const { musicCommandSgid, adminCommandSgid, notifyNowPlaying, botLanguage, moveBotToRequesterChannel, audioQuality, downloadRateLimitKbps, defaultPlaylistSize, downloadProgressEnabled } = req.body;

    const data: any = {};
    if (musicCommandSgid !== undefined) data.musicCommandSgid = normSgid(musicCommandSgid);
    if (adminCommandSgid !== undefined) data.adminCommandSgid = normSgid(adminCommandSgid);
    if (notifyNowPlaying !== undefined) data.notifyNowPlaying = !!notifyNowPlaying;
    if (moveBotToRequesterChannel !== undefined) data.moveBotToRequesterChannel = !!moveBotToRequesterChannel;
    if (botLanguage !== undefined) {
      if (!['en', 'pt-BR'].includes(botLanguage)) throw new AppError(400, 'Invalid botLanguage');
      data.botLanguage = botLanguage;
    }
    if (audioQuality !== undefined) {
      if (!['normal', 'low'].includes(audioQuality)) throw new AppError(400, 'Invalid audioQuality');
      data.audioQuality = audioQuality;
    }
    if (downloadRateLimitKbps !== undefined) {
      if (downloadRateLimitKbps === null || downloadRateLimitKbps === '') {
        data.downloadRateLimitKbps = null;
      } else {
        const parsed = parseInt(String(downloadRateLimitKbps), 10);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new AppError(400, 'Invalid downloadRateLimitKbps');
        data.downloadRateLimitKbps = parsed;
      }
    }
    if (defaultPlaylistSize !== undefined) {
      const parsed = parseInt(String(defaultPlaylistSize), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new AppError(400, 'Invalid defaultPlaylistSize');
      data.defaultPlaylistSize = parsed;
    }
    if (downloadProgressEnabled !== undefined) data.downloadProgressEnabled = !!downloadProgressEnabled;

    await prisma.musicCommandSettings.update({ where: { id: current.id }, data });
    setYtDlpRateLimit(data.downloadRateLimitKbps !== undefined ? data.downloadRateLimitKbps : current.downloadRateLimitKbps ?? null);
    setDefaultPlaylistLimit(data.defaultPlaylistSize ?? current.defaultPlaylistSize ?? 10);
    res.json({ success: true });
  } catch (err) { next(err); }
});
