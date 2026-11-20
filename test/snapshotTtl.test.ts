import { describe, it, expect } from 'vitest';
import {
  snapshotTtlSeconds,
  LIVE_TTL_SECONDS,
  FINAL_TTL_SECONDS,
} from '../src/snapshot';

const feed = (abstractGameState: string, detailedState: string) => ({
  gameData: { status: { abstractGameState, detailedState } },
});

describe('snapshotTtlSeconds', () => {
  it('uses the short live TTL for an in-progress game', () => {
    expect(snapshotTtlSeconds(feed('Live', 'In Progress'))).toBe(LIVE_TTL_SECONDS);
  });

  it('uses the long TTL for every finished-game detailedState', () => {
    for (const detailed of ['Final', 'Game Over', 'Completed Early']) {
      expect(snapshotTtlSeconds(feed('Final', detailed))).toBe(FINAL_TTL_SECONDS);
    }
  });

  it('falls back to the live TTL when status is missing', () => {
    expect(snapshotTtlSeconds({})).toBe(LIVE_TTL_SECONDS);
    expect(snapshotTtlSeconds(undefined)).toBe(LIVE_TTL_SECONDS);
  });
});
