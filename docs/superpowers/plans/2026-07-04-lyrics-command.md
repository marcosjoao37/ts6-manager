# Commande !lyrics / /lyrics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter `!lyrics`/`!paroles` (TeamSpeak) et `/lyrics` (Discord) qui récupèrent les paroles d'une chanson (piste en cours ou recherche libre) via LRCLIB avec fallback lyrics.ovh, et les postent là où la commande a été tapée.

**Architecture:** Un module partagé `packages/backend/src/voice/lyrics.ts` contient la logique de récupération (cascade LRCLIB exact → LRCLIB search → lyrics.ovh) et deux fonctions pures (`cleanTrackTitle`, `chunkLyrics`). `MusicCommandHandler` (TS) et `DiscordBridge` (Discord) ne font que la présentation : chunks ≤ 900 caractères côté TS, embeds ≤ 4096 côté Discord (helper `lyricsEmbeds` dans `embeds.ts`).

**Tech Stack:** TypeScript ESM (imports en `.js`), `fetch` natif Node (aucune dépendance nouvelle), vitest (`pnpm --filter @ts6/backend test`), discord.js v14.

**Spec:** `docs/superpowers/specs/2026-07-04-lyrics-command-design.md`

## Global Constraints

- Aucune dépendance npm nouvelle ; `fetch` natif uniquement.
- Timeout de 10 s par requête HTTP (`AbortSignal.timeout(10_000)`), en-tête `User-Agent: ts6-manager`.
- Toute erreur réseau/API est absorbée dans `fetchLyrics` (retour `null`), jamais de stack côté utilisateur.
- Messages utilisateur en français, comme les commandes existantes.
- `lyrics` reste dans le tier « musique » du contrôle d'accès : **ne pas** modifier `music-command-access.ts`.
- Commandes de vérification : `pnpm --filter @ts6/backend test` et `pnpm --filter @ts6/backend typecheck` (à lancer depuis la racine du repo).

---

### Task 1: Module `lyrics.ts` — fonctions pures (`cleanTrackTitle`, `chunkLyrics`)

**Files:**
- Create: `packages/backend/src/voice/lyrics.ts`
- Test: `packages/backend/src/voice/lyrics.test.ts`

**Interfaces:**
- Produces: `cleanTrackTitle(title: string): string` ; `chunkLyrics(header: string, lyrics: string, maxLen: number): string[]` ; types `LyricsResult` et `LyricsQuery` (utilisés par les Tasks 2–4).

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `packages/backend/src/voice/lyrics.test.ts` :

```ts
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
```

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `pnpm --filter @ts6/backend test -- lyrics.test`
Expected: FAIL — « Cannot find module './lyrics.js' » (ou équivalent).

- [ ] **Step 3: Implémenter les fonctions pures**

Créer `packages/backend/src/voice/lyrics.ts` :

```ts
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
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `pnpm --filter @ts6/backend test -- lyrics.test`
Expected: PASS (10 tests).

Note : si le test « splits on line boundaries » échoue parce que `'aaaa\nbbbb'` fait exactement 9 caractères, c'est l'implémentation qu'il faut corriger (le `+ 1` du `\n` doit être compté), pas le test.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/voice/lyrics.ts packages/backend/src/voice/lyrics.test.ts
git commit -m "feat(lyrics): title cleaning and line-boundary chunking helpers"
```

---

### Task 2: `fetchLyrics` — cascade LRCLIB → lyrics.ovh

**Files:**
- Modify: `packages/backend/src/voice/lyrics.ts` (ajout en fin de fichier)
- Test: `packages/backend/src/voice/lyrics.test.ts` (ajout en fin de fichier)

**Interfaces:**
- Consumes: types `LyricsResult`/`LyricsQuery` de la Task 1.
- Produces: `fetchLyrics(input: LyricsQuery): Promise<LyricsResult | null>` (utilisée par les Tasks 3 et 4).

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter à la fin de `packages/backend/src/voice/lyrics.test.ts` :

