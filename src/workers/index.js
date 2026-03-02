const { isQueueEnabled } = require('../queue');
const { startMetaWorker } = require('./meta-worker');
const { startUptimeWorker } = require('./uptime-worker');
const { startNotificationWorker } = require('./notification-worker');

const workerState = {
  started: false,
  meta: null,
  uptime: null,
  notification: null
};

async function closeWorker(worker) {
  if (!worker || typeof worker.close !== 'function') return;
  await worker.close().catch((err) => {
    console.error(`[Queue] Worker close error: ${err.message}`);
  });
}

async function startQueueWorkers() {
  if (!isQueueEnabled()) return workerState;
  if (workerState.started) return workerState;

  workerState.meta = startMetaWorker();
  workerState.uptime = startUptimeWorker();
  workerState.notification = startNotificationWorker();
  workerState.started = true;

  return workerState;
}

async function stopQueueWorkers() {
  if (!workerState.started) return workerState;
  await Promise.all([
    closeWorker(workerState.meta),
    closeWorker(workerState.uptime),
    closeWorker(workerState.notification)
  ]);
  workerState.meta = null;
  workerState.uptime = null;
  workerState.notification = null;
  workerState.started = false;
  return workerState;
}

function getWorkerStatus() {
  return {
    started: workerState.started,
    meta: !!workerState.meta,
    uptime: !!workerState.uptime,
    notification: !!workerState.notification
  };
}

module.exports = {
  startQueueWorkers,
  stopQueueWorkers,
  getWorkerStatus
};
