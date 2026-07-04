/**
 * Lyrics lookup shared by the TS (!lyrics) and Discord (/lyrics) commands.
 * Sources: LRCLIB (no API key) with a lyrics.ovh fallback. Pure helpers
 * (title cleaning, chunking) live here too so both bridges stay thin.
 */

const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = 'ts6-manager';

export interface LyricsResult {
  artist: string;
  title: string;
  lyrics: string;
  source: 'lrclib' | 'lyrics.ovh';
  instrumental: boolean;
}

export interface LyricsQuery {
  artist?: string;
  title?: string;
  query?: string;
}

/**
 * Strips the noise YouTube appends to track titles — "(Official Video)",
 * "[Clip Officiel]", "(Lyrics)", "HD", "4K", … — so the title can be used
 * as a lyrics search term. Parentheses that are part of the actual title
 * (no noise keyword inside) are preserved.
 */
export function cleanTrackTitle(title: string): string {
  const NOISE = /(official|officiel|video|vidéo|clip|lyric|paroles|audio|visuali[sz]er|remaster|\b(hd|4k|mv)\b)/i;
  return title
    .replace(/[([{][^()[\]{}]*[)\]}]/g, (m) => (NOISE.test(m) ? ' ' : m))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Splits `header + lyrics` into chunks of at most `maxLen` characters,
 * cutting only on line boundaries (a single line longer than maxLen is
 * hard-split as a degenerate case). Empty chunks are dropped.
 */
export function chunkLyrics(header: string, lyrics: string, maxLen: number): string[] {
  const text = header ? `${header}\n${lyrics}` : lyrics;
  const chunks: string[] = [];
  let buf: string | null = null;
  for (let line of text.split('\n')) {
    while (line.length > maxLen) {
      if (buf !== null) { chunks.push(buf); buf = null; }
      chunks.push(line.slice(0, maxLen));
      line = line.slice(maxLen);
    }
    if (buf === null) buf = line;
    else if (buf.length + 1 + line.length <= maxLen) buf += '\n' + line;
    else { chunks.push(buf); buf = line; }
  }
  if (buf !== null) chunks.push(buf);
  return chunks.map((c) => c.trim() === '' ? '' : c).filter((c) => c !== '');
}
