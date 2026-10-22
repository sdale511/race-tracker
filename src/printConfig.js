const { execFileSync } = require('child_process');
const { sections, formatValue, overrideTag, modesSections } = require('./configReport');

// Prints the fully-resolved configuration - see configReport.js for the
// section/row data shared with the admin dashboards' GET /config page.
// Secrets (the Redis password) are redacted, never printed even in a
// debug tool.

console.log('race-tracker resolved configuration\n');

// This script runs as its own process, so it can't ask the app which mode it is. On a Pi set up with
// install-service.sh it can still tell from which race-tracker systemd unit is running (same unit names as that
// script); anywhere else (macOS, a plain `npm run ...` in a terminal) the mode is unknown.
const MODE_UNITS = { 'boat-agent': 'boat', 'mark-station': 'mark', 'base-station': 'base', 'basertk-station': 'basertk', 'rtk-station': 'rtk' };
// Returns the modes whose service is running (usually one; none off a Pi or when started by hand).
function runningServiceModes() {
  const running = Object.keys(MODE_UNITS).filter((unit) => {
    try {
      execFileSync('systemctl', ['is-active', '--quiet', unit], { stdio: 'ignore' });
      return true;
    } catch (err) {
      return false; // inactive, not installed, or no systemctl at all
    }
  });
  return running.map((unit) => MODE_UNITS[unit]);
}
const running = runningServiceModes();
const modes = modesSections(
  running.length ? running.join(', ') : 'unknown (no race-tracker service running)',
  running,
  'from the race-tracker systemd service running on this machine'
);

// Kept to 100 columns: notes wrap at the value column, a value too long to sit beside its label (a file path, a URL)
// drops to its own line, and the "(ENV_VAR, default)" tag moves under the value when the two don't fit on one line.
const WIDTH = 100;
const PATH_INDENT = '      ';

// Word-wraps text into lines no wider than WIDTH, each starting with indent. A single word longer than the room
// left (a path) gets a line of its own rather than being split.
function wrap(text, indent) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && indent.length + line.length + 1 + word.length > WIDTH) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

for (const section of [...modes, ...sections]) {
  console.log(section.title);
  const labelWidth = Math.max(...section.rows.map((row) => row.label.length));
  const valueIndent = ' '.repeat(2 + labelWidth + 2);
  for (const { label, value, envVar, inverted, unit, note } of section.rows) {
    const tag = overrideTag(envVar, inverted);
    const formatted = formatValue(value, unit);
    const head = `  ${label.padEnd(labelWidth)}  `;
    if (head.length + formatted.length <= WIDTH) {
      // Value is left as-is (not padded to the widest in the section) so a
      // single long value doesn't force every other row's tag out to that
      // same column.
      const line = head + formatted;
      if (!tag) console.log(line);
      else if (line.length + 2 + tag.length <= WIDTH) console.log(`${line}  ${tag}`);
      else console.log(`${line}\n${valueIndent}${tag}`);
    } else {
      console.log(`  ${label}${tag ? '  ' + tag : ''}`);
      console.log(PATH_INDENT + formatted);
    }
    // A hint about the value (e.g. what this path looks like on macOS) - its
    // own wrapped lines rather than crammed onto the value line, since it's
    // not part of the resolved value itself.
    if (note) wrap(`(${note})`, valueIndent).forEach((l) => console.log(l));
  }
  console.log('');
}
