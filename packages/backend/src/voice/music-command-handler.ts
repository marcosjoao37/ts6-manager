import type { PrismaClient } from '../../generated/prisma/index.js';
import { VoiceBotManager } from './voice-bot-manager.js';
import type { VoiceBot } from './voice-bot.js';
import type { QueueItem } from './playlist/queue.js';
import { downloadAndEnqueue, isSpotifyUrl, loadSpotifyConfig, enqueueSpotify, cancelDownloadsForBot, getDownloadStatus } from './music-ops.js';
import { saveQueueItemsAsPlaylist, listSavedPlaylists, loadSavedPlaylist } from './saved-playlists.js';
import { setYtDlpRateLimit } from './audio/youtube.js';
import { setDefaultPlaylistLimit } from './music-ops.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import type { WebQueryClient } from '../ts-client/webquery-client.js';
import { requiredSgid, parseServerGroupIds, type MusicCommandAccessSettings } from './music-command-access.js';
import { botMessages, isBotLanguage, type BotLanguage, type BotMessages } from './music-bot-messages.js';
import { isMusicAudioQuality, type MusicAudioQuality } from './audio-presets.js';

const CMD_PREFIX = '!';

/**
 * Splits a command argument string into tokens, honouring single and double
 * quotes so channel/user names containing spaces can be passed as one token
 * (e.g. `!move "John Doe" "Salon de jeu"`). Unquoted runs split on whitespace.
 */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return tokens;
}

