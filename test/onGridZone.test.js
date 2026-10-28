// onGridWatcher.js's sameZone: the base republishes the on-grid zone when the start marks no longer give the published one.
const test = require('node:test');
const assert = require('node:assert');
const { zonePolygon, sameZone } = require('../src/onGridWatcher');

const marks = () => ({
  committeeStart: { lat: 41.5000, lon: -72.0000 },
  pin: { lat: 41.5000, lon: -71.9980 },
  windwardGreen: { lat: 41.5100, lon: -71.9990 },
  leewardGreen: { lat: 41.4900, lon: -71.9990 },
});

test('the zone is the same for the same marks, even after a JSON round trip with mark assignment fields', () => {
  const zone = zonePolygon(marks(), 10);
  const withAssignment = marks();
  withAssignment.pin.assignedBoatId = 'mark-pin';
  withAssignment.pin.assignedAt = 1;
  const stored = JSON.parse(JSON.stringify(zonePolygon(withAssignment, 10)));
  assert.ok(sameZone(stored, zone));
});

test('a pin or committeeStart that moved gives a different zone', () => {
  const before = zonePolygon(marks(), 10);
  const pinMoved = marks();
  pinMoved.pin = { lat: 41.5000, lon: -71.9975 };
  assert.ok(!sameZone(zonePolygon(pinMoved, 10), before));
  const committeeMoved = marks();
  committeeMoved.committeeStart = { lat: 41.5001, lon: -72.0000 };
  assert.ok(!sameZone(zonePolygon(committeeMoved, 10), before));
});

test('a move of a centimetre or less is not a change; a few metres is', () => {
  const before = zonePolygon(marks(), 10);
  const nudged = marks();
  nudged.pin = { lat: 41.5000 + 5e-8, lon: -71.9980 };
  assert.ok(sameZone(zonePolygon(nudged, 10), before));
  nudged.pin = { lat: 41.5000 + 5e-5, lon: -71.9980 };
  assert.ok(!sameZone(zonePolygon(nudged, 10), before));
});

test('nothing published, or a zone of a different shape, is not the same zone', () => {
  const zone = zonePolygon(marks(), 10);
  assert.ok(!sameZone(null, zone));
  assert.ok(!sameZone(zone.slice(0, 3), zone));
  assert.ok(!sameZone([], zone));
});
