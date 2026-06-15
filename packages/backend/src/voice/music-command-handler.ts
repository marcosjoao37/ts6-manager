import type { PrismaClient } from '../../generated/prisma/index.js';
import { VoiceBotManager } from './voice-bot-manager.js';
import type { VoiceBot } from './voice-bot.js';
import type { QueueItem } from './playlist/queue.js';
import { downloadAndEnqueue, isSpotifyUrl, loadSpotifyConfig, enqueueSpotify } from './music-ops.js';

const CMD_PREFIX = '!';

/** Formats a number of seconds as m:ss (or h:mm:ss past an hour). */
function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${sec}`;
  return `${m}:${sec}`;
}

/** Sends a reply back to wherever the command came from (private or channel). */
type ReplyFn = (msg: string) => void;

const MUSIC_COMMANDS = new Set([
  'radio', 'play', 'spotify', 'stop', 'pause', 'skip', 'next', 'prev',
  'vol', 'volume', 'np', 'nowplaying', 'queue', 'add',
  'stream', 'stopstream', 'viewers',
  'help', 'aide', 'info',
]);

/**
 * Handles text-based music commands (!radio, !play, !stop, etc.)
 * by listening directly on each VoiceBot's TS3 connection.
 *
 * The bot receives `notifytextmessage` in its own channel —
 * no SSH EventBridge needed.
 */
export class MusicCommandHandler {
  private registeredBots = new Set<number>();

  constructor(
    private prisma: PrismaClient,
    private voiceBotManager: VoiceBotManager,
  ) {}

  /**
   * Register text message listener on a VoiceBot instance.
   * Called by VoiceBotManager whenever a bot is created/started.
   */
  registerBot(botId: number, bot: VoiceBot): void {
    if (this.registeredBots.has(botId)) return;
    this.registeredBots.add(botId);

    bot.on('textMessage', (data: Record<string, string>) => {
      this.onTextMessage(botId, bot, data).catch(err => {
        console.error(`[MusicCmd] Error processing text message on bot ${botId}: ${err.message}`);
      });
    });

    console.log(`[MusicCmd] Registered text command listener on bot ${botId}`);
  }

  unregisterBot(botId: number): void {
    this.registeredBots.delete(botId);
  }

  private async onTextMessage(botId: number, bot: VoiceBot, data: Record<string, string>): Promise<void> {
    const msg = (data.msg || '').trim();
    if (!msg.startsWith(CMD_PREFIX)) return;

    const parts = msg.substring(CMD_PREFIX.length).split(/\s+/);
    const command = parts[0].toLowerCase();
    if (!MUSIC_COMMANDS.has(command)) return;

    const args = parts.slice(1).join(' ').trim();
    const userClid = parseInt(data.invokerid || '0');
    if (!userClid) return;

    // Ignore messages from ourselves (the bot)
    if (userClid === bot.ts3ClientId) return;

    // Reply where we were asked: privately to a private message (targetmode 1),
    // in the channel to a channel message (targetmode 2).
    const inChannel = String(data.targetmode || '') === '2';
    const reply: ReplyFn = (m: string) => {
      try {
        if (inChannel) bot.sendChannelMessage(m);
        else bot.sendTextMessage(userClid, m);
      } catch (err: any) {
        console.error(`[MusicCmd] Failed to send reply: ${err.message}`);
      }
    };

    console.log(`[MusicCmd] Bot ${botId}: !${command} ${args} (from clid=${userClid}, ${inChannel ? 'channel' : 'private'})`);

    try {
      switch (command) {
        case 'radio':
          await this.handleRadio(botId, bot, reply, args);
          break;
        case 'play':
          await this.handlePlay(bot, reply, args);
          break;
        case 'spotify':
          await this.handleSpotify(bot, reply, args);
          break;
        case 'stop':
          this.handleStop(bot, reply);
          break;
        case 'pause':
          this.handlePause(bot, reply);
          break;
        case 'skip':
        case 'next':
          await this.handleSkip(bot, reply);
          break;
        case 'prev':
          await this.handlePrev(bot, reply);
          break;
        case 'vol':
        case 'volume':
          this.handleVolume(bot, reply, args);
          break;
        case 'np':
        case 'nowplaying':
          this.handleNowPlaying(bot, reply);
          break;
        case 'queue':
        case 'add':
          await this.handleQueue(bot, reply, args);
          break;
        case 'stream':
          await this.handleStream(bot, reply, args);
          break;
        case 'stopstream':
          await this.handleStopStream(bot, reply);
          break;
        case 'viewers':
          this.handleViewers(bot, reply);
          break;
        case 'help':
        case 'aide':
          this.handleHelp(reply);
          break;
        case 'info':
          this.handleInfo(bot, reply);
          break;
      }
    } catch (err: any) {
      console.error(`[MusicCmd] Error handling !${command}: ${err.message}`);
      reply(`Error: ${err.message}`);
    }
  }

  // ─── Command Handlers ───────────────────────────────────────

  private async handleRadio(botId: number, bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    // Get serverConfigId for this bot from DB
    const dbBot = await this.prisma.musicBot.findUnique({ where: { id: botId }, select: { serverConfigId: true } });
    if (!dbBot) {
      reply('Bot config not found.');
      return;
    }

    const stations = await this.prisma.radioStation.findMany({
      where: { serverConfigId: dbBot.serverConfigId },
      orderBy: { name: 'asc' },
    });

    if (stations.length === 0) {
      reply('No radio stations configured.');
      return;
    }

    // No argument — list stations
    if (!args) {
      const lines = stations.map((s: any) => `[${s.id}] ${s.name}${s.genre ? ` (${s.genre})` : ''}`);
      reply('Radio Stations:\n' + lines.join('\n'));
      return;
    }

    // Argument — play station by ID
    const stationId = parseInt(args);
    if (isNaN(stationId)) {
      reply('Usage: !radio <id> — Use !radio to list stations.');
      return;
    }

    const station = stations.find((s: any) => s.id === stationId);
    if (!station) {
      reply(`Station #${stationId} not found. Use !radio to list stations.`);
      return;
    }

    const queueItem: QueueItem = {
      id: `radio_${station.id}`,
      title: station.name,
      artist: station.genre ?? 'Radio',
      filePath: '',
      source: 'radio',
      streamUrl: station.url,
    };

    await bot.playStream(queueItem);
    reply(`Now playing: ${station.name}`);
  }

  private async handlePlay(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    if (!args) {
      if (bot.status === 'paused') {
        bot.resume();
        reply('Resumed.');
        return;
      }
      reply('Usage: !play <youtube-url | lien Spotify>');
      return;
    }

    // Spotify links are metadata-only: delegate to the Spotify→YouTube path
    if (isSpotifyUrl(args)) {
      await this.handleSpotify(bot, reply, args);
      return;
    }

    if (!args.startsWith('http://') && !args.startsWith('https://')) {
      reply('Please provide a valid URL. Usage: !play <youtube-url | lien Spotify>');
      return;
    }

    reply('Loading...');

    try {
      const { item, queued } = await downloadAndEnqueue(this.prisma, bot, args);
      if (queued) {
        reply(`Queued: ${item.artist} - ${item.title} (position #${bot.queue.length})`);
      } else {
        reply(`Now playing: ${item.artist} - ${item.title}`);
      }
    } catch (err: any) {
      reply(`Failed to play: ${err.message}`);
    }
  }

  private async handleSpotify(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    if (!args) {
      reply('Usage: !spotify <lien-track-ou-album-spotify>');
      return;
    }

    const config = await loadSpotifyConfig(this.prisma);
    if (!config) {
      reply('Spotify non configuré (Settings → Spotify).');
      return;
    }

    reply('Résolution du lien Spotify...');

    try {
      const result = await enqueueSpotify(this.prisma, bot, config, args);
      if (result.type === 'album') {
        reply(`Album "${result.name}" : ${result.added}/${result.total} piste(s) ajoutée(s).`);
      } else if (result.added > 0) {
        reply(result.firstStarted ? `Now playing: ${result.name}` : `Queued: ${result.name}`);
      } else {
        reply(`Échec : ${result.failed[0] || 'aucune piste ajoutée'}`);
      }
    } catch (err: any) {
      reply(`Échec Spotify : ${err.message}`);
    }
  }

  private showQueue(bot: VoiceBot, reply: ReplyFn): void {
    const items = bot.queue.getAll();
    if (items.length === 0) {
      reply('Queue is empty.');
      return;
    }

    const currentIdx = bot.queue.index;
    const lines = items.slice(0, 15).map((item, i) => {
      const marker = i === currentIdx ? '▶ ' : '  ';
      const artist = item.artist ? `${item.artist} - ` : '';
      const dur = item.duration ? ` [${Math.floor(item.duration / 60)}:${String(Math.floor(item.duration % 60)).padStart(2, '0')}]` : '';
      return `${marker}${i + 1}. ${artist}${item.title}${dur}`;
    });
    if (items.length > 15) lines.push(`  ... and ${items.length - 15} more`);
    reply(`Queue (${items.length} tracks):\n${lines.join('\n')}`);
  }

  private async handleQueue(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    // No args or "show" — display current queue
    if (!args || args.toLowerCase() === 'show') {
      this.showQueue(bot, reply);
      return;
    }

    // !queue remove <index>
    if (args.toLowerCase().startsWith('remove ')) {
      const idx = parseInt(args.substring(7).trim()) - 1; // 1-based to 0-based
      const items = bot.queue.getAll();
      if (isNaN(idx) || idx < 0 || idx >= items.length) {
        reply(`Invalid index. Queue has ${items.length} tracks.`);
        return;
      }
      const removed = items[idx];
      bot.queue.remove(removed.id);
      reply(`Removed #${idx + 1}: ${removed.title}`);
      return;
    }

    // !queue play <index>
    if (args.toLowerCase().startsWith('play ')) {
      const idx = parseInt(args.substring(5).trim()) - 1; // 1-based to 0-based
      const item = bot.queue.playAt(idx);
      if (!item) {
        reply(`Invalid index. Queue has ${bot.queue.length} tracks.`);
        return;
      }
      if (item.streamUrl) {
        await bot.playStream(item);
      } else {
        await bot.play(item);
      }
      reply(`Playing #${idx + 1}: ${item.title}`);
      return;
    }

    // !queue clear
    if (args.toLowerCase() === 'clear') {
      bot.queue.clear();
      reply('Queue cleared.');
      return;
    }

    // URL provided — add to queue without interrupting
    if (!args.startsWith('http://') && !args.startsWith('https://')) {
      reply('Usage: !queue [show|play <n>|remove <n>|clear|<url>]');
      return;
    }

    reply('Loading...');

    try {
      const { item, queued } = await downloadAndEnqueue(this.prisma, bot, args);
      if (queued) {
        reply(`Queued: ${item.artist} - ${item.title} (position #${bot.queue.length})`);
      } else {
        reply(`Now playing: ${item.artist} - ${item.title}`);
      }
    } catch (err: any) {
      reply(`Failed to queue: ${err.message}`);
    }
  }

  private handleStop(bot: VoiceBot, reply: ReplyFn): void {
    bot.stopAudio();
    reply('Playback stopped.');
  }

  private handlePause(bot: VoiceBot, reply: ReplyFn): void {
    if (bot.status === 'paused') {
      bot.resume();
      reply('Resumed.');
    } else if (bot.status === 'playing') {
      bot.pause();
      reply('Paused.');
    } else {
      reply('Nothing is playing.');
    }
  }

  private async handleSkip(bot: VoiceBot, reply: ReplyFn): Promise<void> {
    const next = bot.queue.next();
    if (next) {
      if (next.streamUrl) {
        await bot.playStream(next);
      } else {
        await bot.play(next);
      }
      reply(`Skipped to: ${next.title}`);
    } else {
      bot.stopAudio();
      reply('Queue empty — playback stopped.');
    }
  }

  private async handlePrev(bot: VoiceBot, reply: ReplyFn): Promise<void> {
    const prev = bot.queue.previous();
    if (prev) {
      if (prev.streamUrl) {
        await bot.playStream(prev);
      } else {
        await bot.play(prev);
      }
      reply(`Previous: ${prev.title}`);
    } else {
      reply('No previous track.');
    }
  }

  private handleVolume(bot: VoiceBot, reply: ReplyFn, args: string): void {
    if (!args) {
      const vol = bot.currentConfig.volume;
      reply(`Volume: ${vol}%`);
      return;
    }

    const vol = parseInt(args);
    if (isNaN(vol) || vol < 0 || vol > 100) {
      reply('Usage: !vol <0-100>');
      return;
    }

    bot.setVolume(vol);
    reply(`Volume set to ${vol}%.`);
  }

  private handleNowPlaying(bot: VoiceBot, reply: ReplyFn): void {
    const np = bot.nowPlaying;
    if (!np) {
      reply('Nothing is playing.');
      return;
    }

    const artist = np.artist ? `${np.artist} - ` : '';
    const lines = [`Now playing: ${artist}${np.title}`];

    const progress = this.formatProgress(bot);
    if (progress) lines.push(progress);

    reply(lines.join('\n'));
  }

  /**
   * Builds a textual progress indicator for the current track, e.g.
   *   1:07 ▬▬▬▬▬▬●▬▬▬▬▬▬▬▬▬▬▬ 3:42
   * Returns null when there's nothing playing. For live streams (no known
   * duration) only the elapsed time is shown.
   */
  private formatProgress(bot: VoiceBot): string | null {
    const p = bot.playbackProgress;
    if (!p) return null;

    const pos = Math.max(0, Math.floor(p.position));

    // Live stream / unknown duration — just the elapsed time.
    if (!p.duration || p.duration <= 0) {
      return `⏱ ${formatTime(pos)} (en direct)`;
    }

    const dur = Math.floor(p.duration);
    const ratio = Math.min(1, pos / dur);
    const barLen = 18;
    const filled = Math.round(ratio * (barLen - 1));
    const bar = '▬'.repeat(filled) + '●' + '▬'.repeat(barLen - 1 - filled);
    return `${formatTime(pos)} ${bar} ${formatTime(dur)}`;
  }

  private handleInfo(bot: VoiceBot, reply: ReplyFn): void {
    const np = bot.nowPlaying;
    if (!np) {
      reply('Aucune musique en cours de lecture.');
      return;
    }

    const lines: string[] = ['♪ Musique en cours :'];
    lines.push(`  Titre  : ${np.title}`);
    if (np.artist) lines.push(`  Artiste: ${np.artist}`);

    if (np.duration) {
      const min = Math.floor(np.duration / 60);
      const sec = String(Math.floor(np.duration % 60)).padStart(2, '0');
      lines.push(`  Durée  : ${min}:${sec}`);
    }

    const progress = this.formatProgress(bot);
    if (progress) lines.push(`  Progression : ${progress}`);

    // Lien direct vers la source (YouTube/Spotify via sourceUrl, radio via streamUrl)
    const link = np.sourceUrl || np.streamUrl;
    if (link) lines.push(`  Lien   : [URL]${link}[/URL]`);

    reply(lines.join('\n'));
  }

  private handleHelp(reply: ReplyFn): void {
    reply([
      'Commandes musicales disponibles :',
      '  !play <url>          Lire une vidéo YouTube ou un lien Spotify',
      '  !spotify <lien>      Lire une piste/album Spotify',
      '  !radio [id]          Lister les radios ou en lancer une',
      '  !queue [..]          Voir/gérer la file (show|play <n>|remove <n>|clear|<url>)',
      '  !add <url>           Ajouter une piste à la file',
      '  !skip / !next        Piste suivante',
      '  !prev                Piste précédente',
      '  !pause               Mettre en pause / reprendre',
      '  !stop                Arrêter la lecture',
      '  !vol <0-100>         Régler ou afficher le volume',
      '  !np / !nowplaying    Titre en cours de lecture',
      '  !info                Détails du titre en cours (artiste, titre, lien direct)',
      '  !stream <url> [qual] Diffuser une vidéo (presets : 480p, 720p, 1080p)',
      '  !stopstream          Arrêter la diffusion vidéo',
      '  !viewers             Lister les spectateurs du stream vidéo',
      '  !help / !aide        Afficher cette aide',
    ].join('\n'));
  }

  // ─── Video Streaming Commands ─────────────────────────────

  private async handleStream(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    if (!args) {
      reply('Usage: !stream <url> [preset]  — Presets: 480p, 720p, 1080p');
      return;
    }

    const parts = args.split(/\s+/);
    const url = parts[0];
    const preset = parts[1] || undefined;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      reply('Please provide a valid URL.');
      return;
    }

    if (bot.videoStreaming) {
      // Change source if already streaming
      try {
        await bot.setVideoSource(url);
        reply(`Stream source changed to: ${url}`);
      } catch (err: any) {
        reply(`Error: ${err.message}`);
      }
      return;
    }

    reply('Starting video stream...');
    try {
      await bot.startVideoStream(url, preset);
      reply(`Video stream started: ${url}`);
    } catch (err: any) {
      reply(`Failed to start stream: ${err.message}`);
    }
  }

  private async handleStopStream(bot: VoiceBot, reply: ReplyFn): Promise<void> {
    if (!bot.videoStreaming) {
      reply('No active video stream.');
      return;
    }
    await bot.stopVideoStream();
    reply('Video stream stopped.');
  }

  private handleViewers(bot: VoiceBot, reply: ReplyFn): void {
    const status = bot.videoStreamStatus;
    if (!status.streaming) {
      reply('No active video stream.');
      return;
    }
    if (status.viewers.length === 0) {
      reply('No viewers connected.');
      return;
    }
    const lines = status.viewers.map((v) => {
      const duration = Math.floor((Date.now() - v.joinedAt) / 1000);
      return `  clid=${v.clid} (${duration}s)`;
    });
    reply(`Viewers (${status.viewerCount}):\n${lines.join('\n')}`);
  }

}
