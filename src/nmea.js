// Builds a standard NMEA $GPGGA sentence from a decoded position object -
// shared by baseStation.js and boatAgent.js's local UDP broadcasts (see
// config.js's localBroadcast.format) for consumers that only speak NMEA
// rather than this app's own UBX re-encode (ubxParser.js's encodeNavPvt).
// Works with either shape of input: a boat's own raw pvt object
// (ubxParser.js's _decodePvt) or the base's decoded radio frame
// (protocol.js's decode) - both carry the same {timestamp, lat, lon,
// carrSoln, gnssFixOk, numSV} fields this only actually needs.
function toGGA(d) {
  const t = new Date(d.timestamp);
  const hhmmss =
    String(t.getUTCHours()).padStart(2, '0') +
    String(t.getUTCMinutes()).padStart(2, '0') +
    String(t.getUTCSeconds()).padStart(2, '0');

  const latAbs = Math.abs(d.lat);
  const latDeg = Math.floor(latAbs);
  const latMin = (latAbs - latDeg) * 60;
  const latStr = `${String(latDeg).padStart(2, '0')}${latMin.toFixed(4).padStart(7, '0')}`;
  const latHem = d.lat >= 0 ? 'N' : 'S';

  const lonAbs = Math.abs(d.lon);
  const lonDeg = Math.floor(lonAbs);
  const lonMin = (lonAbs - lonDeg) * 60;
  const lonStr = `${String(lonDeg).padStart(3, '0')}${lonMin.toFixed(4).padStart(7, '0')}`;
  const lonHem = d.lon >= 0 ? 'E' : 'W';

  const fixQuality = d.carrSoln === 2 ? 4 : d.carrSoln === 1 ? 5 : d.gnssFixOk ? 1 : 0; // 4=RTK fixed,5=RTK float,1=GPS
  const body = `GPGGA,${hhmmss},${latStr},${latHem},${lonStr},${lonHem},${fixQuality},${String(d.numSV).padStart(2, '0')},1.0,0.0,M,0.0,M,,`;
  return '$' + body + '*' + checksum(body);
}

function checksum(str) {
  let cs = 0;
  for (let i = 0; i < str.length; i++) cs ^= str.charCodeAt(i);
  return cs.toString(16).toUpperCase().padStart(2, '0');
}

module.exports = { toGGA };
