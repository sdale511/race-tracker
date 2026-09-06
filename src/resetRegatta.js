const readline = require('readline');
const config = require('./config');
const { getPersistedRegattaId, persistRegattaId } = require('./regattaIdFile');

// Standalone CLI counterpart to the admin dashboard's own regatta dropdown
// (see baseStation.js's selectRegatta) and to baseStation's own startup
// terminal prompt (promptForRegatta) - lets an operator pick which regatta
// is "current" from the command line, without needing a running base
// station or its admin page open at all. Writes the same regatta-id.txt
// file either of those paths write (see regattaIdFile.js), so whichever was
// used most recently is what a base station picks up:
//   - a base station NOT currently running picks this up the next time it
//     starts (see config.js's resolveDefaultRegattaId)
//   - a base station that IS currently running keeps racing whatever it
//     already has selected - this only changes the on-disk default, it has
//     no way to reach into another process. Use the admin dashboard's own
//     dropdown to switch a live base station instead; the course/pin-
//     boundary/on-grid-zone refresh selectRegatta does there applies
//     immediately.
// Run with `npm run reset-regatta` (respects REGATTAUP_ACTIVE_REGATTAS_URL
// same as baseStation - see config.js).
(async () => {
  console.log(`[resetRegatta] fetching active/future regattas from ${config.regattaup.activeRegattasUrl}`);
  let regattas = [];
  try {
    const res = await fetch(config.regattaup.activeRegattasUrl, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    regattas = Array.isArray(body.regattas) ? body.regattas : [];
  } catch (err) {
    console.error('[resetRegatta] failed to fetch active regattas:', err.message);
    process.exitCode = 1;
    return;
  }
  if (regattas.length === 0) {
    console.log('[resetRegatta] no active/future regattas returned - nothing to pick from');
    return;
  }

  const current = getPersistedRegattaId();
  console.log(current ? `[resetRegatta] currently persisted default: "${current.name || current.id}"` : '[resetRegatta] no regatta currently persisted');
  console.log('\n[resetRegatta] choose a regatta:');
  regattas.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.name} - ${r.venue} (${r.start_date} to ${r.end_date})`);
  });

  if (!process.stdin.isTTY) {
    console.error('[resetRegatta] no interactive terminal to prompt on - run this from an actual terminal');
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () => new Promise((resolve) => rl.question('[resetRegatta] enter a number: ', resolve));
  let choice = null;
  while (!choice) {
    const answer = (await ask()).trim();
    const n = parseInt(answer, 10);
    if (Number.isInteger(n) && n >= 1 && n <= regattas.length) choice = regattas[n - 1];
    else console.log(`[resetRegatta] enter a number between 1 and ${regattas.length}`);
  }
  rl.close();

  persistRegattaId(choice.id, choice.name, choice.default_lat, choice.default_lon);
  console.log(
    `[resetRegatta] persisted "${choice.name}" (${choice.venue}, default center ${choice.default_lat}/${choice.default_lon}) as the default regatta - ` +
      'a base station not currently running will pick this up (course/pin-boundary/on-grid-zone included) on its next start; ' +
      'a base station that IS running keeps its current selection until switched from its own admin dashboard.'
  );
})();
