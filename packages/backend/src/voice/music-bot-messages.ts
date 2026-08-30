export type BotLanguage = 'en' | 'pt-BR';

export interface BotMessages {
  // Generic
  error: (message: string) => string;

  // Radio
  botConfigNotFound: string;
  noRadioStations: string;
  radioListHeader: string;
  radioUsage: string;
  stationNotFound: (id: number) => string;
  nowPlayingRadio: (name: string) => string;
  radioGenreFallback: string;

  // Play
  resumed: string;
  playUsage: string;
  invalidUrlUsage: string;
  loading: string;
  queued: (artist: string, title: string, position: number) => string;
  nowPlaying: (artist: string, title: string) => string;
  failedToPlay: (message: string) => string;
  playlistQueued: (added: number, total: number, failed: number) => string;
  playlistNowPlaying: (added: number, total: number, failed: number) => string;

  // Spotify
  spotifyUsage: string;
  spotifyNotConfigured: string;
  resolvingSpotify: string;
  spotifyAlbum: (name: string, added: number, total: number) => string;
  spotifyPlaylist: (name: string, added: number, total: number) => string;
  spotifyQueued: (name: string) => string;
  spotifyNowPlaying: (name: string) => string;
  spotifyFailure: (firstFailure: string) => string;
  spotifyFailed: (message: string) => string;

  // Queue
  queueEmpty: string;
  queueHeader: (count: number) => string;
  queueMore: (remaining: number) => string;
  invalidQueueIndex: (count: number) => string;
  removedTrack: (index: number, title: string) => string;
  playingIndex: (index: number, title: string) => string;
  queueCleared: string;
  queueUsage: string;
  failedToQueue: (message: string) => string;

  // Playback
  playbackStopped: string;
  paused: string;
  nothingPlaying: string;
  skippedTo: (title: string) => string;
  queueEmptyStopped: string;
  previousTrack: (title: string) => string;
  noPreviousTrack: string;
  volume: (value: number) => string;
  volumeUsage: string;
  volumeSet: (value: number) => string;
  liveProgress: (time: string) => string;
  nowPlayingHeader: (artist: string, title: string) => string;

  // Info
  infoNoMusic: string;
  infoHeader: string;
  infoTitle: (title: string) => string;
  infoArtist: (artist: string) => string;
  infoDuration: (duration: string) => string;
  infoProgress: (progress: string) => string;
  infoLink: (link: string) => string;

  // Access control
  accessCheckFailed: string;
  accessRestrictedToGroup: (groupName: string) => string;

  // Channels
  noChannels: string;
  channelsHeader: (count: number) => string;
  channelsMore: (remaining: number) => string;
  channelNotFoundById: (id: number) => string;
  multipleChannelsNamed: (name: string) => string;
  multipleChannelsMatching: (name: string, ids: string) => string;
  channelNotFound: (name: string) => string;

  // Move
  moveUsage: string;
  moved: (user: string, channel: string) => string;
  moveAllUsage: string;
  noOneToMove: (channel: string) => string;
  moveAllResult: (channel: string, moved: number, failed?: string) => string;
  multipleClientsNamed: (name: string) => string;
  multipleClientsMatching: (name: string, names: string) => string;
  userNotFound: (name: string) => string;

  // Notifications
  notifEnabled: string;
  notifDisabled: string;
  nowPlayingNotification: (artist: string, title: string) => string;

  // Help
  helpLines: string[];

  // Video streaming
  streamUsage: string;
  invalidStreamUrl: string;
  streamSourceChanged: (url: string) => string;
  streamError: (message: string) => string;
  startingVideoStream: string;
  videoStreamStarted: (url: string) => string;
  failedToStartStream: (message: string) => string;
  noActiveVideoStream: string;
  videoStreamStopped: string;
  noViewers: string;
  viewersHeader: (count: number) => string;
  viewerLine: (clid: number, seconds: number) => string;
}

