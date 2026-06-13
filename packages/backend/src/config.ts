import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'file:./data/ts6webui.db',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me-in-production',
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  tsAllowSelfSigned: process.env.TS_ALLOW_SELF_SIGNED === 'true' || process.env.TS_ALLOW_SELF_SIGNED === '1',
  // Number of reverse-proxy hops in front of the backend, used to read the
  // real client IP from X-Forwarded-For (logging, rate limiting). The bundled
  // frontend nginx is always 1; add 1 per extra proxy (e.g. a WAF / CDN).
  // Accepts a number, 'true' (trust all — only behind a fully trusted chain),
  // or an Express-style subnet list.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
};

function parseTrustProxy(raw: string | undefined): number | boolean | string {
  if (raw === undefined || raw === '') return 1; // default: the frontend nginx
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  return raw; // subnet list, e.g. "127.0.0.1, 172.16.0.0/12"
}
