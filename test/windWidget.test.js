const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { renderWindWidget, windApiPayload, STALE_MS } = require('../src/windWidget');
const { startAdminServer } = require('../src/adminServer');

test('the API payload carries the newest sample, or null, and whether the base is listening', () => {
  const sample = { t: 1, dir: 200, avg: 6.5, gust: 8, lull: 5, station: 'ST-1', units: 'mph' };
  assert.deepStrictEqual(windApiPayload(true, sample), { listening: true, sample, staleAfterMs: STALE_MS });
  assert.deepStrictEqual(windApiPayload(false, undefined), { listening: false, sample: null, staleAfterMs: STALE_MS });
});

test('the arrow is turned to the reading\'s own direction - it points to where the wind comes from', () => {
  assert.ok(renderWindWidget().includes("'rotate(' + (s.dir % 360) + ' 50 50)'"));
});

test('the widget has a compact one-line layout for short frames, and ?size=compact forces it', () => {
  const page = renderWindWidget({ compact: true });
  assert.ok(page.includes('@media (max-height: 70px)'));
  assert.ok(page.includes('<body class="compact">'));
});

test('the widget page has the compass and polls /api/wind; ?theme=light swaps the colours', () => {
  const dark = renderWindWidget();
  assert.ok(dark.includes('id="arrow"') && dark.includes("fetch('/api/wind'") && dark.includes("new EventSource('/api/wind/stream')"));
  assert.ok(dark.includes('#161b22') && !dark.includes('#ffffff'));
  assert.ok(renderWindWidget({ theme: 'light' }).includes('background: #ffffff'));
});

test('the base serves /wind and /api/wind (any origin may read it)', async () => {
  const sample = { t: 1, dir: 200, avg: 6.5, gust: 8, lull: 5, station: 'ST-1', units: 'mph' };
  const server = startAdminServer({ port: 0, getStats: async () => ({}), getWind: () => ({ listening: true, sample }) });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const get = (path) =>
    new Promise((resolve, reject) => {
      http.get({ port, path }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ res, body }));
      }).on('error', reject);
    });
  try {
    const page = await get('/wind?theme=light');
    assert.strictEqual(page.res.statusCode, 200);
    assert.ok(page.body.includes('background: #ffffff'));
    assert.ok(!page.body.includes('<body class="compact">'));
    assert.ok((await get('/wind?size=compact')).body.includes('<body class="compact">'));
    const api = await get('/api/wind');
    assert.strictEqual(api.res.headers['access-control-allow-origin'], '*');
    assert.deepStrictEqual(JSON.parse(api.body).sample, sample);
  } finally {
    server.close();
  }
});

test('the live stream sends the current wind at once, pushes each new sample, and unsubscribes on disconnect', async () => {
  let sample = null;
  const subscribers = new Set();
  const server = startAdminServer({
    port: 0,
    getStats: async () => ({}),
    getWind: () => ({ listening: true, sample }),
    subscribeWind: (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  });
  await new Promise((r) => server.once('listening', r));
  const events = [];
  let gotEvent;
  const req = http.get({ port: server.address().port, path: '/api/wind/stream' }, (res) => {
    assert.strictEqual(res.headers['content-type'], 'text/event-stream');
    let buf = '';
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.startsWith('data: ')) {
          events.push(JSON.parse(block.slice(6)));
          if (gotEvent) gotEvent();
        }
      }
    });
  });
  const nextEvent = () => new Promise((r) => (gotEvent = r));
  try {
    await nextEvent();
    assert.strictEqual(events[0].sample, null); // nothing heard yet
    assert.strictEqual(subscribers.size, 1);
    sample = { t: 2, dir: 90, avg: 7, gust: 8, lull: 6, station: 'ST-1', units: 'mph' };
    const pushed = nextEvent();
    for (const fn of subscribers) fn(sample);
    await pushed;
    assert.deepStrictEqual(events[1].sample, sample);
  } finally {
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(subscribers.size, 0);
    server.close();
  }
});
