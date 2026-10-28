// codeAnnouncer.js: a transponder code (boat id) is announced to RegattaUp once, the first time the base hears the boat.
const test = require('node:test');
const assert = require('node:assert');
const { createCodeAnnouncer } = require('../src/codeAnnouncer');

function setup({ regatta = 'reg1', announce } = {}) {
  const state = { regatta, announced: [] };
  const noteCode = createCodeAnnouncer({
    announce: announce || ((event) => state.announced.push(event)),
    getRegattaId: () => state.regatta,
  });
  return { state, noteCode };
}

test('a code seen for the first time is announced, with when it was heard as the hit time', () => {
  const { state, noteCode } = setup();
  assert.strictEqual(noteCode('00051', 1785337740000, 2), true);
  assert.strictEqual(state.announced.length, 1);
  assert.strictEqual(state.announced[0].boatId, '00051');
  assert.strictEqual(state.announced[0].rtcTime, 1785337740000 * 1000);
  assert.strictEqual(state.announced[0].strength, 2);
  assert.ok(!Number.isNaN(Date.parse(state.announced[0].receivedAt)));
});

test('a hello from a rover with no fix yet announces its code, with a strength of 0', () => {
  const { state, noteCode } = setup();
  assert.strictEqual(noteCode('00051', 1785337740000, undefined), true);
  assert.strictEqual(state.announced[0].strength, 0);
});

test('the same code is announced once however often the boat is heard, hello or fix', () => {
  const { state, noteCode } = setup();
  noteCode('00051', 1000, 0);
  noteCode('00051', 2000, 2);
  noteCode('00051', 3000, 2);
  assert.strictEqual(state.announced.length, 1);
  noteCode('00052', 4000, 2);
  assert.deepStrictEqual(state.announced.map((e) => e.boatId), ['00051', '00052']);
});

test('nothing is announced with no regatta selected, and the code counts as new once one is', () => {
  const { state, noteCode } = setup({ regatta: null });
  assert.strictEqual(noteCode('00051', 1000, 2), false);
  state.regatta = 'reg1';
  assert.strictEqual(noteCode('00051', 2000, 2), true);
});

test('the same code in another regatta is new there', () => {
  const { state, noteCode } = setup();
  noteCode('00051', 1000, 2);
  state.regatta = 'reg2';
  noteCode('00051', 2000, 2);
  assert.strictEqual(state.announced.length, 2);
});

test('a hit that could not be queued is tried again on the boat\'s next frame', () => {
  let fail = true;
  const queued = [];
  const { noteCode } = setup({
    announce: (event) => {
      if (fail) throw new Error('disk full');
      queued.push(event);
    },
  });
  assert.throws(() => noteCode('00051', 1000, 2), /disk full/);
  fail = false;
  assert.strictEqual(noteCode('00051', 2000, 2), true);
  assert.strictEqual(queued.length, 1);
});
