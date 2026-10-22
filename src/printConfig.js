const { execFileSync } = require('child_process');
const { sections, MODES, formatValue, overrideTag, modesSections, modesFor, sectionsFor } = require('./configReport');

// Prints the fully-resolved configuration - see configReport.js for the
// section/row data shared with the admin dashboards' GET /config page.
// Secrets (the Redis password) are redacted, never printed even in a
// debug tool.
//
// npm run print-config                    every setting, each labelled with the modes that read it
// npm run print-config -- --mode <mode>   just the settings that mode reads, as its own /config page shows them

const MODE_NAMES = MODES.map((m) => m.mode);
// --mode boat or --mode=boat; null when not given.
function parseModeArg(args) {
  const i = args.findIndex((a) => a === '--mode' || a.startsWith('--mode='));
  if (i < 0) return null;
  const mode = args[i].includes('=') ? args[i].slice('--mode='.length) : args[i + 1];
  if (!MODE_NAMES.includes(mode)) {
    console.error(`--mode must be one of: ${MODE_NAMES.join(', ')} (got ${mode === undefined ? 'nothing' : JSON.stringify(mode)})`);
    process.exit(1);
  }
  return mode;
}
const onlyMode = parseModeArg(process.argv.slice(2));

console.log('race-tracker resolved configuration');
console.log(
  onlyMode
    ? `settings read in ${onlyMode} mode (drop --mode to see every setting)\n`
    : 'every setting, labelled [with the modes that read it]; --mode <mode> shows just one mode\n'
);

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

// "[boat, mark]", or "[all modes]" for a setting every mode reads.
function modesLabel(row, section) {
  const modes = modesFor(row, section);
  return `[${modes.length === MODE_NAMES.length ? 'all modes' : modes.join(', ')}]`;
}

for (const section of [...modes, ...(onlyMode ? sectionsFor(onlyMode) : sections)]) {
  console.log(section.title);
  const labelWidth = Math.max(...section.rows.map((row) => row.label.length));
  const valueIndent = ' '.repeat(2 + labelWidth + 2);
  // The mode sections describe modes rather than being settings, and with --mode every row printed is that mode's.
  const labelled = !onlyMode && !modes.includes(section);
  for (const row of section.rows) {
    const { label, value, envVar, inverted, unit, note } = row;
    const tagParts = [overrideTag(envVar, inverted), labelled ? modesLabel(row, section) : ''].filter(Boolean);
    const tag = tagParts.join('  ');
    // Under the value: the env-var tag and modes label together, or on a line each when even that is too wide.
    const tagLines = () => (valueIndent.length + tag.length <= WIDTH ? [tag] : tagParts).map((t) => valueIndent + t);
    const formatted = formatValue(value, unit);
    const head = `  ${label.padEnd(labelWidth)}  `;
    if (head.length + formatted.length <= WIDTH) {
      // Value is left as-is (not padded to the widest in the section) so a
      // single long value doesn't force every other row's tag out to that
      // same column.
      const line = head + formatted;
      if (!tag) console.log(line);
      else if (line.length + 2 + tag.length <= WIDTH) console.log(`${line}  ${tag}`);
      else [line, ...tagLines()].forEach((l) => console.log(l));
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