```ts
import { fetchLyrics } from './lyrics.js';
import { vi, beforeEach, afterEach } from 'vitest';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('fetchLyrics', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the LRCLIB exact match first', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      artistName: 'Queen', trackName: 'Bohemian Rhapsody',
      plainLyrics: 'Is this the real life?', instrumental: false,
    }));
    const r = await fetchLyrics({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    expect(r).toMatchObject({ artist: 'Queen', lyrics: 'Is this the real life?', source: 'lrclib' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('lrclib.net/api/get?');
  });

  it('falls back to LRCLIB search when exact match 404s', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404))
      .mockResolvedValueOnce(jsonResponse([
        { artistName: 'A', trackName: 'T', plainLyrics: '', instrumental: false },
        { artistName: 'Queen', trackName: 'Bohemian Rhapsody', plainLyrics: 'lyrics here', instrumental: false },
      ]));
    const r = await fetchLyrics({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    expect(r).toMatchObject({ lyrics: 'lyrics here', source: 'lrclib' });
    expect(String(fetchMock.mock.calls[1][0])).toContain('lrclib.net/api/search?');
  });

  it('skips the exact-match step for free-text queries', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      { artistName: 'Queen', trackName: 'Bohemian Rhapsody', plainLyrics: 'found', instrumental: false },
    ]));
    const r = await fetchLyrics({ query: 'queen bohemian rhapsody' });
    expect(r?.lyrics).toBe('found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/search?');
  });

  it('falls back to lyrics.ovh when LRCLIB has nothing', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 404))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ lyrics: 'ovh lyrics' }));
    const r = await fetchLyrics({ artist: 'Queen', title: 'Bohemian Rhapsody' });
    expect(r).toMatchObject({ lyrics: 'ovh lyrics', source: 'lyrics.ovh' });
    expect(String(fetchMock.mock.calls[2][0])).toContain('api.lyrics.ovh/v1/');
  });

  it('returns null when every source fails or is empty', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonResponse({ error: 'No lyrics found' }, 404));
    const r = await fetchLyrics({ artist: 'Nobody', title: 'Nothing' });
    expect(r).toBeNull();
  });

  it('reports LRCLIB instrumentals explicitly', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      artistName: 'Vangelis', trackName: 'Chariots of Fire',
      plainLyrics: null, instrumental: true,
    }));
    const r = await fetchLyrics({ artist: 'Vangelis', title: 'Chariots of Fire' });
    expect(r).toMatchObject({ instrumental: true, lyrics: '' });
  });

  it('never calls lyrics.ovh without both artist and title', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const r = await fetchLyrics({ query: 'unknown song' });
    expect(r).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // search only
  });
});
```

Note : regrouper les imports vitest avec la ligne d'import existante en tête de fichier (`import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';`) plutôt que de laisser un second import au milieu du fichier.

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `pnpm --filter @ts6/backend test -- lyrics.test`
Expected: FAIL — « fetchLyrics is not a function » (ou export manquant).

- [ ] **Step 3: Implémenter la cascade**

Ajouter à la fin de `packages/backend/src/voice/lyrics.ts` :

```ts
/** GET a JSON endpoint; null on any error, non-2xx or timeout. */
async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Maps an LRCLIB record to a LyricsResult; null if it has no usable lyrics. */
function toLrclibResult(entry: any): LyricsResult | null {
  if (!entry || typeof entry !== 'object') return null;
  const artist = String(entry.artistName ?? '');
  const title = String(entry.trackName ?? '');
  if (entry.instrumental === true) {
    return { artist, title, lyrics: '', source: 'lrclib', instrumental: true };
  }
  const lyrics = typeof entry.plainLyrics === 'string' ? entry.plainLyrics.trim() : '';
  if (!lyrics) return null;
  return { artist, title, lyrics, source: 'lrclib', instrumental: false };
}

/**
 * Fetches lyrics for a track. Cascade: LRCLIB exact match (when artist and
 * title are known) → LRCLIB fuzzy search → lyrics.ovh (artist+title only).
 * Every step swallows its own errors; null means "not found anywhere".
 */
