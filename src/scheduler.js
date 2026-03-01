const cron = require('node-cron');
const pool = require('./db');
const { checkUrl } = require('./checker');
const { checkSemaphore, domainRateLimit } = require('./queue');
const { sendDigest } = require('./mailer');

// Map of urlId -> cron ScheduledTask
const activeJobs = new Map();

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

module.exports = { startScheduler, scheduleUrl, unscheduleUrl, intervalToCron };
