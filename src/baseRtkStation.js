// npm run basertk - the exact same baseStation.js process, with the base
// GPS's TMODE3/survey-in control cards (and their API routes) additionally
// wired in - see baseStation.js's own rtkControlsEnabled. For a single
// machine acting as both the telemetry base AND the RTK correction source,
// rather than splitting those onto two separate machines/processes (see
// README's "RTK-only mode" for that split, where a dedicated rtkStation.js
// runs on just the correction-source machine and plain `npm run base` runs
// elsewhere with no RTK controls of its own).
//
// A thin wrapper, not a second copy of baseStation.js's ~2000 lines: this
// just sets the flag baseStation.js already checks, then requires it -
// setting the env var here (rather than needing an operator to remember
// `RTK_CONTROLS_ENABLED=1 npm run base` by hand) is what makes `npm run
// basertk` its own real, discoverable command.
process.env.RTK_CONTROLS_ENABLED = '1';
require('./baseStation');