const en: BotMessages = {
  error: (m) => `Error: ${m}`,

  botConfigNotFound: 'Bot config not found.',
  noRadioStations: 'No radio stations configured.',
  radioListHeader: 'Radio Stations:',
  radioUsage: 'Usage: !radio <id> — Use !radio to list stations.',
  stationNotFound: (id) => `Station #${id} not found. Use !radio to list stations.`,
  nowPlayingRadio: (name) => `Now playing: ${name}`,
  radioGenreFallback: 'Radio',

  resumed: 'Resumed.',
  playUsage: 'Usage: !play <youtube-url | youtube-playlist | Spotify link>',
  invalidUrlUsage: 'Please provide a valid URL. Usage: !play <youtube-url | youtube-playlist | Spotify link>',
  loading: 'Loading...',
  queued: (artist, title, position) => `Queued: ${artist} - ${title} (position #${position})`,
  nowPlaying: (artist, title) => `Now playing: ${artist} - ${title}`,
  failedToPlay: (m) => `Failed to play: ${m}`,
  playlistQueued: (added, total, failed) =>
    `Playlist queued: ${added}/${total} track(s)${failed ? ` (${failed} failed)` : ''}`,
  playlistNowPlaying: (added, total, failed) =>
    `Now playing playlist: ${added}/${total} track(s)${failed ? ` (${failed} failed)` : ''}`,

  spotifyUsage: 'Usage: !spotify <spotify-track-album-or-playlist-link>',
  spotifyNotConfigured: 'Spotify is not configured (Settings → Spotify).',
  resolvingSpotify: 'Resolving Spotify link...',
  spotifyAlbum: (name, added, total) => `Album "${name}": ${added}/${total} track(s) added.`,
  spotifyPlaylist: (name, added, total) => `Playlist "${name}": ${added}/${total} track(s) added.`,
  spotifyQueued: (name) => `Queued: ${name}`,
  spotifyNowPlaying: (name) => `Now playing: ${name}`,
  spotifyFailure: (first) => `Failed: ${first || 'no tracks added'}`,
  spotifyFailed: (m) => `Spotify failed: ${m}`,

  queueEmpty: 'Queue is empty.',
  queueHeader: (count) => `Queue (${count} tracks):`,
  queueMore: (remaining) => `  ... and ${remaining} more`,
  invalidQueueIndex: (count) => `Invalid index. Queue has ${count} tracks.`,
  removedTrack: (index, title) => `Removed #${index}: ${title}`,
  playingIndex: (index, title) => `Playing #${index}: ${title}`,
  queueCleared: 'Queue cleared.',
  queueUsage: 'Usage: !queue [show|play <n>|remove <n>|clear|<url>]',
  failedToQueue: (m) => `Failed to queue: ${m}`,

  playbackStopped: 'Playback stopped.',
  paused: 'Paused.',
  nothingPlaying: 'Nothing is playing.',
  skippedTo: (title) => `Skipped to: ${title}`,
  queueEmptyStopped: 'Queue empty — playback stopped.',
  previousTrack: (title) => `Previous: ${title}`,
  noPreviousTrack: 'No previous track.',
  volume: (value) => `Volume: ${value}%`,
  volumeUsage: 'Usage: !vol <0-100>',
  volumeSet: (value) => `Volume set to ${value}%.`,
  liveProgress: (time) => `⏱ ${time} (live)`,
  nowPlayingHeader: (artist, title) => `Now playing: ${artist}${title}`,

  infoNoMusic: 'No music currently playing.',
  infoHeader: '♪ Current track:',
  infoTitle: (title) => `  Title  : ${title}`,
  infoArtist: (artist) => `  Artist : ${artist}`,
  infoDuration: (duration) => `  Duration: ${duration}`,
  infoProgress: (progress) => `  Progress: ${progress}`,
  infoLink: (link) => `  Link   : [URL]${link}[/URL]`,

  accessCheckFailed: '⛔ Could not verify your permissions, command denied.',
  accessRestrictedToGroup: (group) => `⛔ Command reserved for the « ${group} » group.`,

  noChannels: 'No channels.',
  channelsHeader: (count) => `Channels (${count}):`,
  channelsMore: (remaining) => `  ... and ${remaining} more`,
  channelNotFoundById: (id) => `No channel with ID ${id}. Use !channels for the list.`,
  multipleChannelsNamed: (name) => `Multiple channels named « ${name} ». Use the ID (see !channels).`,
  multipleChannelsMatching: (name, ids) =>
    `Multiple channels match « ${name} »: ${ids}. Use the ID.`,
  channelNotFound: (name) => `Channel not found: « ${name} ». Use !channels for the list.`,

  moveUsage: 'Usage: !move <user> <channel|id> — use quotes for names with spaces, e.g. !move "John Doe" "Salon 1"',
  moved: (user, channel) => `Moved: ${user} → ${channel}`,
  moveAllUsage: 'Usage: !moveall <channel|id> — moves everyone to that channel.',
  noOneToMove: (channel) => `No one to move to ${channel}.`,
  moveAllResult: (channel, moved, failed) =>
    `${moved} user(s) moved to ${channel}.${failed ? ` Failed for: ${failed}.` : ''}`,
  multipleClientsNamed: (name) => `Multiple clients named « ${name} ». Be more specific.`,
  multipleClientsMatching: (name, names) =>
    `Multiple clients match « ${name} »: ${names}. Be more specific.`,
  userNotFound: (name) => `User not found: « ${name} ».`,

  notifEnabled: '🔔 Now-playing notifications: enabled (all bots).',
  notifDisabled: '🔕 Now-playing notifications: disabled.',
  nowPlayingNotification: (artist, title) => `♪ Now playing: ${artist}${title}`,

  helpLines: [
    'Available music commands:',
    '  !play <url>          Play a YouTube video/playlist or a Spotify link',
    '  !spotify <link>      Play a Spotify track/album/playlist',
    '  !radio [id]          List radio stations or play one',
    '  !queue [..]          Show/manage the queue (show|play <n>|remove <n>|clear|<url>)',
    '  !add <url>           Add a track to the queue',
    '  !skip / !next        Next track',
    '  !prev                Previous track',
    '  !pause               Pause / resume',
    '  !stop                Stop playback',
    '  !vol <0-100>         Show or set the volume',
    '  !np / !nowplaying    Show the current track',
    '  !info                Current track details (artist, title, direct link)',
    '  !stream <url> [qual] Stream a video (presets: 480p, 720p, 1080p)',
    '  !stopstream          Stop the video stream',
    '  !viewers             List video stream viewers',
    '  !channels            List channels and their IDs',
    '  !move <user> <salon> Move a user (name or ID; use quotes for spaces)',
    '  !moveall <salon>     Move everyone to a channel',
    '  !notif               Toggle the now-playing notification (TS channel)',
    '  !help / !aide        Show this help',
  ],

  streamUsage: 'Usage: !stream <url> [preset]  — Presets: 480p, 720p, 1080p',
  invalidStreamUrl: 'Please provide a valid URL.',
  streamSourceChanged: (url) => `Stream source changed to: ${url}`,
  streamError: (m) => `Error: ${m}`,
  startingVideoStream: 'Starting video stream...',
  videoStreamStarted: (url) => `Video stream started: ${url}`,
  failedToStartStream: (m) => `Failed to start stream: ${m}`,
  noActiveVideoStream: 'No active video stream.',
  videoStreamStopped: 'Video stream stopped.',
  noViewers: 'No viewers connected.',
  viewersHeader: (count) => `Viewers (${count}):`,
  viewerLine: (clid, seconds) => `  clid=${clid} (${seconds}s)`,
};

