const { checkMonitor } = require('../uptime-checker');
const { isQueueEnabled, getRedisConnection, QUEUE_NAMES } = require('../queue');
const { parsePositiveInt, withRedisLock } = require('./lock');

function getWorkerCtor() {
  try {
    return require('bullmq').Worker;
  } catch {
    return null;
  }
}

function startUptimeWorker() {
  if (!isQueueEnabled()) return null;

  const Worker = getWorkerCtor();
  if (!Worker) {
    console.error('[Queue] BullMQ Worker is unavailable; uptime worker not started');
    return null;
  }

  const concurrency = Math.max(1, parseInt(process.env.UPTIME_WORKER_CONCURRENCY || '5', 10) || 5);
  const lockTtlMs = parsePositiveInt(process.env.UPTIME_WORKER_LOCK_TTL_MS, 15 * 60 * 1000);
  const lockPrefix = String(process.env.WORKER_LOCK_PREFIX || 'metawatch:lock').trim() || 'metawatch:lock';
  const redis = getRedisConnection();
  const worker = new Worker(
    QUEUE_NAMES.uptime,
    async (job) => {
      const monitorId = parseInt(job?.data?.monitorId, 10);
      if (!Number.isFinite(monitorId) || monitorId <= 0) {
        return { skipped: true, reason: 'invalid_monitor_id' };
      }
      const lockKey = `${lockPrefix}:uptime:monitor:${monitorId}`;
      return withRedisLock(
        {
          redis,
          key: lockKey,
          ttlMs: lockTtlMs,
          onLockedResult: { skipped: true, reason: 'duplicate_in_progress', monitorId }
        },
        async () => {
          await checkMonitor(monitorId);
          return { ok: true, monitorId };
        }
      );
    },
    {
      connection: redis,
      concurrency
    }
  );

  worker.on('failed', (job, err) => {
    const monitorId = job?.data?.monitorId || '?';
    console.error(`[Queue] Uptime worker failed monitor #${monitorId}: ${err.message}`);
  });

  worker.on('error', (err) => {
    console.error(`[Queue] Uptime worker error: ${err.message}`);
  });

  console.log(`[Queue] Uptime worker started (concurrency=${concurrency})`);
  return worker;
}

module.exports = { startUptimeWorker };
