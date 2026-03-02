const express = require('express');
const { requireAdmin } = require('../auth');
const { isQueueEnabled, getQueueInstances } = require('../queue');

const router = express.Router();

let cachedBoardRouter = null;
let boardUnavailableReason = null;

function createBoardRouter() {
  if (!isQueueEnabled()) {
    boardUnavailableReason = 'Queue dashboard requires REDIS_URL and BullMQ mode.';
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
    return serverAdapter.getRouter();
  } catch (err) {
    boardUnavailableReason = `Bull Board dependencies missing: ${err.message}`;
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
    return res.status(503).render('error', {
      title: 'Queue Dashboard Unavailable',
      error: boardUnavailableReason || 'Queue dashboard is unavailable'
    });
  }

  return cachedBoardRouter(req, res, next);
});

module.exports = router;
