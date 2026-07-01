export interface AwayClient {
  clid: string;
  cid: string;
  isAway: boolean;
  nickname: string;
}

export interface AwayChange {
  clid: string;
  cid: string;
  nickname: string;
  isAway: boolean;
}

/**
 * Compare the previous away-state map against the current client list.
 * On first run (empty prev) it seeds without emitting changes, to avoid
 * spamming a notification for every already-away client at startup/reload.
 */
export function diffAwayState(
  prev: Map<string, boolean>,
  current: AwayClient[],
): { changes: AwayChange[]; next: Map<string, boolean>; seeded: boolean } {
  const next = new Map<string, boolean>();
  const seeded = prev.size === 0;
  const changes: AwayChange[] = [];

  for (const client of current) {
    next.set(client.clid, client.isAway);
    if (seeded) continue;
    const was = prev.get(client.clid);
    if (was !== undefined && was !== client.isAway) {
      changes.push({ clid: client.clid, cid: client.cid, nickname: client.nickname, isAway: client.isAway });
    }
  }

  return { changes, next, seeded };
}
