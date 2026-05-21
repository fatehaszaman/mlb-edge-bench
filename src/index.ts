import { GameSnapshot, extractSnapshot } from './snapshot';

export interface Env {}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const colo = (request.cf?.colo as string) ?? 'unknown';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', edgeRegion: colo });
    }

    const snapMatch = url.pathname.match(/^\/api\/game\/(\d+)\/snapshot$/);
    if (!snapMatch) {
      return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders() });
    }

    const gameId = snapMatch[1];
    const t0 = Date.now();

    // Simple edge cache for now. Phase 2 swaps in a Durable Object.
    const cacheKey = new Request(`https://cache.local/snapshot/${gameId}`, request);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const body = (await cached.json()) as GameSnapshot;
      body.edgeRegion = colo;
      body.edgeLatencyMs = Date.now() - t0;
      return Response.json(body, { headers: corsHeaders('HIT') });
    }

    const mlbRes = await fetch(`https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`);
    if (!mlbRes.ok) {
      return Response.json({ error: `mlb ${mlbRes.status}` }, { status: 502, headers: corsHeaders() });
    }
    const raw = await mlbRes.json();
    const snap = extractSnapshot(gameId, raw, colo, Date.now() - t0);
    if (!snap) {
      return Response.json({ error: 'parse error' }, { status: 502, headers: corsHeaders() });
    }

    const response = Response.json(snap, { headers: corsHeaders('MISS') });
    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(JSON.stringify(snap), {
          headers: { 'Cache-Control': 'public, max-age=6', 'Content-Type': 'application/json' },
        })
      )
    );
    return response;
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
