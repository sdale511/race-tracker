// A tiny standalone wind display served by the base at GET /wind, meant to be embedded in an iframe (a RegattaUp page, a
// club website, a screen in the committee boat):
//
//   <iframe src="http://<base>:8092/wind" width="320" height="140" style="border:0"></iframe>
//
// It shows the newest Tempest wind sample (see tempestListener.js): a blue compass ring with a blue arrow pointing to where
// the wind is coming FROM, and the numbers, all in plain white: speed with the last minute's range under it (lull - gust),
// and the direction (the way a race committee reads it) with its swing over the last 10 minutes under it - also drawn as
// a band on the compass ring. mph only for now. (RegattaUp's own map arrow points the other way, downwind.)
//
// In a short iframe (70 px tall or less), or with ?size=compact, it becomes one line like RegattaUp's wind pill - a small
// arrow, the speed and the direction:
//
//   <iframe src="http://<base>:8092/wind?size=compact" width="150" height="28" style="border:0"></iframe> It updates the moment
// each reading reaches the base, over the GET /api/wind/stream Server-Sent Events stream (falling back to polling
// GET /api/wind every 3 s where that can't be used), scales to whatever size the iframe is, greys out once the reading
// is over 3 minutes old and says "No wind data" until there is any. ?theme=light for a light background (the default is
// dark).

const STALE_MS = 180000;

// The JSON behind the widget: the newest sample (or null), the last 10 minutes' direction swing ({from, to, width} or
// null - see tempestListener.js's directionSwing) and whether the base is listening at all.
function windApiPayload(listening, sample, swing = null) {
  return { listening, sample: sample || null, swing: swing || null, staleAfterMs: STALE_MS };
}

