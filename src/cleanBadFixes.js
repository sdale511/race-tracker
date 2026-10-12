const config = require('./config');
const { RedisStore } = require('./redisStore');
const { implausibleReason } = require('./fixSanity');

// Finds corrupted fixes already stored in a regatta's tracks (a boat id of garbage characters, a latitude past 90, a time in
// 1994 or 2049 - see fixSanity.js) and, with --apply, removes them from the regatta's all-boats track, the boat's own track
// and, when that leaves a boat with no fixes at all, the known-boats set. Without --apply it only lists what it found.
// Run with `npm run clean-bad-fixes` (the regatta saved in regatta-id.txt, or `-- --regatta <id>`); respects REDIS_ENV /
// REDIS_URL like everything else, so it works on whichever Redis your base writes to.
(async () => {
  const apply = process.argv.includes('--apply');
  const at = process.argv.indexOf('--regatta');
  const regattaId = at !== -1 ? process.argv[at + 1] : config.regattaup.defaultRegatta && config.regattaup.defaultRegatta.id;
  if (!regattaId) {
    console.error('[cleanBadFixes] no regatta - pass --regatta <id>, or select one first (race-config/regatta-id.txt)');
    process.exit(1);
  }
  const store = new RedisStore({
    url: config.redis.url,
    connection: config.redis.connection,
    minMovementM: config.redis.minMovementM,
    trackRetentionHours: config.redis.trackRetentionHours,
    keepaliveIntervalMs: config.redis.keepaliveIntervalMs,
  });
  await store.ready;
  const prefix = `regattas:${regattaId}:`;
  const raw = await store.client.zrange(`${prefix}all:track`, 0, -1, 'WITHSCORES');
  console.log(`[cleanBadFixes] regatta ${regattaId}: ${raw.length / 2} fixes in the all-boats track`);
  const bad = [];
  for (let i = 0; i < raw.length; i += 2) {
    let p = null;
    try {
      p = JSON.parse(raw[i]);
    } catch (e) {
      // unparseable member
    }
    const fix = p && { boatId: p.b ?? p.boatId, lat: p.la ?? p.lat, lon: p.lo ?? p.lon, speedKnots: p.s ?? p.speedKnots, timestamp: Number(raw[i + 1]) };
    const why = p ? implausibleReason(fix) : 'unparseable';
    if (why) bad.push({ member: raw[i], boatId: fix ? fix.boatId : null, why });
  }
  if (bad.length === 0) console.log('[cleanBadFixes] nothing suspicious found');
  for (const b of bad) console.log(`  ${apply ? 'removing' : 'found'}: boat ${JSON.stringify(b.boatId)} - ${b.why}`);
  if (apply && bad.length) {
    for (const b of bad) {
      await store.client.zrem(`${prefix}all:track`, b.member);
      if (typeof b.boatId === 'string') {
        const key = `${prefix}boat:${b.boatId}:track`;
        await store.client.zrem(key, b.member);
        if ((await store.client.zcard(key)) === 0) await store.client.srem(`${prefix}boats:known`, b.boatId);
      }
    }
    console.log(`[cleanBadFixes] removed ${bad.length} fix(es)`);
  } else if (bad.length) {
    console.log('[cleanBadFixes] nothing removed - run again with --apply (npm run clean-bad-fixes -- --apply) to delete them');
  }
  process.exit(0);
})().catch((err) => {
  console.error('[cleanBadFixes] failed:', err.message);
  process.exit(1);
});
