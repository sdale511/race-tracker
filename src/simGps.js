const { EventEmitter } = require('events');

// Fake GPS source for hardware-free testing: emits synthetic fixes in the
// same shape UbxParser emits from real hardware (see ubxParser.js
// _decodePvt), so boatAgent doesn't need to know the difference. The boat
// sails a closed triangular racecourse loop (leeward/windward/wing) around
// a configurable center point, using a flat-earth approximation (fine at
// racecourse scale, and guarantees the loop closes exactly rather than
// drifting over many laps).
const METERS_PER_DEG_LAT = 111320;

// Course marks as {north, east} meter offsets from the center point.
const COURSE_MARKS_M = [
  { north: 0, east: 0 }, // start / leeward
  { north: 800, east: 0 }, // windward mark
  { north: 100, east: 700 }, // wing mark
];

function offsetToLatLon(centerLat, centerLon, { north, east }) {
  const lat = centerLat + north / METERS_PER_DEG_LAT;
  const lon = centerLon + east / (METERS_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180));
  return { lat, lon };
}

function legInfo(from, to) {
  const dNorth = to.north - from.north;
  const dEast = to.east - from.east;
  return {
    distanceM: Math.hypot(dNorth, dEast),
    bearingDeg: ((Math.atan2(dEast, dNorth) * 180) / Math.PI + 360) % 360,
    dNorth,
    dEast,
  };
}

class SimGpsSource extends EventEmitter {
  constructor({ centerLat, centerLon, speedKn, hz }) {
    super();
    this.centerLat = centerLat;
    this.centerLon = centerLon;
    this.speedMS = speedKn * 0.514444; // knots -> m/s
    this.intervalMs = 1000 / hz;
    this.legs = COURSE_MARKS_M.map((mark, i) => legInfo(mark, COURSE_MARKS_M[(i + 1) % COURSE_MARKS_M.length]));

    this.legIndex = 0;
    this.distanceIntoLeg = 0;

    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    clearInterval(this._timer);
  }

  _tick() {
    this.distanceIntoLeg += this.speedMS * (this.intervalMs / 1000);
    while (this.distanceIntoLeg >= this.legs[this.legIndex].distanceM) {
      this.distanceIntoLeg -= this.legs[this.legIndex].distanceM;
      this.legIndex = (this.legIndex + 1) % this.legs.length;
    }

    const leg = this.legs[this.legIndex];
    const mark = COURSE_MARKS_M[this.legIndex];
    const frac = this.distanceIntoLeg / leg.distanceM;
    const north = mark.north + leg.dNorth * frac;
    const east = mark.east + leg.dEast * frac;
    const { lat, lon } = offsetToLatLon(this.centerLat, this.centerLon, { north, east });

    this.emit('nav-pvt', {
      fixType: 3,
      gnssFixOk: true,
      diffSoln: true,
      carrSoln: 2, // RTK fixed - simulate a healthy link
      numSV: 14,
      lat,
      lon,
      heightMm: 5000,
      hAccMm: 15,
      gSpeedMmS: Math.round(this.speedMS * 1000),
      headMotDeg: leg.bearingDeg,
      timestamp: Date.now(),
    });
  }
}

module.exports = { SimGpsSource };
