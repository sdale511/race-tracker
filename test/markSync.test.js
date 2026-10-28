// markSync.js: which course marks changed in Redis (e.g. edited in RegattaUp) compared with the base's in-memory ones.
const test = require('node:test');
const assert = require('node:assert');
const { changedMarks } = require('../src/markSync');

const NAMES = ['pin', 'committeeStart', 'windwardGreen'];
const current = () => ({
  pin: { lat: 41.5, lon: -71.998, assignedBoatId: 'mark-pin', assignedAt: 1 },
  committeeStart: { lat: 41.5, lon: -72.0 },
  windwardGreen: { lat: 41.51, lon: -71.999 },
});

test('marks that are where the base has them are not changes, whatever their assignment fields say', () => {
  const fresh = current();
  fresh.pin = { lat: 41.5, lon: -71.998, assignedBoatId: undefined, assignedAt: undefined };
  fresh.committeeStart = { lat: 41.5 + 5e-8, lon: -72.0 };
  assert.deepStrictEqual(changedMarks(current(), fresh, NAMES), []);
});

test('a mark moved in RegattaUp is reported, in mark order', () => {
  const fresh = current();
  fresh.windwardGreen = { lat: 41.511, lon: -71.999 };
  fresh.pin = { lat: 41.5, lon: -71.9975 };
  assert.deepStrictEqual(changedMarks(current(), fresh, NAMES), ['pin', 'windwardGreen']);
});

test('a mark Redis does not have is not a change, and one the base lacks is', () => {
  const fresh = current();
  fresh.pin = null;
  assert.deepStrictEqual(changedMarks(current(), fresh, NAMES), []);
  const cur = current();
  delete cur.windwardGreen;
  assert.deepStrictEqual(changedMarks(cur, current(), NAMES), ['windwardGreen']);
});
