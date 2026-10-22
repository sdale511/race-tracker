const { execFileSync } = require('child_process');
const { sections, formatValue, overrideTag, modeRow } = require('./configReport');

// Prints the fully-resolved configuration - see configReport.js for the
// section/row data shared with the admin dashboards' GET /config page.
// Secrets (the Redis password) are redacted, never printed even in a
// debug tool.

console.log('race-tracker resolved configuration\n');

// This script runs as its own process, so it can't ask the app which mode it is. On a Pi set up with
// install-service.sh it can still tell from which race-tracker systemd unit is running (same unit names as that
// script); anywhere else (macOS, a plain `npm run ...` in a terminal) the mode is unknown.
const MODE_UNITS = { 'boat-agent': 'boat', 'mark-station': 'mark', 'base-station': 'base', 'basertk-station': 'basertk', 'rtk-station': 'rtk' };
function runningServiceMode() {
  const running = Object.keys(MODE_UNITS).filter((unit) => {
    try {
      execFileSync('systemctl', ['is-active', '--quiet', unit], { stdio: 'ignore' });
      return true;
    } catch (err) {
      return false; // inactive, not installed, or no systemctl at all
    }
  });
  if (running.length === 0) return 'unknown (no race-tracker service running)';
  return running.map((unit) => `${MODE_UNITS[unit]} (${unit} service)`).join(', ');
}

for (const s of sections) {
  const section = s.title === 'Mode' ? { ...s, rows: [modeRow(runningServiceMode(), 'from the race-tracker systemd service running on this machine'), ...s.rows] } : s;
  console.log(section.title);
  const labelWidth = Math.max(...section.rows.map((row) => row.label.length));
  for (const { label, value, envVar, inverted, unit, note } of section.rows) {
    const paddedLabel = label.padEnd(labelWidth);
    const tag = overrideTag(envVar, inverted);
    // Value is left as-is (not padded to the widest in the section) so a
    // single long value - a URL, a full path - doesn't force every other
    // row's tag out to that same column.
    console.log(`  ${paddedLabel}  ${formatValue(value, unit)}${tag ? '  ' + tag : ''}`);
    // A platform-specific hint (e.g. what this path looks like on macOS
    // vs the Linux paths used elsewhere) - a second, indented line rather
    // than crammed onto the value line, since it's not part of the
    // resolved value itself.
    if (note) console.log(`  ${' '.repeat(labelWidth)}  (${note})`);
  }
  console.log('');
}
