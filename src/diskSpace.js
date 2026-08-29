const fs = require('fs');

// Below this percentage free, the disk space card reads ALERT instead of
// OK - 10% is the same rule of thumb most OS-level low-disk warnings use,
// picked here for the same reason: an SD card that's still got a few
// percent left can fill the rest of the way surprisingly fast once webhook
// queues/CSV logs/course track history are all still growing, so the
// warning needs real lead time before it's actually full.
const ALERT_BELOW_PCT = 10;

// Below THIS percentage free, logRotation.js's pruneForDiskSpace starts
// deleting the oldest log files to claw back room - a harder floor than
// ALERT_BELOW_PCT above (which just colors the dashboard card red), since
// automatically deleting data is a much bigger action than a warning and
// should only kick in once things are genuinely critical, not merely worth
// flagging.
const CRITICAL_BELOW_PCT = 5;

// Free/total space (bytes) for the filesystem holding `dirPath` - SD-card
// capacity on a real boat/base Pi is finite and shared with the OS itself,
// so a webhook retry queue, an SD log, or growing course-track history can
// genuinely fill it over the course of a long regatta. Uses Node's own
// fs.statfsSync (the same statfs() syscall `df` itself calls), not a
// shelled-out `df` - one syscall, no subprocess. Returns null instead of
// throwing if the path doesn't exist yet or statfs isn't available on this
// platform, so a not-yet-created log directory at first boot (or an
// unsupported OS) doesn't crash whatever's asking for this - callers
// should treat null as "unknown," not "zero free."
function getDiskSpace(dirPath) {
  try {
    const stat = fs.statfsSync(dirPath);
    const totalBytes = stat.blocks * stat.bsize;
    // bavail (blocks available to an unprivileged process) rather than
    // bfree (raw free blocks, which includes space the OS reserves for
    // root) - bavail is what this process could actually still write,
    // which is the number that matters for "about to run out of room."
    const freeBytes = stat.bavail * stat.bsize;
    const freePct = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;
    return {
      totalBytes,
      freeBytes,
      freePct,
      status: freePct < ALERT_BELOW_PCT ? 'alert' : 'ok',
    };
  } catch (err) {
    return null;
  }
}

module.exports = { getDiskSpace, ALERT_BELOW_PCT, CRITICAL_BELOW_PCT };
