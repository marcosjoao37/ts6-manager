import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { AppError } from '../middleware/error-handler.js';
import { RETENTION_KEY, DEFAULT_RETENTION_DAYS } from '../connection-journal.js';
import { buildJournalQuery } from './journal-query.js';

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
    const page = Math.max(1, parseInt(String(req.query.page)) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit)) || 50));

    const { where, orderBy } = buildJournalQuery({
      source: String(req.query.source || ''),
      hideBots: String(req.query.hideBots || ''),
      login: req.query.login ? String(req.query.login) : undefined,
      ip: req.query.ip ? String(req.query.ip) : undefined,
      country: req.query.country ? String(req.query.country) : undefined,
      result: req.query.result ? String(req.query.result) : undefined,
      sort: req.query.sort ? String(req.query.sort) : undefined,
      dir: req.query.dir ? String(req.query.dir) : undefined,
    });

    const [total, entries] = await Promise.all([
      prisma.connectionLog.count({ where }),
      prisma.connectionLog.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
    ]);

    res.json({ entries, total, page, limit });
  } catch (err) { next(err); }
});
