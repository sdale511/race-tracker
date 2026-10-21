const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

// RadioLink opens a real SerialPort; swap in a stand-in that answers like an XBee in transparent mode.
const writes = [];
class FakeSerialPort extends EventEmitter {
  constructor() {
    super();
    this.isOpen = false;
    setImmediate(() => { this.isOpen = true; this.emit('open'); });
  }
  write(data) {
    const text = Buffer.isBuffer(data) ? data.toString('latin1') : String(data);
    writes.push(text);
    const reply = (r) => setImmediate(() => this.emit('data', Buffer.from(r)));
    if (text === '+++' || /^AT(NI.+|WR|CN)\r$/.test(text)) reply('OK\r');
    else if (text === 'ATNI\r') reply('OLD\r');
    return true;
  }
}
require.cache[require.resolve('serialport')] = { exports: { SerialPort: FakeSerialPort } };
const xbeeAt = require('../src/xbeeAt');
const realSet = xbeeAt.setNodeIdentifier;
// RadioLink calls setNodeIdentifier with the real 1.1 s guard time; skip it in the test
require.cache[require.resolve('../src/xbeeAt')].exports.setNodeIdentifier = (io, ni) => realSet(io, ni, { guardMs: 0, timeoutMs: 200 });
const { RadioLink } = require('../src/radioLink');

test('RadioLink sets the node identifier before it says connected, and sends nothing in command mode', async () => {
  const radio = new RadioLink({ port: '/dev/fake', baud: 115200, nodeIdentifier: 'AB12C' });
  const events = [];
  let sentWhileBusy = null;
  radio.on('node-identifier', (r) => events.push(['node-identifier', r]));
  setImmediate(() => { sentWhileBusy = radio.send(Buffer.from([1, 2, 3])); }); // a send while the AT exchange runs
  await new Promise((resolve) => radio.on('connected', () => { events.push(['connected']); resolve(); }));
  assert.strictEqual(sentWhileBusy, false);
  assert.deepStrictEqual(events, [
    ['node-identifier', { wanted: 'AB12C', ok: true, previous: 'OLD', changed: true }],
    ['connected'],
  ]);
  assert.deepStrictEqual(writes, ['+++', 'ATNI\r', 'ATNIAB12C\r', 'ATWR\r', 'ATCN\r']);
  assert.strictEqual(radio.send(Buffer.from([1, 2, 3])), true); // back to normal afterwards
});

test('RadioLink without a node identifier says connected at once and never enters command mode', async () => {
  writes.length = 0;
  const radio = new RadioLink({ port: '/dev/fake', baud: 115200 });
  await new Promise((resolve) => radio.on('connected', resolve));
  assert.deepStrictEqual(writes, []);
});