export async function fetchLyrics(input: LyricsQuery): Promise<LyricsResult | null> {
  const artist = input.artist?.trim() ?? '';
  const title = input.title?.trim() ?? '';
  const query = input.query?.trim() || [artist, title].filter(Boolean).join(' ');

  // 1. LRCLIB exact match
  if (artist && title) {
    const data = await getJson(
      `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`,
    );
    const r = toLrclibResult(data);
    if (r) return r;
  }

  // 2. LRCLIB fuzzy search — first entry with usable lyrics wins
  if (query) {
    const data = await getJson(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`);
    if (Array.isArray(data)) {
      for (const entry of data) {
        const r = toLrclibResult(entry);
        if (r) return r;
      }
    }
  }

  // 3. lyrics.ovh fallback
  if (artist && title) {
    const data = await getJson(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
    ) as { lyrics?: unknown } | null;
    const lyrics = typeof data?.lyrics === 'string' ? data.lyrics.trim() : '';
    if (lyrics) return { artist, title, lyrics, source: 'lyrics.ovh', instrumental: false };
  }

  return null;
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `pnpm --filter @ts6/backend test -- lyrics.test`
Expected: PASS (17 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @ts6/backend typecheck`
Expected: exit 0.

```bash
git add packages/backend/src/voice/lyrics.ts packages/backend/src/voice/lyrics.test.ts
git commit -m "feat(lyrics): LRCLIB lookup with lyrics.ovh fallback"
```

---

### Task 3: Commande TeamSpeak `!lyrics` / `!paroles`

**Files:**
- Modify: `packages/backend/src/voice/music-command-handler.ts`

**Interfaces:**
- Consumes: `fetchLyrics`, `cleanTrackTitle`, `chunkLyrics` de `./lyrics.js` (Tasks 1–2).
- Produces: rien (feuille).

Le handler n'a pas de fichier de test (comme le reste de `music-command-handler.ts`, dont la logique testable vit dans des modules purs) ; la vérification est typecheck + suite complète.

- [ ] **Step 1: Ajouter l'import et les commandes au set**

Dans `packages/backend/src/voice/music-command-handler.ts` :

Après la ligne `import { requiredSgid, ... } from './music-command-access.js';` (ligne 8), ajouter :

```ts
import { fetchLyrics, cleanTrackTitle, chunkLyrics } from './lyrics.js';
```

Dans `MUSIC_COMMANDS` (lignes 40–46), remplacer :

```ts
  'stream', 'stopstream', 'viewers',
```

par :

```ts
  'stream', 'stopstream', 'viewers',
  'lyrics', 'paroles',
```

- [ ] **Step 2: Brancher le switch**

Dans le `switch (command)` de `onTextMessage`, après le bloc `case 'queue': case 'add':` (lignes 174–177), ajouter :

```ts
        case 'lyrics':
        case 'paroles':
          await this.handleLyrics(bot, reply, args);
          break;
```

- [ ] **Step 3: Implémenter `handleLyrics`**

Après la méthode `handleInfo` (vers la ligne 542), ajouter :

```ts
  private async handleLyrics(bot: VoiceBot, reply: ReplyFn, args: string): Promise<void> {
    let input: { artist?: string; title?: string; query?: string };
    let label: string;

    if (args) {
      input = { query: args };
      label = args;
    } else {
      const np = bot.nowPlaying;
      if (!np) {
        reply('Aucune musique en cours. Usage : !lyrics [artiste - titre]');
        return;
      }
      const artist = np.artist && np.artist !== 'Unknown' ? np.artist : undefined;
      input = { artist, title: cleanTrackTitle(np.title) };
      label = `${artist ? `${artist} - ` : ''}${np.title}`;
    }

    reply('Recherche des paroles…');
    const result = await fetchLyrics(input);
    if (!result) {
      reply(`Paroles introuvables pour « ${label} ».`);
      return;
    }
    if (result.instrumental) {
      reply(`♪ ${result.artist} — ${result.title} : morceau instrumental.`);
      return;
    }

    const header = `🎤 ${result.artist ? `${result.artist} — ` : ''}${result.title}`;
    // Same per-message budget as !channels (~1KB TS limit).
    for (const chunk of chunkLyrics(header, result.lyrics, 900)) {
      reply(chunk);
    }
  }
```

- [ ] **Step 4: Ajouter la ligne d'aide**

Dans `handleHelp`, après la ligne `'  !info                Détails du titre en cours (artiste, titre, lien direct)',` ajouter :

```ts
      '  !lyrics [recherche]  Paroles de la piste en cours ou d\'une recherche (!paroles)',
```

- [ ] **Step 5: Typecheck, tests, commit**

Run: `pnpm --filter @ts6/backend typecheck` — Expected: exit 0.
Run: `pnpm --filter @ts6/backend test` — Expected: PASS (aucune régression).

```bash
git add packages/backend/src/voice/music-command-handler.ts
git commit -m "feat(ts): !lyrics / !paroles command with chunked channel replies"
```

---

### Task 4: Commande Discord `/lyrics`

**Files:**
- Modify: `packages/backend/src/discord/embeds.ts` (helper `lyricsEmbeds`)
- Modify: `packages/backend/src/discord/discord-bridge.ts`
- Test: `packages/backend/src/discord/embeds.test.ts` (ajout)

**Interfaces:**
- Consumes: `fetchLyrics`, `cleanTrackTitle`, `chunkLyrics` de `../voice/lyrics.js` (Tasks 1–2).
- Produces: `lyricsEmbeds(artist: string, title: string, lyrics: string): Array<{ color: number; title?: string; description: string }>` dans `embeds.ts`.

- [ ] **Step 1: Écrire le test du helper d'embeds (échec attendu)**

Ajouter à la fin de `packages/backend/src/discord/embeds.test.ts` (adapter l'import existant en tête de fichier pour inclure `lyricsEmbeds`) :

```ts
describe('lyricsEmbeds', () => {
  it('puts the 🎤 title on the first embed only', () => {
    const embeds = lyricsEmbeds('Queen', 'Bohemian Rhapsody', 'line\n'.repeat(1000));
    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds[0].title).toBe('🎤 Queen — Bohemian Rhapsody');
    expect(embeds[1].title).toBeUndefined();
  });

  it('keeps every description within the 4096-char embed limit', () => {
    const embeds = lyricsEmbeds('A', 'B', 'x'.repeat(10_000));
    for (const e of embeds) expect(e.description.length).toBeLessThanOrEqual(4096);
  });

  it('omits the artist when unknown', () => {
    const embeds = lyricsEmbeds('', 'Title', 'some lyrics');
    expect(embeds[0].title).toBe('🎤 Title');
  });
});
```

- [ ] **Step 2: Vérifier que le test échoue**

Run: `pnpm --filter @ts6/backend test -- embeds.test`
Expected: FAIL — `lyricsEmbeds` non exporté.

- [ ] **Step 3: Implémenter `lyricsEmbeds`**

Dans `packages/backend/src/discord/embeds.ts` :

En tête de fichier, ajouter l'import :

```ts
import { chunkLyrics } from '../voice/lyrics.js';
```

Après `queueEmbed` (vers la ligne 118), ajouter (même style « plain object » et `COLORS` que le reste du fichier) :

```ts
export function lyricsEmbeds(artist: string, title: string, lyrics: string) {
  const heading = `🎤 ${artist ? `${artist} — ` : ''}${title}`;
  return chunkLyrics('', lyrics, 4096).map((chunk, i) => ({
    color: COLORS.purple,
    ...(i === 0 ? { title: heading } : {}),
    description: chunk,
  }));
}
```

- [ ] **Step 4: Vérifier que les tests passent**

Run: `pnpm --filter @ts6/backend test -- embeds.test`
Expected: PASS.

- [ ] **Step 5: Enregistrer la slash command**

Dans `packages/backend/src/discord/discord-bridge.ts` :

En tête de fichier, compléter l'import de `music-ops` par un nouvel import :

```ts
import { fetchLyrics, cleanTrackTitle } from '../voice/lyrics.js';
```

et ajouter `lyricsEmbeds` à l'import existant depuis `./embeds.js`.

Dans `registerCommands()` (defs, lignes 280–295), après la ligne `nowplaying`, ajouter :

```ts
      new SlashCommandBuilder().setName('lyrics').setDescription('Paroles de la piste en cours ou d\'une recherche')
        .addStringOption((o) => o.setName('query').setDescription('Artiste et titre — vide = piste en cours').setRequired(false)),
```

- [ ] **Step 6: Implémenter le case `lyrics` dans `handleCommand`**

Dans le `switch (i.commandName)`, après le bloc `case 'nowplaying':`, ajouter :

```ts
      case 'lyrics': {
        await i.deferReply();
        const query = i.options.getString('query');

        let input: { artist?: string; title?: string; query?: string };
        let label: string;
        if (query) {
          input = { query };
          label = query;
        } else {
          const np = this.musicBot().nowPlaying;
          if (!np) {
            await i.editReply('Rien en cours de lecture. Précise un titre : `/lyrics query`');
            return;
          }
          const artist = np.artist && np.artist !== 'Unknown' ? np.artist : undefined;
          input = { artist, title: cleanTrackTitle(np.title) };
          label = `${artist ? `${artist} — ` : ''}${np.title}`;
        }

        const result = await fetchLyrics(input);
        if (!result) {
          await i.editReply(`❌ Paroles introuvables pour « ${label} ».`);
          return;
        }
        if (result.instrumental) {
          await i.editReply(`♪ **${result.artist} — ${result.title}** : morceau instrumental.`);
          return;
        }

        // Discord allows up to 10 embeds per message, one is plenty here;
        // longer lyrics go out as follow-ups in the same channel.
        const embeds = lyricsEmbeds(result.artist, result.title, result.lyrics);
        await i.editReply({ embeds: [embeds[0]] });
        for (const embed of embeds.slice(1)) {
          await i.followUp({ embeds: [embed] });
        }
        break;
      }
```

- [ ] **Step 7: Typecheck, suite complète, commit**

Run: `pnpm --filter @ts6/backend typecheck` — Expected: exit 0.
Run: `pnpm --filter @ts6/backend test` — Expected: PASS (aucune régression).

```bash
git add packages/backend/src/discord/embeds.ts packages/backend/src/discord/embeds.test.ts packages/backend/src/discord/discord-bridge.ts
git commit -m "feat(discord): /lyrics slash command with paginated embeds"
```

---

### Vérification finale (manuelle, après déploiement)

Non scriptable ici — à faire sur la VM après pull + rebuild :

1. TS, dans le canal du bot : `!lyrics` pendant une lecture → paroles en plusieurs messages dans le canal ; `!lyrics Queen Bohemian Rhapsody` → idem ; `!lyrics zzzzinexistant` → « Paroles introuvables… » ; en message privé au bot → réponse en privé.
2. Discord : `/lyrics` sans option pendant une lecture → embed(s) dans le canal ; `/lyrics query:…` → idem ; la commande apparaît bien dans la liste (re-registration au démarrage du bridge).
