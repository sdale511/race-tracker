// The pieces of the RF test mode (fleetSim.js with RF_BRIDGE=1): the real radio hands each frame's bytes to the bridge, and a
// simulated boat's IPC radio turns those bytes back into the events a real radio would give it. Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const protocol = require('../src/protocol');
const { RadioLink } = require('../src/radioLink');
const { IpcRadioLink } = require('../src/ipcRadioLink');

const slotTable = () => protocol.encodeSlotTable({ version: 3, slotCount: 22, slotWidthMs: 40, joinSlots: 2, entries: [{ boatId: 'BOAT1', slot: 4 }] });

// A RadioLink without a serial port: only its byte scanner is used
function bareRadioLink() {
  const r = Object.create(RadioLink.prototype);
  EventEmitter.call(r);
  r._buf = Buffer.alloc(0);
  return r;
}

test('the real radio link hands the bridge each frame\'s own bytes, even when they arrive in pieces and around noise', () => {
  const radio = bareRadioLink();
  const raw = [];
  const events = [];
  radio.on('raw-frame', (b) => raw.push(Buffer.from(b)));
  radio.on('slot-table', (t) => events.push(t));
  const frame = slotTable();
  radio._onData(Buffer.concat([Buffer.from([0x00, 0x01]), frame.subarray(0, 5)]));
  assert.strictEqual(raw.length, 0, 'half a frame is not a frame yet');
  radio._onData(frame.subarray(5));
  assert.strictEqual(raw.length, 1);
  assert.ok(raw[0].equals(frame), 'the exact bytes, without the noise before them');
  assert.strictEqual(events.length, 1);
});

test('a boat\'s IPC radio hears what the bridge relays and sends frames to the bridge', () => {
  const sent = [];
  const realSend = process.send;
  const realConnected = process.connected;
  process.send = (m) => sent.push(m);
  Object.defineProperty(process, 'connected', { value: true, configurable: true });
  try {
    const radio = new IpcRadioLink();
    const heard = [];
    radio.on('slot-table', (t) => heard.push(t));
    process.emit('message', { radioRx: slotTable().toString('base64') });
    process.emit('message', 'start-race'); // fleetSim's own messages are not radio traffic
    assert.strictEqual(heard.length, 1);
    assert.strictEqual(heard[0].entries[0].boatId, 'BOAT1');

    const frame = slotTable();
    assert.strictEqual(radio.send(frame), true);
    assert.deepStrictEqual(sent, [{ radioTx: frame.toString('base64') }]);

    radio.setSleeping(true); // radio sleep mode: deaf and silent, like a real XBee in pin sleep
    process.emit('message', { radioRx: slotTable().toString('base64') });
    assert.strictEqual(heard.length, 1);
    assert.strictEqual(radio.send(frame), false);
  } finally {
    process.send = realSend;
    Object.defineProperty(process, 'connected', { value: realConnected, configurable: true });
    process.removeAllListeners('message');
  }
});
