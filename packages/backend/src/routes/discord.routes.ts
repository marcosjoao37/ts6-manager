import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/rbac.js';
import { encrypt } from '../utils/crypto.js';
import type { DiscordBridge } from '../discord/discord-bridge.js';

export const discordRoutes: Router = Router();

discordRoutes.use(requireRole('admin'));

async function getOrCreateSettings(prisma: any) {
  const existing = await prisma.discordSettings.findFirst();
  if (existing) return existing;
  return prisma.discordSettings.create({ data: {} });
}

// GET /api/discord/settings — current config (token never returned)
discordRoutes.get('/settings', async (req: Request, res: Response, next) => {
  try {
    const s = await getOrCreateSettings(req.app.locals.prisma);
    res.json({
      enabled: s.enabled,
      hasToken: !!s.botToken,
      guildId: s.guildId,
      notificationsChannelId: s.notificationsChannelId,
      statsChannelId: s.statsChannelId,
      voiceChannelId: s.voiceChannelId,
      statsLiveEnabled: s.statsLiveEnabled,
      defaultMusicBotId: s.defaultMusicBotId,
      serverConfigId: s.serverConfigId,
      virtualServerId: s.virtualServerId,
    });
  } catch (err) { next(err); }
});

// PUT /api/discord/settings — update config and hot-reload the bridge
discordRoutes.put('/settings', async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const current = await getOrCreateSettings(prisma);

    const { enabled, botToken, guildId, notificationsChannelId, statsChannelId, voiceChannelId, statsLiveEnabled, defaultMusicBotId, serverConfigId, virtualServerId } = req.body;

    const data: any = {};
    if (enabled !== undefined) data.enabled = !!enabled;
    // Empty token field means "unchanged" (same convention as API keys)
    if (botToken) data.botToken = encrypt(String(botToken));
    if (guildId !== undefined) data.guildId = guildId || null;
    if (notificationsChannelId !== undefined) data.notificationsChannelId = notificationsChannelId || null;
    if (statsChannelId !== undefined) data.statsChannelId = statsChannelId || null;
    if (voiceChannelId !== undefined) data.voiceChannelId = voiceChannelId || null;
    if (statsLiveEnabled !== undefined) data.statsLiveEnabled = !!statsLiveEnabled;
    if (defaultMusicBotId !== undefined) data.defaultMusicBotId = defaultMusicBotId ? parseInt(defaultMusicBotId) : null;
    if (serverConfigId !== undefined) data.serverConfigId = serverConfigId ? parseInt(serverConfigId) : null;
    if (virtualServerId !== undefined) data.virtualServerId = parseInt(virtualServerId) || 1;

    await prisma.discordSettings.update({ where: { id: current.id }, data });

    const bridge: DiscordBridge | undefined = req.app.locals.discordBridge;
    await bridge?.reload();

    res.json({ success: true, status: bridge?.getStatus() ?? null });
  } catch (err) { next(err); }
});

// GET /api/discord/status — bridge connection state for the UI badge
discordRoutes.get('/status', (req: Request, res: Response) => {
  const bridge: DiscordBridge | undefined = req.app.locals.discordBridge;
  res.json(bridge?.getStatus() ?? { enabled: false, running: false, error: 'Bridge not initialized', guildName: null, warnings: [] });
});

// GET /api/discord/guilds — servers the bot has been invited to
discordRoutes.get('/guilds', (req: Request, res: Response) => {
  const bridge: DiscordBridge | undefined = req.app.locals.discordBridge;
  res.json(bridge?.listGuilds() ?? []);
});

// GET /api/discord/channels — text + voice channels of the configured guild
discordRoutes.get('/channels', (req: Request, res: Response) => {
  const bridge: DiscordBridge | undefined = req.app.locals.discordBridge;
  res.json(bridge?.listChannels() ?? { text: [], voice: [] });
});
