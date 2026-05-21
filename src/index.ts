// MLB Edge Bench — Cloudflare Worker entry point (free-tier build).
//
// Routes
//   GET /                            → static dashboard
//   GET /health                      → { status, edgeRegion }
//   GET /api/game/:id/snapshot       → slimmed JSON snapshot (cached at edge)
//
// Architecture (free tier)
//   The Worker fetches MLB's GUMBO feed, extracts a slimmed snapshot, and
//   caches it in `caches.default` for 6 seconds. Concurrent viewers from the
//   same colo share the cache, so upstream load drops to ~1 request per game
//   per 6s per colo. The Durable-Object-based fanout is on a separate branch
//   for when this graduates to the paid plan.

import { GameSnapshot, extractSnapshot } from './snapshot';
import { DASHBOARD_HTML } from './dashboard';

export interface Env {}

const MLB_FEED = (gameId: string) =>
  `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const colo = (request.cf?.colo as string) ?? 'unknown';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(DASHBOARD_HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=60',
        },
      });
    }

    if (url.pathname === '/health') {
      return Response.json(
        { status: 'ok', edgeRegion: colo, ts: new Date().toISOString() },
        { headers: corsHeaders() }
      );
    }

    const snapMatch = url.pathname.match(/^\/api\/game\/(\d+)\/snapshot$/);
    if (snapMatch) {
      return handleSnapshot(snapMatch[1], colo, ctx);
    }

    return Response.json(
      { error: 'not found', path: url.pathname },
      { status: 404, headers: corsHeaders() }
    );
  },
};

async function handleSnapshot(
  gameId: string,
  colo: string,
  ctx: ExecutionContext
): Promise<Response> {
  const t0 = Date.now();
  const cacheKey = new Request(`https://cache.local/snapshot/${gameId}`);
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = (await cached.json()) as GameSnapshot;
    body.edgeRegion = colo;
    body.edgeLatencyMs = Date.now() - t0;
    return Response.json(body, { headers: corsHeaders('HIT') });
  }

  try {
    const mlbRes = await fetch(MLB_FEED(gameId), {
      headers: { 'User-Agent': 'mlb-edge-bench/0.1 (+github.com)' },
    });
    if (!mlbRes.ok) {
      return Response.json(
        { error: `mlb ${mlbRes.status}` },
        { status: 502, headers: corsHeaders() }
      );
    }
    const raw = (await mlbRes.json()) as any;
    const snap = extractSnapshot(gameId, raw, colo, Date.now() - t0);
    if (!snap) {
      return Response.json(
        { error: 'parse error' },
        { status: 502, headers: corsHeaders() }
      );
    }

    const response = Response.json(snap, { headers: corsHeaders('MISS') });
    ctx.waitUntil(
      cache.put(
        cacheKey,
        new Response(JSON.stringify(snap), {
          headers: {
            'Cache-Control': 'public, max-age=6',
            'Content-Type': 'application/json',
          },
        })
      )
    );
    return response;
  } catch (err) {
    return Response.json(
      { error: 'internal', detail: String(err) },
      { status: 500, headers: corsHeaders() }
    );
  }
}

function corsHeaders(cacheStatus?: string): HeadersInit {
  const h: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Expose X-Cache so the dashboard can tally hit rate. Without this, browsers
    // strip it on cross-origin reads (the dashboard reads it from same-origin
    // here, but be explicit so the snapshot endpoint is correct anywhere.)
    'Access-Control-Expose-Headers': 'X-Cache',
  };
  if (cacheStatus) h['X-Cache'] = cacheStatus;
  return h;
}