const ptBR: BotMessages = {
  error: (m) => `Erro: ${m}`,

  botConfigNotFound: 'Configuração do bot não encontrada.',
  noRadioStations: 'Nenhuma estação de rádio configurada.',
  radioListHeader: 'Estações de rádio:',
  radioUsage: 'Uso: !radio <id> — Use !radio para listar as estações.',
  stationNotFound: (id) => `Estação #${id} não encontrada. Use !radio para listar as estações.`,
  nowPlayingRadio: (name) => `Tocando agora: ${name}`,
  radioGenreFallback: 'Rádio',

  resumed: 'Retomado.',
  playUsage: 'Uso: !play <url-do-youtube | playlist-do-youtube | link-do-spotify>',
  invalidUrlUsage: 'Forneça uma URL válida. Uso: !play <url-do-youtube | playlist-do-youtube | link-do-spotify>',
  loading: 'Carregando...',
  queued: (artist, title, position) => `Na fila: ${artist} - ${title} (posição #${position})`,
  nowPlaying: (artist, title) => `Tocando agora: ${artist} - ${title}`,
  failedToPlay: (m) => `Falha ao tocar: ${m}`,
  playlistQueued: (added, total, failed) =>
    `Playlist na fila: ${added}/${total} faixa(s)${failed ? ` (${failed} falharam)` : ''}`,
  playlistNowPlaying: (added, total, failed) =>
    `Tocando playlist: ${added}/${total} faixa(s)${failed ? ` (${failed} falharam)` : ''}`,

  spotifyUsage: 'Uso: !spotify <link-de-faixa-álbum-ou-playlist-do-spotify>',
  spotifyNotConfigured: 'Spotify não configurado (Configurações → Spotify).',
  resolvingSpotify: 'Resolvendo link do Spotify...',
  spotifyAlbum: (name, added, total) => `Álbum "${name}": ${added}/${total} faixa(s) adicionada(s).`,
  spotifyPlaylist: (name, added, total) => `Playlist "${name}": ${added}/${total} faixa(s) adicionada(s).`,
  spotifyQueued: (name) => `Na fila: ${name}`,
  spotifyNowPlaying: (name) => `Tocando agora: ${name}`,
  spotifyFailure: (first) => `Falha: ${first || 'nenhuma faixa adicionada'}`,
  spotifyFailed: (m) => `Falha no Spotify: ${m}`,

  queueEmpty: 'A fila está vazia.',
  queueHeader: (count) => `Fila (${count} faixas):`,
  queueMore: (remaining) => `  ... e mais ${remaining}`,
  invalidQueueIndex: (count) => `Índice inválido. A fila tem ${count} faixas.`,
  removedTrack: (index, title) => `Removida #${index}: ${title}`,
  playingIndex: (index, title) => `Tocando #${index}: ${title}`,
  queueCleared: 'Fila limpa.',
  queueUsage: 'Uso: !queue [show|play <n>|remove <n>|clear|<url>]',
  failedToQueue: (m) => `Falha ao adicionar à fila: ${m}`,

  playbackStopped: 'Reprodução parada.',
  paused: 'Pausado.',
  nothingPlaying: 'Nada está tocando.',
  skippedTo: (title) => `Pulado para: ${title}`,
  queueEmptyStopped: 'Fila vazia — reprodução parada.',
  previousTrack: (title) => `Anterior: ${title}`,
  noPreviousTrack: 'Nenhuma faixa anterior.',
  volume: (value) => `Volume: ${value}%`,
  volumeUsage: 'Uso: !vol <0-100>',
  volumeSet: (value) => `Volume definido para ${value}%.`,
  liveProgress: (time) => `⏱ ${time} (ao vivo)`,
  nowPlayingHeader: (artist, title) => `Tocando agora: ${artist}${title}`,

  infoNoMusic: 'Nenhuma música tocando no momento.',
  infoHeader: '♪ Música atual:',
  infoTitle: (title) => `  Título : ${title}`,
  infoArtist: (artist) => `  Artista: ${artist}`,
  infoDuration: (duration) => `  Duração: ${duration}`,
  infoProgress: (progress) => `  Progresso: ${progress}`,
  infoLink: (link) => `  Link   : [URL]${link}[/URL]`,

  accessCheckFailed: '⛔ Não foi possível verificar suas permissões, comando negado.',
  accessRestrictedToGroup: (group) => `⛔ Comando reservado ao grupo « ${group} ».`,

  noChannels: 'Nenhum canal.',
  channelsHeader: (count) => `Canais (${count}):`,
  channelsMore: (remaining) => `  ... e mais ${remaining}`,
  channelNotFoundById: (id) => `Nenhum canal com o ID ${id}. Use !channels para ver a lista.`,
  multipleChannelsNamed: (name) => `Vários canais chamados « ${name} ». Use o ID (veja !channels).`,
  multipleChannelsMatching: (name, ids) =>
    `Vários canais correspondem a « ${name} »: ${ids}. Use o ID.`,
  channelNotFound: (name) => `Canal não encontrado: « ${name} ». Use !channels para ver a lista.`,

  moveUsage: 'Uso: !move <usuário> <canal|id> — use aspas para nomes com espaços, ex.: !move "João" "Sala 1"',
  moved: (user, channel) => `Movido: ${user} → ${channel}`,
  moveAllUsage: 'Uso: !moveall <canal|id> — move todos para esse canal.',
  noOneToMove: (channel) => `Ninguém para mover para ${channel}.`,
  moveAllResult: (channel, moved, failed) =>
    `${moved} usuário(s) movido(s) para ${channel}.${failed ? ` Falha para: ${failed}.` : ''}`,
  multipleClientsNamed: (name) => `Vários clientes chamados « ${name} ». Seja mais específico.`,
  multipleClientsMatching: (name, names) =>
    `Vários clientes correspondem a « ${name} »: ${names}. Seja mais específico.`,
  userNotFound: (name) => `Usuário não encontrado: « ${name} ».`,

  notifEnabled: '🔔 Notificações da faixa atual: ativadas (todos os bots).',
  notifDisabled: '🔕 Notificações da faixa atual: desativadas.',
  nowPlayingNotification: (artist, title) => `♪ Tocando agora: ${artist}${title}`,

  helpLines: [
    'Comandos de música disponíveis:',
    '  !play <url>          Tocar um vídeo/playlist do YouTube ou um link do Spotify',
    '  !spotify <link>      Tocar uma faixa/álbum/playlist do Spotify',
    '  !radio [id]          Listar estações de rádio ou tocar uma',
    '  !queue [..]          Ver/gerenciar a fila (show|play <n>|remove <n>|clear|<url>)',
    '  !add <url>           Adicionar uma faixa à fila',
    '  !skip / !next        Próxima faixa',
    '  !prev                Faixa anterior',
    '  !pause               Pausar / retomar',
    '  !stop                Parar a reprodução',
    '  !vol <0-100>         Mostrar ou definir o volume',
    '  !np / !nowplaying    Mostrar a faixa atual',
    '  !info                Detalhes da faixa atual (artista, título, link direto)',
    '  !stream <url> [qual] Transmitir um vídeo (presets: 480p, 720p, 1080p)',
    '  !stopstream          Parar a transmissão de vídeo',
    '  !viewers             Listar espectadores da transmissão',
    '  !channels            Listar canais e seus IDs',
    '  !move <user> <canal> Mover um usuário (nome ou ID; use aspas se houver espaços)',
    '  !moveall <canal>     Mover todos para um canal',
    '  !notif               Ativar/desativar a notificação da faixa atual (canal TS)',
    '  !help / !aide        Mostrar esta ajuda',
  ],

  streamUsage: 'Uso: !stream <url> [preset]  — Presets: 480p, 720p, 1080p',
  invalidStreamUrl: 'Forneça uma URL válida.',
  streamSourceChanged: (url) => `Fonte do stream alterada para: ${url}`,
  streamError: (m) => `Erro: ${m}`,
  startingVideoStream: 'Iniciando transmissão de vídeo...',
  videoStreamStarted: (url) => `Transmissão de vídeo iniciada: ${url}`,
  failedToStartStream: (m) => `Falha ao iniciar a transmissão: ${m}`,
  noActiveVideoStream: 'Nenhuma transmissão de vídeo ativa.',
  videoStreamStopped: 'Transmissão de vídeo parada.',
  noViewers: 'Nenhum espectador conectado.',
  viewersHeader: (count) => `Espectadores (${count}):`,
  viewerLine: (clid, seconds) => `  clid=${clid} (${seconds}s)`,
};

export const botMessages: Record<BotLanguage, BotMessages> = { en, 'pt-BR': ptBR };

export function isBotLanguage(value: unknown): value is BotLanguage {
  return value === 'en' || value === 'pt-BR';
}
