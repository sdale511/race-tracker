// This checkout's version, worked out once at startup from git, so every commit bumps it with nothing to edit by hand:
// package.json's major.minor, then the number of commits as the last part - 0.1.288 is the 288th commit. Bump the minor in
// package.json for a bigger step. The short hash, the commit's date and whether the checkout has uncommitted changes come
// with it, so the admin pages can say exactly what a Pi is running.
//
// Without git (a copy with no .git, or git not installed) it is package.json's version as it stands, with no hash.

const { execFileSync } = require('child_process');
const path = require('path');

const REPO_DIR = path.join(__dirname, '..');

function git(args, run) {
  try {
    return run('git', args, { cwd: REPO_DIR, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// { version: '0.1.288', commit: 'abc1234' | null, date: '2026-10-26' | null, dirty: boolean, label: 'v0.1.288' }
// run: execFileSync, swappable for the tests.
function readVersion({ run = execFileSync, pkgVersion = require('../package.json').version } = {}) {
  const [major = '0', minor = '0'] = String(pkgVersion).split('.');
  const count = git(['rev-list', '--count', 'HEAD'], run);
  const commit = git(['rev-parse', '--short', 'HEAD'], run);
  if (!count || !/^\d+$/.test(count) || !commit) {
    return { version: pkgVersion, commit: null, date: null, dirty: false, label: `v${pkgVersion}` };
  }
  const date = git(['log', '-1', '--format=%cs'], run);
  // Tracked files only: a log or config file the app writes is not a code change
  const status = git(['status', '--porcelain', '--untracked-files=no'], run);
  const version = `${major}.${minor}.${count}`;
  return { version, commit, date: date || null, dirty: !!status, label: `v${version}` };
}

// Read once: the code running doesn't change until the process restarts (a git pull needs a restart to take effect).
const VERSION = readVersion();

// One line for logs and print-config: "v0.1.288 (abc1234, 2026-10-26)", with "+ local changes" when dirty.
function versionLine(v = VERSION) {
  const details = [v.commit, v.date].filter(Boolean).join(', ');
  return `${v.label}${details ? ` (${details})` : ''}${v.dirty ? ' + local changes' : ''}`;
}

module.exports = { VERSION, readVersion, versionLine };
