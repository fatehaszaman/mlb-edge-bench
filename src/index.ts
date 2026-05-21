import { DurableObject } from 'cloudflare:workers';
import { GameSnapshot, extractSnapshot } from './snapshot';
import { DASHBOARD_HTML } from './dashboard';

export interface Env {
  GAME_STATE: DurableObjectNamespace<GameStateDO>;
}

const MLB_FEED = (gameId: string) =>
  `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;

const TERMINAL_STATUSES = new Set([
  'Final', 'Game Over', 'Completed Early', 'Postponed', 'Cancelled',
]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const colo = (request.cf?.colo as string) ?? 'unknown';

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', edgeRegion: colo });
    }

    const snapMatch = url.pathname.match(/^\/api\/game\/(\d+)\/snapshot$/);
    if (snapMatch) {
      const gameId = snapMatch[1];
      const id = env.GAME_STATE.idFromName(gameId);
      const stub = env.GAME_STATE.get(id);
      const t0 = Date.now();
      const snap = await stub.getSnapshot(gameId, colo);
      if (!snap) return Response.json({ error: 'game not available' }, { status: 404, headers: corsHeaders() });
      snap.edgeLatencyMs = Date.now() - t0;
      return Response.json(snap, { headers: corsHeaders('DO') });
    }

    const statsMatch = url.pathname.match(/^\/api\/game\/(\d+)\/stats$/);
    if (statsMatch) {
      const id = env.GAME_STATE.idFromName(statsMatch[1]);
      const stub = env.GAME_STATE.get(id);
      return Response.json(await stub.stats(), { headers: corsHeaders() });
    }

    return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders() });
  },
};

function corsHeaders(cacheStatus?: string): HeadersInit {
  const h: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  if (cacheStatus) h['X-Cache'] = cacheStatus;
  return h;
}

export class GameStateDO extends DurableObject<Env> {
  private snapshot: GameSnapshot | null = null;
  private gameId: string = '';
  private upstreamCount: number = 0;
  private fanoutCount: number = 0;
  private lastError: string | null = null;
  private lastPolledAt: number = 0;

  async getSnapshot(gameId: string, colo: string): Promise<GameSnapshot | null> {
    this.gameId = gameId;
    const alarm = await this.ctx.storage.getAlarm();
    if (!alarm) await this.ctx.storage.setAlarm(Date.now() + 100);
    if (!this.snapshot) this.snapshot = await this.pollMLB();
    this.fanoutCount++;
    if (!this.snapshot) return null;
    return { ...this.snapshot, edgeRegion: colo };
  }

  async stats() {
    return {
      upstreamCount: this.upstreamCount,
      fanoutCount: this.fanoutCount,
      lastPolledAt: this.lastPolledAt,
      lastError: this.lastError,
      gameId: this.gameId,
      status: this.snapshot?.status ?? null,
    };
  }

  async alarm(): Promise<void> {
    const snap = await this.pollMLB();
    if (snap) this.snapshot = snap;
    const status = this.snapshot?.status ?? '';
    if (!TERMINAL_STATUSES.has(status)) {
      await this.ctx.storage.setAlarm(Date.now() + 6_000);
    }
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
      const raw = await res.json();
      const snap = extractSnapshot(this.gameId, raw, 'do', 0);
      if (snap) this.lastError = null;
      return snap;
    } catch (err) {
      this.lastError = String(err);
      return this.snapshot;
    }
  }
}
