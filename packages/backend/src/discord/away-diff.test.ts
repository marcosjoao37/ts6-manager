import { describe, it, expect } from 'vitest';
import { diffAwayState, type AwayClient } from './away-diff.js';

const c = (clid: string, isAway: boolean, cid = '5', nickname = `U${clid}`): AwayClient => ({ clid, cid, isAway, nickname });

describe('diffAwayState', () => {
  it('amorce sans changement quand prev est vide', () => {
    const { changes, next, seeded } = diffAwayState(new Map(), [c('1', false), c('2', true)]);
    expect(seeded).toBe(true);
    expect(changes).toEqual([]);
    expect(next.get('1')).toBe(false);
    expect(next.get('2')).toBe(true);
  });

  it('détecte le passage AFK (false → true)', () => {
    const prev = new Map([['1', false]]);
    const { changes } = diffAwayState(prev, [c('1', true)]);
    expect(changes).toEqual([{ clid: '1', cid: '5', nickname: 'U1', isAway: true }]);
  });

  it('détecte le retour (true → false)', () => {
    const prev = new Map([['1', true]]);
    const { changes } = diffAwayState(prev, [c('1', false)]);
    expect(changes[0].isAway).toBe(false);
  });

  it("n'émet rien quand l'état est inchangé", () => {
    const prev = new Map([['1', false]]);
    const { changes } = diffAwayState(prev, [c('1', false)]);
    expect(changes).toEqual([]);
  });

  it("enregistre un nouveau client sans le notifier", () => {
    const prev = new Map([['1', false]]);
    const { changes, next } = diffAwayState(prev, [c('1', false), c('2', true)]);
    expect(changes).toEqual([]);
    expect(next.get('2')).toBe(true);
  });

  it('purge les clids disparus de la liste courante', () => {
    const prev = new Map([['1', false], ['2', true]]);
    const { next } = diffAwayState(prev, [c('1', false)]);
    expect(next.has('2')).toBe(false);
  });
});
