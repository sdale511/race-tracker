// npm run markset - an ordinary boatAgent.js process (real GPS, real
// telemetry radio, transmits its own position and gets tracked as a
// regular boat, same as any other rover) with one addition: its own
// roverAdminServer.js /map page shows a "Set" button per course mark,
// sending this device's own current GPS position to the base over the
// radio (see protocol.js's encodeSetMark/boatAgent.js's sendSetMark) - no
// WiFi, no crosshair, no continuous auto-post, no "this device represents
// mark X" assignment, just a one-off send using wherever this device
// actually is right now.
//
// Deliberately not shown on an ordinary boat's own map - an accidental tap
// during racing shouldn't be able to move a live course mark, so this only
// appears on a device an operator explicitly launched this way for
// mark-setting duty. Field workflow: walk/sail to the mark you just
// placed, open this device's own /map on its touchscreen, tap "Set" for
// that mark.
//
// A thin wrapper, not a second copy of boatAgent.js - same pattern as
// baseRtkStation.js (npm run basertk): set the flag config.js already
// checks (config.marksetMode), then require boatAgent.js.
process.env.MARKSET_MODE = '1';
require('./boatAgent');
