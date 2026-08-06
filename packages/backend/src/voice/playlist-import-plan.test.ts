import { describe, it, expect } from 'vitest';
import { planImport, youtubeWatchUrl, type PlanEntry } from './playlist-import-plan.js';

const e = (id: string): PlanEntry => ({ id, title: `Track ${id}`, url: youtubeWatchUrl(id) });

describe('youtubeWatchUrl', () => {
  it('builds a canonical watch url', () => {
    expect(youtubeWatchUrl('abc')).toBe('https://www.youtube.com/watch?v=abc');
  });
});

describe('planImport', () => {
  it('returns everything empty for an empty playlist', () => {
    const plan = planImport([], new Set(), 50);
    expect(plan.toImport).toEqual([]);
    expect(plan.alreadyPresent).toEqual([]);
    expect(plan.truncated).toBe(0);
  });

  it('imports every entry when under the cap', () => {
    const plan = planImport([e('a'), e('b')], new Set(), 50);
    expect(plan.toImport.map((x) => x.id)).toEqual(['a', 'b']);
    expect(plan.truncated).toBe(0);
  });

  it('caps the import and reports how many were cut', () => {
    const plan = planImport([e('a'), e('b'), e('c')], new Set(), 2);
    expect(plan.toImport.map((x) => x.id)).toEqual(['a', 'b']);
    expect(plan.truncated).toBe(1);
  });

  it('skips entries already attached to this playlist', () => {
    const plan = planImport([e('a'), e('b')], new Set([youtubeWatchUrl('a')]), 50);
    expect(plan.toImport.map((x) => x.id)).toEqual(['b']);
    expect(plan.alreadyPresent.map((x) => x.id)).toEqual(['a']);
    expect(plan.truncated).toBe(0);
  });

  it('does not let already-present entries consume the cap', () => {
    // The cap bounds downloads. Tracks already attached cost nothing, so a
    // playlist that is mostly imported already must still make progress.
    const entries = [e('a'), e('b'), e('c'), e('d')];
    const attached = new Set([youtubeWatchUrl('a'), youtubeWatchUrl('b'), youtubeWatchUrl('c')]);
    const plan = planImport(entries, attached, 2);
    expect(plan.toImport.map((x) => x.id)).toEqual(['d']);
    expect(plan.alreadyPresent).toHaveLength(3);
    expect(plan.truncated).toBe(0);
  });

  it('treats a cap of zero as importing nothing', () => {
    const plan = planImport([e('a'), e('b')], new Set(), 0);
    expect(plan.toImport).toEqual([]);
    expect(plan.truncated).toBe(2);
  });

  it('drops entries with no id', () => {
    const plan = planImport([{ id: '', title: 'broken', url: '' }, e('a')], new Set(), 50);
    expect(plan.toImport.map((x) => x.id)).toEqual(['a']);
  });
});
