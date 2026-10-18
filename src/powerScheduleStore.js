// The base's side of the fleet power schedule: the two rules set on the admin's Data page - the Witty Pi power schedule
// (wittySchedule.js) and the boat's own software shutdown (fleetShutdown.js) - their stored settings, Enable / Disable, and the
// one frame that carries both to the boats (protocol.js's encodePowerSchedule). A rule never set is sent as "not managed" and
// the boats keep their own; a disabled rule is still sent (a Witty Pi schedule as 'off', a shutdown as disabled), so a boat
// that missed the change still gets it. baseStation.js sends the frame now and every WITTY_REBROADCAST_S.
//
//   const store = createPowerScheduleStore({ send: (frame) => radio.broadcast(frame) });
//   store.setWitty({ action: 'enable', mode: 'daily', startTime: '09:00', endTime: '17:00' });
//   store.setShutdown({ action: 'disable' });

const protocol = require('./protocol');
const wittySchedule = require('./wittySchedule');
const fleetShutdown = require('./fleetShutdown');

function createPowerScheduleStore({
  send,
  wittyFile,
  shutdownFile,
  rebroadcastS = 60,
  getPlace = () => null,
  radioEnabled = () => true,
  nowMs = Date.now,
  log = console.log,
}) {
  let witty = wittySchedule.loadSettings(wittyFile); // { ...settings, enabled } or null
  let shutdown = fleetShutdown.load(shutdownFile); // { enabled, time, idleMinutes, speedKn, stamp } or null
  let lastSentAt = null;
  let sendCount = 0;
  const stampNow = () => Math.floor(nowMs() / 1000);

  // The frame for the current settings, or null when neither rule was ever set.
  function frame() {
    if (!witty && !shutdown) return null;
    return protocol.encodePowerSchedule({
      stamp: Math.max(witty ? witty.stamp : 0, shutdown ? shutdown.stamp : 0),
      witty: witty ? (witty.enabled ? witty : { ...witty, mode: 'off' }) : null,
      shutdown,
    });
  }

  function sendNow() {
    const f = frame();
    if (!f || !radioEnabled()) return false;
    send(f);
    lastSentAt = nowMs();
    sendCount++;
    return true;
  }

  // 'enable' stores the fields it is sent (if any) and turns the rule on - it is also how an enabled rule is updated;
  // 'disable' turns it off and keeps the stored fields. Throws a plain message on bad input.
  function setWitty(input) {
    if (input.action === 'enable') {
      if (input.mode) {
        const settings = wittySchedule.validateSettings({ ...input, mode: input.mode === 'off' ? 'daily' : input.mode, stamp: null }, nowMs());
        witty = { ...settings, enabled: true };
      } else if (witty) {
        witty = { ...witty, enabled: true, stamp: stampNow() };
      } else {
        throw new Error('fill in the schedule first');
      }
    } else if (input.action === 'disable') {
      if (!witty) throw new Error('there is no schedule to disable');
      witty = { ...witty, enabled: false, stamp: stampNow() };
    } else {
      throw new Error(`unknown action ${JSON.stringify(input.action)}`);
    }
    wittySchedule.saveSettings(witty, wittyFile);
    sendCount = 0;
    sendNow();
    log(`[witty] fleet Witty Pi schedule ${witty.enabled ? 'enabled' : 'disabled'}: ${wittySchedule.describe(witty)}`);
  }

  function setShutdown(input) {
    if (input.action === 'enable') {
      if (input.time) {
        shutdown = fleetShutdown.validate({ ...input, enabled: true, stamp: null }, nowMs());
      } else if (shutdown) {
        shutdown = { ...shutdown, enabled: true, stamp: stampNow() };
      } else {
        throw new Error('set the shutdown time first');
      }
    } else if (input.action === 'disable') {
      if (!shutdown) throw new Error('there is no shutdown to disable');
      shutdown = { ...shutdown, enabled: false, stamp: stampNow() };
    } else {
      throw new Error(`unknown action ${JSON.stringify(input.action)}`);
    }
    fleetShutdown.save(shutdown, shutdownFile);
    sendCount = 0;
    sendNow();
    log(`[shutdown] fleet shutdown ${shutdown.enabled ? 'enabled' : 'disabled'}: ${fleetShutdown.describe(shutdown)}`);
  }

  // What the admin cards show.
  function status() {
    return {
      lastSentAt,
      sendCount,
      rebroadcastS,
      radioEnabled: radioEnabled(),
      witty: { settings: witty, description: witty ? wittySchedule.describe(witty) : null, defaultPlace: getPlace() },
      shutdown: { settings: shutdown, description: shutdown ? fleetShutdown.describe(shutdown) : null },
    };
  }

  return { frame, sendNow, setWitty, setShutdown, status };
}

module.exports = { createPowerScheduleStore };
