import api from './client';

export type MusicBotLanguage = 'en' | 'pt-BR';
export type MusicAudioQuality = 'normal' | 'low';

export interface MusicCommandSettings {
  musicCommandSgid: number | null;
  adminCommandSgid: number | null;
  notifyNowPlaying: boolean;
  botLanguage: MusicBotLanguage;
  moveBotToRequesterChannel: boolean;
  audioQuality: MusicAudioQuality;
  downloadRateLimitKbps: number | null;
  defaultPlaylistSize: number;
  downloadProgressEnabled: boolean;
}

export const musicCommandSettingsApi = {
  get: (): Promise<MusicCommandSettings> =>
    api.get('/music-command-settings').then((r) => r.data),
  update: (data: Partial<MusicCommandSettings>) =>
    api.put('/music-command-settings', data).then((r) => r.data),
};
