const cron = require('node-cron');
const pool = require('./db');
const { checkUrl } = require('./checker');
const { checkMonitor } = require('./uptime-checker');
const { checkSemaphore, domainRateLimit, userRateLimit } = require('./queue');
const { sendDigest } = require('./mailer');
const { sendWebhook } = require('./notifier');
const { runOnboardingSequenceDaily } = require('./onboarding-sequence');

// Map of urlId -> cron ScheduledTask
const activeJobs = new Map();
// Map of monitorId -> cron ScheduledTask (uptime monitors)
const uptimeJobs = new Map();

// Runtime de-duplication to avoid parallel checks for same entity in this process
const runningUrlChecks = new Set();
const runningMonitorChecks = new Set();

let schedulerStarted = false;
let schedulerLockClient = null;
const SCHEDULER_LOCK_KEY_A = 9090;
const SCHEDULER_LOCK_KEY_B = 2026;

function intervalToCron(minutes) {
  if (minutes <= 0) minutes = 60;
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return '0 0 * * *';
  if (hours === 1) return '0 * * * *';
  return `0 */${hours} * * *`;
}

function getPriorityLevel(intervalMinutes) {
  if (intervalMinutes <= 15) return 'critical';
  if (intervalMinutes <= 60) return 'warning';
  return 'info';
}

function getJitterMs(priority) {
  if (priority === 'critical') return Math.floor(Math.random() * 10 * 1000);
  if (priority === 'warning') return Math.floor(Math.random() * 30 * 1000);
  return Math.floor(Math.random() * 60 * 1000);
}

function interleaveByUser(records) {
  const buckets = new Map();
  for (const r of records) {
    const key = String(r.user_id || '0');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const keys = [...buckets.keys()];
  const out = [];
  let idx = 0;
  while (keys.length > 0) {
    const key = keys[idx % keys.length];
    const bucket = buckets.get(key);
    const next = bucket.shift();
    if (next) out.push(next);
    if (bucket.length === 0) {
      const removeAt = keys.indexOf(key);
      if (removeAt >= 0) keys.splice(removeAt, 1);
    } else {
      idx++;
    }
  }
  return out;
}

async function acquireSchedulerLock() {
  if (schedulerLockClient) return true;

  const client = await pool.connect();
  try {
    const { rows: [row] } = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [SCHEDULER_LOCK_KEY_A, SCHEDULER_LOCK_KEY_B]
    );
    if (!row?.locked) {
      client.release();
      return false;
    }
    schedulerLockClient = client;
    return true;
  } catch (err) {
    client.release();
    throw err;
  }
}

async function releaseSchedulerLock() {
  if (!schedulerLockClient) return;
  try {
    await schedulerLockClient.query(
      'SELECT pg_advisory_unlock($1, $2)',
      [SCHEDULER_LOCK_KEY_A, SCHEDULER_LOCK_KEY_B]
    );
  } catch {
    // Lock is session-bound; releasing connection is enough on shutdown
  } finally {
    schedulerLockClient.release();
    schedulerLockClient = null;
  }
}

async function runUrlCheck(urlRecord, source = 'cron') {
  const { id, url } = urlRecord;
  if (runningUrlChecks.has(id)) {
    console.log(`[Scheduler] Skip URL #${id} (${source}) — already running`);
    return;
  }
  runningUrlChecks.add(id);
  try {
    await checkSemaphore.wrap(async () => {
      await userRateLimit(urlRecord.user_id, 250);
      await domainRateLimit(url);
      await checkUrl(id);
    });
  } catch (err) {
    console.error(`[Scheduler] Error checking URL #${id} (${url}): ${err.message}`);
  } finally {
    runningUrlChecks.delete(id);
  }
}

async function runMonitorCheck(monitor, source = 'cron') {
  const { id, url } = monitor;
  if (runningMonitorChecks.has(id)) {
    console.log(`[Uptime] Skip monitor #${id} (${source}) — already running`);
    return;
  }
  runningMonitorChecks.add(id);
  try {
    await checkSemaphore.wrap(async () => {
      await userRateLimit(monitor.user_id, 200);
      await domainRateLimit(url);
      await checkMonitor(id);
    });
  } catch (err) {
    console.error(`[Uptime] Error checking monitor #${id} (${url}): ${err.message}`);
  } finally {
    runningMonitorChecks.delete(id);
  }
}

