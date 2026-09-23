// npm run mark - an ordinary boatAgent.js process (real GPS, real
// telemetry radio, transmits its own position and gets tracked as a
// regular boat, same as any other rover) permanently attached to ONE
// course mark: it continuously auto-sends that mark's position over the
// radio (see protocol.js's encodeSetMark/boatAgent.js's handlePvt own
// markMode block) whenever its own GPS drifts MARK_DISTANCE_M from the
// last position it sent for that mark - no operator action needed once
// assigned. The continuous counterpart to markset (npm run markset,
// markSetStation.js), which is a manual, one-tap-per-update assist for an
// operator walking between marks; the two are distinct workflows, not two
// settings of the same mode - see config.js's own markMode comment.
//
// MARK_NAME picks which mark this device represents (falls back to
// whatever was last assigned and persisted - see markNameFile.js/config
// .js's resolveMarkName), or leave it unset and assign one from this
// device's own dashboard once it's running:
//   MARK_NAME=windwardBlack npm run mark
//
// A thin wrapper, not a second copy of boatAgent.js - same pattern as
// markSetStation.js/baseRtkStation.js: set the flag config.js already
// checks (config.markMode), then require boatAgent.js.
process.env.MARK_MODE = '1';
require('./boatAgent');
