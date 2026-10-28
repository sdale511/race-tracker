// codeAnnouncer.js: a transponder code (boat id) is announced to RegattaUp once, the first time it is heard in a regatta.
const test = require('node:test');
const assert = require('node:assert');
const { createCodeAnnouncer } = require('../src/codeAnnouncer');

function setup({ known = [], regatta = 'reg1', isKnown } = {}) {
  const state = { regatta, announced: [], lookups: 0 };
  const noteCode = createCodeAnnouncer({
    isKnown:
      isKnown ||
      (async (boatId) => {
        state.lookups++;
        return known.includes(boatId);
      }),
    announce: (event) => state.announced.push(event),
    getRegattaId: () => state.regatta,
  });
  return { state, noteCode };
}

const fix = (boatId, timestamp = 1785337740000) => ({ boatId, timestamp, carrSoln: 2 });

test('a code heard for the first time is announced with its first fix as the hit', async () => {
  const { state, noteCode } = setup();
  assert.strictEqual(await noteCode(fix('00051')), true);
  assert.strictEqual(state.announced.length, 1);
  assert.strictEqual(state.announced[0].boatId, '00051');
  assert.strictEqual(state.announced[0].rtcTime, 1785337740000 * 1000);
  assert.strictEqual(state.announced[0].strength, 2);
  assert.ok(!Number.isNaN(Date.parse(state.announced[0].receivedAt)));
});

test('the same code is announced once, and asks Redis once', async () => {
  const { state, noteCode } = setup();
  await Promise.all([noteCode(fix('00051')), noteCode(fix('00051')), noteCode(fix('00051'))]);
  await noteCode(fix('00051'));
  assert.strictEqual(state.announced.length, 1);
  assert.strictEqual(state.lookups, 1);
});

test('a code the regatta already knows (heard in an earlier run) is not announced again', async () => {
  const { state, noteCode } = setup({ known: ['00051'] });
  assert.strictEqual(await noteCode(fix('00051')), false);
  assert.strictEqual(await noteCode(fix('00052')), true);
  assert.deepStrictEqual(state.announced.map((e) => e.boatId), ['00052']);
});

test('nothing is announced with no regatta selected, and the code counts as new once one is', async () => {
  const { state, noteCode } = setup({ regatta: null });
  assert.strictEqual(await noteCode(fix('00051')), false);
  state.regatta = 'reg1';
  assert.strictEqual(await noteCode(fix('00051')), true);
});

test('the same code in another regatta is new there', async () => {
  const { state, noteCode } = setup();
  await noteCode(fix('00051'));
  state.regatta = 'reg2';
  await noteCode(fix('00051'));
  assert.strictEqual(state.announced.length, 2);
});

test('when Redis cannot be asked the code is announced anyway', async () => {
  const { state, noteCode } = setup({
    isKnown: async () => {
      throw new Error('Redis down');
    },
  });
  assert.strictEqual(await noteCode(fix('00051')), true);
  assert.strictEqual(state.announced.length, 1);
});
