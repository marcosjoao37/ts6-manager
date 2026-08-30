export type MusicAudioQuality = 'normal' | 'low';

export interface MusicAudioPreset {
  bitrate: number;
  bufferMs: number;
}

export const MUSIC_AUDIO_PRESETS: Record<MusicAudioQuality, MusicAudioPreset> = {
  normal: { bitrate: 128_000, bufferMs: 200 },
  low: { bitrate: 64_000, bufferMs: 400 },
};

export function isMusicAudioQuality(value: unknown): value is MusicAudioQuality {
  return value === 'normal' || value === 'low';
}
