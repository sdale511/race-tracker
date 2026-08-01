const config = require('./config');

// Prints the fully-resolved configuration - every default plus whatever
// you've actually overridden via environment variables or a .env file - so
// there's one place to check "what am I actually running with" instead of
// reading through config.js's env var fallbacks by hand. Secrets (the
// Redis password) are redacted, never printed even in a debug tool.
const redacted = JSON.parse(JSON.stringify(config));
if (redacted.redis && redacted.redis.connection && redacted.redis.connection.password) {
  redacted.redis.connection.password = '***REDACTED***';
}

console.log(JSON.stringify(redacted, null, 2));
