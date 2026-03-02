const { checkUrl } = require('../checker');
const { isQueueEnabled, getRedisConnection, QUEUE_NAMES } = require('../queue');
const { parsePositiveInt, withRedisLock } = require('./lock');

function getWorkerCtor() {
  try {
    return require('bullmq').Worker;
  } catch {
    return null;
  }
}

function startMetaWorker() {
  if (!isQueueEnabled()) return null;

  const Worker = getWorkerCtor();
  if (!Worker) {
    console.error('[Queue] BullMQ Worker is unavailable; meta worker not started');
    return null;
  }

  const concurrency = Math.max(1, parseInt(process.env.META_WORKER_CONCURRENCY || '5', 10) || 5);
  const lockTtlMs = parsePositiveInt(process.env.META_WORKER_LOCK_TTL_MS, 20 * 60 * 1000);
  const lockPrefix = String(process.env.WORKER_LOCK_PREFIX || 'metawatch:lock').trim() || 'metawatch:lock';
  const redis = getRedisConnection();
  const worker = new Worker(
    QUEUE_NAMES.meta,
    async (job) => {
      const urlId = parseInt(job?.data?.urlId, 10);
      if (!Number.isFinite(urlId) || urlId <= 0) {
        return { skipped: true, reason: 'invalid_url_id' };
      }
      const lockKey = `${lockPrefix}:meta:url:${urlId}`;
      return withRedisLock(
        {
          redis,
          key: lockKey,
          ttlMs: lockTtlMs,
          onLockedResult: { skipped: true, reason: 'duplicate_in_progress', urlId }
        },
        async () => {
          await checkUrl(urlId);
          return { ok: true, urlId };
        }
      );
    },
    {
      connection: redis,
      concurrency
    }
  );

  worker.on('failed', (job, err) => {
    const urlId = job?.data?.urlId || '?';
    console.error(`[Queue] Meta worker failed URL #${urlId}: ${err.message}`);
  });

  worker.on('error', (err) => {
    console.error(`[Queue] Meta worker error: ${err.message}`);
  });

  console.log(`[Queue] Meta worker started (concurrency=${concurrency})`);
  return worker;
}

module.exports = { startMetaWorker };
