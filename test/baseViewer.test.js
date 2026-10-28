const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createViewer, normalizeBaseUrl } = require('../src/baseViewer');
const { renderDashboard } = require('../src/adminServer');

const STATS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'base-stats.json'), 'utf8'));

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// A viewer on an ephemeral port with a fake clock and a scripted base: respond() is called per fetch.
async function withViewer(respond, fn, opts = {}) {
  let clock = 1000000;
  const calls = [];
  const logs = [];
  const viewer = createViewer({
    baseUrl: 'http://base.test:8092',
    timeoutMs: 50,
    cacheMs: 2000,
    now: () => clock,
    log: (line) => logs.push(line),
    fetchImpl: async (url, init) => {
      calls.push(url);
      return respond(url, init);
    },
    ...opts,
  });
  await new Promise((resolve) => viewer.server.listen(0, '127.0.0.1', resolve));
  const port = viewer.server.address().port;
  const get = async (urlPath = '/', method = 'GET') => {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method });
    return { status: res.status, body: await res.text() };
  };
  try {
    await fn({ get, calls, logs, advance: (ms) => (clock += ms), viewer });
  } finally {
    await new Promise((resolve) => viewer.server.close(resolve));
  }
}

test('normalizeBaseUrl accepts a bare host, host:port and a full URL', () => {
  assert.strictEqual(normalizeBaseUrl('pi.local'), 'http://pi.local:8092');
  assert.strictEqual(normalizeBaseUrl('pi.local:9000'), 'http://pi.local:9000');
  assert.strictEqual(normalizeBaseUrl('http://10.0.0.5:8092/some/path'), 'http://10.0.0.5:8092');
  assert.strictEqual(normalizeBaseUrl('https://base.example.com'), 'https://base.example.com');
  assert.strictEqual(normalizeBaseUrl('  http://pi.local  '), 'http://pi.local:8092');
});

test('normalizeBaseUrl rejects an empty or non-http address', () => {
  assert.throws(() => normalizeBaseUrl(''), /no base address/);
  assert.throws(() => normalizeBaseUrl(undefined), /no base address/);
  assert.throws(() => normalizeBaseUrl('ftp://pi.local'), /unsupported/);
});

test('the read-only dashboard has the fleet table and none of the controls', () => {
  const full = renderDashboard(STATS, false, 'home');
  const html = renderDashboard(STATS, false, 'home', { readOnly: true });

  // The editable page does carry every control, so the checks below are not vacuous.
  for (const control of ['Ping fleet</button>', 'Clear stats</button>', 'setPracticeMode(false, this)', 'id="regatta-select"', 'href="/map"', 'Wind display</a>']) {
    assert.ok(full.includes(control), `the normal dashboard should have ${control}`);
  }

  assert.ok(html.includes('<h2>Fleet</h2>'));
  assert.ok(html.includes('boat 00001'));
  for (const control of ['Ping fleet</button>', 'Clear stats</button>', 'setPracticeMode(false, this)', 'id="regatta-select"', 'href="/map"', 'href="/radio"', 'href="/wind"']) {
    assert.ok(!html.includes(control), `the read-only dashboard must not have ${control}`);
  }
  assert.ok(html.includes('race-tracker base viewer'));
  assert.ok(html.includes('base-pi'), "the base's host is shown");
  assert.ok(html.includes('test - JYC'), 'the regatta is shown as text');
});

test('the viewer serves the fleet page from the base stats, with the viewer title', async () => {
  await withViewer(
    () => jsonResponse(STATS),
    async ({ get, calls }) => {
      const res = await get('/');
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.includes('<title>race-tracker base viewer</title>'));
      assert.ok(res.body.includes('<h2>Fleet</h2>'));
      assert.ok(!res.body.includes('Base unreachable'));
      assert.deepStrictEqual(calls, ['http://base.test:8092/api/stats']);
    }
  );
});

test('the viewer only answers GET and HEAD, and only at /', async () => {
  await withViewer(
    () => jsonResponse(STATS),
    async ({ get, calls }) => {
      assert.strictEqual((await get('/api/ping-fleet', 'POST')).status, 405);
      assert.strictEqual((await get('/', 'POST')).status, 405);
      assert.strictEqual((await get('/', 'DELETE')).status, 405);
      assert.strictEqual((await get('/data')).status, 404);
      assert.strictEqual((await get('/api/stats')).status, 404);
      assert.strictEqual((await get('/', 'HEAD')).status, 200);
      assert.ok(calls.length <= 1, 'rejected requests never reach the base');
    }
  );
});

test('requests within the cache window share one fetch from the base', async () => {
  await withViewer(
    () => jsonResponse(STATS),
    async ({ get, calls, advance }) => {
      await Promise.all([get('/'), get('/'), get('/')]);
      await get('/');
      assert.strictEqual(calls.length, 1);
      advance(2500);
      await get('/');
      assert.strictEqual(calls.length, 2);
    }
  );
});

test('before the first answer an unreachable base gives a waiting page, not an error', async () => {
  await withViewer(
    () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    },
    async ({ get, logs }) => {
      const res = await get('/');
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.includes('Waiting for the base at'));
      assert.ok(res.body.includes('http://base.test:8092'));
      assert.ok(res.body.includes('ECONNREFUSED'));
      assert.ok(res.body.includes('http-equiv="refresh"'));
      assert.deepStrictEqual(logs, ['[baseViewer] base unreachable at http://base.test:8092: ECONNREFUSED']);
    }
  );
});

