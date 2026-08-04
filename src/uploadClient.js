const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { chunkFilename } = require('./sdLogger');

// Uploads a boat's chunked CSV logs (see sdLogger.js) to the base station
// over WiFi whenever it's actually reachable. A rover is expected to go in
// and out of range constantly, so every step here is built to fail safely
// and just retry on the next periodic check rather than needing to get it
// right in one shot - nothing here assumes the base is reachable, and
// nothing blocks waiting for it to be.
//
// Tracking which files are already uploaded is a plain marker file
// (<original>.csv.uploaded, empty, created only after the base
// acknowledges receipt) sitting next to the original CSV - no separate
// database/index to get out of sync or corrupt; each file's upload state
// is self-contained and crash-safe (either the marker exists or it
// doesn't, nothing in between).
function markerPath(csvPath) {
  return `${csvPath}.uploaded`;
}

function isUploaded(csvPath) {
  return fs.existsSync(markerPath(csvPath));
}

// Oldest pending (not the current chunk, not already uploaded) log file for
// this boat, or null if there's nothing to send right now. Oldest first so
// a rover that's been out of range for a while catches up in order rather
// than skipping straight to whatever's newest. chunkMinutes must match
// whatever the boat's own SdLogger is actually using (see boatAgent.js) -
// otherwise this could misidentify which file is still in progress.
function findPendingUpload(logDir, boatId, chunkMinutes) {
  // The current chunk's file is still being actively appended to, so it's
  // never an upload candidate until its chunk boundary passes and it
  // becomes fixed and complete.
  const currentChunkFile = chunkFilename(boatId, Date.now(), chunkMinutes);
  let files;
  try {
    files = fs.readdirSync(logDir);
  } catch (err) {
    return null;
  }
  const pattern = new RegExp(`^boat${boatId}_\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}\\.csv$`);
  const candidates = files
    .filter((f) => pattern.test(f) && f !== currentChunkFile)
    .filter((f) => !isUploaded(path.join(logDir, f)))
    .sort(); // the chunk bucket in each name sorts chronologically as a plain string
  return candidates.length > 0 ? path.join(logDir, candidates[0]) : null;
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume(); // drain the body, don't care about its contents
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function uploadFile(url, filePath, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Gzipped, not sent raw: CSV text compresses well (repeated
    // timestamp/numeric structure), and a smaller transfer has a better
    // chance of finishing inside a short/marginal WiFi window before the
    // rover drives back out of range - the actual reason this matters here,
    // more than the bandwidth saved (these files are tiny either way). No
    // Content-Length up front since gzip's compressed size isn't known
    // until after compressing - Node sends this chunked-encoded instead,
    // which uploadServer.js's req.complete check already handles fine.
    const req = http.request(
      url,
      { method: 'POST', timeout: timeoutMs, headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'text/csv' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    fs.createReadStream(filePath).pipe(zlib.createGzip()).pipe(req);
  });
}

// getBaseAddress: () => { ip, port } | null - a live getter, not a value
// fixed at construction time, since the base's address only becomes known
// once a marks broadcast actually arrives (see boatAgent.js), and could in
// principle change (the base reconnecting on a new DHCP lease) over the
// course of a long race day.
function startUploadClient({ logDir, boatId, chunkMinutes = 10, getBaseAddress, checkIntervalMs = 15000, timeoutMs = 5000 }) {
  let inFlight = false;

  async function tick() {
    if (inFlight) return; // don't overlap attempts if one's still running
    const base = getBaseAddress();
    if (!base || base.ip === '0.0.0.0' || !base.port) return; // no known upload target yet

    inFlight = true;
    try {
      const healthUrl = `http://${base.ip}:${base.port}/health`;
      const healthStatus = await httpGet(healthUrl, timeoutMs).catch(() => null);
      if (healthStatus !== 200) return; // base not reachable right now - retry next tick

      const filePath = findPendingUpload(logDir, boatId, chunkMinutes);
      if (!filePath) return; // nothing pending

      const filename = path.basename(filePath);
      const uploadUrl = `http://${base.ip}:${base.port}/upload/${encodeURIComponent(filename)}`;
      const status = await uploadFile(uploadUrl, filePath, timeoutMs).catch((err) => {
        console.error(`[uploadClient] upload failed for ${filename}:`, err.message);
        return null;
      });
      if (status === 200) {
        fs.writeFileSync(markerPath(filePath), '');
        console.log(`[uploadClient] uploaded ${filename} to base`);
      }
      // Anything other than 200 (or a thrown error, already logged above)
      // just leaves the file unmarked - picked up again next tick.
    } finally {
      inFlight = false;
    }
  }

  const interval = setInterval(tick, checkIntervalMs);
  return { stop: () => clearInterval(interval) };
}

module.exports = { startUploadClient, findPendingUpload, isUploaded, markerPath };
