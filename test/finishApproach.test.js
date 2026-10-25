const test = require('node:test');
const assert = require('node:assert');
const { headingUpwind } = require('../src/finishApproach');

// A finish line running east from the committee boat, so upwind (90 degrees counter-clockwise from committeeFinish -> finish)
// is north.
const committeeFinish = { lat: 40.9, lon: -118.4 };
const finish = { lat: 40.9, lon: -118.399 };
const at = (headMotDeg, kn = 20) => ({ lat: 40.8995, lon: -118.3995, headMotDeg, gSpeedMmS: (kn / 1.94384) * 1000 });

test('a boat beating up to the finish line on either tack is heading upwind', () => {
  assert.strictEqual(headingUpwind(at(0), committeeFinish, finish), true);
  assert.strictEqual(headingUpwind(at(45), committeeFinish, finish), true);
  assert.strictEqual(headingUpwind(at(315), committeeFinish, finish), true);
});

test('a boat coming down the run or on a broad reach past the line is not', () => {
  assert.strictEqual(headingUpwind(at(180), committeeFinish, finish), false);
  assert.strictEqual(headingUpwind(at(135), committeeFinish, finish), false);
  assert.strictEqual(headingUpwind(at(225), committeeFinish, finish), false);
});

test('a boat too slow for its heading to mean anything is not', () => {
  assert.strictEqual(headingUpwind(at(0, 0.5), committeeFinish, finish), false);
  assert.strictEqual(headingUpwind({ ...at(0), headMotDeg: undefined }, committeeFinish, finish), false);
});

test('upwind follows the line, not north: a line running north from the committee boat has upwind to the west', () => {
  const northFinish = { lat: 40.901, lon: -118.4 };
  assert.strictEqual(headingUpwind(at(270), committeeFinish, northFinish), true);
  assert.strictEqual(headingUpwind(at(90), committeeFinish, northFinish), false);
});
