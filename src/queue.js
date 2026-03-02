class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }

  acquire() {
    return new Promise((resolve) => {
      if (this.count < this.max) {
        this.count++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.count--;
    }
  }

  async wrap(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// Per-domain rate limiter: enforces at least 1000ms between requests to the same domain
const domainLastRequest = new Map();
const userLastRequest = new Map();

async function domainRateLimit(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return;
  }

  const now = Date.now();
  const last = domainLastRequest.get(hostname) || 0;
  const wait = 1000 - (now - last);

  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }

  domainLastRequest.set(hostname, Date.now());
}

async function userRateLimit(userId, minGapMs = 250) {
  if (!userId) return;
  const key = String(userId);
  const now = Date.now();
  const last = userLastRequest.get(key) || 0;
  const wait = minGapMs - (now - last);
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  userLastRequest.set(key, Date.now());
}

// Global semaphore: max 5 concurrent URL checks
const checkSemaphore = new Semaphore(5);

const REDIS_URL = String(process.env.REDIS_URL || '').trim();
const BULLMQ_PREFIX = String(process.env.BULLMQ_PREFIX || 'metawatch').trim() || 'metawatch';
const QUEUE_NAMES = {
  meta: `${BULLMQ_PREFIX}:meta`,
  uptime: `${BULLMQ_PREFIX}:uptime`,
  notification: `${BULLMQ_PREFIX}:notification`
};

let QueueCtor = null;
let IORedisCtor = null;
let queueInitError = null;

try {
  ({ Queue: QueueCtor } = require('bullmq'));
  IORedisCtor = require('ioredis');
} catch (err) {
  queueInitError = err;
  if (REDIS_URL) {
    console.error(`[Queue] REDIS_URL is set, but BullMQ dependencies are unavailable: ${err.message}`);
  }
}

const queueEnabled = Boolean(REDIS_URL && QueueCtor && IORedisCtor);

let redisConnection = null;
let metaQueue = null;
let uptimeQueue = null;
let notificationQueue = null;

function getQueueBackendLabel() {
  return queueEnabled ? 'redis (bullmq)' : 'in-memory';
}

function isQueueEnabled() {
  return queueEnabled;
}

function getQueueDiagnostics() {
  return {
    backend: getQueueBackendLabel(),
    queueEnabled,
    redisUrlConfigured: Boolean(REDIS_URL),
    bullmqAvailable: Boolean(QueueCtor),
    ioredisAvailable: Boolean(IORedisCtor),
    initError: queueInitError ? String(queueInitError.message || queueInitError) : null
  };
}

function getRedisConnection() {
  if (!queueEnabled) return null;
  if (!redisConnection) {
    redisConnection = new IORedisCtor(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    });
    redisConnection.on('error', (err) => {
      console.error(`[Queue] Redis error: ${err.message}`);
    });
  }
  return redisConnection;
}

function ensureBullQueues() {
  if (!queueEnabled) {
    return {
      metaQueue: null,
      uptimeQueue: null,
      notificationQueue: null
    };
  }
  if (!metaQueue || !uptimeQueue || !notificationQueue) {
    const connection = getRedisConnection();
    const baseOptions = {
      connection,
      defaultJobOptions: {
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600, count: 2000 }
      }
    };
    metaQueue = metaQueue || new QueueCtor(QUEUE_NAMES.meta, baseOptions);
    uptimeQueue = uptimeQueue || new QueueCtor(QUEUE_NAMES.uptime, baseOptions);
    notificationQueue = notificationQueue || new QueueCtor(QUEUE_NAMES.notification, baseOptions);
  }
  return { metaQueue, uptimeQueue, notificationQueue };
}

function getQueueInstances() {
  return ensureBullQueues();
}

function mapPriority(priority) {
  const normalized = String(priority || '').toLowerCase().trim();
  if (normalized === 'critical') return 1;
  if (normalized === 'warning') return 3;
  if (normalized === 'info') return 6;
  return 5;
}

function safePositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function safeDedupWindowMs(value, fallbackMs) {
  const parsed = safePositiveInt(value, fallbackMs);
  if (!Number.isFinite(parsed)) return fallbackMs;
  return Math.max(0, parsed);
}

