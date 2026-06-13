import {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type TextChannel,
  type GuildMember,
} from 'discord.js';
import { DiscordVoiceRelay } from './discord-voice.js';
import type { PrismaClient, DiscordSettings } from '../../generated/prisma/index.js';
import type { ConnectionPool } from '../ts-client/connection-pool.js';
import type { VoiceBotManager } from '../voice/voice-bot-manager.js';
import type { VoiceBot } from '../voice/voice-bot.js';
import type { QueueItem } from '../voice/playlist/queue.js';
import { EventBridge } from '../bot-engine/event-bridge.js';
import { decrypt } from '../utils/crypto.js';
import { resolvePlayQuery, downloadAndEnqueue } from '../voice/music-ops.js';
import {
  clientConnectedEmbed,
  clientDisconnectedEmbed,
  nowPlayingEmbed,
  statsEmbed,
  queueEmbed,
  type ServerStats,
} from './embeds.js';

const STATS_PANEL_INTERVAL_MS = 60_000;

export interface DiscordStatus {
  enabled: boolean;
  running: boolean;
  error: string | null;
  guildName: string | null;
  warnings: string[];
}

/**
 * Bridges Discord and the TS manager: slash commands for music and stats,
 * TS connect/disconnect notifications, now-playing announcements, and an
 * optional auto-updated stats panel. Fully hot-reloadable from the settings.
 */
export class DiscordBridge {
  private client: Client | null = null;
  private settings: DiscordSettings | null = null;
  private eventBridge: EventBridge | null = null;
  private voiceRelay: DiscordVoiceRelay | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private nowPlayingListeners = new Map<number, (item: QueueItem) => void>();
  private clientNicknames = new Map<string, string>(); // clid → nickname (for leave events)
  private lastError: string | null = null;
  private warnings: string[] = [];
  private startEpoch = 0; // guards async callbacks across reloads

  constructor(
    private prisma: PrismaClient,
    private pool: ConnectionPool,
    private voiceBotManager: VoiceBotManager,
  ) {
    // Attach now-playing listeners to bots created after startup too, and
    // re-attach the voice relay when the default music bot is recreated
    this.voiceBotManager.onBotCreated((botId, bot) => {
      if (this.client) this.attachNowPlaying(botId, bot);
      if (this.voiceRelay && this.settings?.defaultMusicBotId === botId) {
        this.voiceRelay.attachBot(bot);
      }
    });
  }

