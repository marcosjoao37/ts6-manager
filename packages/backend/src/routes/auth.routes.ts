import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { authMiddleware } from '../middleware/auth.js';
import { AppError } from '../middleware/error-handler.js';
import { validatePassword, loadPasswordPolicy } from '../utils/validate-password.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { generateMfaSecret, buildOtpAuthUrl, verifyTotp, generateRecoveryCodes, consumeRecoveryCode } from '../utils/mfa.js';
import QRCode from 'qrcode';

export const authRoutes: Router = Router();

// Short-lived token proving the password step passed, scoped to the MFA step.
const MFA_CHALLENGE_TTL = '5m';
function signMfaChallenge(userId: number): string {
  return jwt.sign({ mfa: true, id: userId }, config.jwtSecret, { expiresIn: MFA_CHALLENGE_TTL } as jwt.SignOptions);
}
function verifyMfaChallenge(token: string): number {
  const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as any;
  if (!payload?.mfa || !payload.id) throw new AppError(401, 'Invalid MFA session');
  return payload.id;
}

// Issue access + refresh tokens and the user payload (shared by login and the MFA step).
async function issueSession(prisma: any, user: any) {
  const payload = { id: user.id, username: user.username, role: user.role };
  const accessToken = jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtAccessExpiry } as jwt.SignOptions);
  const refreshToken = crypto.randomBytes(64).toString('hex');
  const family = nanoid();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await prisma.refreshToken.create({ data: { token: refreshToken, userId: user.id, expiresAt, family } });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
  };
}

authRoutes.post('/login', async (req: Request, res: Response, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) throw new AppError(400, 'Username and password required');

    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { username } });

    if (!user || !user.enabled) throw new AppError(401, 'Invalid credentials');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new AppError(401, 'Invalid credentials');

    // MFA gate: don't issue tokens until the second factor is verified.
    if (user.mfaEnabled) {
      res.json({ mfaRequired: true, mfaToken: signMfaChallenge(user.id) });
      return;
    }
    if (user.mfaRequired) {
      // Admin-forced but not yet set up — the client must enroll first.
      res.json({ mfaSetupRequired: true, mfaToken: signMfaChallenge(user.id) });
      return;
    }

    res.json(await issueSession(prisma, user));
  } catch (err) { next(err); }
});

// Second login step: verify a TOTP or recovery code against the MFA challenge.
authRoutes.post('/login/mfa', async (req: Request, res: Response, next) => {
  try {
    const { mfaToken, code } = req.body;
    if (!mfaToken || !code) throw new AppError(400, 'MFA token and code required');

    const userId = verifyMfaChallenge(mfaToken);
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.enabled || !user.mfaEnabled || !user.mfaSecret) {
      throw new AppError(401, 'Invalid MFA session');
    }

    const okTotp = verifyTotp(String(code), decrypt(user.mfaSecret));
    if (!okTotp) {
      // Fall back to a one-time recovery code
      const stored: string[] = user.mfaRecoveryCodes ? JSON.parse(decrypt(user.mfaRecoveryCodes)) : [];
      const remaining = consumeRecoveryCode(String(code), stored);
      if (!remaining) throw new AppError(401, 'Invalid code');
      await prisma.user.update({
        where: { id: user.id },
        data: { mfaRecoveryCodes: encrypt(JSON.stringify(remaining)) },
      });
    }

    res.json(await issueSession(prisma, user));
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError || err instanceof jwt.TokenExpiredError) {
      return next(new AppError(401, 'MFA session expired, please log in again'));
    }
    next(err);
  }
});

authRoutes.post('/refresh', async (req: Request, res: Response, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new AppError(400, 'Refresh token required');

    const prisma = req.app.locals.prisma;
    const stored = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    });

    if (!stored) {
      // H5: Token not found — check if it was already used (reuse detection)
      const replaced = await prisma.refreshToken.findFirst({
        where: { replacedBy: refreshToken },
      });
      if (replaced) {
        // Reuse detected! Revoke entire token family
        console.warn(`[SECURITY] Refresh token reuse detected for user ${replaced.userId}. Revoking all tokens.`);
        await prisma.refreshToken.deleteMany({ where: { userId: replaced.userId } });
      }
      throw new AppError(401, 'Invalid refresh token');
    }

    if (stored.expiresAt < new Date() || !stored.user.enabled) {
      await prisma.refreshToken.delete({ where: { id: stored.id } });
      throw new AppError(401, 'Invalid refresh token');
    }

    // Rotate: mark old token as replaced, create new one in same family
    const newRefreshToken = crypto.randomBytes(64).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await prisma.refreshToken.update({
      where: { id: stored.id },
      data: { replacedBy: newRefreshToken },
    });

    await prisma.refreshToken.create({
      data: { token: newRefreshToken, userId: stored.userId, expiresAt, family: stored.family },
    });

    // Delete old token after creating new one
    await prisma.refreshToken.delete({ where: { id: stored.id } });

    const payload = { id: stored.user.id, username: stored.user.username, role: stored.user.role };
    const accessToken = jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtAccessExpiry } as jwt.SignOptions);

    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (err) { next(err); }
});

