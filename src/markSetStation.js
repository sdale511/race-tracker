// npm run markset - the exact same baseStation.js process, with its GPS
// forced always-on (like a boat's own, not gated on GPS_PORT being
// explicitly set) and its dashboard defaulting to the course map instead
// of the fleet view - see baseStation.js's own marksetMode. For walking
// (or sailing) the actual course with a real RTK GPS unit and setting each
// mark's position from wherever the crosshair sits - see README's
// "Mark-set mode" section.
//
// A thin wrapper, not a second copy of baseStation.js's ~2000 lines - same
// pattern as baseRtkStation.js (npm run basertk): set the flag
// baseStation.js already checks, then require it. Everything else about
// this process - radio, fleet tracking, Redis, RegattaUp reporting - stays
// exactly as plain `npm run base` would run it; only the GPS-gating and
// default page change.
process.env.MARKSET_MODE = '1';
require('./baseStation');
