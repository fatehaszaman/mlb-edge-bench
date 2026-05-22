// The dashboard is served inline by the Worker. Kept as a single string so the
// Worker has zero static-asset binding requirements — wrangler deploy is enough.

export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MLB Edge Bench</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    --bg: #0a0e14;
    --panel: #141821;
    --panel-2: #1a1f2b;
    --border: #1f242e;
    --text: #e8e8e8;
    --muted: #888;
    --direct: #5fa8d3;
    --edge: #7ec699;
  }
  * { box-sizing: border-box; }
  body {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    background: var(--bg);
    color: var(--text);
    margin: 0;
    padding: 24px;
    min-height: 100vh;
  }
  h1 { font-size: 18px; margin: 0 0 4px; letter-spacing: 0.02em; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
  .sub a { color: var(--direct); text-decoration: none; }
  .sub a:hover { text-decoration: underline; }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    max-width: 1100px;
  }
  @media (max-width: 720px) {
    .grid { grid-template-columns: 1fr; }
  }
  .col {
    background: var(--panel);
    border-radius: 8px;
    padding: 20px;
    border: 1px solid var(--border);
  }
  .col h2 { font-size: 13px; margin: 0 0 16px; color: var(--direct); letter-spacing: 0.04em; }
  .col.edge h2 { color: var(--edge); }
  .row {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .row:last-child { border-bottom: none; }
  .row span:first-child { color: var(--muted); }
  .row span:last-child { font-variant-numeric: tabular-nums; }
  .spark { width: 100%; height: 36px; margin-top: 12px; display: block; }
  .method {
    color: var(--muted);
    font-size: 12px;
    margin-top: 24px;
    max-width: 1100px;
    line-height: 1.6;
  }
  .game-pick { margin: 12px 0 20px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .game-pick input {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid #2a2f3b;
    border-radius: 4px;
    padding: 6px 10px;
    font-family: inherit;
    font-size: 13px;
    width: 130px;
  }
  .game-pick button {
    background: var(--direct);
    color: var(--bg);
    border: none;
    padding: 6px 14px;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    font-weight: 600;
    font-size: 13px;
  }
  .game-pick button:hover { filter: brightness(1.1); }
  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    background: #1a1f2b;
    border: 1px solid #2a2f3b;
    color: var(--muted);
    font-size: 11px;
  }
  .pill.live { color: var(--edge); border-color: #2d4a3a; }
  .scoreboard {
    color: var(--muted);
    font-size: 13px;
    margin-top: 6px;
  }
  .wp-bar {
    width: 100%;
    height: 6px;
    background: var(--panel-2);
    border-radius: 3px;
    overflow: hidden;
    margin-top: 8px;
  }
  .wp-bar > div {
    height: 100%;
    background: linear-gradient(90deg, var(--edge), var(--direct));
    transition: width 0.4s ease;
  }
</style>
</head>
<body>

<h1>MLB Edge Bench</h1>
<div class="sub">
  Latency comparison: <code>statsapi.mlb.com</code> direct vs. Cloudflare edge layer ·
  measured from your browser
</div>

<div class="game-pick">
  <input id="gameId" value="823545" placeholder="game ID">
  <button id="switchBtn">Switch game</button>
  <span class="sub" style="margin:0">Try a recent gamePk from
    <a href="https://statsapi.mlb.com/api/v1/schedule?sportId=1" target="_blank" rel="noopener">today's schedule</a>
  </span>
  <span id="status-pill" class="pill">idle</span>
</div>

<div id="scoreboard" class="scoreboard"></div>
<div class="wp-bar"><div id="wp-fill" style="width:50%"></div></div>

<div class="grid" style="margin-top:20px">

  <div class="col">
    <h2>DIRECT · statsapi.mlb.com</h2>
    <div class="row"><span>p50</span><span id="d-p50">—</span></div>
    <div class="row"><span>p95</span><span id="d-p95">—</span></div>
    <div class="row"><span>p99</span><span id="d-p99">—</span></div>
    <div class="row"><span>Last bytes</span><span id="d-bytes">—</span></div>
    <div class="row"><span>Origin</span><span>statsapi.mlb.com (single origin)</span></div>
    <div class="row"><span>Samples</span><span id="d-n">0</span></div>
    <canvas id="d-spark" class="spark" width="500" height="36"></canvas>
  </div>

  <div class="col edge">
    <h2>EDGE · Cloudflare Worker (SSE)</h2>
    <div class="row"><span>Avg latency</span><span id="e-p50">—</span></div>
    <div class="row"><span>Avg bytes / update</span><span id="e-bytes">—</span></div>
    <div class="row"><span>Total bytes (60 updates)</span><span id="e-total">—</span></div>
    <div class="row"><span>Edge region</span><span id="e-region">—</span></div>
    <div class="row"><span>Upstream → fanout</span><span id="e-ratio">—</span></div>
    <div class="row"><span>Updates received</span><span id="e-n">0</span></div>
    <canvas id="e-spark" class="spark" width="500" height="36"></canvas>
  </div>

</div>

<div class="method">
  <strong>Methodology.</strong> Both columns observe the same game from the same client.
  The direct column issues <code>fetch()</code> requests every 5 seconds to MLB's full
  GUMBO feed (~400–500 KB). The edge column subscribes via Server-Sent Events to a
  Cloudflare Worker, which reads in-memory state from a Durable Object that polls MLB
  once per 6 seconds via the Alarms API. Each SSE message after the initial snapshot
  is a structural diff of just the fields that changed, so the per-update byte count
  is typically under a few hundred bytes. p50/p95/p99 are computed over the most
  recent 60 samples per column. Lower bytes also means faster decompression and parse
  on the client.
</div>

<script>
(function () {
  let dHist = [];
  let eHist = [];
  let gameId = document.getElementById('gameId').value || '823545';
  let es = null;
  let statsTimer = null;
  let scoreboardState = null;

  function pct(arr, p) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) * p)];
  }
  function fmtMs(ms) { return ms == null ? '—' : ms.toFixed(0) + ' ms'; }
  function fmtBytes(b) {
    if (b == null) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
  }
  function avg(arr) {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function update() {
    const dMs = dHist.map(x => x.ms);
    document.getElementById('d-p50').textContent = fmtMs(pct(dMs, 0.5));
    document.getElementById('d-p95').textContent = fmtMs(pct(dMs, 0.95));
    document.getElementById('d-p99').textContent = fmtMs(pct(dMs, 0.99));
    document.getElementById('d-n').textContent = dHist.length;
    if (dHist.length) {
      document.getElementById('d-bytes').textContent = fmtBytes(dHist[dHist.length - 1].bytes);
    }

    const eBytes = eHist.map(x => x.bytes);
    document.getElementById('e-p50').textContent = fmtMs(avg(eHist.map(x => x.ms).filter(v => v > 0)));
    document.getElementById('e-bytes').textContent = fmtBytes(avg(eBytes));
    document.getElementById('e-total').textContent = fmtBytes(eBytes.reduce((a, b) => a + b, 0));
    document.getElementById('e-n').textContent = eHist.length;
    if (eHist.length) {
      document.getElementById('e-region').textContent = eHist[eHist.length - 1].region || '—';
    }

    drawSpark('d-spark', dMs, getCSS('--direct'));
    drawSpark('e-spark', eBytes, getCSS('--edge'));
  }

  function getCSS(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#5fa8d3';
  }

  function drawSpark(id, data, color) {
    const c = document.getElementById(id);
    const ctx = c.getContext('2d');
    // Resize for crispness
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 500;
    const h = c.clientHeight || 36;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; ctx.scale(dpr, dpr); }
    ctx.clearRect(0, 0, w, h);
    if (!data.length) return;
    const max = Math.max(...data, 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = i * (w / Math.max(data.length - 1, 1));
      const y = h - (v / max) * (h - 2) - 1;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function applyScoreboard(s) {
    if (!s) return;
    scoreboardState = Object.assign(scoreboardState || {}, s);
    const half = scoreboardState.halfInning === 'T' ? 'Top' : 'Bot';
    const wp = (scoreboardState.homeWinProbability ?? 0.5) * 100;
    document.getElementById('scoreboard').innerHTML =
      '<strong>' + (scoreboardState.awayTeam || '—') + '</strong> ' +
      (scoreboardState.awayScore ?? 0) + ' @ ' +
      '<strong>' + (scoreboardState.homeTeam || '—') + '</strong> ' +
      (scoreboardState.homeScore ?? 0) +
      ' &middot; ' + half + ' ' + (scoreboardState.inning ?? 1) +
      ', ' + (scoreboardState.outs ?? 0) + ' out' +
      ' &middot; Home WP ' + wp.toFixed(1) + '%' +
      ' &middot; <span class="pill ' + (isLive(scoreboardState.status) ? 'live' : '') + '">' +
      (scoreboardState.status || 'unknown') + '</span>';
    document.getElementById('wp-fill').style.width = wp.toFixed(1) + '%';
    document.getElementById('status-pill').textContent =
      isLive(scoreboardState.status) ? 'streaming' : 'idle';
    document.getElementById('status-pill').className =
      'pill ' + (isLive(scoreboardState.status) ? 'live' : '');
  }
  function isLive(status) {
    if (!status) return false;
    return !['Final', 'Game Over', 'Completed Early', 'Postponed', 'Scheduled'].includes(status);
  }

  function tickDirect() {
    const t0 = performance.now();
    fetch('https://statsapi.mlb.com/api/v1.1/game/' + gameId + '/feed/live')
      .then(async r => {
        const text = await r.text();
        dHist.push({ ms: performance.now() - t0, bytes: text.length });
        if (dHist.length > 60) dHist.shift();
        update();
      })
      .catch(() => {});
  }

  function openStream() {
    if (es) es.close();
    es = new EventSource('/api/game/' + gameId + '/stream');
    es.onmessage = (ev) => {
      const t = performance.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const region = (msg.payload && msg.payload.edgeRegion) || (scoreboardState && scoreboardState.edgeRegion) || '—';
      eHist.push({
        ms: msg.type === 'full' ? (msg.payload && msg.payload.edgeLatencyMs) || 0 : 0,
        bytes: ev.data.length,
        region: region,
      });
      if (eHist.length > 60) eHist.shift();
      applyScoreboard(msg.payload || {});
      update();
    };
    es.onerror = () => {
      // EventSource auto-reconnects; surface state in pill
      document.getElementById('status-pill').textContent = 'reconnecting';
    };
  }

  async function pollStats() {
    try {
      const r = await fetch('/api/game/' + gameId + '/stats');
      if (!r.ok) return;
      const s = await r.json();
      const ratio = s.upstreamCount > 0
        ? (s.fanoutCount / s.upstreamCount).toFixed(1) + ':1'
        : '—';
      document.getElementById('e-ratio').textContent =
        s.upstreamCount + ' → ' + s.fanoutCount + ' (' + ratio + ')';
    } catch {}
  }

  function restart() {
    gameId = document.getElementById('gameId').value || '746429';
    dHist = []; eHist = []; scoreboardState = null;
    update();
    openStream();
  }

  document.getElementById('switchBtn').addEventListener('click', restart);
  document.getElementById('gameId').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') restart();
  });

  // Boot
  tickDirect();
  openStream();
  pollStats();
  setInterval(tickDirect, 5000);
  statsTimer = setInterval(pollStats, 3000);
  // Periodic spark refresh in case of long idle
  setInterval(update, 1000);
})();
</script>
</body>
</html>`;
