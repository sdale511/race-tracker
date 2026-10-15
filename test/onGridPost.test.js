// onGridPost.js: the base holds the on-grid event for a racing boat that merely clips the zone. Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const { decideOnGridPost } = require('../src/onGridPost');

test('a boat arriving to queue for a start posts on entry, and again only when the resend latch is up', () => {
  assert.deepStrictEqual(decideOnGridPost({ mode: 'ongrid', wasOnGrid: false, dueForResend: false, racing: false, held: false }), { action: 'post', held: false });
  assert.deepStrictEqual(decideOnGridPost({ mode: 'ongrid', wasOnGrid: true, dueForResend: false, racing: false, held: false }), { action: 'none', held: false });
  assert.deepStrictEqual(decideOnGridPost({ mode: 'ongrid', wasOnGrid: true, dueForResend: true, racing: false, held: false }), { action: 'post', held: false });
});

test('a racing boat clipping the zone is held, and nothing is sent if it leaves', () => {
  const enter = decideOnGridPost({ mode: 'ongrid', wasOnGrid: false, dueForResend: false, racing: true, held: false });
  assert.deepStrictEqual(enter, { action: 'hold', held: true });
  const again = decideOnGridPost({ mode: 'ongrid', wasOnGrid: true, dueForResend: false, racing: true, held: true });
  assert.deepStrictEqual(again, { action: 'none', held: true }, 'still held, and not announced again');
  const leave = decideOnGridPost({ mode: 'offgrid', wasOnGrid: true, dueForResend: false, racing: true, held: true });
  assert.deepStrictEqual(leave, { action: 'none', held: false }, 'gone: the hold is dropped');
});

test('a held boat that stays until it is parked (no longer racing) is announced then', () => {
  assert.deepStrictEqual(decideOnGridPost({ mode: 'ongrid', wasOnGrid: true, dueForResend: false, racing: false, held: true }), { action: 'post', held: false });
});

test('a boat already on the grid that is then marked racing is not held a second time', () => {
  assert.deepStrictEqual(decideOnGridPost({ mode: 'ongrid', wasOnGrid: true, dueForResend: false, racing: true, held: false }), { action: 'none', held: false });
});
