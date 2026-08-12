const { sections, formatValue, overrideTag } = require('./configReport');

// Prints the fully-resolved configuration - see configReport.js for the
// section/row data shared with the admin dashboards' GET /config page.
// Secrets (the Redis password) are redacted, never printed even in a
// debug tool.

console.log('race-tracker resolved configuration\n');

for (const section of sections) {
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
