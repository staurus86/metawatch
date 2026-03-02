const express = require('express');
const { requireAdmin } = require('../auth');
const { isQueueEnabled, getQueueInstances, getQueueDiagnostics } = require('../queue');

const router = express.Router();

let cachedBoardRouter = null;
let boardUnavailableReason = null;
let boardUnavailableDetails = null;

function buildUnavailableReason() {
  const diagnostics = getQueueDiagnostics();
  if (!diagnostics.redisUrlConfigured) {
    return 'REDIS_URL is not configured on this service.';
  }
  if (!diagnostics.bullmqAvailable || !diagnostics.ioredisAvailable) {
    return 'BullMQ dependencies are unavailable in this build.';
  }
  return 'Queue dashboard is unavailable in the current runtime mode.';
}

function createBoardRouter() {
  if (!isQueueEnabled()) {
    boardUnavailableReason = buildUnavailableReason();
    boardUnavailableDetails = getQueueDiagnostics();
    return null;
  }

  try {
    const { createBullBoard } = require('@bull-board/api');
    const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
    const { ExpressAdapter } = require('@bull-board/express');
    const { metaQueue, uptimeQueue, notificationQueue } = getQueueInstances();

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');

    createBullBoard({
      queues: [metaQueue, uptimeQueue, notificationQueue]
        .filter(Boolean)
        .map((q) => new BullMQAdapter(q)),
      serverAdapter
    });

    boardUnavailableReason = null;
    boardUnavailableDetails = null;
    return serverAdapter.getRouter();
  } catch (err) {
    boardUnavailableReason = `Bull Board dependencies missing: ${err.message}`;
    boardUnavailableDetails = {
      ...getQueueDiagnostics(),
      bullBoardAvailable: false,
      bullBoardError: err.message
    };
    console.error(`[Queue] Unable to initialize Bull Board: ${err.message}`);
    return null;
  }
}

router.use(requireAdmin);

router.use((req, res, next) => {
  if (!cachedBoardRouter) {
    cachedBoardRouter = createBoardRouter();
  }

  if (!cachedBoardRouter) {
    return res.status(200).render('admin-queues-unavailable', {
      title: 'Admin — Queue Dashboard',
      reason: boardUnavailableReason || 'Queue dashboard is unavailable',
      diagnostics: boardUnavailableDetails || getQueueDiagnostics()
    });
  }

  return cachedBoardRouter(req, res, next);
});

module.exports = router;
