// npm run mark - identical to `npm run markset` (see markSetStation.js) as
// of the redesign that made mark-setting a one-off "tap Set, use my
// current GPS fix" action with no continuous auto-post or assignment: the
// thing that used to distinguish this command (prompting on startup for
// which single mark this device should continuously represent) no longer
// has anything to apply to. Kept as its own command purely so
// `npm run mark` keeps working for anyone already used to typing it.
require('./markSetStation');
