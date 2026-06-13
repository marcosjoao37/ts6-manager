# Connection journal — sortable & filterable — design

**Date:** 2026-06-13
Sub-project A of the (journal sort/filter → Discord flow nodes → i18n) split.

Adds sorting and per-column filtering to the existing connection journal.

## Backend (`GET /api/journal`)

New query params on top of the current `source`/`hideBots`/`page`/`limit`:
- `sort`: one of `createdAt | login | ip | country | success` (whitelist;
  anything else falls back to `createdAt`).
- `dir`: `asc | desc` (default `desc`).
- `login`, `ip`: case-insensitive `contains`.
- `country`: exact ISO code (uppercased); the special value `LAN` matches
  `country = null` (private/unknown).
- `result` (web only): `success` | `failed`.

A pure `buildJournalQuery(params)` helper returns `{ where, orderBy }`;
filters apply before pagination and `total` reflects them. The sort field is
whitelisted so no arbitrary column reaches Prisma's `orderBy`.

## Frontend (Journal page)

- Clickable column headers: click sorts, re-click flips direction, active
  column shows ▲/▼.
- A filter row under the headers: text inputs for Login and IP (debounced),
  a Country input (ISO or `LAN`), and a Result select (All / Success /
  Failed) on the Web tab. The "Hide bots" toggle stays on the TeamSpeak tab.
- Any sort/filter change resets to page 1; a "Reset" button clears filters.

## Testing

Unit tests on `buildJournalQuery`: field whitelist, direction default,
contains filters, the `LAN` special case, and web-only result mapping.
