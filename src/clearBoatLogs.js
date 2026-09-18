const fs = require('fs');
const config = require('./config');

// Deletes this boat's own local SD-card log entirely - every chunked CSV
// file and its .uploaded marker under BOAT_LOG_DIR (default boat-logs/, see
// config.js's own boatLogDir comment - a completely separate directory from
// the base's LOG_DIR, not a subdirectory of it) - so a boat can be reset to
// a clean slate after testing without touching anything else this device
// has: its identity/state in race-config/ (boat_id.txt included - this does
// NOT regenerate a new BOAT_ID, only clears the track history), or LOG_DIR
// if this same machine also happens to be running the base role (see
// clearFleetLogs.js for that side - the two are deliberately separate
// commands, with distinct names, since a boat has no Redis access and no
// regatta concept at all, see README's "File layout"). Run with
// `npm run clear-boat-logs`.
if (!fs.existsSync(config.boatLogDir)) {
  console.log(`[clearBoatLogs] no boat log directory found at ${config.boatLogDir} - nothing to clear`);
} else {
  const fileCount = fs.readdirSync(config.boatLogDir).length;
  fs.rmSync(config.boatLogDir, { recursive: true, force: true });
  console.log(`[clearBoatLogs] removed ${config.boatLogDir} (${fileCount} file(s))`);
}
