// The dashboard is served inline by the Worker. Phase 1: both columns poll
// every 5 seconds and measure end-to-end fetch latency.

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
  .spark { width: 100%; height: 32px; margin-top: 12px; display: block; }
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
</div>

<div class="grid">

  <div class="col">
    <h2>DIRECT · statsapi.mlb.com</h2>
    <div class="row"><span>p50</span><span id="d-p50">—</span></div>
    <div class="row"><span>p95</span><span id="d-p95">—</span></div>
    <div class="row"><span>p99</span><span id="d-p99">—</span></div>
    <div class="row"><span>Last bytes</span><span id="d-bytes">—</span></div>
    <div class="row"><span>Origin</span><span>statsapi.mlb.com</span></div>
    <div class="row"><span>Samples</span><span id="d-n">0</span></div>
    <canvas id="d-spark" class="spark" width="500" height="36"></canvas>
  </div>

  <div class="col edge">
    <h2>EDGE · Cloudflare Worker</h2>
    <div class="row"><span>p50</span><span id="e-p50">—</span></div>
    <div class="row"><span>p95</span><span id="e-p95">—</span></div>
    <div class="row"><span>p99</span><span id="e-p99">—</span></div>
    <div class="row"><span>Last bytes</span><span id="e-bytes">—</span></div>
    <div class="row"><span>Edge region</span><span id="e-region">—</span></div>
    <div class="row"><span>Upstream → fanout</span><span id="e-ratio">—</span></div>
    <div class="row"><span>Samples</span><span id="e-n">0</span></div>
    <canvas id="e-spark" class="spark" width="500" height="36"></canvas>
  </div>

</div>

<div class="method">
  <strong>Methodology.</strong> Both columns issue parallel <code>fetch()</code> requests
  every 5 seconds from this browser. Direct path returns MLB's full GUMBO feed
  (~400-500 KB). Edge path returns a slimmed snapshot served from a Cloudflare Worker
  with a 6-second cache. Lower bytes = faster decompression and parse on the client.
  Sample window is the most recent 60 requests per column.
</div>

<script>
(function () {
  let dHist = [];
  let eHist = [];
  let gameId = document.getElementById('gameId').value || '823545';

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

  function update() {
    const dMs = dHist.map(x => x.ms);
    const eMs = eHist.map(x => x.ms);
    document.getElementById('d-p50').textContent = fmtMs(pct(dMs, 0.5));
    document.getElementById('d-p95').textContent = fmtMs(pct(dMs, 0.95));
    document.getElementById('d-p99').textContent = fmtMs(pct(dMs, 0.99));
    document.getElementById('e-p50').textContent = fmtMs(pct(eMs, 0.5));
    document.getElementById('e-p95').textContent = fmtMs(pct(eMs, 0.95));
    document.getElementById('e-p99').textContent = fmtMs(pct(eMs, 0.99));
    document.getElementById('d-n').textContent = dHist.length;
    document.getElementById('e-n').textContent = eHist.length;
    if (dHist.length) document.getElementById('d-bytes').textContent = fmtBytes(dHist[dHist.length - 1].bytes);
    if (eHist.length) {
      document.getElementById('e-bytes').textContent = fmtBytes(eHist[eHist.length - 1].bytes);
      document.getElementById('e-region').textContent = eHist[eHist.length - 1].region || '—';
    }
    drawSpark('d-spark', dMs, getCSS('--direct'));
    drawSpark('e-spark', eMs, getCSS('--edge'));
  }

  function getCSS(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#5fa8d3';
  }

  function drawSpark(id, data, color) {
    const c = document.getElementById(id);
    const ctx = c.getContext('2d');
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

  function tick() {
    const t0 = performance.now();
    fetch('https://statsapi.mlb.com/api/v1.1/game/' + gameId + '/feed/live')
      .then(async r => {
        const text = await r.text();
        dHist.push({ ms: performance.now() - t0, bytes: text.length });
        if (dHist.length > 60) dHist.shift();
        update();
      })
      .catch(() => {});

    const t1 = performance.now();
    fetch('/api/game/' + gameId + '/snapshot')
      .then(async r => {
        const text = await r.text();
        let obj = {};
        try { obj = JSON.parse(text); } catch {}
        eHist.push({ ms: performance.now() - t1, bytes: text.length, region: obj.edgeRegion });
        if (eHist.length > 60) eHist.shift();
        update();
      })
      .catch(() => {});
  }

  function restart() {
    gameId = document.getElementById('gameId').value || '823545';
    dHist = []; eHist = [];
    update();
  }

  document.getElementById('switchBtn').addEventListener('click', restart);
  document.getElementById('gameId').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') restart();
  });

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

  tick();
  pollStats();
  setInterval(tick, 5000);
  setInterval(pollStats, 3000);
})();
</script>
</body>
</html>`;