function scheduleUrl(urlRecord) {
  const { id, check_interval_minutes } = urlRecord;

  if (activeJobs.has(id)) {
    activeJobs.get(id).stop();
    activeJobs.delete(id);
  }

  const cronExpr = intervalToCron(check_interval_minutes);
  const priority = getPriorityLevel(check_interval_minutes);

  const job = cron.schedule(cronExpr, () => {
    const jitterMs = getJitterMs(priority);
    setTimeout(() => runUrlCheck(urlRecord, `cron:${priority}`), jitterMs);
  });

  activeJobs.set(id, job);
  console.log(`[Scheduler] URL #${id} scheduled — every ${check_interval_minutes}min [${priority}]`);
}

function unscheduleUrl(urlId) {
  if (activeJobs.has(urlId)) {
    activeJobs.get(urlId).stop();
    activeJobs.delete(urlId);
    console.log(`[Scheduler] Removed URL #${urlId}`);
  }
}

async function startScheduler() {
  if (schedulerStarted) {
    console.log('[Scheduler] Already started in this process');
    return;
  }
  schedulerStarted = true;

  const hasLock = await acquireSchedulerLock();
  if (!hasLock) {
    console.log('[Scheduler] Another instance owns the scheduler lock; skipping cron startup');
    return;
  }

  // Keep lock until process exits
  process.once('beforeExit', () => {
    releaseSchedulerLock().catch(() => {});
  });
  process.once('SIGTERM', () => {
    releaseSchedulerLock().finally(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    releaseSchedulerLock().finally(() => process.exit(0));
  });

  const { rows } = await pool.query(
    'SELECT id, url, check_interval_minutes, user_id FROM monitored_urls WHERE is_active = true'
  );
  const fairRows = interleaveByUser(rows);

  // Startup stagger: spread load over up to 5 min
  const staggerMaxMs = 5 * 60 * 1000;
  const staggerStep = fairRows.length > 1
    ? Math.floor(staggerMaxMs / fairRows.length)
    : 0;

  for (let i = 0; i < fairRows.length; i++) {
    const delay = Math.min(staggerMaxMs, i * staggerStep) + Math.floor(Math.random() * 3000);
    setTimeout(() => scheduleUrl(fairRows[i]), delay);
  }

  console.log(`[Scheduler] Started with ${fairRows.length} active URL(s)`);

  // Load and schedule uptime monitors
  const { rows: monitors } = await pool.query(
    'SELECT id, url, interval_minutes, user_id FROM uptime_monitors WHERE is_active = true'
  );
  for (const m of interleaveByUser(monitors)) scheduleMonitor(m);
  console.log(`[Uptime] Started with ${monitors.length} active monitor(s)`);

  // Snapshot + logs retention — runs daily at 03:00
  const retentionDays = parseInt(process.env.SNAPSHOT_RETENTION_DAYS || '90', 10);
  const alertRetentionDays = parseInt(process.env.ALERT_RETENTION_DAYS || '180', 10);
  const notificationRetentionDays = parseInt(process.env.NOTIFICATION_LOG_RETENTION_DAYS || '180', 10);
  const webhookLogRetentionDays = parseInt(process.env.WEBHOOK_LOG_RETENTION_DAYS || '30', 10);

  cron.schedule('0 3 * * *', async () => {
    try {
      if (retentionDays > 0) {
        const snapshotRes = await pool.query(
          `DELETE FROM snapshots
           WHERE checked_at < NOW() - INTERVAL '${retentionDays} days'
             AND id NOT IN (
               SELECT DISTINCT reference_snapshot_id
               FROM monitored_urls
               WHERE reference_snapshot_id IS NOT NULL
             )`
        );
        if (snapshotRes.rowCount > 0) {
          console.log(`[Retention] Deleted ${snapshotRes.rowCount} snapshots older than ${retentionDays} days`);
        }

        const upRes = await pool.query(
          `DELETE FROM uptime_checks WHERE checked_at < NOW() - INTERVAL '${retentionDays} days'`
        );
        if (upRes.rowCount > 0) {
          console.log(`[Retention] Deleted ${upRes.rowCount} uptime_checks older than ${retentionDays} days`);
        }
      }

      if (alertRetentionDays > 0) {
        const alertRes = await pool.query(
          `DELETE FROM alerts WHERE detected_at < NOW() - INTERVAL '${alertRetentionDays} days'`
        );
        if (alertRes.rowCount > 0) {
          console.log(`[Retention] Deleted ${alertRes.rowCount} alerts older than ${alertRetentionDays} days`);
        }
      }

      if (notificationRetentionDays > 0) {
        const logRes = await pool.query(
          `DELETE FROM notification_log WHERE sent_at < NOW() - INTERVAL '${notificationRetentionDays} days'`
        );
        if (logRes.rowCount > 0) {
          console.log(`[Retention] Deleted ${logRes.rowCount} notification logs older than ${notificationRetentionDays} days`);
        }
      }

      if (webhookLogRetentionDays > 0) {
        const whRes = await pool.query(
          `DELETE FROM webhook_delivery_log
           WHERE created_at < NOW() - INTERVAL '${webhookLogRetentionDays} days'
             AND status IN ('delivered', 'failed')`
        );
        if (whRes.rowCount > 0) {
          console.log(`[Retention] Deleted ${whRes.rowCount} webhook logs older than ${webhookLogRetentionDays} days`);
        }
      }
    } catch (err) {
      console.error('[Retention] Error:', err.message);
    }
  });
  console.log('[Scheduler] Retention cron active (daily)');

  // Email digest cron — runs every hour, checks per-user settings
  cron.schedule('0 * * * *', () => sendHourlyDigests());
  console.log('[Scheduler] Email digest cron active (hourly check)');

  // Webhook retry cron — runs every 2 minutes
  cron.schedule('*/2 * * * *', () => retryWebhooks());
  console.log('[Scheduler] Webhook retry queue active (every 2 min)');

  // Onboarding email sequence cron — runs daily
  cron.schedule('30 9 * * *', () => runOnboardingSequenceDaily());
  console.log('[Scheduler] Onboarding sequence cron active (daily at 09:30 UTC)');
}

async function sendHourlyDigests() {
  try {
    const now = new Date();
    const currentHour = now.getUTCHours();
    const currentDow = now.getUTCDay(); // 0=Sun, 1=Mon, ...

    // Find digest_settings rows due this hour
    const { rows: settings } = await pool.query(`
      SELECT ds.*, u.email AS user_email, u.id AS uid, COALESCE(u.language, 'en') AS user_language
      FROM digest_settings ds
      JOIN users u ON u.id = ds.user_id
      WHERE ds.enabled = true
        AND ds.hour = $1
        AND (
          ds.frequency = 'daily'
          OR (ds.frequency = 'weekly' AND ds.day_of_week = $2)
        )
        AND (ds.last_sent_at IS NULL OR ds.last_sent_at < NOW() - INTERVAL '20 hours')
    `, [currentHour, currentDow]);

    for (const ds of settings) {
      const to = ds.alt_email || ds.user_email;
      if (!to) continue;

      const since = ds.last_sent_at || new Date(Date.now() - (ds.frequency === 'weekly' ? 7 * 86400000 : 86400000));
      const sinceIso = since.toISOString();

      // Section 1: Meta alerts
      const { rows: alerts } = await pool.query(`
        SELECT a.*, mu.url, mu.id AS url_id
        FROM alerts a
        JOIN monitored_urls mu ON mu.id = a.url_id
        WHERE mu.user_id = $1 AND a.detected_at > $2
        ORDER BY a.detected_at DESC LIMIT 200
      `, [ds.uid, sinceIso]);

      // Section 2: Uptime incidents
      const { rows: incidents } = await pool.query(`
        SELECT ui.*, um.name AS monitor_name, um.url AS monitor_url
        FROM uptime_incidents ui
        JOIN uptime_monitors um ON um.id = ui.monitor_id
        WHERE um.user_id = $1 AND ui.started_at > $2
        ORDER BY ui.started_at DESC LIMIT 50
      `, [ds.uid, sinceIso]);

      // Section 3: SSL expirations in next 30 days
      const { rows: sslExpirations } = await pool.query(`
        SELECT mu.url, mu.id AS url_id, s.ssl_expires_at,
               EXTRACT(DAY FROM s.ssl_expires_at - NOW())::int AS days_left
        FROM monitored_urls mu
        JOIN LATERAL (
          SELECT ssl_expires_at FROM snapshots
          WHERE url_id = mu.id AND ssl_expires_at IS NOT NULL
          ORDER BY checked_at DESC LIMIT 1
        ) s ON true
        WHERE mu.user_id = $1
          AND s.ssl_expires_at BETWEEN NOW() AND NOW() + INTERVAL '30 days'
        ORDER BY s.ssl_expires_at ASC
      `, [ds.uid]);

      if (alerts.length === 0 && incidents.length === 0 && sslExpirations.length === 0) {
        await pool.query('UPDATE digest_settings SET last_sent_at = NOW() WHERE id = $1', [ds.id]);
        continue;
      }

      const locale = String(ds.user_language || 'en').toLowerCase() === 'ru' ? 'ru-RU' : 'en-US';
      const rangeEnd = now.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
      const rangeStart = new Date(since).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
      const dateRange = ds.frequency === 'weekly' ? `${rangeStart} - ${rangeEnd}` : rangeEnd;
      const periodLabel = ds.frequency === 'weekly'
        ? (locale === 'ru-RU' ? `Последние 7 дней (${dateRange})` : `Last 7 days (${dateRange})`)
        : (locale === 'ru-RU' ? 'Последние 24 часа' : 'Last 24 hours');

      const sent = await sendDigest({
        to, frequency: ds.frequency, periodLabel, dateRange,
        language: ds.user_language,
        alerts, incidents, sslExpirations
      });

      if (sent) {
        await pool.query('UPDATE digest_settings SET last_sent_at = NOW() WHERE id = $1', [ds.id]);
      }
    }
  } catch (err) {
    console.error('[Digest] Hourly check error:', err.message);
  }
}

// ─── Webhook retry queue ──────────────────────────────────────────────────────

async function retryWebhooks() {
  try {
    const { rows: pending } = await pool.query(
      `SELECT * FROM webhook_delivery_log
       WHERE status = 'pending' AND next_retry_at <= NOW()
       ORDER BY next_retry_at ASC LIMIT 20`
    );

    for (const job of pending) {
      try {
        const delivered = await sendWebhook({
          webhookUrl: job.webhook_url,
          payload: JSON.parse(job.payload)
        });
        if (!delivered) {
          throw new Error('Webhook blocked or delivery failed');
        }
        await pool.query(
          `UPDATE webhook_delivery_log
           SET status = 'delivered', last_attempt_at = NOW(), attempts = attempts + 1
           WHERE id = $1`,
          [job.id]
        );
      } catch (err) {
        const attempts = job.attempts + 1;
        const MAX_ATTEMPTS = 5;
        const backoffSeconds = Math.pow(2, attempts) * 60; // 2min, 4min, 8min, 16min, 32min

        if (attempts >= MAX_ATTEMPTS) {
          await pool.query(
            `UPDATE webhook_delivery_log
             SET status = 'failed', last_attempt_at = NOW(), attempts = $1, error_message = $2
             WHERE id = $3`,
            [attempts, err.message, job.id]
          );
        } else {
          await pool.query(
            `UPDATE webhook_delivery_log
              SET last_attempt_at = NOW(), attempts = $1, error_message = $2,
                 next_retry_at = NOW() + make_interval(secs => $3::int)
              WHERE id = $4`,
            [attempts, err.message, backoffSeconds, job.id]
          );
        }
      }
    }
  } catch (err) {
    console.error('[WebhookRetry] Error:', err.message);
  }
}

// ─── Uptime monitor scheduling ────────────────────────────────────────────────

function scheduleMonitor(monitor) {
  const { id, interval_minutes } = monitor;

  if (uptimeJobs.has(id)) {
    uptimeJobs.get(id).stop();
    uptimeJobs.delete(id);
  }

  const cronExpr = intervalToCron(interval_minutes);
  const priority = getPriorityLevel(interval_minutes);

  const job = cron.schedule(cronExpr, () => {
    const jitterMs = getJitterMs(priority);
    setTimeout(() => runMonitorCheck(monitor, `cron:${priority}`), jitterMs);
  });

  uptimeJobs.set(id, job);
  console.log(`[Uptime] Monitor #${id} scheduled — every ${interval_minutes}min [${priority}]`);
}

function unscheduleMonitor(monitorId) {
  if (uptimeJobs.has(monitorId)) {
    uptimeJobs.get(monitorId).stop();
    uptimeJobs.delete(monitorId);
    console.log(`[Uptime] Removed monitor #${monitorId}`);
  }
}

function getSchedulerStatus() {
  return {
    started: schedulerStarted,
    hasLock: !!schedulerLockClient,
    queueBackend: process.env.REDIS_URL ? 'redis (not configured in this build)' : 'in-memory',
    urlJobs: activeJobs.size,
    uptimeJobs: uptimeJobs.size,
    runningUrlChecks: runningUrlChecks.size,
    runningUptimeChecks: runningMonitorChecks.size
  };
}

module.exports = {
  startScheduler,
  scheduleUrl,
  unscheduleUrl,
  scheduleMonitor,
  unscheduleMonitor,
  intervalToCron,
  getSchedulerStatus
};
