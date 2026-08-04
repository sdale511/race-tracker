const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

// Only accepts filenames matching sdLogger.js's own naming convention
// (boat<id>_<YYYY-MM-DDTHH-MM>.csv) - rejects anything else so this can't
// be used to write arbitrary files/paths onto the base station. Matches
// any chunk size (LOG_CHUNK_MINUTES) since the bucket string's shape is
// the same regardless of what duration produced it. Capture group pulls
// the boat ID out so uploads can be filed into a per-boat subdirectory.
const VALID_FILENAME = /^boat(\d+)_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}\.csv$/;

// Best-effort pick of a non-internal IPv4 address to publish in the marks
// broadcast (see protocol.js's encodeMarks) - a machine can have several
// interfaces (WiFi, Ethernet, VPNs...), this just takes the first plausible
// one. Override with BASE_IP if it picks the wrong one for your setup.
// Returns null if nothing suitable is found (e.g. no network at all).
function detectLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const addr of interfaces[name]) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

// Receives boat log uploads over HTTP - a rover pushes one of its chunked
// CSV files (see sdLogger.js) here whenever it's back in WiFi range of the
// base (see uploadClient.js). Deliberately dumb: no auth, no listing, just
// "accept this exact file into race-uploads." Writes to a .part file first
// and only renames into the final name once the full body has actually
// arrived (checked via req.complete, not just the write stream finishing -
// pipe() only ends the destination on the source's own 'end', so a
// dropped connection needs its own explicit cleanup path here) - a
// connection dropping mid-upload, exactly what happens when a rover drives
// out of WiFi range, leaves a stray .part file behind, never a truncated
// file masquerading as complete under the real filename. A retried upload
// of the same file just overwrites the stale .part and tries again.
//
// uploadClient.js sends each file gzip-compressed (smaller transfer, better
// odds of finishing inside a short WiFi window - see its own comment) but
// that's wire-transfer plumbing only: decompressed here on the way in, so
// what actually lands in race-uploads is a plain, immediately-readable
// .csv, identical to what the boat originally wrote - not something you
// need to gunzip yourself before opening it.
function startUploadServer({ port, uploadDir }) {
  fs.mkdirSync(uploadDir, { recursive: true });

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }

    const match = req.method === 'POST' && req.url.match(/^\/upload\/([^/]+)$/);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }

    const filename = decodeURIComponent(match[1]);
    const filenameMatch = VALID_FILENAME.exec(filename);
    if (!filenameMatch) {
      res.writeHead(400);
      res.end('invalid filename');
      return;
    }

    // One subdirectory per boat, named after its numeric ID (e.g.
    // race-uploads/1/boat1_2026-08-04T17-10.csv) - keeps a multi-boat
    // fleet's uploads organized instead of one flat directory of files
    // from every boat mixed together.
    const boatDir = path.join(uploadDir, filenameMatch[1]);
    fs.mkdirSync(boatDir, { recursive: true });

    const finalPath = path.join(boatDir, filename);
    const partPath = `${finalPath}.part`;
    const out = fs.createWriteStream(partPath);
    const gunzip = req.headers['content-encoding'] === 'gzip' ? zlib.createGunzip() : null;

    const onError = (stage) => (err) => {
      console.error(`[uploadServer] ${stage} failed for ${filename}:`, err.message);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
      out.destroy();
      if (gunzip) gunzip.destroy();
      fs.unlink(partPath, () => {});
    };

    out.on('error', onError('write'));
    if (gunzip) {
      gunzip.on('error', onError('decompress'));
      req.pipe(gunzip).pipe(out);
    } else {
      req.pipe(out);
    }

    // Finalizes once `out` has actually flushed everything - not driven off
    // req's own 'close' timing, since with gunzip in the pipe chain there
    // can still be buffered decompressed data working its way through to
    // disk after req itself has finished receiving bytes off the wire.
    // pipe() already calls out.end() automatically once its source (gunzip,
    // or req directly when uncompressed) reaches its own 'end' - calling
    // out.end() a second time here would race that, which is exactly what
    // was truncating uploads to 0 bytes before this fix.
    out.on('finish', () => {
      fs.rename(partPath, finalPath, (err) => {
        if (err) {
          console.error(`[uploadServer] failed to finalize ${filename}:`, err.message);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
          return;
        }
        console.log(`[uploadServer] received ${filename} (${fs.statSync(finalPath).size} bytes)`);
        res.writeHead(200);
        res.end('ok');
      });
    });

    req.on('close', () => {
      if (!req.complete) {
        // Connection dropped before the full body arrived - a rover going
        // out of WiFi range mid-upload is exactly this case. Don't
        // respond; the rover's own request already failed from the same
        // dropped connection and will retry this file later. Destroying
        // `out` here means it never reaches 'finish' above, so no rename
        // happens - the stale .part file just gets overwritten by the
        // next retry.
        out.destroy();
        if (gunzip) gunzip.destroy();
        fs.unlink(partPath, () => {});
      }
    });
  });

  server.on('error', (err) => console.error('[uploadServer] error:', err.message));
  server.listen(port, () => console.log(`[uploadServer] listening on :${port}, writing to ${uploadDir}`));

  return server;
}

module.exports = { startUploadServer, detectLocalIp, VALID_FILENAME };
