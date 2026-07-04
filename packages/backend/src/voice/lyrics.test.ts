import { describe, it, expect } from 'vitest';
import { cleanTrackTitle, chunkLyrics } from './lyrics.js';

describe('cleanTrackTitle', () => {
  it('strips bracketed YouTube noise', () => {
    expect(cleanTrackTitle('Bohemian Rhapsody (Official Video)')).toBe('Bohemian Rhapsody');
    expect(cleanTrackTitle('Alors on danse [Clip Officiel]')).toBe('Alors on danse');
    expect(cleanTrackTitle('Take on Me (Official 4K Video)')).toBe('Take on Me');
    expect(cleanTrackTitle('Numb (Official Music Video) [HD]')).toBe('Numb');
    expect(cleanTrackTitle('Shape of You (Lyrics)')).toBe('Shape of You');
  });

  it('keeps meaningful parentheses', () => {
    expect(cleanTrackTitle('Time (You and I)')).toBe('Time (You and I)');
  });

  it('collapses leftover whitespace', () => {
    expect(cleanTrackTitle('  Song   (Official Audio)  ')).toBe('Song');
  });

  it('returns plain titles untouched', () => {
    expect(cleanTrackTitle('Bohemian Rhapsody')).toBe('Bohemian Rhapsody');
  });
});

describe('chunkLyrics', () => {
  it('returns a single chunk when everything fits', () => {
    expect(chunkLyrics('HEAD', 'line1\nline2', 100)).toEqual(['HEAD\nline1\nline2']);
  });

  it('splits on line boundaries, never mid-line', () => {
    const chunks = chunkLyrics('', 'aaaa\nbbbb\ncccc', 9);
    expect(chunks).toEqual(['aaaa\nbbbb', 'cccc']);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(9);
  });

  it('puts the header in the first chunk only', () => {
    const chunks = chunkLyrics('🎤 Artist — Title', 'l1\nl2\nl3\nl4', 20);
    expect(chunks[0].startsWith('🎤 Artist — Title')).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]).not.toContain('🎤');
  });

  it('hard-splits a single line longer than maxLen (degenerate case)', () => {
    const chunks = chunkLyrics('', 'x'.repeat(25), 10);
    expect(chunks).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('drops empty/whitespace-only chunks', () => {
    expect(chunkLyrics('', '\n\n\n', 50)).toEqual([]);
  });

  it('works with an empty header (Discord mode)', () => {
    expect(chunkLyrics('', 'hello', 50)).toEqual(['hello']);
  });
});
