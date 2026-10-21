const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { setNodeIdentifier } = require('../src/xbeeAt');

// A fake XBee in transparent mode: answers +++ with OK, then ATNI / ATNI<x> / ATWR / ATCN as the real one does.
function fakeXbee({ ni = '', answersPlus = true, noiseBeforeOk = null } = {}) {
  const radio = new EventEmitter();
  const state = { ni, written: [], saved: false, inCommandMode: false };
  const reply = (text) => setImmediate(() => radio.emit('data', Buffer.from(text, 'latin1')));
  const io = {
    write: (text) => {
      state.written.push(text);
      if (text === '+++') {
        if (!answersPlus) return;
        if (noiseBeforeOk) reply(noiseBeforeOk);
        state.inCommandMode = true;
        return reply('OK\r');
      }
      if (!state.inCommandMode) return;
      const cmd = text.replace(/\r$/, '');
      if (cmd === 'ATNI') return reply(`${state.ni}\r`);
      if (cmd.startsWith('ATNI')) { state.ni = cmd.slice(4); return reply('OK\r'); }
      if (cmd === 'ATWR') { state.saved = true; return reply('OK\r'); }
      if (cmd === 'ATCN') { state.inCommandMode = false; return reply('OK\r'); }
      reply('ERROR\r');
    },
    onData: (cb) => { radio.on('data', cb); return () => radio.off('data', cb); },
  };
  return { io, state };
}
const fast = { guardMs: 0, timeoutMs: 200 };

test('a radio with another name is renamed to the boat id and saved, then leaves command mode', async () => {
  const { io, state } = fakeXbee({ ni: 'OLDNAME' });
  assert.deepStrictEqual(await setNodeIdentifier(io, 'AB12C', fast), { ok: true, previous: 'OLDNAME', changed: true });
  assert.strictEqual(state.ni, 'AB12C');
  assert.strictEqual(state.saved, true);
  assert.strictEqual(state.inCommandMode, false);
});

test('a radio already named the boat id is left alone: no ATNI write, no ATWR', async () => {
  const { io, state } = fakeXbee({ ni: 'AB12C' });
  assert.deepStrictEqual(await setNodeIdentifier(io, 'AB12C', fast), { ok: true, previous: 'AB12C', changed: false });
  assert.deepStrictEqual(state.written, ['+++', 'ATNI\r', 'ATCN\r']);
  assert.strictEqual(state.saved, false);
});

test('a blank node identifier counts as different', async () => {
  const { io, state } = fakeXbee({ ni: '' });
  assert.strictEqual((await setNodeIdentifier(io, 'AB12C', fast)).changed, true);
  assert.strictEqual(state.ni, 'AB12C');
});

test('frames from the air arriving before the OK (binary, with a \\r in them) do not count as the reply', async () => {
  const { io, state } = fakeXbee({ ni: 'X', noiseBeforeOk: '\xa5\x0d\x01junk\x0d' });
  assert.strictEqual((await setNodeIdentifier(io, 'AB12C', fast)).ok, true);
  assert.strictEqual(state.ni, 'AB12C');
});

test('no OK after +++ (not an XBee, or wrong baud) fails without sending any AT command', async () => {
  const { io, state } = fakeXbee({ answersPlus: false });
  const result = await setNodeIdentifier(io, 'AB12C', fast);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /no "OK" after \+\+\+/);
  assert.deepStrictEqual(state.written, ['+++']);
});

test('a node identifier that is not 1-20 printable characters is refused before touching the radio', async () => {
  const { io, state } = fakeXbee();
  assert.strictEqual((await setNodeIdentifier(io, 'x'.repeat(21), fast)).ok, false);
  assert.strictEqual((await setNodeIdentifier(io, 'bad\nid', fast)).ok, false);
  assert.deepStrictEqual(state.written, []);
});
