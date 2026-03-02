const pool = require('./db');
const { sendEmail, isEmailConfigured } = require('./mailer');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const STEPS = {
  DAY0_WELCOME: 'day0_welcome',
  DAY1_REMINDER: 'day1_first_url_reminder',
  DAY3_UPTIME: 'day3_uptime_hint',
  DAY7_REPORT: 'day7_weekly_report',
  DAY14_UPGRADE: 'day14_upgrade_nudge'
};

function appBaseUrl() {
  const raw = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return String(raw).replace(/\/+$/, '');
}

function asInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function renderEmailShell({ title, subtitle, bodyHtml, ctaText, ctaUrl }) {
  const ctaBlock = ctaText && ctaUrl
    ? `<p style="margin:18px 0 0"><a href="${ctaUrl}" style="display:inline-block;background:#2b6cb0;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">${ctaText}</a></p>`
    : '';

  return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;background:#f7fafc;margin:0;padding:20px;color:#2d3748">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
    <div style="background:#1a202c;color:#fff;padding:18px 22px">
      <div style="font-size:18px;font-weight:700">${title}</div>
      ${subtitle ? `<div style="margin-top:6px;font-size:13px;color:#cbd5e0">${subtitle}</div>` : ''}
    </div>
    <div style="padding:20px 22px;font-size:14px;line-height:1.55">
      ${bodyHtml}
      ${ctaBlock}
    </div>
  </div>
</body>
</html>`;
}

async function markStepSent(userId, step) {
  await pool.query(
    `INSERT INTO email_sequence_log (user_id, step, sent_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, step) DO NOTHING`,
    [userId, step]
  );
}

async function loadSentStepsMap() {
  const { rows } = await pool.query('SELECT user_id, step FROM email_sequence_log');
  const sent = new Map();
  for (const row of rows) {
    const key = String(row.user_id);
    if (!sent.has(key)) sent.set(key, new Set());
    sent.get(key).add(String(row.step));
  }
  return sent;
}

async function sendStepEmail(userRow, step) {
  if (!userRow?.email) return false;
  if (!isEmailConfigured()) return false;

  const base = appBaseUrl();
  let subject = '';
  let html = '';

  if (step === STEPS.DAY0_WELCOME) {
    subject = 'Welcome to MetaWatch - add your first URL';
    html = renderEmailShell({
      title: 'Welcome to MetaWatch',
      subtitle: 'Start monitoring in a couple of minutes',
      bodyHtml: `
        <p>Your workspace is ready. Quick start:</p>
        <ol style="padding-left:20px;margin:8px 0">
          <li>Add your first page URL.</li>
          <li>Choose check interval and fields.</li>
          <li>Run the first check and review Changes.</li>
        </ol>
        <p style="color:#4a5568">No credit card required for Free plan.</p>
      `,
      ctaText: 'Add First URL',
      ctaUrl: `${base}/urls/add`
    });
  } else if (step === STEPS.DAY1_REMINDER) {
    subject = 'Reminder: add your first URL in 2 minutes';
    html = renderEmailShell({
      title: 'Quick reminder',
      subtitle: 'You still have 0 monitored URLs',
      bodyHtml: `
        <p>Add your first URL to start receiving change alerts.</p>
        <p style="margin:10px 0;color:#4a5568">
          Tip: use one homepage first, then bulk import later.
        </p>
        <p style="margin:10px 0">
          Mini demo GIF:
          <a href="https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExd3Z0NnN4ZTI5ZWQ2Ym5tbzlqbGptdHd3aWJyaTN6Nmd4NHE5aDJvbiZlcD12MV9naWZzX3NlYXJjaCZjdD1n/l3q2K5jinAlChoCLS/giphy.gif">
            watch
          </a>
        </p>
      `,
      ctaText: 'Add URL Now',
      ctaUrl: `${base}/urls/add`
    });
  } else if (step === STEPS.DAY3_UPTIME) {
    subject = 'Did you know? Uptime checks every 5 minutes';
    html = renderEmailShell({
      title: 'Enable uptime monitoring',
      subtitle: 'Get incidents and recovery alerts',
      bodyHtml: `
        <p>You can monitor availability separately from metadata changes.</p>
        <ul style="padding-left:18px;margin:8px 0">
          <li>Statuses: up / degraded / down</li>
          <li>Incident timeline and duration</li>
          <li>Public status page per monitor or group</li>
        </ul>
      `,
      ctaText: 'Create Uptime Monitor',
      ctaUrl: `${base}/uptime/add`
    });
  } else if (step === STEPS.DAY7_REPORT) {
    const urls = asInt(userRow.urls_count);
    const monitors = asInt(userRow.monitors_count);
    const checks = asInt(userRow.checks_count);
    const changes = asInt(userRow.changes_count);
    const uptimePct = asNumber(userRow.uptime_pct_7d);
    const uptimeText = uptimePct == null ? 'n/a' : `${uptimePct}%`;

    subject = 'Your first week report in MetaWatch';
    html = renderEmailShell({
      title: 'Week 1 report',
      subtitle: 'Your monitoring activity summary',
      bodyHtml: `
        <table style="border-collapse:collapse;width:100%;max-width:420px">
          <tr><td style="padding:6px 0;color:#718096">URLs monitored</td><td style="padding:6px 0;text-align:right;font-weight:700">${urls}</td></tr>
          <tr><td style="padding:6px 0;color:#718096">Uptime monitors</td><td style="padding:6px 0;text-align:right;font-weight:700">${monitors}</td></tr>
          <tr><td style="padding:6px 0;color:#718096">Checks run</td><td style="padding:6px 0;text-align:right;font-weight:700">${checks}</td></tr>
          <tr><td style="padding:6px 0;color:#718096">Changes detected</td><td style="padding:6px 0;text-align:right;font-weight:700">${changes}</td></tr>
          <tr><td style="padding:6px 0;color:#718096">Uptime (7d)</td><td style="padding:6px 0;text-align:right;font-weight:700">${uptimeText}</td></tr>
        </table>
      `,
      ctaText: 'Open Dashboard',
      ctaUrl: `${base}/dashboard`
    });
  } else if (step === STEPS.DAY14_UPGRADE) {
    subject = "You're on Free plan - see what you're missing";
    html = renderEmailShell({
      title: 'Ready to upgrade?',
      subtitle: 'Unlock tighter intervals and higher limits',
      bodyHtml: `
        <p>Free is great to start. Paid plans add:</p>
        <ul style="padding-left:18px;margin:8px 0">
          <li>More URLs and uptime monitors</li>
          <li>Shorter check intervals</li>
          <li>Agency features for status pages</li>
        </ul>
      `,
      ctaText: 'Compare Plans',
      ctaUrl: `${base}/billing`
    });
  } else {
    return false;
  }

  return sendEmail({ to: userRow.email, subject, html });
}

async function triggerWelcomeOnboarding(userId) {
  if (!userId) return;
  try {
    const { rows: [existing] } = await pool.query(
      'SELECT 1 FROM email_sequence_log WHERE user_id = $1 AND step = $2 LIMIT 1',
      [userId, STEPS.DAY0_WELCOME]
    );
    if (existing) return;

    const { rows: [userRow] } = await pool.query(
      'SELECT id, email FROM users WHERE id = $1',
      [userId]
    );
    if (!userRow) return;

    const sent = await sendStepEmail(userRow, STEPS.DAY0_WELCOME);
    if (sent) {
      await markStepSent(userId, STEPS.DAY0_WELCOME);
    }
  } catch (err) {
    console.error('[Onboarding] Day 0 send failed:', err.message);
  }
}

async function runOnboardingSequenceDaily() {
  if (!isEmailConfigured()) return;

  try {
    const { rows: users } = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.created_at,
        COALESCE(lp.plan_name, 'Free') AS plan_name,
        (SELECT COUNT(*)::int FROM monitored_urls mu WHERE mu.user_id = u.id) AS urls_count,
        (SELECT COUNT(*)::int FROM uptime_monitors um WHERE um.user_id = u.id) AS monitors_count,
        (SELECT COUNT(*)::int
         FROM snapshots s
         JOIN monitored_urls mu ON mu.id = s.url_id
         WHERE mu.user_id = u.id) AS checks_count,
        (SELECT COUNT(*)::int
         FROM alerts a
         JOIN monitored_urls mu ON mu.id = a.url_id
         WHERE mu.user_id = u.id) AS changes_count,
        (
          SELECT CASE WHEN COUNT(*) = 0 THEN NULL
            ELSE ROUND((COUNT(*) FILTER (WHERE uc.status IN ('up', 'degraded'))::numeric / COUNT(*) * 100), 1)
          END
          FROM uptime_checks uc
          JOIN uptime_monitors um ON um.id = uc.monitor_id
          WHERE um.user_id = u.id
            AND uc.checked_at > NOW() - INTERVAL '7 days'
        ) AS uptime_pct_7d
      FROM users u
      LEFT JOIN LATERAL (
        SELECT p.name AS plan_name
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = u.id
          AND s.status IN ('active', 'trial')
        ORDER BY
          CASE WHEN s.status = 'active' THEN 0 ELSE 1 END,
          COALESCE(s.current_period_end, s.trial_ends_at, s.created_at) DESC
        LIMIT 1
      ) lp ON true
    `);

    const sentSteps = await loadSentStepsMap();
    const now = Date.now();

    for (const userRow of users) {
      const userId = asInt(userRow.id);
      const userSent = sentSteps.get(String(userId)) || new Set();
      const createdAt = new Date(userRow.created_at);
      const ageDays = Math.floor((now - createdAt.getTime()) / ONE_DAY_MS);
      const urlsCount = asInt(userRow.urls_count);
      const monitorsCount = asInt(userRow.monitors_count);
      const isFreePlan = String(userRow.plan_name || 'Free').toLowerCase() === 'free';
      const isActive = urlsCount > 0 || monitorsCount > 0;

      if (ageDays >= 1 && urlsCount === 0 && !userSent.has(STEPS.DAY1_REMINDER)) {
        const sent = await sendStepEmail(userRow, STEPS.DAY1_REMINDER);
        if (sent) {
          await markStepSent(userId, STEPS.DAY1_REMINDER);
          userSent.add(STEPS.DAY1_REMINDER);
        }
      }

      if (ageDays >= 3 && monitorsCount === 0 && !userSent.has(STEPS.DAY3_UPTIME)) {
        const sent = await sendStepEmail(userRow, STEPS.DAY3_UPTIME);
        if (sent) {
          await markStepSent(userId, STEPS.DAY3_UPTIME);
          userSent.add(STEPS.DAY3_UPTIME);
        }
      }

      if (ageDays >= 7 && isActive && !userSent.has(STEPS.DAY7_REPORT)) {
        const sent = await sendStepEmail(userRow, STEPS.DAY7_REPORT);
        if (sent) {
          await markStepSent(userId, STEPS.DAY7_REPORT);
          userSent.add(STEPS.DAY7_REPORT);
        }
      }

      if (ageDays >= 14 && isFreePlan && !userSent.has(STEPS.DAY14_UPGRADE)) {
        const sent = await sendStepEmail(userRow, STEPS.DAY14_UPGRADE);
        if (sent) {
          await markStepSent(userId, STEPS.DAY14_UPGRADE);
          userSent.add(STEPS.DAY14_UPGRADE);
        }
      }
    }
  } catch (err) {
    console.error('[Onboarding] Daily sequence error:', err.message);
  }
}

module.exports = {
  STEPS,
  triggerWelcomeOnboarding,
  runOnboardingSequenceDaily
};
