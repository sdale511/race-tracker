const test = require('node:test');
const assert = require('node:assert');
const { readVersion, versionLine } = require('../src/version');
const { renderVersionBadge } = require('../src/dashboardFormat');

// A stand-in for execFileSync('git', args): answers by the git subcommand.
const fakeGit = (answers) => (cmd, args) => {
  const answer = answers[args[0]];
  if (answer instanceof Error) throw answer;
  return answer;
};

test('the version is package.json major.minor plus the commit count', () => {
  const v = readVersion({ pkgVersion: '0.1.0', run: fakeGit({ 'rev-list': '288\n', 'rev-parse': 'abc1234\n', log: '2026-10-26\n', status: '' }) });
  assert.deepStrictEqual(v, { version: '0.1.288', commit: 'abc1234', date: '2026-10-26', dirty: false, label: 'v0.1.288' });
  assert.strictEqual(versionLine(v), 'v0.1.288 (abc1234, 2026-10-26)');
});

test('uncommitted changes to tracked files mark it dirty', () => {
  const v = readVersion({ pkgVersion: '0.1.0', run: fakeGit({ 'rev-list': '289', 'rev-parse': 'def5678', log: '2026-10-27', status: ' M src/config.js' }) });
  assert.strictEqual(v.dirty, true);
  assert.strictEqual(versionLine(v), 'v0.1.289 (def5678, 2026-10-27) + local changes');
});

test('without git it is package.json\'s version as it stands', () => {
  const v = readVersion({ pkgVersion: '0.1.0', run: fakeGit({ 'rev-list': new Error('not a git repository') }) });
  assert.deepStrictEqual(v, { version: '0.1.0', commit: null, date: null, dirty: false, label: 'v0.1.0' });
  assert.strictEqual(versionLine(v), 'v0.1.0');
});

test('the badge shows the label, the commit on hover, and local changes in amber', () => {
  const clean = renderVersionBadge({ label: 'v0.1.288', commit: 'abc1234', date: '2026-10-26', dirty: false });
  assert.match(clean, /class="version-badge" title="commit abc1234, 2026-10-26">v0\.1\.288</);
  const dirty = renderVersionBadge({ label: 'v0.1.288', commit: 'abc1234', date: '2026-10-26', dirty: true });
  assert.match(dirty, /class="version-badge dirty"/);
  assert.match(dirty, />v0\.1\.288 \+ local changes</);
});
