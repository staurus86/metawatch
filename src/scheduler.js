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

  const job = cron.schedule(cronExpr, () => {
    // Random jitter: up to 60s so URLs with same interval don't fire simultaneously
    const jitterMs = Math.floor(Math.random() * 60 * 1000);
    setTimeout(async () => {
      console.log(`[Scheduler] Running check: ${url}`);
      try {
        await checkSemaphore.wrap(async () => {
          await domainRateLimit(url);
          await checkUrl(id);
        });
      } catch (err) {
        console.error(`[Scheduler] Error checking URL #${id} (${url}): ${err.message}`);
      }
    }, jitterMs);
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

  // Stagger startup: distribute over max 5 minutes so DB is not hammered at once
  const staggerMs = rows.length > 1 ? Math.min(5 * 60 * 1000, 300 * 1000) / rows.length : 0;
  for (let i = 0; i < rows.length; i++) {
    const delay = Math.round(i * staggerMs + Math.random() * 5000);
    setTimeout(() => scheduleUrl(rows[i]), delay);
  }

  console.log(`[Scheduler] Started with ${rows.length} active URL(s) (stagger: ${Math.round(staggerMs)}ms each)`);

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

  // Email digest cron — runs every hour, checks per-user settings
  cron.schedule('0 * * * *', () => sendHourlyDigests());
  console.log('[Scheduler] Email digest cron active (hourly check)');

  // Webhook retry cron — runs every 2 minutes
  cron.schedule('*/2 * * * *', () => retryWebhooks());
  console.log('[Scheduler] Webhook retry queue active (every 2 min)');
}

async function sendHourlyDigests() {
  try {
    const now = new Date();
    const currentHour = now.getUTCHours();
    const currentDow  = now.getUTCDay(); // 0=Sun, 1=Mon, ...

    // Find digest_settings rows due this hour
    const { rows: settings } = await pool.query(`
      SELECT ds.*, u.email AS user_email, u.id AS uid
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
      const interval = ds.frequency === 'weekly' ? '7 days' : '24 hours';

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
        // Still update last_sent_at so we don't resend empty digest
        await pool.query('UPDATE digest_settings SET last_sent_at = NOW() WHERE id = $1', [ds.id]);
        continue;
      }

      const rangeEnd = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const rangeStart = new Date(since).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const dateRange = ds.frequency === 'weekly' ? `${rangeStart} – ${rangeEnd}` : rangeEnd;
      const periodLabel = ds.frequency === 'weekly' ? `Last 7 days (${dateRange})` : `Last 24 hours`;

      const sent = await sendDigest({
        to, frequency: ds.frequency, periodLabel, dateRange,
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

  const job = cron.schedule(cronExpr, () => {
    const jitterMs = Math.floor(Math.random() * 30 * 1000); // up to 30s jitter for uptime
    setTimeout(async () => {
      console.log(`[Uptime] Checking monitor: ${url}`);
      try {
        await checkSemaphore.wrap(async () => {
          await domainRateLimit(url);
          await checkMonitor(id);
        });
      } catch (err) {
        console.error(`[Uptime] Error checking monitor #${id} (${url}): ${err.message}`);
      }
    }, jitterMs);
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
