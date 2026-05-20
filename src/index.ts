export interface Env {}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', edgeRegion: request.cf?.colo ?? 'unknown' });
    }
    return new Response('mlb-edge-bench', { headers: { 'Content-Type': 'text/plain' } });
  },
};