  async start(): Promise<void> {
    const epoch = ++this.startEpoch;
    this.lastError = null;
    this.warnings = [];

    this.settings = await this.prisma.discordSettings.findFirst();
    if (!this.settings?.enabled || !this.settings.botToken) return;

    let token: string;
    try {
      token = decrypt(this.settings.botToken);
    } catch {
      this.lastError = 'Stored bot token cannot be decrypted — re-enter it';
      return;
    }

    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });
    this.client = client;

    client.on(Events.ClientReady, () => {
      if (epoch !== this.startEpoch) return;
      console.log(`[Discord] Connected as ${client.user?.tag}`);
      this.registerCommands().catch((err) => {
        this.lastError = `Slash command registration failed: ${err.message}`;
        console.error(`[Discord] ${this.lastError}`);
      });
      this.startStatsPanel();
      this.startVoiceRelay().catch((err) => {
        console.error(`[Discord] Voice relay start failed: ${err.message}`);
      });
    });

    client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      this.handleCommand(interaction).catch(async (err) => {
        console.error(`[Discord] /${interaction.commandName} failed: ${err.message}`);
        const msg = { content: `❌ ${err.message}` };
        try {
          if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
          else await interaction.reply({ ...msg, ephemeral: true });
        } catch { /* interaction expired */ }
      });
    });

    client.on(Events.Error, (err) => {
      console.error(`[Discord] Client error: ${err.message}`);
    });

    try {
      await client.login(token);
    } catch (err: any) {
      this.lastError = `Login failed: ${err.message}`;
      console.error(`[Discord] ${this.lastError}`);
      await this.teardownClient();
      return;
    }

    this.attachNowPlayingToAllBots();
    await this.startTsEventBridge();
  }

  async stop(): Promise<void> {
    this.startEpoch++;
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.voiceRelay) {
      this.voiceRelay.destroy();
      this.voiceRelay = null;
    }
    this.detachNowPlayingFromAllBots();
    if (this.eventBridge) {
      const settings = this.settings;
      if (settings?.serverConfigId) {
        try {
          await this.eventBridge.disconnectServer(settings.serverConfigId, settings.virtualServerId);
        } catch { /* already gone */ }
      }
      this.eventBridge.removeAllListeners();
      this.eventBridge = null;
    }
    await this.teardownClient();
  }

  async reload(): Promise<void> {
    await this.stop();
    await this.start();
  }

  getStatus(): DiscordStatus {
    return {
      enabled: !!this.settings?.enabled,
      running: !!this.client?.isReady(),
      error: this.lastError,
      guildName: this.guild()?.name ?? null,
      warnings: this.warnings,
    };
  }

  /** Guilds the bot is a member of — lets the UI offer a picker instead of a raw ID field. */
  listGuilds(): Array<{ id: string; name: string }> {
    if (!this.client?.isReady()) return [];
    return this.client.guilds.cache
      .map((g) => ({ id: g.id, name: g.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Text + voice channels of the configured guild, for the settings UI dropdowns. */
  listChannels(): { text: Array<{ id: string; name: string }>; voice: Array<{ id: string; name: string }> } {
    const guild = this.guild();
    if (!guild) return { text: [], voice: [] };
    const ofType = (type: ChannelType) =>
      guild.channels.cache
        .filter((c) => c.type === type)
        .map((c) => ({ id: c.id, name: `#${c.name}` }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return { text: ofType(ChannelType.GuildText), voice: ofType(ChannelType.GuildVoice) };
  }

  // ─── Internals ──────────────────────────────────────────────

  private guild() {
    if (!this.client?.isReady() || !this.settings?.guildId) return null;
    return this.client.guilds.cache.get(this.settings.guildId) ?? null;
  }

  private async teardownClient(): Promise<void> {
    if (!this.client) return;
    try { await this.client.destroy(); } catch { }
    this.client = null;
  }

  private async registerCommands(): Promise<void> {
    if (!this.client?.application || !this.settings?.guildId) {
      this.warnings.push('No guild ID configured — slash commands not registered');
      return;
    }

    const defs = [
      new SlashCommandBuilder().setName('play').setDescription('Jouer une musique (URL ou recherche YouTube)')
        .addStringOption((o) => o.setName('query').setDescription('URL ou termes de recherche').setRequired(true)),
      new SlashCommandBuilder().setName('stop').setDescription('Arrêter la lecture'),
      new SlashCommandBuilder().setName('pause').setDescription('Pause / reprise'),
      new SlashCommandBuilder().setName('skip').setDescription('Piste suivante'),
      new SlashCommandBuilder().setName('next').setDescription('Piste suivante (alias de /skip)'),
      new SlashCommandBuilder().setName('prev').setDescription('Piste précédente'),
      new SlashCommandBuilder().setName('queue').setDescription("Afficher la file d'attente"),
      new SlashCommandBuilder().setName('volume').setDescription('Régler le volume')
        .addIntegerOption((o) => o.setName('level').setDescription('0-100').setMinValue(0).setMaxValue(100).setRequired(true)),
      new SlashCommandBuilder().setName('nowplaying').setDescription('Piste en cours'),
      new SlashCommandBuilder().setName('stats').setDescription('Stats du serveur TeamSpeak'),
      new SlashCommandBuilder().setName('join').setDescription('Faire venir le bot dans ton salon vocal'),
      new SlashCommandBuilder().setName('leave').setDescription('Faire quitter le salon vocal au bot'),
    ].map((c) => c.toJSON());

    await this.client.application.commands.set(defs, this.settings.guildId);
    console.log(`[Discord] Registered ${defs.length} slash commands on guild ${this.settings.guildId}`);
  }

  private musicBot(): VoiceBot {
    const id = this.settings?.defaultMusicBotId;
    if (!id) throw new Error('Aucun bot musique par défaut configuré (Settings → Discord)');
    const bot = this.voiceBotManager.getBot(id);
    if (!bot) throw new Error(`Le bot musique #${id} n'est pas démarré`);
    return bot;
  }

  private async handleCommand(i: ChatInputCommandInteraction): Promise<void> {
    switch (i.commandName) {
      case 'play': {
        await i.deferReply();
        const bot = this.musicBot();
        const url = await resolvePlayQuery(i.options.getString('query', true));
        const { item, queued } = await downloadAndEnqueue(this.prisma, bot, url);
        const artist = item.artist && item.artist !== 'Unknown' ? `${item.artist} — ` : '';
        await i.editReply(queued
          ? `➕ En file (#${bot.queue.length}) : ${artist}**${item.title}**`
          : `🎵 Lecture : ${artist}**${item.title}**`);
        break;
      }
      case 'stop': {
        this.musicBot().stopAudio();
        await i.reply('⏹️ Lecture arrêtée.');
        break;
      }
      case 'pause': {
        const bot = this.musicBot();
        if (bot.status === 'paused') {
          bot.resume();
          await i.reply('▶️ Reprise.');
        } else if (bot.status === 'playing') {
          bot.pause();
          await i.reply('⏸️ Pause.');
        } else {
          await i.reply({ content: 'Rien en cours de lecture.', ephemeral: true });
        }
        break;
      }
      case 'skip':
      case 'next': {
        await i.deferReply();
        const bot = this.musicBot();
        const next = bot.queue.next();
        if (next) {
          if (next.streamUrl) await bot.playStream(next);
          else await bot.play(next);
          await i.editReply(`⏭️ ${next.title}`);
        } else {
          bot.stopAudio();
          await i.editReply('⏹️ File vide — lecture arrêtée.');
        }
        break;
      }
      case 'prev': {
        await i.deferReply();
        const bot = this.musicBot();
        const prev = bot.queue.previous();
        if (prev) {
          if (prev.streamUrl) await bot.playStream(prev);
          else await bot.play(prev);
          await i.editReply(`⏮️ ${prev.title}`);
        } else {
          await i.editReply('Pas de piste précédente.');
        }
        break;
      }
      case 'queue': {
        const bot = this.musicBot();
        await i.reply({ embeds: [queueEmbed(bot.queue.getAll(), bot.queue.index)] });
        break;
      }
      case 'volume': {
        const level = i.options.getInteger('level', true);
        this.musicBot().setVolume(level);
        await i.reply(`🔊 Volume : ${level}%`);
        break;
      }
      case 'nowplaying': {
        const bot = this.musicBot();
        const np = bot.nowPlaying;
        if (!np) {
          await i.reply({ content: 'Rien en cours de lecture.', ephemeral: true });
        } else {
          await i.reply({ embeds: [nowPlayingEmbed(bot.currentConfig.name, np)] });
        }
        break;
      }
      case 'stats': {
        await i.deferReply();
        await i.editReply({ embeds: [statsEmbed(await this.fetchStats())] });
        break;
      }
      case 'join': {
        const member = i.member as GuildMember | null;
        const channelId = member?.voice?.channelId;
        if (!channelId || !i.guild) {
          await i.reply({ content: "Rejoins d'abord un salon vocal.", ephemeral: true });
          return;
        }
        if (!this.voiceRelay) throw new Error('Relais vocal non initialisé');
        await i.deferReply();
        await this.voiceRelay.joinChannel(i.guild, channelId);
        await i.editReply(`🔊 Connecté à <#${channelId}> — la musique du bot y est diffusée.`);
        break;
      }
      case 'leave': {
        this.voiceRelay?.leaveChannel();
        await i.reply('👋 Salon vocal quitté.');
        break;
      }
    }
  }

  // ─── Voice relay ────────────────────────────────────────────

  private async startVoiceRelay(): Promise<void> {
    const settings = this.settings;
    if (!settings) return;

    this.voiceRelay = new DiscordVoiceRelay();

    if (settings.defaultMusicBotId) {
      const bot = this.voiceBotManager.getBot(settings.defaultMusicBotId);
      if (bot) this.voiceRelay.attachBot(bot);
    } else if (settings.voiceChannelId) {
      this.warnings.push('Voice channel configured but no default music bot — nothing to relay');
    }

    if (settings.voiceChannelId) {
      const guild = this.guild();
      if (guild) {
        await this.voiceRelay.joinChannel(guild, settings.voiceChannelId);
      }
    }
  }

  private async fetchStats(): Promise<ServerStats> {
    const settings = this.settings;
    if (!settings?.serverConfigId) throw new Error('Aucun serveur TS configuré (Settings → Discord)');

    const client = await this.pool.getOrLoad(settings.serverConfigId);
    const sid = settings.virtualServerId;
    const [serverInfo, clientList, channelList, connectionInfo] = await Promise.all([
      client.execute(sid, 'serverinfo'),
      client.execute(sid, 'clientlist'),
      client.execute(sid, 'channellist'),
      client.execute(sid, 'serverrequestconnectioninfo'),
    ]);

    const info = Array.isArray(serverInfo) ? serverInfo[0] : serverInfo;
    const connInfo = Array.isArray(connectionInfo) ? connectionInfo[0] : connectionInfo;
    const clients = Array.isArray(clientList) ? clientList : [];
    const channels = Array.isArray(channelList) ? channelList : [];

    return {
      serverName: info.virtualserver_name,
      onlineUsers: clients.filter((c: any) => String(c.client_type) === '0').length,
      maxClients: Number(info.virtualserver_maxclients) || 0,
      channelCount: channels.length,
      uptime: Number(info.virtualserver_uptime) || 0,
      bandwidthIn: Number(connInfo.connection_bandwidth_received_last_second_total) || 0,
      bandwidthOut: Number(connInfo.connection_bandwidth_sent_last_second_total) || 0,
    };
  }

  // ─── TS connect/disconnect notifications ───────────────────

  private async startTsEventBridge(): Promise<void> {
    const settings = this.settings;
    if (!settings?.notifyConnections) return; // connect/disconnect notifications disabled
    if (!settings.notificationsChannelId) return;
    if (!settings.serverConfigId) {
      this.warnings.push('Notifications enabled but no TS server configured');
      return;
    }

    const server = await this.prisma.tsServerConfig.findUnique({ where: { id: settings.serverConfigId } });
    if (!server?.sshUsername || !server?.sshPassword) {
      this.warnings.push('TS connect/disconnect notifications need SSH credentials on the server connection');
      return;
    }

    // Own EventBridge instance: the flow engine prunes SSH connections its
    // flows no longer use, which would silently kill a shared subscription.
    this.eventBridge = new EventBridge(this.prisma);
    this.eventBridge.on('tsEvent', (_configId, _sid, eventName, data) => {
      this.onTsEvent(eventName, data).catch((err) => {
        console.error(`[Discord] TS event handling failed: ${err.message}`);
      });
    });
    await this.eventBridge.connectServer(settings.serverConfigId, settings.virtualServerId);
  }

  private async onTsEvent(eventName: string, data: Record<string, string>): Promise<void> {
    if (eventName === 'notifycliententerview') {
      // Real clients only (query clients are type 1), fresh connections only
      if (String(data.client_type) !== '0' || String(data.reasonid || '0') !== '0') return;
      const nickname = data.client_nickname || `Client #${data.clid}`;
      this.clientNicknames.set(String(data.clid), nickname);
      await this.postToChannel(this.settings?.notificationsChannelId, { embeds: [clientConnectedEmbed(nickname)] });
    } else if (eventName === 'notifyclientleftview') {
      const clid = String(data.clid);
      const nickname = this.clientNicknames.get(clid);
      this.clientNicknames.delete(clid);
      if (!nickname) return; // unknown clid (connected before us, or a query client)
      await this.postToChannel(this.settings?.notificationsChannelId, { embeds: [clientDisconnectedEmbed(nickname)] });
    }
  }

  // ─── Now playing ────────────────────────────────────────────

  private attachNowPlaying(botId: number, bot: VoiceBot): void {
    if (this.nowPlayingListeners.has(botId)) return;
    const listener = (item: QueueItem) => {
      if (!this.settings?.notifyNowPlaying) return; // now-playing notifications disabled
      this.postToChannel(this.settings?.notificationsChannelId, {
        embeds: [nowPlayingEmbed(bot.currentConfig.name, item)],
      }).catch(() => { });
    };
    bot.on('nowPlaying', listener);
    this.nowPlayingListeners.set(botId, listener);
  }

  private attachNowPlayingToAllBots(): void {
    for (const { botId, bot } of this.voiceBotManager.getAllBots()) {
      this.attachNowPlaying(botId, bot);
    }
  }

  private detachNowPlayingFromAllBots(): void {
    for (const [botId, listener] of this.nowPlayingListeners) {
      this.voiceBotManager.getBot(botId)?.removeListener('nowPlaying', listener);
    }
    this.nowPlayingListeners.clear();
  }

  // ─── Live stats panel ───────────────────────────────────────

  private startStatsPanel(): void {
    if (!this.settings?.statsLiveEnabled || !this.settings.statsChannelId) return;
    const tick = () => {
      this.updateStatsPanel().catch((err) => {
        console.error(`[Discord] Stats panel update failed: ${err.message}`);
      });
    };
    this.statsTimer = setInterval(tick, STATS_PANEL_INTERVAL_MS);
    tick();
  }

  private async updateStatsPanel(): Promise<void> {
    const settings = this.settings;
    if (!settings?.statsChannelId || !this.client?.isReady()) return;

    const embed = statsEmbed(await this.fetchStats());
    const channel = await this.client.channels.fetch(settings.statsChannelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    const textChannel = channel as TextChannel;

    if (settings.statsMessageId) {
      const existing = await textChannel.messages.fetch(settings.statsMessageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return;
      }
    }

    const message = await textChannel.send({ embeds: [embed] });
    settings.statsMessageId = message.id;
    await this.prisma.discordSettings.update({
      where: { id: settings.id },
      data: { statsMessageId: message.id },
    });
  }

  private async postToChannel(channelId: string | null | undefined, payload: any): Promise<void> {
    if (!channelId || !this.client?.isReady()) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isSendable()) return;
    await channel.send(payload);
  }
}
