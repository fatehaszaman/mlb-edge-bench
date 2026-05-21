// MLB Edge Bench — Cloudflare Worker entry point.
//
// Routes
//   GET /                            → static dashboard
//   GET /health                      → { status, edgeRegion }
//   GET /api/game/:id/snapshot       → slimmed JSON snapshot, served from DO
//   GET /api/game/:id/stream         → SSE stream of full snapshot + diffs
//   GET /api/game/:id/stats          → DO upstream/fanout counters
//
// Architecture
//   Each gamePk maps to a single GameStateDO instance via
//   env.GAME_STATE.idFromName(gameId). The DO polls MLB's GUMBO feed every
//   6 seconds via the Alarms API and holds the slimmed snapshot in memory.
//   All viewer requests read the DO's state — upstream load is constant
//   regardless of viewer count. SSE pushes structural diffs to clients.

import { DurableObject } from 'cloudflare:workers';
import { DASHBOARD_HTML } from './dashboard';
import {
  GameSnapshot,
  extractSnapshot,
  computeDiff,
} from './snapshot';

export interface Env {
  GAME_STATE: DurableObjectNamespace<GameStateDO>;
}

const MLB_FEED = (gameId: string) =>
  `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;

const TERMINAL_STATUSES = new Set([
  'Final',
  'Game Over',
  'Completed Early',
  'Postponed',
  'Cancelled',
]);

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const colo = (request.cf?.colo as string) ?? 'unknown';

    // CORS preflight (the direct path is cross-origin from the dashboard's
    // perspective only when run outside the Worker — we still allow it.)
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Dashboard
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(DASHBOARD_HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=60',
        },
      });
    }

    // Health
    if (url.pathname === '/health') {
      return Response.json(
        { status: 'ok', edgeRegion: colo, ts: new Date().toISOString() },
        { headers: corsHeaders() }
      );
    }

    // /api/game/:id/snapshot
    const snapMatch = url.pathname.match(/^\/api\/game\/(\d+)\/snapshot$/);
    if (snapMatch) {
      return handleSnapshot(snapMatch[1], env, colo);
    }

    // /api/game/:id/stream  (SSE)
    const streamMatch = url.pathname.match(/^\/api\/game\/(\d+)\/stream$/);
    if (streamMatch) {
      return handleStream(streamMatch[1], env, colo, ctx);
    }

    // /api/game/:id/stats
    const statsMatch = url.pathname.match(/^\/api\/game\/(\d+)\/stats$/);
    if (statsMatch) {
      return handleStats(statsMatch[1], env);
    }

    return Response.json(
      { error: 'not found', path: url.pathname },
      { status: 404, headers: corsHeaders() }
    );
  },
};

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleSnapshot(
  gameId: string,
  env: Env,
  colo: string
): Promise<Response> {
  const id = env.GAME_STATE.idFromName(gameId);
  const stub = env.GAME_STATE.get(id);
  const t0 = Date.now();
  try {
    const snapshot = await stub.getSnapshot(gameId, colo);
    if (!snapshot) {
      return Response.json(
        { error: 'game not available' },
        { status: 404, headers: corsHeaders('MISS') }
      );
    }
    snapshot.edgeLatencyMs = Date.now() - t0;
    return Response.json(snapshot, { headers: corsHeaders('DO') });
  } catch (err) {
    return Response.json(
      { error: 'internal', detail: String(err) },
      { status: 500, headers: corsHeaders() }
    );
  }
}

async function handleStats(gameId: string, env: Env): Promise<Response> {
  const id = env.GAME_STATE.idFromName(gameId);
  const stub = env.GAME_STATE.get(id);
  try {
    const stats = await stub.stats();
    return Response.json(stats, { headers: corsHeaders() });
  } catch (err) {
    return Response.json(
      { error: 'internal', detail: String(err) },
      { status: 500, headers: corsHeaders() }
    );
  }
}

async function handleStream(
  gameId: string,
  env: Env,
  colo: string,
  _ctx: ExecutionContext
): Promise<Response> {
  const id = env.GAME_STATE.idFromName(gameId);
  const stub = env.GAME_STATE.get(id);

  let lastSent: GameSnapshot | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
          );
        } catch {
          // Controller already closed.
        }
      };

      // Initial full snapshot
      try {
        const initial = await stub.getSnapshot(gameId, colo);
        if (initial) {
          send({ type: 'full', payload: initial });
          lastSent = initial;
        } else {
          send({ type: 'error', payload: { message: 'game not available' } });
        }
      } catch (err) {
        send({ type: 'error', payload: { message: String(err) } });
      }

      // Poll the DO every 2s and emit a diff if anything changed.
      interval = setInterval(async () => {
        try {
          const snap = await stub.getSnapshot(gameId, colo);
          if (!snap) return;
          if (lastSent) {
            const diff = computeDiff(
              lastSent as unknown as Record<string, any>,
              snap as unknown as Record<string, any>
            );
            // Ignore diffs that only changed the latency/fetchedAt fields —
            // those are read-side artifacts, not game state.
            const meaningful = Object.keys(diff).filter(
              (k) => k !== 'edgeLatencyMs' && k !== 'fetchedAt'
            );
            if (meaningful.length) {
              const meaningfulDiff: Record<string, any> = {};
              for (const k of meaningful) meaningfulDiff[k] = (diff as any)[k];
              send({ type: 'diff', payload: meaningfulDiff });
            } else {
              // Heartbeat with empty payload keeps the column ticking and
              // proxies happy. Comment line is ignored by EventSource.
              try {
                controller.enqueue(encoder.encode(`: keepalive\n\n`));
              } catch {}
            }
          }
          lastSent = snap;
        } catch {
          /* swallow — next tick will retry */
        }
      }, 2000);

      // Free-tier safety: cap each connection at 5 minutes; client reconnects.
      killTimer = setTimeout(() => {
        if (interval) clearInterval(interval);
        try {
          controller.close();
        } catch {}
      }, 5 * 60 * 1000);
    },
    cancel() {
      if (interval) clearInterval(interval);
      if (killTimer) clearTimeout(killTimer);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function corsHeaders(cacheStatus?: string): HeadersInit {
  const h: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (cacheStatus) h['X-Cache'] = cacheStatus;
  return h;
}

// ---------------------------------------------------------------------------
// Durable Object: one per active gamePk
// ---------------------------------------------------------------------------

export class GameStateDO extends DurableObject<Env> {
  private snapshot: GameSnapshot | null = null;
  private gameId: string = '';
  private upstreamCount: number = 0;
  private fanoutCount: number = 0;
  private lastError: string | null = null;
  private lastPolledAt: number = 0;

  /**
   * Called by the Worker on every viewer request. Lazily kicks off the alarm
   * loop on first contact and serves the in-memory snapshot to every caller.
   */
  async getSnapshot(
    gameId: string,
    colo: string
  ): Promise<GameSnapshot | null> {
    this.gameId = gameId;

    // Ensure the alarm loop is running.
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm) {
      await this.ctx.storage.setAlarm(Date.now() + 100);
    }

    // First contact: prime the cache synchronously so the very first viewer
    // doesn't get a null.
    if (!this.snapshot) {
      this.snapshot = await this.pollMLB();
    }

    this.fanoutCount++;
    if (!this.snapshot) return null;

    // Return a copy with the live colo (the cached colo on the DO instance
    // would be misleading — what matters is which colo served the viewer).
    return { ...this.snapshot, edgeRegion: colo };
  }

  async stats(): Promise<{
    upstreamCount: number;
    fanoutCount: number;
    lastPolledAt: number;
    lastError: string | null;
    gameId: string;
    status: string | null;
  }> {
    return {
      upstreamCount: this.upstreamCount,
      fanoutCount: this.fanoutCount,
      lastPolledAt: this.lastPolledAt,
      lastError: this.lastError,
      gameId: this.gameId,
      status: this.snapshot?.status ?? null,
    };
  }

  /**
   * Alarms API: the DO wakes itself up on its own schedule and polls MLB.
   * One upstream request per game per 6 seconds, regardless of viewer count.
   */
  async alarm(): Promise<void> {
    const snap = await this.pollMLB();
    if (snap) this.snapshot = snap;

    const status = this.snapshot?.status ?? '';
    const isTerminal = TERMINAL_STATUSES.has(status);
    if (!isTerminal) {
      await this.ctx.storage.setAlarm(Date.now() + 6_000);
    }
    // If terminal, we let the DO go idle; cached snapshot remains served until
    // the instance is evicted, after which the next viewer re-primes it.
  }

  private async pollMLB(): Promise<GameSnapshot | null> {
    this.upstreamCount++;
    this.lastPolledAt = Date.now();
    try {
      const res = await fetch(MLB_FEED(this.gameId), {
        headers: { 'User-Agent': 'mlb-edge-bench/0.1 (+github.com)' },
      });
      if (!res.ok) {
        this.lastError = `mlb ${res.status}`;
        return this.snapshot;
      }
      const raw = (await res.json()) as any;
      const snap = extractSnapshot(this.gameId, raw, 'do', 0);
      if (snap) this.lastError = null;
      return snap;
    } catch (err) {
      this.lastError = String(err);
      return this.snapshot;
    }
  }
}
