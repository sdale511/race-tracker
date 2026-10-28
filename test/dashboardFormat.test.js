const test = require('node:test');
const assert = require('node:assert');
const { formatAgo, formatAgoShort } = require('../src/dashboardFormat');

test('formatAgoShort is formatAgo without the words, for a one-line table cell', () => {
  const ago = (seconds) => Date.now() - seconds * 1000;
  assert.strictEqual(formatAgoShort(null), 'never');
  assert.strictEqual(formatAgoShort(ago(1)), 'now');
  assert.strictEqual(formatAgoShort(ago(42)), '42s');
  assert.strictEqual(formatAgoShort(ago(7 * 60 + 5)), '7m');
  assert.strictEqual(formatAgoShort(ago(2 * 3600 + 15 * 60)), '2h15m');
  assert.strictEqual(formatAgo(ago(42)), '42s ago', 'formatAgo itself is unchanged');
});
