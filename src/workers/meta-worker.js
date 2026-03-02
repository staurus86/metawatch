const { checkUrl } = require('../checker');
const { isQueueEnabled, getRedisConnection, QUEUE_NAMES } = require('../queue');

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
  const worker = new Worker(
    QUEUE_NAMES.meta,
    async (job) => {
      const urlId = parseInt(job?.data?.urlId, 10);
      if (!Number.isFinite(urlId) || urlId <= 0) {
        return { skipped: true, reason: 'invalid_url_id' };
      }
      await checkUrl(urlId);
      return { ok: true, urlId };
    },
    {
      connection: getRedisConnection(),
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
