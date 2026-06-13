import type { QueueItem } from '../voice/playlist/queue.js';

/**
 * Pure Discord embed builders (plain APIEmbed-compatible objects), kept free
 * of discord.js so they can be unit-tested.
 */

const COLORS = {
  green: 0x2ecc71,
  red: 0xe74c3c,
  blue: 0x3498db,
  purple: 0x9b59b6,
};

export interface ServerStats {
  serverName: string;
  onlineUsers: number;
  maxClients: number;
  channelCount: number;
  uptime: number; // seconds
  bandwidthIn: number; // bytes/s
  bandwidthOut: number; // bytes/s
}

export function clientConnectedEmbed(nickname: string) {
  return {
    color: COLORS.green,
    description: `🟢 **${nickname}** s'est connecté`,
    timestamp: new Date().toISOString(),
  };
}

export function clientDisconnectedEmbed(nickname: string) {
  return {
    color: COLORS.red,
    description: `🔴 **${nickname}** s'est déconnecté`,
    timestamp: new Date().toISOString(),
  };
}

/** Channel join/leave notification from a rendered message template. */
export function channelPresenceEmbed(message: string, kind: 'join' | 'leave') {
  return {
    color: kind === 'join' ? COLORS.green : COLORS.red,
    description: `${kind === 'join' ? '🟢' : '🔴'} ${message}`,
    timestamp: new Date().toISOString(),
  };
}

/** Render a notification template, substituting {user} and {channel}. */
export function renderTemplate(template: string, vars: { user: string; channel: string }): string {
  return template
    .replace(/\{\{?\s*user\s*\}?\}/gi, vars.user)
    .replace(/\{\{?\s*(channel|canal)\s*\}?\}/gi, vars.channel);
}

export const DEFAULT_JOIN_TEMPLATE = '{user} a rejoint le canal {channel} du TeamSpeak';
export const DEFAULT_LEAVE_TEMPLATE = '{user} a quitté le canal {channel} du TeamSpeak';

export function nowPlayingEmbed(botName: string, item: { title: string; artist?: string; duration?: number }) {
  const artist = item.artist && item.artist !== 'Unknown' ? `${item.artist} — ` : '';
  return {
    color: COLORS.purple,
    description: `🎵 **${botName}** joue : ${artist}**${item.title}**${item.duration ? ` \`[${formatDuration(item.duration)}]\`` : ''}`,
  };
}

export function statsEmbed(stats: ServerStats) {
  return {
    color: COLORS.blue,
    title: `📊 ${stats.serverName}`,
    fields: [
      { name: 'En ligne', value: `${stats.onlineUsers} / ${stats.maxClients}`, inline: true },
      { name: 'Canaux', value: String(stats.channelCount), inline: true },
      { name: 'Uptime', value: formatUptime(stats.uptime), inline: true },
      { name: 'Bande passante', value: `↓ ${formatBytes(stats.bandwidthIn)}/s  ↑ ${formatBytes(stats.bandwidthOut)}/s`, inline: false },
    ],
    timestamp: new Date().toISOString(),
  };
}

export function queueEmbed(items: QueueItem[], currentIndex: number) {
  if (items.length === 0) {
    return { color: COLORS.blue, description: 'La file est vide.' };
  }
  const lines = items.slice(0, 15).map((item, i) => {
    const marker = i === currentIndex ? '▶ ' : '';
    const artist = item.artist ? `${item.artist} — ` : '';
    const dur = item.duration ? ` \`[${formatDuration(item.duration)}]\`` : '';
    return `${marker}**${i + 1}.** ${artist}${item.title}${dur}`;
  });
  if (items.length > 15) lines.push(`… et ${items.length - 15} de plus`);
  return {
    color: COLORS.blue,
    title: `File d'attente (${items.length} piste${items.length > 1 ? 's' : ''})`,
    description: lines.join('\n'),
  };
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}j ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${bytes} o`;
}
