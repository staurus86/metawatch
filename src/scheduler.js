const cron = require('node-cron');
const axios = require('axios');
const pool = require('./db');
const { checkUrl } = require('./checker');
const { checkMonitor } = require('./uptime-checker');
const { checkSemaphore, domainRateLimit } = require('./queue');
const { sendDigest } = require('./mailer');

// Map of urlId -> cron ScheduledTask
const activeJobs = new Map();
// Map of monitorId -> cron ScheduledTask (uptime monitors)
const uptimeJobs = new Map();

function intervalToCron(minutes) {
  if (minutes <= 0) minutes = 60;
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return '0 0 * * *';
  if (hours === 1) return '0 * * * *';
  return `0 */${hours} * * *`;
}

function scheduleUrl(urlRecord) {
  const { id, url, check_interval_minutes } = urlRecord;

  if (activeJobs.has(id)) {
    activeJobs.get(id).stop();
    activeJobs.delete(id);
  }

  const cronExpr = intervalToCron(check_interval_minutes);

  const job = cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Running check: ${url}`);
    try {
      await checkSemaphore.wrap(async () => {
        await domainRateLimit(url);
        await checkUrl(id);
      });
    } catch (err) {
      console.error(`[Scheduler] Error checking URL #${id} (${url}): ${err.message}`);
    }
  });

  activeJobs.set(id, job);
  console.log(`[Scheduler] URL #${id} scheduled — every ${check_interval_minutes}min [${cronExpr}]`);
}

function unscheduleUrl(urlId) {
  if (activeJobs.has(urlId)) {
    activeJobs.get(urlId).stop();
    activeJobs.delete(urlId);
    console.log(`[Scheduler] Removed URL #${urlId}`);
  }
}

async function startScheduler() {
  const { rows } = await pool.query(
    'SELECT id, url, check_interval_minutes FROM monitored_urls WHERE is_active = true'
  );

  for (const row of rows) {
    scheduleUrl(row);
  }

  console.log(`[Scheduler] Started with ${rows.length} active URL(s)`);

  // Load and schedule uptime monitors
  const { rows: monitors } = await pool.query(
    'SELECT id, url, interval_minutes FROM uptime_monitors WHERE is_active = true'
  );
  for (const m of monitors) scheduleMonitor(m);
  console.log(`[Uptime] Started with ${monitors.length} active monitor(s)`);

  // Snapshot retention — runs daily at 03:00
  const retentionDays = parseInt(process.env.SNAPSHOT_RETENTION_DAYS || '90', 10);
  if (retentionDays > 0) {
    cron.schedule('0 3 * * *', async () => {
      try {
        const result = await pool.query(
          `DELETE FROM snapshots
           WHERE checked_at < NOW() - INTERVAL '${retentionDays} days'
             AND id NOT IN (
               SELECT DISTINCT reference_snapshot_id
               FROM monitored_urls
               WHERE reference_snapshot_id IS NOT NULL
             )`
        );
        if (result.rowCount > 0) {
          console.log(`[Retention] Deleted ${result.rowCount} snapshots older than ${retentionDays} days`);
        }
        // Uptime checks retention (same period)
        const upRes = await pool.query(
          `DELETE FROM uptime_checks WHERE checked_at < NOW() - INTERVAL '${retentionDays} days'`
        );
        if (upRes.rowCount > 0) {
          console.log(`[Retention] Deleted ${upRes.rowCount} uptime_checks older than ${retentionDays} days`);
        }
      } catch (err) {
        console.error('[Retention] Error:', err.message);
      }
    });
    console.log(`[Scheduler] Snapshot retention enabled (${retentionDays} days)`);
  }

  // Email digest cron jobs
  // Daily: every day at 08:00
  cron.schedule('0 8 * * *', () => sendDigests('daily'));
  // Weekly: every Monday at 08:00
  cron.schedule('0 8 * * 1', () => sendDigests('weekly'));
  console.log('[Scheduler] Email digest jobs scheduled (daily 08:00, weekly Mon 08:00)');

  // Webhook retry cron — runs every 2 minutes
  cron.schedule('*/2 * * * *', () => retryWebhooks());
  console.log('[Scheduler] Webhook retry queue active (every 2 min)');
}

async function sendDigests(frequency) {
  const interval = frequency === 'weekly' ? '7 days' : '24 hours';
  const periodLabel = frequency === 'weekly'
    ? `Last 7 days (${new Date(Date.now() - 7 * 86400000).toLocaleDateString()} – today)`
    : `Last 24 hours`;

  try {
    // Find users with this digest frequency who have a digest_email
    const { rows: users } = await pool.query(
      `SELECT id, COALESCE(digest_email, email) AS send_to
       FROM users
       WHERE digest_frequency = $1 AND (digest_email IS NOT NULL OR email IS NOT NULL)`,
      [frequency]
    );

    for (const user of users) {
      if (!user.send_to) continue;
      // Fetch alerts for this user's URLs in the period
      const { rows: alerts } = await pool.query(
        `SELECT a.*, mu.url, mu.id AS url_id
         FROM alerts a
         JOIN monitored_urls mu ON mu.id = a.url_id
         WHERE mu.user_id = $1 AND a.detected_at > NOW() - INTERVAL '${interval}'
         ORDER BY a.detected_at DESC`,
        [user.id]
      );

      if (alerts.length === 0) continue;

      await sendDigest({
        to: user.send_to,
        frequency,
        alerts,
        periodLabel
      });
    }
  } catch (err) {
    console.error(`[Digest] Error sending ${frequency} digests:`, err.message);
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
        await axios.post(job.webhook_url, JSON.parse(job.payload), {
          timeout: 10000,
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'MetaWatch/2.0' }
        });
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
                 next_retry_at = NOW() + INTERVAL '${backoffSeconds} seconds'
             WHERE id = $3`,
            [attempts, err.message, job.id]
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
  const { id, url, interval_minutes } = monitor;

  if (uptimeJobs.has(id)) {
    uptimeJobs.get(id).stop();
    uptimeJobs.delete(id);
  }

  const cronExpr = intervalToCron(interval_minutes);

  const job = cron.schedule(cronExpr, async () => {
    console.log(`[Uptime] Checking monitor: ${url}`);
    try {
      await checkSemaphore.wrap(async () => {
        await domainRateLimit(url);
        await checkMonitor(id);
      });
    } catch (err) {
      console.error(`[Uptime] Error checking monitor #${id} (${url}): ${err.message}`);
    }
  });

  uptimeJobs.set(id, job);
  console.log(`[Uptime] Monitor #${id} scheduled — every ${interval_minutes}min [${cronExpr}]`);
}

function unscheduleMonitor(monitorId) {
  if (uptimeJobs.has(monitorId)) {
    uptimeJobs.get(monitorId).stop();
    uptimeJobs.delete(monitorId);
    console.log(`[Uptime] Removed monitor #${monitorId}`);
  }
}

module.exports = { startScheduler, scheduleUrl, unscheduleUrl, scheduleMonitor, unscheduleMonitor, intervalToCron };