function buildEntityJobId(prefix, id, dedupWindowMs) {
  const windowMs = Math.max(0, safePositiveInt(dedupWindowMs, 0));
  if (windowMs === 0) {
    return `${prefix}:${id}:ts:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
  }
  const slot = Math.floor(Date.now() / windowMs);
  return `${prefix}:${id}:slot:${slot}`;
}

async function enqueueMetaCheck({ urlId, userId = null, source = 'scheduler', priority = 'warning' }) {
  const id = safePositiveInt(urlId, 0);
  if (id <= 0) return { queued: false, reason: 'invalid_url_id', backend: getQueueBackendLabel() };
  if (!queueEnabled) return { queued: false, backend: 'in-memory' };

  const { metaQueue } = ensureBullQueues();
  const dedupWindowMs = safeDedupWindowMs(process.env.QUEUE_META_DEDUP_MS, 45 * 1000);
  const jobId = buildEntityJobId('url', id, dedupWindowMs);
  try {
    const job = await metaQueue.add(
      'check-url',
      {
        urlId: id,
        userId: userId || null,
        source: String(source || 'scheduler'),
        queuedAt: new Date().toISOString()
      },
      {
        jobId,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        priority: mapPriority(priority)
      }
    );
    return { queued: true, backend: 'redis', jobId: String(job.id) };
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('jobid') || msg.includes('already exists')) {
      return { queued: true, backend: 'redis', jobId, duplicate: true };
    }
    throw err;
  }
}

async function enqueueUptimeCheck({ monitorId, userId = null, source = 'scheduler', priority = 'warning' }) {
  const id = safePositiveInt(monitorId, 0);
  if (id <= 0) return { queued: false, reason: 'invalid_monitor_id', backend: getQueueBackendLabel() };
  if (!queueEnabled) return { queued: false, backend: 'in-memory' };

  const { uptimeQueue } = ensureBullQueues();
  const dedupWindowMs = safeDedupWindowMs(process.env.QUEUE_UPTIME_DEDUP_MS, 45 * 1000);
  const jobId = buildEntityJobId('monitor', id, dedupWindowMs);
  try {
    const job = await uptimeQueue.add(
      'check-monitor',
      {
        monitorId: id,
        userId: userId || null,
        source: String(source || 'scheduler'),
        queuedAt: new Date().toISOString()
      },
      {
        jobId,
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        priority: mapPriority(priority)
      }
    );
    return { queued: true, backend: 'redis', jobId: String(job.id) };
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('jobid') || msg.includes('already exists')) {
      return { queued: true, backend: 'redis', jobId, duplicate: true };
    }
    throw err;
  }
}

async function enqueueNotification({
  channel,
  target,
  payload,
  alertId = null,
  jobId = null,
  delayMs = 0,
  attempts = 3
}) {
  if (!queueEnabled) return { queued: false, backend: 'in-memory' };
  const { notificationQueue } = ensureBullQueues();

  const job = await notificationQueue.add(
    'send-notification',
    {
      channel: String(channel || '').trim(),
      target,
      payload: payload || {},
      alertId: alertId || null,
      queuedAt: new Date().toISOString()
    },
    {
      jobId: jobId || undefined,
      delay: safePositiveInt(delayMs, 0),
      attempts: Math.max(1, safePositiveInt(attempts, 3)),
      backoff: { type: 'exponential', delay: 4000 }
    }
  );

  return { queued: true, backend: 'redis', jobId: String(job.id) };
}

async function getQueueStats() {
  if (!queueEnabled) return null;
  const { metaQueue, uptimeQueue, notificationQueue } = ensureBullQueues();
  const countKeys = ['waiting', 'active', 'delayed', 'completed', 'failed', 'paused'];
  const [meta, uptime, notification] = await Promise.all([
    metaQueue.getJobCounts(...countKeys),
    uptimeQueue.getJobCounts(...countKeys),
    notificationQueue.getJobCounts(...countKeys)
  ]);
  return { meta, uptime, notification };
}

async function closeBullQueues() {
  const closeOps = [];
  if (metaQueue?.close) closeOps.push(metaQueue.close());
  if (uptimeQueue?.close) closeOps.push(uptimeQueue.close());
  if (notificationQueue?.close) closeOps.push(notificationQueue.close());
  await Promise.allSettled(closeOps);

  if (redisConnection?.quit) {
    await redisConnection.quit().catch(() => {});
  } else if (redisConnection?.disconnect) {
    redisConnection.disconnect();
  }

  metaQueue = null;
  uptimeQueue = null;
  notificationQueue = null;
  redisConnection = null;
}

module.exports = {
  Semaphore,
  domainRateLimit,
  userRateLimit,
  checkSemaphore,
  QUEUE_NAMES,
  getQueueBackendLabel,
  isQueueEnabled,
  getQueueDiagnostics,
  getRedisConnection,
  getQueueInstances,
  enqueueMetaCheck,
  enqueueUptimeCheck,
  enqueueNotification,
  getQueueStats,
  closeBullQueues
};
