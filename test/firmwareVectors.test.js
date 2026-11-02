const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

// The ESP32 rover (firmware/esp32-rover) is tested against vectors written from this repo's Node code. If a change to
// protocol.js (or the other modules tools/gen_vectors.js reads) leaves them stale, the C++ would be tested against the old
// wire format - so fail here, where every Node change is tested, and say how to fix it.
test('the ESP32 rover test vectors match the Node code', () => {
  const script = path.join(__dirname, '..', 'firmware', 'esp32-rover', 'tools', 'gen_vectors.js');
  try {
    execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' });
  } catch (err) {
    assert.fail(String(err.stderr || err.message).trim());
  }
});
