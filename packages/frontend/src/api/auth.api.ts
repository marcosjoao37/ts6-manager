import api from './client';

export const authApi = {
  login: (username: string, password: string) =>
    api.post('/auth/login', { username, password }).then((r) => r.data),

  refresh: (refreshToken: string) =>
    api.post('/auth/refresh', { refreshToken }).then((r) => r.data),

  logout: (refreshToken: string) =>
    api.post('/auth/logout', { refreshToken }),

  me: () => api.get('/auth/me').then((r) => r.data),

  changePassword: (currentPassword: string, newPassword: string) =>
    api.put('/auth/password', { currentPassword, newPassword }),

  // MFA — login second step
  loginMfa: (mfaToken: string, code: string) =>
    api.post('/auth/login/mfa', { mfaToken, code }).then((r) => r.data),

  // MFA — enrollment. mfaToken is only needed during admin-forced setup at
  // login; from the Account tab the session cookie/header authorizes it.
  mfaSetup: (mfaToken?: string) =>
    api.post('/auth/mfa/setup', mfaToken ? { mfaToken } : {}).then((r) => r.data),
  mfaEnable: (code: string, mfaToken?: string) =>
    api.post('/auth/mfa/enable', mfaToken ? { code, mfaToken } : { code }).then((r) => r.data),
  mfaDisable: (password: string) =>
    api.post('/auth/mfa/disable', { password }),
};