test('when the base stops answering the last reading stays up under an unreachable banner', async () => {
  let up = true;
  await withViewer(
    () => {
      if (up) return jsonResponse(STATS);
      throw new Error('boom');
    },
    async ({ get, logs, advance }) => {
      assert.ok(!(await get('/')).body.includes('Base unreachable'));
      up = false;
      advance(5000);
      const stale = await get('/');
      assert.strictEqual(stale.status, 200);
      assert.ok(stale.body.includes('Base unreachable at http://base.test:8092 (boom)'));
      assert.ok(stale.body.includes('5s ago') || stale.body.includes('ago.'), 'says how old the reading is');
      assert.ok(stale.body.includes('<h2>Fleet</h2>'), 'still shows the last fleet');

      up = true;
      advance(5000);
      const back = await get('/');
      assert.ok(!back.body.includes('Base unreachable'));
      assert.deepStrictEqual(logs, ['[baseViewer] base unreachable at http://base.test:8092: boom', '[baseViewer] base reachable again at http://base.test:8092']);
    }
  );
});

test('a base that answers with something that is not stats counts as unreachable', async () => {
  await withViewer(
    (url) => (url.endsWith('/api/stats') ? jsonResponse({ hello: 'world' }) : jsonResponse({}, 404)),
    async ({ get }) => {
      const res = await get('/');
      assert.ok(res.body.includes('Waiting for the base'));
      assert.ok(res.body.includes('not a base station'));
    }
  );
  await withViewer(
    () => jsonResponse({}, 502),
    async ({ get }) => {
      assert.ok((await get('/')).body.includes('HTTP 502'));
    }
  );
});

const base = (host, url, regatta = null) => ({ host, regatta, version: null, address: new URL(url).hostname, adminPort: 8092, url });

test('with no address the viewer finds the base by discovery and reads its stats', async () => {
  await withViewer(
    () => jsonResponse(STATS),
    async ({ get, calls, logs }) => {
      const res = await get('/');
      assert.ok(res.body.includes('<h2>Fleet</h2>'));
      assert.deepStrictEqual(calls, ['http://10.0.0.5:8092/api/stats']);
      assert.deepStrictEqual(logs, ['[baseViewer] found base base-pi at http://10.0.0.5:8092']);
    },
    { baseUrl: null, discover: async () => [base('base-pi', 'http://10.0.0.5:8092')] }
  );
});

test('when discovery hears no base the viewer waits and keeps looking', async () => {
  let found = [];
  await withViewer(
    () => jsonResponse(STATS),
    async ({ get, calls, advance }) => {
      const res = await get('/');
      assert.ok(res.body.includes('Looking for a base station on the local network'));
      assert.ok(res.body.includes('no base answered on the network'));
      assert.ok(res.body.includes('http-equiv="refresh"'));
      assert.deepStrictEqual(calls, []);

      found = [base('base-pi', 'http://10.0.0.5:8092')];
      advance(3000);
      assert.ok((await get('/')).body.includes('<h2>Fleet</h2>'));
    },
    { baseUrl: null, discover: async () => found }
  );
});

test('when several bases answer the viewer lists them instead of guessing', async () => {
  await withViewer(
    () => jsonResponse(STATS),
    async ({ get, calls }) => {
      const res = await get('/');
      assert.ok(res.body.includes('2 bases answered'));
      assert.ok(res.body.includes('npm run viewer -- http://10.0.0.5:8092'));
      assert.ok(res.body.includes('npm run viewer -- http://10.0.0.9:8092'));
      assert.ok(res.body.includes('sim-laptop'));
      assert.deepStrictEqual(calls, []);
    },
    { baseUrl: null, discover: async () => [base('base-pi', 'http://10.0.0.5:8092', 'JYC'), base('sim-laptop', 'http://10.0.0.9:8092')] }
  );
});

test('a discovered base that moves to a new address is found again', async () => {
  let at = 'http://10.0.0.5:8092';
  let down = false;
  let discoveries = 0;
  await withViewer(
    (url) => {
      if (down && url.startsWith('http://10.0.0.5')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } });
      return jsonResponse(STATS);
    },
    async ({ get, calls, logs, advance }) => {
      assert.ok((await get('/')).body.includes('<h2>Fleet</h2>'));
      down = true;
      at = 'http://10.0.0.77:8092';
      advance(3000);
      assert.ok((await get('/')).body.includes('Base unreachable'), 'too soon after the last search to look again');
      assert.strictEqual(discoveries, 1);

      advance(11000);
      await get('/'); // fails, then looks again and finds the same hostname at its new address
      assert.strictEqual(discoveries, 2);
      advance(3000);
      const back = await get('/');
      assert.ok(!back.body.includes('Base unreachable'));
      assert.strictEqual(calls[calls.length - 1], 'http://10.0.0.77:8092/api/stats');
      assert.ok(logs.includes('[baseViewer] found base base-pi at http://10.0.0.77:8092 (was http://10.0.0.5:8092)'));
    },
    {
      baseUrl: null,
      discover: async () => {
        discoveries++;
        return [base('base-pi', at)];
      },
    }
  );
});
