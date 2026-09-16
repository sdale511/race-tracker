// npm run mark - the exact same baseStation.js process markset uses (see
// markSetStation.js), for the common case of a rover physically attached
// to one course mark rather than an operator walking between all of them -
// see README's "Mark mode". A thin wrapper, not a second copy of
// baseStation.js's ~2000 lines: it sets MARKSET_MODE=1, the same flag
// markSetStation.js sets, since mark mode IS markset mode - always-on GPS,
// map-only dashboard, no radio/fleet/upload/webhook subsystems. The only
// thing that actually distinguishes "mark mode" from "markset mode" is
// whether a mark is currently assigned (config.markName/MARK_NAME, or the
// map's own "This rover represents" dropdown) - that's runtime state, not
// a separate code path, so there's nothing else for this file to set.
//
// MARK_NAME can be passed here for a one-step launch-and-assign, e.g.:
//   MARK_NAME=windwardBlack npm run mark
// or left unset to start unassigned and pick one from the map afterward -
// exactly like running `npm run markset` and assigning it from there.
process.env.MARKSET_MODE = '1';
require('./baseStation');
