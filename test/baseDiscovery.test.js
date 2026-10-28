const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const { broadcastTargets, startResponder, discover, parseReply } = require('../src/baseDiscovery');

const INFO = { host: 'base-pi', version: 'commit abc1234', adminPort: 8092, regatta: 'test - JYC' };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withResponder(opts, fn) {
  const { socket, port } = await startResponder({ port: 0, address: '127.0.0.1', getInfo: () => INFO, ...opts });
  try {
    await fn(port);
  } finally {
    socket.close();
  }
}

test('broadcastTargets gives each external interface its directed broadcast, plus the limited one', () => {
  const targets = broadcastTargets({
    lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    en0: [
      { family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false },
      { family: 'IPv4', address: '192.168.1.10', netmask: '255.255.255.0', internal: false },
    ],
    en1: [{ family: 'IPv4', address: '10.0.17.5', netmask: '255.255.240.0', internal: false }],
  });
  assert.deepStrictEqual(targets.sort(), ['10.0.31.255', '192.168.1.255', '255.255.255.255']);
});

test('a probe is answered with the base info, and the viewer takes the address from the packet', async () => {
  await withResponder({}, async (port) => {
    const found = await discover({ port, targets: ['127.0.0.1'], timeoutMs: 400, intervalMs: 100 });
    assert.strictEqual(found.length, 1, 'repeated probes still give one base');
    assert.deepStrictEqual(found[0], { ...INFO, address: '127.0.0.1', url: 'http://127.0.0.1:8092' });
  });
});

test('discovery finds nothing, without failing, when no base answers', async () => {
  const silent = dgram.createSocket('udp4');
  await new Promise((resolve) => silent.bind(0, '127.0.0.1', resolve));
  const { port } = silent.address();
  try {
    assert.deepStrictEqual(await discover({ port, targets: ['127.0.0.1'], timeoutMs: 250, intervalMs: 100 }), []);
  } finally {
    silent.close();
  }
});

test('the responder ignores anything that is not a probe', async () => {
  await withResponder({}, async (port) => {
    const client = dgram.createSocket('udp4');
    const heard = [];
    client.on('message', (buf) => heard.push(buf.toString()));
    await new Promise((resolve) => client.bind(0, '127.0.0.1', resolve));
    for (const junk of ['hello', '{"probe":"something-else"}', '{"nope":1}', '']) client.send(junk, port, '127.0.0.1');
    await wait(150);
    client.close();
    assert.deepStrictEqual(heard, []);
  });
});

test('the responder caps how many answers it sends in a second', async () => {
  await withResponder({ now: () => 5000 }, async (port) => {
    const client = dgram.createSocket('udp4');
    let heard = 0;
    client.on('message', () => heard++);
    await new Promise((resolve) => client.bind(0, '127.0.0.1', resolve));
    for (let i = 0; i < 30; i++) client.send('{"probe":"race-tracker-base"}', port, '127.0.0.1');
    await wait(300);
    client.close();
    assert.ok(heard > 0 && heard <= 10, `answered ${heard} of 30`);
  });
});

test('parseReply accepts a base answer and rejects anything else', () => {
  const reply = (obj) => Buffer.from(JSON.stringify(obj));
  assert.strictEqual(parseReply(reply({ service: 'race-tracker-base', adminPort: 8092, host: 'b' }), '10.0.0.5').url, 'http://10.0.0.5:8092');
  assert.strictEqual(parseReply(reply({ service: 'other', adminPort: 8092 }), '10.0.0.5'), null);
  assert.strictEqual(parseReply(reply({ service: 'race-tracker-base', adminPort: 'x' }), '10.0.0.5'), null);
  assert.strictEqual(parseReply(reply({ service: 'race-tracker-base', adminPort: 70000 }), '10.0.0.5'), null);
  assert.strictEqual(parseReply(Buffer.from('not json'), '10.0.0.5'), null);
});
