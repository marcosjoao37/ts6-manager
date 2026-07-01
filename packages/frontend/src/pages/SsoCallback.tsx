import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { authApi } from '@/api/auth.api';
import { useAuthStore } from '@/stores/auth.store';
import { applyUserLanguage } from '@/hooks/use-auth';

export default function SsoCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const err = params.get('error');
    if (err) { setError(err); return; }
    const code = params.get('code');
    if (!code) { setError('missing_code'); return; }
    authApi.samlExchange(code)
      .then((res) => {
        if (res.accessToken) {
          setAuth(res.accessToken, res.refreshToken, res.user);
          applyUserLanguage(res.user);
          navigate('/dashboard', { replace: true });
        } else {
          // MFA required: hand off to the login page's MFA step via router state.
          navigate('/login', { replace: true, state: { mfa: res } });
        }
      })
      .catch(() => setError('exchange_failed'));
  }, [params, navigate, setAuth]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4 text-sm">
      {error
        ? <div className="space-y-2 text-center">
            <p className="text-destructive">{t(`login.ssoError.${error}`, t('login.ssoError.generic'))}</p>
            <a className="text-primary underline" href="/login">{t('login.backToLogin')}</a>
          </div>
        : <p className="text-muted-foreground">{t('login.ssoProcessing')}</p>}
    </div>
  );
}