function renderWindWidget({ theme = 'dark', compact = false } = {}) {
  const light = theme === 'light';
  const c = light
    ? { bg: '#ffffff', fg: '#000000', arrow: '#0284c7' }
    : { bg: '#161b22', fg: '#ffffff', arrow: '#58a6ff' };
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wind</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: ${c.bg}; color: ${c.fg};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    display: flex; align-items: center; justify-content: center; overflow: hidden;
  }
  /* Everything sized from the frame's own height and width, so it fits any iframe. */
  .wind { display: flex; align-items: center; gap: 6vmin; padding: 4vmin; width: 100%; height: 100%; justify-content: center; }
  .wind.stale { opacity: 0.5; }
  .compass { height: min(86vh, 45vw); aspect-ratio: 1; flex-shrink: 0; }
  .compass svg { width: 100%; height: 100%; display: block; }
  .numbers { display: flex; flex-direction: column; gap: 1.5vmin; min-width: 0; }
  .speed { font-size: min(26vh, 13vw); font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .speed .unit { font-size: 0.4em; font-weight: 600; margin-left: 0.15em; }
  /* The direction, styled like the speed: a big number, the compass point small and muted like "mph". */
  .dir { font-size: min(20vh, 10vw); font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dir .unit { font-size: 0.55em; font-weight: 600; margin-left: 0.2em; }
  /* The last minute's lull - gust, low to high. */
  .detail { font-size: min(12vh, 6vw); font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .none { font-size: min(11vh, 6vw); }
  /* The direction's swing over the last 10 minutes, under the direction - the same style as the speed's range. */
  .swing { font-size: min(12vh, 6vw); font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
  /* Compact: one line - an arrow without the compass ring, the speed and the direction - sized from the frame's height,
     capped by its width. */
  @media (max-height: 70px) {
    .wind { gap: min(14vh, 3vw); padding: 0 min(22vh, 4vw); justify-content: flex-start; }
    .compass { height: 80vh; }
    .ring { display: none; }
    .arrow-size { transform: scale(1.7); transform-origin: 50px 50px; }
    .numbers { flex-direction: row; align-items: baseline; gap: min(16vh, 3.5vw); }
    .speed { font-size: min(50vh, 10vw); }
    .speed .unit { font-size: 0.75em; }
    .dir { font-size: min(50vh, 10vw); }
    .detail, .swing { display: none; }
    .none { font-size: min(44vh, 10vw); }
  }
  body.compact .wind { gap: min(14vh, 3vw); padding: 0 min(22vh, 4vw); justify-content: flex-start; }
  body.compact .compass { height: 80vh; }
  body.compact .ring { display: none; }
  body.compact .arrow-size { transform: scale(1.7); transform-origin: 50px 50px; }
  body.compact .numbers { flex-direction: row; align-items: baseline; gap: min(16vh, 3.5vw); }
  body.compact .speed { font-size: min(50vh, 10vw); }
  body.compact .speed .unit { font-size: 0.75em; }
  body.compact .dir { font-size: min(50vh, 10vw); }
  body.compact .detail, body.compact .swing { display: none; }
  body.compact .none { font-size: min(44vh, 10vw); }
</style>
</head>
<body${compact ? ' class="compact"' : ''}>
  <div class="wind" id="wind">
    <div class="compass">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle class="ring" cx="50" cy="50" r="44" fill="none" stroke="${c.arrow}" stroke-width="3"/>
        ${[90, 180, 270]
          .map((d) => `<line class="ring" x1="50" y1="6" x2="50" y2="11" stroke="${c.arrow}" stroke-width="2" transform="rotate(${d} 50 50)"/>`)
          .join('')}
        <text class="ring" x="50" y="17" text-anchor="middle" font-size="11" font-weight="800" fill="${c.fg}">N</text>
        <path id="swing" class="ring" d="" fill="none" stroke="${c.arrow}" stroke-width="8" stroke-opacity="0.6" style="display:none"/>
        <g class="arrow-size"><g id="arrow" style="display:none">
          <line x1="50" y1="68" x2="50" y2="40" stroke="${c.arrow}" stroke-width="7" stroke-linecap="round"/>
          <polygon points="50,26 37,44 63,44" fill="${c.arrow}"/>
        </g></g>
      </svg>
    </div>
    <div class="numbers" id="numbers"><div class="none">No wind data</div></div>
  </div>
  <script>
    const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const compass = (deg) => POINTS[Math.round(deg / 22.5) % 16];
    const ago = (ms) => {
      const s = Math.floor((Date.now() - ms) / 1000);
      return s < 5 ? 'just now' : s < 60 ? s + 's ago' : s < 3600 ? Math.floor(s / 60) + 'm ago' : Math.floor(s / 3600) + 'h ago';
    };
    const fmt = (v) => (v == null ? '—' : Number(v).toFixed(1));
    // The swing band runs on its own track just inside the ring (radius 37). A point on that track at a compass bearing,
    // and the clockwise arc from 'from' spanning 'width' degrees.
    const SWING_R = 37;
    const ringPoint = (deg) => {
      const r = (deg * Math.PI) / 180;
      return (50 + SWING_R * Math.sin(r)).toFixed(2) + ' ' + (50 - SWING_R * Math.cos(r)).toFixed(2);
    };
    const arcPath = (from, width) =>
      'M ' + ringPoint(from) + ' A ' + SWING_R + ' ' + SWING_R + ' 0 ' + (width > 180 ? 1 : 0) + ' 1 ' + ringPoint(from + width);
    function render(data) {
      const box = document.getElementById('wind');
      const numbers = document.getElementById('numbers');
      const arrow = document.getElementById('arrow');
      const s = data && data.sample;
      const swing = document.getElementById('swing');
      if (!s || s.dir == null || s.avg == null) {
        arrow.style.display = 'none';
        swing.style.display = 'none';
        box.classList.remove('stale');
        numbers.innerHTML = '<div class="none">' + (data && !data.listening ? 'Wind not available' : 'No wind data') + '</div>';
        return;
      }
      const stale = Date.now() - s.t > data.staleAfterMs;
      box.classList.toggle('stale', stale);
      arrow.style.display = '';
      // The arrow points to where the wind comes FROM - the reading's own direction. Set as the SVG attribute, not a CSS
      // transition: a transition is paused while the page is hidden (a background tab or an off-screen iframe), which
      // left the arrow pointing the wrong way, and it would swing the long way round when the wind crosses north.
      arrow.setAttribute('transform', 'rotate(' + (s.dir % 360) + ' 50 50)');
      // The last 10 minutes' direction swing: a band along the ring from 'from' clockwise to 'to' (a full circle once the
      // wind has been all the way round), and the same as numbers under the direction.
      const sw = data.swing;
      if (sw && sw.width > 0) {
        swing.style.display = '';
        swing.setAttribute('d', sw.width >= 359 ? 'M 50 13 A 37 37 0 1 1 49.99 13' : arcPath(sw.from, sw.width));
      } else {
        swing.style.display = 'none';
      }
      numbers.innerHTML =
        '<div class="speed">' + fmt(s.avg) + '<span class="unit">mph</span></div>' +
        '<div class="detail">' + fmt(s.lull) + ' – ' + fmt(s.gust) + '</div>' +
        '<div class="dir">' + Math.round(s.dir) + '°<span class="unit">' + compass(s.dir) + '</span></div>' +
        (sw && sw.width > 0 ? '<div class="swing">' + Math.round(sw.from) + '° – ' + Math.round(sw.to) + '°</div>' : '') +
        (stale ? '<div class="detail">' + ago(s.t) + '</div>' : '');
    }
    // Live: each reading is pushed the moment the base receives it. EventSource reconnects on its own after a dropped
    // connection; if the stream can't be used at all (no EventSource, or it fails repeatedly) poll instead.
    let last = null;
    const show = (data) => { last = data; render(data); };
    let pollTimer = null;
    async function poll() {
      try {
        show(await (await fetch('/api/wind', { cache: 'no-store' })).json());
      } catch (err) {
        // base unreachable for a moment - keep showing the last reading, try again next tick
      }
    }
    function startPolling() {
      if (pollTimer) return;
      poll();
      pollTimer = setInterval(poll, 3000);
    }
    if (window.EventSource) {
      let failures = 0;
      const stream = new EventSource('/api/wind/stream');
      stream.onmessage = (e) => { failures = 0; show(JSON.parse(e.data)); };
      stream.onerror = () => {
        if (++failures >= 3) { stream.close(); startPolling(); }
      };
    } else {
      startPolling();
    }
    // Re-drawn every 10 s without new data too, so a reading that stops arriving greys out and shows its age.
    setInterval(() => { if (last) render(last); }, 10000);
  </script>
</body>
</html>`;
}

module.exports = { renderWindWidget, windApiPayload, STALE_MS };
