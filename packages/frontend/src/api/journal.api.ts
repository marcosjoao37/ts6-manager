import api from './client';

export interface ConnectionLogEntry {
  id: number;
  source: 'web' | 'teamspeak';
  login: string;
  ip: string;
  country: string | null;
  success: boolean;
  isBot: boolean;
  serverConfigId: number | null;
  createdAt: string;
}

export interface JournalPage {
  entries: ConnectionLogEntry[];
  total: number;
  page: number;
  limit: number;
}

export const journalApi = {
  list: (params: { source: 'web' | 'teamspeak'; hideBots?: boolean; page?: number; limit?: number }): Promise<JournalPage> =>
    api.get('/journal', { params }).then((r) => r.data),
  retention: (): Promise<{ retentionDays: number }> => api.get('/journal/retention').then((r) => r.data),
  updateRetention: (retentionDays: number) =>
    api.put('/journal/retention', { retentionDays }).then((r) => r.data),
};