authRoutes.post('/logout', async (req: Request, res: Response, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const prisma = req.app.locals.prisma;
      await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
    }
    res.status(204).send();
  } catch (err) { next(err); }
});

authRoutes.get('/me', authMiddleware, async (req: Request, res: Response, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new AppError(404, 'User not found');

    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        mfaEnabled: user.mfaEnabled,
        mfaRequired: user.mfaRequired,
      },
    });
  } catch (err) { next(err); }
});

// ─── MFA enrollment (self-service) ───────────────────────────

// Start enrollment: generate a pending secret + QR. Allowed either with a
// normal session or with an MFA challenge token (admin-forced first setup).
async function resolveEnrollUser(req: Request): Promise<{ prisma: any; user: any }> {
  const prisma = req.app.locals.prisma;
  let userId = req.user?.id;
  if (!userId && req.body?.mfaToken) userId = verifyMfaChallenge(req.body.mfaToken);
  if (!userId) throw new AppError(401, 'Authentication required');
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.enabled) throw new AppError(401, 'Invalid session');
  return { prisma, user };
}

authRoutes.post('/mfa/setup', async (req: Request, res: Response, next) => {
  try {
    const { prisma, user } = await resolveEnrollUser(req);
    if (user.mfaEnabled) throw new AppError(400, 'MFA is already enabled');

    const secret = generateMfaSecret();
    await prisma.user.update({ where: { id: user.id }, data: { mfaPendingSecret: encrypt(secret) } });

    const otpauth = buildOtpAuthUrl(secret, user.username);
    const qrDataUrl = await QRCode.toDataURL(otpauth);
    res.json({ secret, otpauth, qrDataUrl });
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) return next(new AppError(401, 'MFA session expired'));
    next(err);
  }
});

authRoutes.post('/mfa/enable', async (req: Request, res: Response, next) => {
  try {
    const { code } = req.body;
    if (!code) throw new AppError(400, 'Verification code required');
    const { prisma, user } = await resolveEnrollUser(req);
    if (user.mfaEnabled) throw new AppError(400, 'MFA is already enabled');
    if (!user.mfaPendingSecret) throw new AppError(400, 'Start MFA setup first');

    const secret = decrypt(user.mfaPendingSecret);
    if (!verifyTotp(String(code), secret)) throw new AppError(401, 'Invalid code');

    const { plain, hashed } = generateRecoveryCodes();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: true,
        mfaSecret: encrypt(secret),
        mfaPendingSecret: null,
        mfaRecoveryCodes: encrypt(JSON.stringify(hashed)),
      },
    });
    res.json({ success: true, recoveryCodes: plain });
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) return next(new AppError(401, 'MFA session expired'));
    next(err);
  }
});

authRoutes.post('/mfa/disable', authMiddleware, async (req: Request, res: Response, next) => {
  try {
    const { password } = req.body;
    if (!password) throw new AppError(400, 'Password required');
    const prisma = req.app.locals.prisma;
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new AppError(404, 'User not found');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new AppError(401, 'Password is incorrect');
    if (user.mfaRequired) throw new AppError(403, 'MFA is required by an administrator and cannot be disabled');

    await prisma.user.update({
      where: { id: user.id },
      data: { mfaEnabled: false, mfaSecret: null, mfaPendingSecret: null, mfaRecoveryCodes: null },
    });
    res.status(204).send();
  } catch (err) { next(err); }
});

authRoutes.put('/password', authMiddleware, async (req: Request, res: Response, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) throw new AppError(400, 'Both passwords required');

    const prisma = req.app.locals.prisma;
    const pwError = validatePassword(newPassword, await loadPasswordPolicy(prisma));
    if (pwError) throw new AppError(400, pwError);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) throw new AppError(404, 'User not found');

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new AppError(401, 'Current password is incorrect');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    // Revoke all refresh tokens on password change
    await prisma.refreshToken.deleteMany({ where: { userId: user.id } });

    res.status(204).send();
  } catch (err) { next(err); }
});
