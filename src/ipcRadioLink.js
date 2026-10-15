const { EventEmitter } = require('events');
const { decodeDatagram } = require('./simRadioLink');

// The radio of a simulated boat that shares one REAL radio with its siblings (fleetSim.js with RF_BRIDGE=1). Same interface as
// RadioLink/SimRadioLink, but instead of a serial port or a UDP socket it talks to the parent process over the child_process IPC
// channel: send() hands the frame to the parent, which writes it to the real radio, and every frame the parent's radio hears
// arrives as a { radioRx } message. Frames cross whole (base64), so nothing needs re-framing here, as with SimRadioLink's UDP.
// The parent is the only thing that touches RF, so what the boats do is on air exactly as a real boat's frames would be.
class IpcRadioLink extends EventEmitter {
  constructor() {
    super();
    this._sleeping = false; // radio sleep mode of THIS boat: it hears nothing and sends nothing, as a real XBee in pin sleep
    process.on('message', (msg) => {
      if (!msg || typeof msg !== 'object' || typeof msg.radioRx !== 'string') return; // fleetSim's 'start-race' etc. are not ours
      if (this._sleeping) return;
      const buf = Buffer.from(msg.radioRx, 'base64');
      this.emit('bytes', { rx: buf.length });
      const result = decodeDatagram(buf);
      if (result) this.emit(result.event, result.decoded);
      else this.emit('sync-error');
    });
    // Ready as soon as the caller has attached its listeners (the parent opens the real radio and reconnects it on its own)
    setImmediate(() => this.emit('connected'));
  }

  get canSleep() {
    return true;
  }

  setSleeping(sleeping) {
    this._sleeping = !!sleeping;
  }

  send(buf) {
    if (this._sleeping) return false;
    if (typeof process.send !== 'function' || !process.connected) return false;
    process.send({ radioTx: buf.toString('base64') });
    this.emit('bytes', { tx: buf.length });
    return true;
  }

  broadcast(buf) {
    return this.send(buf);
  }
}

module.exports = { IpcRadioLink };
