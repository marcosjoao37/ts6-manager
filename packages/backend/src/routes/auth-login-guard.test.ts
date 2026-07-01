import { describe, it, expect } from 'vitest';
import { canLocalLogin } from './auth.routes.js';

describe('canLocalLogin', () => {
  it('refuse un compte sans passwordHash (compte SAML)', () => {
    expect(canLocalLogin({ enabled: true, passwordHash: null })).toBe(false);
  });
  it('refuse un compte désactivé', () => {
    expect(canLocalLogin({ enabled: false, passwordHash: 'x' })).toBe(false);
  });
  it('autorise un compte local activé avec hash', () => {
    expect(canLocalLogin({ enabled: true, passwordHash: 'x' })).toBe(true);
  });
});