/** Formats a number of seconds as m:ss (or h:mm:ss past an hour). */
function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${sec}`;
  return `${m}:${sec}`;
}

/** Parses `!play <url> [count]` into the URL and the optional track limit. */
function parseCommandUrlAndCount(args: string): { url: string; count?: number } {
  const tokens = tokenizeArgs(args);
  const url = tokens[0] ?? '';
  const count = tokens.length > 1 ? parseInt(tokens[1], 10) : undefined;
  return {
    url,
    count: typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : undefined,
  };
}

/** Sends a reply back to wherever the command came from (private or channel). */
type ReplyFn = (msg: string) => void;

const MUSIC_COMMANDS = new Set([
  'radio', 'play', 'spotify', 'stop', 'pause', 'skip', 'next', 'prev',
  'vol', 'volume', 'np', 'nowplaying', 'queue', 'add',
  'stream', 'stopstream', 'viewers',
  'move', 'moveall', 'channels', 'notif',
  'stopdl', 'stopdownload', 'cancel', 'playlist',
  'downloadstatus', 'dlstatus',
  'saved', 'savedplay',
  'help', 'aide', 'info',
]);

interface MusicCommandSettingsRow extends MusicCommandAccessSettings {
  notifyNowPlaying: boolean;
  botLanguage: BotLanguage;
  moveBotToRequesterChannel: boolean;
  audioQuality: MusicAudioQuality;
  downloadRateLimitKbps: number | null;
  defaultPlaylistSize: number;
  downloadProgressEnabled: boolean;
}

/**
 * Handles text-based music commands (!radio, !play, !stop, etc.)
 * by listening directly on each VoiceBot's TS3 connection.
 *
 * The bot receives `notifytextmessage` in its own channel —
 * no SSH EventBridge needed.
 */
export class MusicCommandHandler {
  private registeredBots = new Set<number>();
  // Maps a music bot to the virtual server id (sid) of the TS server it sits
  // on, resolved once from its voice port via serveridgetbyport.
  private sidCache = new Map<number, number>();
  // Short-lived cache of the global MusicCommandSettings row. WebUI edits are
  // picked up within the TTL; !notif invalidates it immediately.
  private settingsCache: { at: number; value: MusicCommandSettingsRow } | null = null;
  private static readonly SETTINGS_TTL_MS = 5000;
  // nowPlaying listeners, kept so they can be detached in unregisterBot.
  private nowPlayingListeners = new Map<number, { bot: VoiceBot; listener: (item: QueueItem) => void }>();
  // Messages for the currently configured bot response language. Updated on
  // every command after the (cached) settings row is loaded.
  private messages: BotMessages = botMessages.en;
  private downloadProgressEnabled = false;

  constructor(
    private prisma: PrismaClient,
    private voiceBotManager: VoiceBotManager,
    private connectionPool: ConnectionPool,
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

    const npListener = (item: QueueItem) => {
      this.onNowPlaying(bot, item).catch((err) =>
        console.error(`[MusicCmd] now-playing notif failed on bot ${botId}: ${err.message}`));
    };
    bot.on('nowPlaying', npListener);
    this.nowPlayingListeners.set(botId, { bot, listener: npListener });

    console.log(`[MusicCmd] Registered text command listener on bot ${botId}`);
  }

  unregisterBot(botId: number): void {
    this.registeredBots.delete(botId);
    const entry = this.nowPlayingListeners.get(botId);
    if (entry) {
      entry.bot.off('nowPlaying', entry.listener);
      this.nowPlayingListeners.delete(botId);
    }
  }

  private async onTextMessage(botId: number, bot: VoiceBot, data: Record<string, string>): Promise<void> {
    const msg = (data.msg || '').trim();
    if (!msg.startsWith(CMD_PREFIX)) return;

    const parts = msg.substring(CMD_PREFIX.length).split(/\s+/);
    const command = parts[0].toLowerCase();
    if (!MUSIC_COMMANDS.has(command)) return;

    const args = parts.slice(1).join(' ').trim();
    const userClid = parseInt(data.invokerid || '0');
    const userName = String(data.invokername || data.invokeruid || userClid || 'unknown');
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

    // Access control: music vs admin tier, gated by configured server groups.
    if (!(await this.checkAccess(botId, command, userClid, reply))) return;

    // Acknowledge immediately for slow commands so the user gets a response
    // before any DB lookups, bot channel moves, or downloads.
    if (this.shouldAckLoading(command, args)) reply(this.messages.loading);

    // Apply runtime audio quality/buffer settings before any playback command.
    const settings = await this.getSettings();
    bot.setAudioQuality(settings.audioQuality);
    setYtDlpRateLimit(settings.downloadRateLimitKbps ?? null);
    setDefaultPlaylistLimit(settings.defaultPlaylistSize);
    this.downloadProgressEnabled = settings.downloadProgressEnabled;

    // Optionally move the bot to the channel of the user that issued the command.
    await this.maybeMoveBotToRequesterChannel(botId, bot, command, args, userClid);

    try {
      switch (command) {
        case 'radio':
          await this.handleRadio(botId, bot, reply, args);
          break;
        case 'play':
          await this.handlePlay(bot, reply, args, userName);
          break;
        case 'spotify':
          await this.handleSpotify(bot, reply, args, undefined, userName);
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
          await this.handleQueue(bot, reply, args, userName);
          break;
        case 'playlist':
          this.showQueue(bot, reply);
          break;
        case 'downloadstatus':
        case 'dlstatus':
          this.handleDownloadStatus(reply);
          break;
        case 'saved':
          await this.handleSavedPlaylists(bot, reply);
          break;
        case 'savedplay':
          await this.handleSavedPlay(bot, reply, args);
          break;
        case 'stopdl':
        case 'stopdownload':
        case 'cancel':
          await this.handleStopDownload(botId, reply);
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
        case 'channels':
          await this.handleChannels(botId, reply);
          break;
        case 'move':
          await this.handleMove(botId, reply, args);
          break;
        case 'moveall':
          await this.handleMoveAll(botId, bot, reply, args);
          break;
        case 'notif':
          await this.handleNotif(reply);
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
      reply(this.messages.error(err.message));
    }
  }

  // ─── Command Handlers ───────────────────────────────────────

  private async handleRadio(botId: number, bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    // Get serverConfigId for this bot from DB
    const dbBot = await this.prisma.musicBot.findUnique({ where: { id: botId }, select: { serverConfigId: true } });
    if (!dbBot) {
      reply(this.messages.botConfigNotFound);
      return;
    }

    const stations = await this.prisma.radioStation.findMany({
      where: { serverConfigId: dbBot.serverConfigId },
      orderBy: { name: 'asc' },
    });

    if (stations.length === 0) {
      reply(this.messages.noRadioStations);
      return;
    }

    // No argument — list stations
    if (!args) {
      const lines = stations.map((s: any) => `[${s.id}] ${s.name}${s.genre ? ` (${s.genre})` : ''}`);
      reply(this.messages.radioListHeader + '\n' + lines.join('\n'));
      return;
    }

    // Argument — play station by ID
    const stationId = parseInt(args);
    if (isNaN(stationId)) {
      reply(this.messages.radioUsage);
      return;
    }

    const station = stations.find((s: any) => s.id === stationId);
    if (!station) {
      reply(this.messages.stationNotFound(stationId));
      return;
    }

    const queueItem: QueueItem = {
      id: `radio_${station.id}`,
      title: station.name,
      artist: station.genre ?? this.messages.radioGenreFallback,
      filePath: '',
      source: 'radio',
      streamUrl: station.url,
    };

    await bot.playStream(queueItem);
    reply(this.messages.nowPlayingRadio(station.name));
  }

  private async handlePlay(bot: VoiceBot, reply: ReplyFn, args: string, userName?: string): Promise<void> {
    if (!args) {
      if (bot.status === 'paused') {
        bot.resume();
        reply(this.messages.resumed);
        return;
      }
      reply(this.messages.playUsage);
      return;
    }

    const { url, count } = parseCommandUrlAndCount(args);

    // Spotify links are metadata-only: delegate to the Spotify→YouTube path
    if (isSpotifyUrl(url)) {
      await this.handleSpotify(bot, reply, url, count, userName);
      return;
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      reply(this.messages.invalidUrlUsage);
      return;
    }

    const queueStart = bot.queue.length;
    try {
      const result = await downloadAndEnqueue(this.prisma, bot, url, {
        playlistLimit: count,
        onProgress: this.downloadProgressEnabled ? (message) => reply(message) : undefined,
      });
      if (result.cancelled) {
        reply(this.messages.downloadCancelled);
        return;
      }
      if (result.playlist) {
        reply(result.queued
          ? this.messages.playlistQueued(result.playlist.added, result.playlist.total, result.playlist.failed.length)
          : this.messages.playlistNowPlaying(result.playlist.added, result.playlist.total, result.playlist.failed.length));

        const newItems = bot.queue.getAll().slice(queueStart);
        const serverConfigId = bot.currentConfig.serverConfigId;
        if (serverConfigId && userName && newItems.length > 0) {
          try {
            const saved = await saveQueueItemsAsPlaylist(
              this.prisma, bot.id, serverConfigId, userName, null, newItems,
            );
            if (saved) reply(this.messages.savedPlaylistSaved(saved.name, saved.songCount));
          } catch (err: any) {
            console.error(`[MusicCmd] Failed to save playlist: ${err.message}`);
          }
        }
      } else if (result.queued) {
        reply(this.messages.queued(result.item.artist ?? '', result.item.title, bot.queue.length));
      } else {
        reply(this.messages.nowPlaying(result.item.artist ?? '', result.item.title));
      }
    } catch (err: any) {
      reply(this.messages.failedToPlay(err.message));
    }
  }

  private async handleSpotify(bot: VoiceBot, reply: ReplyFn, args: string, limit?: number, userName?: string): Promise<void> {
    if (!args) {
      reply(this.messages.spotifyUsage);
      return;
    }

    const config = await loadSpotifyConfig(this.prisma);
    if (!config) {
      reply(this.messages.spotifyNotConfigured);
      return;
    }

    const queueStart = bot.queue.length;
    try {
      const result = await enqueueSpotify(
        this.prisma,
        bot,
        config,
        args,
        limit,
        undefined,
        this.downloadProgressEnabled ? (message) => reply(message) : undefined,
      );
      if (result.cancelled) {
        reply(this.messages.downloadCancelled);
        return;
      }
      if (result.type === 'album') {
        reply(this.messages.spotifyAlbum(result.name, result.added, result.total));
      } else if (result.type === 'playlist') {
        reply(this.messages.spotifyPlaylist(result.name, result.added, result.total));
      } else if (result.added > 0) {
        reply(result.firstStarted ? this.messages.spotifyNowPlaying(result.name) : this.messages.spotifyQueued(result.name));
      } else {
        reply(this.messages.spotifyFailure(result.failed[0]));
      }

      if (result.type === 'album' || result.type === 'playlist') {
        const newItems = bot.queue.getAll().slice(queueStart);
        const serverConfigId = bot.currentConfig.serverConfigId;
        if (serverConfigId && userName && newItems.length > 0) {
          try {
            const saved = await saveQueueItemsAsPlaylist(
              this.prisma, bot.id, serverConfigId, userName, result.name, newItems,
            );
            if (saved) reply(this.messages.savedPlaylistSaved(saved.name, saved.songCount));
          } catch (err: any) {
            console.error(`[MusicCmd] Failed to save Spotify playlist: ${err.message}`);
          }
        }
      }
    } catch (err: any) {
      reply(this.messages.spotifyFailed(err.message));
    }
  }

  private showQueue(bot: VoiceBot, reply: ReplyFn): void {
    const items = bot.queue.getAll();
    if (items.length === 0) {
      reply(this.messages.queueEmpty);
      return;
    }

    // List every remaining track, from the current one to the end. Message
    // chunks keep each reply under the TeamSpeak send-message size limit.
    const currentIdx = Math.max(0, Math.min(bot.queue.index, items.length - 1));
    const lines: string[] = [];
    for (let i = currentIdx; i < items.length; i++) {
      const item = items[i];
      const marker = i === currentIdx ? '▶ ' : '  ';
      const artist = item.artist ? `${item.artist} - ` : '';
      const dur = item.duration ? ` [${Math.floor(item.duration / 60)}:${String(Math.floor(item.duration % 60)).padStart(2, '0')}]` : '';
      lines.push(`${marker}${i + 1}. ${artist}${item.title}${dur}`);
    }

    const header = this.messages.queueHeader(items.length);
    let buf = header;
    for (const line of lines) {
      if (buf.length + 1 + line.length > 900) {
        reply(buf);
        buf = line;
      } else {
        buf += '\n' + line;
      }
    }
    if (buf) reply(buf);
  }

  private async handleQueue(bot: VoiceBot, reply: ReplyFn, args: string, userName?: string): Promise<void> {
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
        reply(this.messages.invalidQueueIndex(items.length));
        return;
      }
      const removed = items[idx];
      bot.queue.remove(removed.id);
      reply(this.messages.removedTrack(idx + 1, removed.title));
      return;
    }

    // !queue play <index>
    if (args.toLowerCase().startsWith('play ')) {
      const idx = parseInt(args.substring(5).trim()) - 1; // 1-based to 0-based
      const item = bot.queue.playAt(idx);
      if (!item) {
        reply(this.messages.invalidQueueIndex(bot.queue.length));
        return;
      }
      if (item.streamUrl) {
        await bot.playStream(item);
      } else {
        await bot.playAdvancingOnError(item);
      }
      reply(this.messages.playingIndex(idx + 1, item.title));
      return;
    }

    // !queue clear
    if (args.toLowerCase() === 'clear') {
      bot.queue.clear();
      reply(this.messages.queueCleared);
      return;
    }

    // Spotify links are metadata-only: resolve through the Spotify path
    if (isSpotifyUrl(args)) {
      await this.handleSpotify(bot, reply, args, undefined, userName);
      return;
    }

    // URL provided — add to queue without interrupting
    if (!args.startsWith('http://') && !args.startsWith('https://')) {
      reply(this.messages.queueUsage);
      return;
    }

    const queueStart = bot.queue.length;
    try {
      const result = await downloadAndEnqueue(this.prisma, bot, args, {
        onProgress: this.downloadProgressEnabled ? (message) => reply(message) : undefined,
      });
      if (result.cancelled) {
        reply(this.messages.downloadCancelled);
        return;
      }
      if (result.playlist) {
        reply(result.queued
          ? this.messages.playlistQueued(result.playlist.added, result.playlist.total, result.playlist.failed.length)
          : this.messages.playlistNowPlaying(result.playlist.added, result.playlist.total, result.playlist.failed.length));

        const newItems = bot.queue.getAll().slice(queueStart);
        const serverConfigId = bot.currentConfig.serverConfigId;
        if (serverConfigId && userName && newItems.length > 0) {
          try {
            const saved = await saveQueueItemsAsPlaylist(
              this.prisma, bot.id, serverConfigId, userName, null, newItems,
            );
            if (saved) reply(this.messages.savedPlaylistSaved(saved.name, saved.songCount));
          } catch (err: any) {
            console.error(`[MusicCmd] Failed to save playlist: ${err.message}`);
          }
        }
      } else if (result.queued) {
        reply(this.messages.queued(result.item.artist ?? '', result.item.title, bot.queue.length));
      } else {
        reply(this.messages.nowPlaying(result.item.artist ?? '', result.item.title));
      }
    } catch (err: any) {
      reply(this.messages.failedToQueue(err.message));
    }
  }

  private async handleStopDownload(botId: number, reply: ReplyFn): Promise<void> {
    const cancelled = cancelDownloadsForBot(botId);
    reply(cancelled ? this.messages.downloadCancelled : this.messages.noActiveDownload);
  }

  private handleDownloadStatus(reply: ReplyFn): void {
    const status = getDownloadStatus();
    reply(this.messages.downloadStatus(
      status.message,
      status.completed,
      status.total,
      status.failed,
      status.cancelled,
    ));
  }

  private async handleSavedPlaylists(bot: VoiceBot, reply: ReplyFn): Promise<void> {
    const playlists = await listSavedPlaylists(this.prisma, bot.id);
    if (playlists.length === 0) {
      reply(this.messages.savedNoPlaylists);
      return;
    }
    const lines = playlists.map((p) => this.messages.savedPlaylistLine(p.id, p.name, p.songCount));
    reply(this.messages.savedPlaylistsHeader(playlists.length) + '\n' + lines.join('\n'));
  }

  private async handleSavedPlay(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    const id = parseInt(args, 10);
    if (!Number.isFinite(id) || id <= 0) {
      reply(this.messages.savedPlaylistUsage);
      return;
    }

    const [playlist, items] = await Promise.all([
      this.prisma.playlist.findUnique({ where: { id }, select: { name: true } }),
      loadSavedPlaylist(this.prisma, id),
    ]);

    if (!playlist || items.length === 0) {
      reply(this.messages.savedPlaylistNotFound);
      return;
    }

    const firstIndex = bot.queue.length;
    bot.queue.addMany(items);

    if (bot.status === 'playing' || bot.status === 'paused') {
      reply(this.messages.savedPlaylistLoaded(playlist.name, items.length));
      return;
    }

    const first = bot.queue.playAt(firstIndex);
    if (first) await bot.playAdvancingOnError(first);
    reply(this.messages.savedPlaylistLoaded(playlist.name, items.length));
  }

  private handleStop(bot: VoiceBot, reply: ReplyFn): void {
    bot.stopAudio();
    reply(this.messages.playbackStopped);
  }

  private handlePause(bot: VoiceBot, reply: ReplyFn): void {
    if (bot.status === 'paused') {
      bot.resume();
      reply(this.messages.resumed);
    } else if (bot.status === 'playing') {
      bot.pause();
      reply(this.messages.paused);
    } else {
      reply(this.messages.nothingPlaying);
    }
  }

  private async handleSkip(bot: VoiceBot, reply: ReplyFn): Promise<void> {
    const next = bot.queue.next();
    if (next) {
      if (next.streamUrl) {
        await bot.playStream(next);
      } else {
        await bot.playAdvancingOnError(next);
      }
      reply(this.messages.skippedTo(next.title));
    } else {
      bot.stopAudio();
      reply(this.messages.queueEmptyStopped);
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
      reply(this.messages.previousTrack(prev.title));
    } else {
      reply(this.messages.noPreviousTrack);
    }
  }

  private handleVolume(bot: VoiceBot, reply: ReplyFn, args: string): void {
    if (!args) {
      const vol = bot.currentConfig.volume;
      reply(this.messages.volume(vol));
      return;
    }

    const vol = parseInt(args);
    if (isNaN(vol) || vol < 0 || vol > 100) {
      reply(this.messages.volumeUsage);
      return;
    }

    bot.setVolume(vol);
    reply(this.messages.volumeSet(vol));
  }

  private handleNowPlaying(bot: VoiceBot, reply: ReplyFn): void {
    const np = bot.nowPlaying;
    if (!np) {
      reply(this.messages.nothingPlaying);
      return;
    }

    const artist = np.artist ? `${np.artist} - ` : '';
    const lines = [this.messages.nowPlayingHeader(artist, np.title)];

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
      return this.messages.liveProgress(formatTime(pos));
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
      reply(this.messages.infoNoMusic);
      return;
    }

    const lines: string[] = [this.messages.infoHeader];
    lines.push(this.messages.infoTitle(np.title));
    if (np.artist) lines.push(this.messages.infoArtist(np.artist));

    if (np.duration) {
      const min = Math.floor(np.duration / 60);
      const sec = String(Math.floor(np.duration % 60)).padStart(2, '0');
      lines.push(this.messages.infoDuration(`${min}:${sec}`));
    }

    const progress = this.formatProgress(bot);
    if (progress) lines.push(this.messages.infoProgress(progress));

    const link = np.sourceUrl || np.streamUrl;
    if (link) lines.push(this.messages.infoLink(link));

    reply(lines.join('\n'));
  }

  // ─── Channel / Client Management ──────────────────────────

  /**
   * Resolve the WebQuery client + virtual server id (sid) for a music bot.
   * The bot only knows its UDP voice port; serveridgetbyport maps that to the
   * sid. Result is cached per bot. Falls back to sid=1 if the lookup fails.
   */
  private async getServer(botId: number): Promise<{ client: WebQueryClient; sid: number }> {
    const dbBot = await this.prisma.musicBot.findUnique({
      where: { id: botId },
      select: { serverConfigId: true, voicePort: true },
    });
    if (!dbBot) throw new Error(this.messages.botConfigNotFound);

    const client = await this.connectionPool.getOrLoad(dbBot.serverConfigId);

    let sid = this.sidCache.get(botId);
    if (!sid) {
      try {
        const res = await client.execute(0, 'serveridgetbyport', { virtualserver_port: dbBot.voicePort });
        const entry = Array.isArray(res) ? res[0] : res;
        sid = parseInt(entry?.server_id) || 1;
      } catch {
        sid = 1; // single-server fallback
      }
      this.sidCache.set(botId, sid);
    }

    return { client, sid };
  }

  /** Load the global command settings, cached for SETTINGS_TTL_MS. */
  private async getSettings(): Promise<MusicCommandSettingsRow> {
    if (this.settingsCache && Date.now() - this.settingsCache.at < MusicCommandHandler.SETTINGS_TTL_MS) {
      return this.settingsCache.value;
    }
    const row = await this.prisma.musicCommandSettings.findFirst();
    const rawLanguage = row?.botLanguage ?? 'en';
    const value: MusicCommandSettingsRow = {
      musicCommandSgid: row?.musicCommandSgid ?? null,
      adminCommandSgid: row?.adminCommandSgid ?? null,
      notifyNowPlaying: row?.notifyNowPlaying ?? false,
      botLanguage: isBotLanguage(rawLanguage) ? rawLanguage : 'en',
      moveBotToRequesterChannel: row?.moveBotToRequesterChannel ?? false,
      audioQuality: isMusicAudioQuality(row?.audioQuality) ? row.audioQuality : 'normal',
      downloadRateLimitKbps: row?.downloadRateLimitKbps ?? null,
      defaultPlaylistSize: row?.defaultPlaylistSize ?? 10,
      downloadProgressEnabled: row?.downloadProgressEnabled ?? false,
    };
    this.settingsCache = { at: Date.now(), value };
    return value;
  }

  private invalidateSettings(): void {
    this.settingsCache = null;
  }

  /** True when we should send an immediate "Loading..." ack for a command. */
  private shouldAckLoading(command: string, args: string): boolean {
    if (command === 'radio' || command === 'stream' || command === 'savedplay') return !!args;
    if (command === 'spotify') return !!args;

    if (command === 'play' || command === 'queue' || command === 'add') {
      const first = args.trim().split(/\s+/)[0] || '';
      if (command === 'queue' || command === 'add') {
        const a = args.trim().toLowerCase();
        if (!a || a === 'show' || a === 'clear' || a.startsWith('remove ')) return false;
      }
      return isSpotifyUrl(first) || first.startsWith('http://') || first.startsWith('https://');
    }
    return false;
  }

  /**
   * True when `command` may start playback and therefore benefits from moving
   * the bot to the channel of the user that issued it.
   */
  private shouldMoveBotForCommand(command: string, args: string): boolean {
    if (command === 'play') return true;
    if (command === 'radio' || command === 'spotify' || command === 'stream') return !!args;
    if (command === 'queue' || command === 'add') {
      const a = args.toLowerCase();
      if (!a || a === 'show' || a.startsWith('remove ') || a === 'clear') return false;
      return true;
    }
    return false;
  }

  /**
   * If enabled in settings, move the bot to the command invoker's current
   * channel before playback. Failures are logged but do not block the command.
   */
  private async maybeMoveBotToRequesterChannel(
    botId: number,
    bot: VoiceBot,
    command: string,
    args: string,
    userClid: number,
  ): Promise<void> {
    const settings = await this.getSettings();
    if (!settings.moveBotToRequesterChannel) return;
    if (!this.shouldMoveBotForCommand(command, args)) return;

    try {
      const { client, sid } = await this.getServer(botId);
      const info = await client.execute(sid, 'clientinfo', { clid: String(userClid) });
      const entry = Array.isArray(info) ? info[0] : info;
      const cid = parseInt(entry?.cid) || 0;
      if (!cid || cid === bot.currentChannelId) return;

      // Use the WebQuery clientmove API: it runs with the configured API key,
      // so it can move the bot even when the bot client itself lacks the
      // native clientmove permission.
      await client.execute(sid, 'clientmove', { clid: String(bot.ts3ClientId), cid });
      bot.setCurrentChannelId(cid);
      console.log(`[MusicCmd] Bot ${botId}: moved to requester channel ${cid}`);
    } catch (err: any) {
      console.error(`[MusicCmd] Failed to move bot ${botId} to requester channel: ${err.message}`);
    }
  }

  /** Post a "now playing" line in the bot's current TS channel when enabled. */
  private async onNowPlaying(bot: VoiceBot, item: QueueItem): Promise<void> {
    const settings = await this.getSettings();
    if (!settings.notifyNowPlaying) return;
    const messages = botMessages[settings.botLanguage];
    const artist = item.artist ? `${item.artist} - ` : '';
    bot.sendChannelMessage(messages.nowPlayingNotification(artist, item.title));
  }

  /** Resolve a server group's display name (best-effort, for messages). */
  private async groupName(client: WebQueryClient, sid: number, sgid: number): Promise<string> {
    try {
      const res = await client.execute(sid, 'servergrouplist');
      const arr = Array.isArray(res) ? res : res ? [res] : [];
      const g = arr.find((x: any) => Number(x.sgid) === sgid);
      return g?.name ? String(g.name) : `#${sgid}`;
    } catch {
      return `#${sgid}`;
    }
  }

  /**
   * Returns true if the invoker may run `command`. On denial it replies with a
   * message and returns false. Open/unconfigured tiers always pass.
   */
  private async checkAccess(botId: number, command: string, userClid: number, reply: ReplyFn): Promise<boolean> {
    const settings = await this.getSettings();
    this.messages = botMessages[settings.botLanguage];
    const required = requiredSgid(command, settings);
    if (required == null) return true;

    const { client, sid } = await this.getServer(botId);

    let entry: any;
    try {
      const info = await client.execute(sid, 'clientinfo', { clid: String(userClid) });
      entry = Array.isArray(info) ? info[0] : info;
    } catch {
      // Could not resolve the invoker (e.g. just disconnected): fail closed.
      reply(this.messages.accessCheckFailed);
      return false;
    }

    const groups = parseServerGroupIds(entry?.client_servergroups);
    if (groups.includes(required)) return true;

    const name = await this.groupName(client, sid, required);
    reply(this.messages.accessRestrictedToGroup(name));
    return false;
  }

  /** Fetch the live channel list (array form) for a virtual server. */
  private async fetchChannels(client: WebQueryClient, sid: number): Promise<any[]> {
    const res = await client.execute(sid, 'channellist');
    return Array.isArray(res) ? res : res ? [res] : [];
  }

  /** Fetch the live client list (array form) for a virtual server. */
  private async fetchClients(client: WebQueryClient, sid: number): Promise<any[]> {
    const res = await client.execute(sid, 'clientlist');
    return Array.isArray(res) ? res : res ? [res] : [];
  }

  /** True for the spacer pseudo-channels used purely for visual separation. */
  private isSpacer(name: string): boolean {
    return name.startsWith('[spacer') || name.startsWith('[*spacer');
  }

  /**
   * Resolve a channel reference — either a numeric cid or a (possibly
   * space-containing) channel name — to a channel entry. Name matching is
   * case-insensitive: exact match first, then a unique substring match.
   * Throws a user-facing message on no/ambiguous match.
   */
  private resolveChannel(channels: any[], ref: string): any {
    const query = ref.trim();

    // Numeric → channel id
    if (/^\d+$/.test(query)) {
      const cid = Number(query);
      const byId = channels.find((c) => Number(c.cid) === cid);
      if (!byId) throw new Error(this.messages.channelNotFoundById(cid));
      return byId;
    }

    const lower = query.toLowerCase();
    const named = channels.filter((c) => !this.isSpacer(String(c.channel_name)));

    const exact = named.filter((c) => String(c.channel_name).toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new Error(this.messages.multipleChannelsNamed(query));
    }

    const partial = named.filter((c) => String(c.channel_name).toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      const ids = partial.slice(0, 6).map((c) => `[${c.cid}] ${c.channel_name}`).join(', ');
      throw new Error(this.messages.multipleChannelsMatching(query, ids));
    }

    throw new Error(this.messages.channelNotFound(query));
  }

  private async handleChannels(botId: number, reply: ReplyFn): Promise<void> {
    const { client, sid } = await this.getServer(botId);
    const channels = await this.fetchChannels(client, sid);
    if (channels.length === 0) {
      reply(this.messages.noChannels);
      return;
    }

    // Build a tree (cid → children) so the list mirrors the channel hierarchy.
    const norm = channels.map((c) => ({
      cid: Number(c.cid),
      pid: Number(c.pid),
      order: Number(c.channel_order) || 0,
      name: String(c.channel_name),
    }));
    const childrenOf = new Map<number, typeof norm>();
    for (const c of norm) {
      if (!childrenOf.has(c.pid)) childrenOf.set(c.pid, []);
      childrenOf.get(c.pid)!.push(c);
    }
    for (const list of childrenOf.values()) list.sort((a, b) => a.order - b.order);

    const lines: string[] = [];
    const MAX = 60;
    const walk = (pid: number, depth: number): void => {
      for (const c of childrenOf.get(pid) ?? []) {
        if (lines.length < MAX && !this.isSpacer(c.name)) {
          lines.push(`${'  '.repeat(depth)}[${c.cid}] ${c.name}`);
        }
        walk(c.cid, depth + 1);
      }
    };
    walk(0, 0);

    if (norm.length > MAX) lines.push(this.messages.channelsMore(norm.length - MAX));

    // Send in chunks to stay under the ~1KB per-message limit on long lists.
    const header = this.messages.channelsHeader(norm.length);
    let buf = header;
    for (const line of lines) {
      if (buf.length + 1 + line.length > 900) {
        reply(buf);
        buf = line;
      } else {
        buf += '\n' + line;
      }
    }
    if (buf) reply(buf);
  }

  private async handleMove(botId: number, reply: ReplyFn, args: string): Promise<void> {
    const tokens = tokenizeArgs(args);
    if (tokens.length < 2) {
      reply(this.messages.moveUsage);
      return;
    }

    const userQuery = tokens[0];
    const channelRef = tokens.slice(1).join(' ');

    const { client, sid } = await this.getServer(botId);
    const [channels, clients] = await Promise.all([
      this.fetchChannels(client, sid),
      this.fetchClients(client, sid),
    ]);

    const channel = this.resolveChannel(channels, channelRef);
    const target = this.resolveClient(clients, userQuery);

    await client.execute(sid, 'clientmove', { clid: target.clid, cid: channel.cid });
    reply(this.messages.moved(target.client_nickname, channel.channel_name));
  }

  private async handleMoveAll(botId: number, bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    const channelRef = tokenizeArgs(args).join(' ').trim();
    if (!channelRef) {
      reply(this.messages.moveAllUsage);
      return;
    }

    const { client, sid } = await this.getServer(botId);
    const [channels, clients] = await Promise.all([
      this.fetchChannels(client, sid),
      this.fetchClients(client, sid),
    ]);

    const channel = this.resolveChannel(channels, channelRef);
    const cid = Number(channel.cid);

    // Real users only (client_type 0), excluding the bot itself and anyone
    // already in the destination channel.
    const toMove = clients.filter((c) =>
      String(c.client_type) === '0' &&
      Number(c.clid) !== bot.ts3ClientId &&
      Number(c.cid) !== cid,
    );

    if (toMove.length === 0) {
      reply(this.messages.noOneToMove(channel.channel_name));
      return;
    }

    let moved = 0;
    const failed: string[] = [];
    // Sequential to stay friendly with the server's flood protection.
    for (const c of toMove) {
      try {
        await client.execute(sid, 'clientmove', { clid: c.clid, cid });
        moved++;
      } catch (err: any) {
        failed.push(String(c.client_nickname || c.clid));
      }
    }

    reply(this.messages.moveAllResult(channel.channel_name, moved, failed.length ? failed.join(', ') : undefined));
  }

  private async handleNotif(reply: ReplyFn): Promise<void> {
    const row = await this.prisma.musicCommandSettings.findFirst();
    const next = !(row?.notifyNowPlaying ?? false);
    if (row) {
      await this.prisma.musicCommandSettings.update({ where: { id: row.id }, data: { notifyNowPlaying: next } });
    } else {
      await this.prisma.musicCommandSettings.create({ data: { notifyNowPlaying: next } });
    }
    this.invalidateSettings();
    reply(next ? this.messages.notifEnabled : this.messages.notifDisabled);
  }

  /**
   * Resolve a user reference (pseudo) to a connected client. Matches only real
   * clients (client_type 0), case-insensitively: exact first, then a unique
   * substring match. Throws a user-facing message on no/ambiguous match.
   */
  private resolveClient(clients: any[], ref: string): any {
    const lower = ref.trim().toLowerCase();
    const real = clients.filter((c) => String(c.client_type) === '0');

    const exact = real.filter((c) => String(c.client_nickname).toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new Error(this.messages.multipleClientsNamed(ref));
    }

    const partial = real.filter((c) => String(c.client_nickname).toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    if (partial.length > 1) {
      const names = partial.slice(0, 6).map((c) => c.client_nickname).join(', ');
      throw new Error(this.messages.multipleClientsMatching(ref, names));
    }

    throw new Error(this.messages.userNotFound(ref));
  }

  private handleHelp(reply: ReplyFn): void {
    reply(this.messages.helpLines.join('\n'));
  }

  // ─── Video Streaming Commands ─────────────────────────────

  private async handleStream(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    if (!args) {
      reply(this.messages.streamUsage);
      return;
    }

    const parts = args.split(/\s+/);
    const url = parts[0];
    const preset = parts[1] || undefined;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      reply(this.messages.invalidStreamUrl);
      return;
    }

    if (bot.videoStreaming) {
      // Change source if already streaming
      try {
        await bot.setVideoSource(url);
        reply(this.messages.streamSourceChanged(url));
      } catch (err: any) {
        reply(this.messages.streamError(err.message));
      }
      return;
    }

    reply(this.messages.startingVideoStream);
    try {
      await bot.startVideoStream(url, preset);
      reply(this.messages.videoStreamStarted(url));
    } catch (err: any) {
      reply(this.messages.failedToStartStream(err.message));
    }
  }

  private async handleStopStream(bot: VoiceBot, reply: ReplyFn): Promise<void> {
    if (!bot.videoStreaming) {
      reply(this.messages.noActiveVideoStream);
      return;
    }
    await bot.stopVideoStream();
    reply(this.messages.videoStreamStopped);
  }

  private handleViewers(bot: VoiceBot, reply: ReplyFn): void {
    const status = bot.videoStreamStatus;
    if (!status.streaming) {
      reply(this.messages.noActiveVideoStream);
      return;
    }
    if (status.viewers.length === 0) {
      reply(this.messages.noViewers);
      return;
    }
    const lines = status.viewers.map((v) => {
      const duration = Math.floor((Date.now() - v.joinedAt) / 1000);
      return this.messages.viewerLine(v.clid, duration);
    });
    reply(this.messages.viewersHeader(status.viewerCount) + '\n' + lines.join('\n'));
  }

}
