import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { RETENTION_KEY, DEFAULT_RETENTION_DAYS } from '../connection-journal.js';

export const journalRoutes: Router = Router();

journalRoutes.use(requireRole('admin'));

// GET /api/journal/retention — current retention (days)
journalRoutes.get('/retention', async (req: Request, res: Response, next) => {
  try {
    const row = await req.app.locals.prisma.appSetting.findUnique({ where: { key: RETENTION_KEY } });
    res.json({ retentionDays: row ? parseInt(row.value) : DEFAULT_RETENTION_DAYS });
  } catch (err) { next(err); }
});

// PUT /api/journal/retention — set retention (days, 0 = keep all)
journalRoutes.put('/retention', async (req: Request, res: Response, next) => {
  try {
    const days = parseInt(req.body.retentionDays);
    if (isNaN(days) || days < 0 || days > 3650) throw new AppError(400, 'retentionDays must be between 0 and 3650');
    await req.app.locals.prisma.appSetting.upsert({
      where: { key: RETENTION_KEY },
      update: { value: String(days) },
      create: { key: RETENTION_KEY, value: String(days) },
    });
    res.json({ retentionDays: days });
  } catch (err) { next(err); }
});

// GET /api/journal — paginated connection log
journalRoutes.get('/', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const source = req.query.source === 'teamspeak' ? 'teamspeak' : 'web';
    const hideBots = req.query.hideBots === 'true';
    const page = Math.max(1, parseInt(String(req.query.page)) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit)) || 50));

    const where: any = { source };
    if (source === 'teamspeak' && hideBots) where.isBot = false;

    const [total, entries] = await Promise.all([
      prisma.connectionLog.count({ where }),
      prisma.connectionLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    res.json({ entries, total, page, limit });
  } catch (err) { next(err); }
});
