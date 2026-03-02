function parsePositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function randomToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

async function tryAcquireLock(redis, key, ttlMs, token) {
  if (!redis || typeof redis.set !== 'function') return false;
  const res = await redis.set(key, token, 'PX', ttlMs, 'NX');
  return res === 'OK';
}

async function releaseLock(redis, key, token) {
  if (!redis || typeof redis.eval !== 'function') return;
  try {
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
  } catch {
    // Best-effort unlock. Lock has TTL as fallback.
  }
}

async function withRedisLock({
  redis,
  key,
  ttlMs,
  onLockedResult = { skipped: true, reason: 'duplicate_in_progress' }
}, run) {
  const safeTtl = parsePositiveInt(ttlMs, 5 * 60 * 1000);
  const token = randomToken();
  const acquired = await tryAcquireLock(redis, key, safeTtl, token).catch(() => false);
  if (!acquired) return onLockedResult;

  try {
    return await run();
  } finally {
    await releaseLock(redis, key, token);
  }
}

module.exports = {
  parsePositiveInt,
  withRedisLock
};

