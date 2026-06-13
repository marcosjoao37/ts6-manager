import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
  type AudioPlayer,
} from '@discordjs/voice';
import { PassThrough } from 'stream';
import type { Guild } from 'discord.js';
import type { VoiceBot } from '../voice/voice-bot.js';
import type { QueueItem } from '../voice/playlist/queue.js';
import type { VoiceBotStatus } from '../voice/voice-bot.js';

/**
 * Relays the music bot's already-encoded opus frames (48kHz stereo, 20ms —
 * the exact format Discord consumes) into a Discord voice channel. One
 * AudioResource per track: started on nowPlaying, ended on stop, paused and
 * resumed in lockstep with the TS playback.
 */
export class DiscordVoiceRelay {
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer;
  private stream: PassThrough | null = null;
  private bot: VoiceBot | null = null;
  private onNowPlaying: ((item: QueueItem) => void) | null = null;
  private onStatusChange: ((status: VoiceBotStatus) => void) | null = null;

  constructor() {
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.player.on('error', (err) => {
      console.error(`[DiscordVoice] Player error: ${err.message}`);
    });
  }

  get connectedChannelId(): string | null {
    return this.connection?.joinConfig.channelId ?? null;
  }

  async joinChannel(guild: Guild, channelId: string): Promise<void> {
    if (this.connection && this.connectedChannelId === channelId) return;
    this.leaveChannel();

    const connection = joinVoiceChannel({
      channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    this.connection = connection;
    connection.subscribe(this.player);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.connection !== connection) return;
      // Brief grace period: discord.js resumes most transient drops itself
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        console.warn('[DiscordVoice] Voice connection lost');
        this.leaveChannel();
      }
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    console.log(`[DiscordVoice] Joined voice channel ${channelId}`);

    // A track may already be playing — start relaying it mid-flight
    if (this.bot && (this.bot.status === 'playing' || this.bot.status === 'paused')) {
      this.startResource();
      if (this.bot.status === 'paused') this.player.pause();
    }
  }

  leaveChannel(): void {
    this.endResource();
    if (this.connection) {
      try { this.connection.destroy(); } catch { }
      this.connection = null;
    }
  }

  /** Follow a music bot: tap its opus frames and mirror its lifecycle. */
  attachBot(bot: VoiceBot): void {
    this.detachBot();
    this.bot = bot;

    bot.setFrameSink((frame) => {
      // Drop frames when no resource is active (player stopped/idle)
      this.stream?.write(frame);
    });

    this.onNowPlaying = () => this.startResource();
    this.onStatusChange = (status) => {
      if (status === 'paused') this.player.pause();
      else if (status === 'playing') this.player.unpause();
      else this.endResource(); // connected / stopped / error → track over
    };

    bot.on('nowPlaying', this.onNowPlaying);
    bot.on('statusChange', this.onStatusChange);

    if (this.connection && (bot.status === 'playing' || bot.status === 'paused')) {
      this.startResource();
      if (bot.status === 'paused') this.player.pause();
    }
  }

  detachBot(): void {
    if (this.bot) {
      this.bot.setFrameSink(null);
      if (this.onNowPlaying) this.bot.removeListener('nowPlaying', this.onNowPlaying);
      if (this.onStatusChange) this.bot.removeListener('statusChange', this.onStatusChange);
    }
    this.bot = null;
    this.onNowPlaying = null;
    this.onStatusChange = null;
    this.endResource();
  }

  destroy(): void {
    this.detachBot();
    this.leaveChannel();
    try { this.player.stop(true); } catch { }
  }

  // One opus packet per chunk: object mode prevents Node from coalescing
  // frames, which would corrupt packet boundaries (StreamType.Opus expects
  // exactly one packet per read).
  private startResource(): void {
    this.endResource();
    if (!this.connection) return;
    this.stream = new PassThrough({ objectMode: true, highWaterMark: 250 });
    this.player.play(createAudioResource(this.stream, { inputType: StreamType.Opus }));
  }

  private endResource(): void {
    if (this.stream) {
      try { this.stream.end(); } catch { }
      this.stream = null;
    }
    try { this.player.stop(); } catch { }
  }
}
