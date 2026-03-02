const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth, generateApiKey, hashApiKey, hashPassword, comparePassword, clearAuthCookie } = require('../auth');
const { auditFromRequest } = require('../audit');
const { normalizeLanguage } = require('../i18n');
const { getReportPlanCaps } = require('../report-access');
const {
  getPushDiagnostics,
  getUserPushStats,
  storePushSubscription,
  removePushSubscription,
  sendPushToUser
} = require('../push');

function sanitizeRowsPerPage(val) {
  const n = parseInt(val, 10);
  return [10, 25, 50].includes(n) ? n : 25;
}

function sanitizeTimezone(tz) {
  const value = String(tz || '').trim();
  if (!value) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return value;
  } catch {
    return 'UTC';
  }
}

// GET /profile
router.get('/', requireAuth, async (req, res) => {
  const [{ rows: [digestSettings] }, pushStats] = await Promise.all([
    pool.query(
      'SELECT * FROM digest_settings WHERE user_id = $1',
      [req.user.id]
    ),
    getUserPushStats(req.user.id).catch(() => ({ activeCount: 0, totalCount: 0, lastUpdatedAt: null }))
  ]);
  const reportCaps = getReportPlanCaps(req.userPlan?.name);
  const pushDiagnostics = getPushDiagnostics();
  res.render('profile', {
    title: 'My Profile',
    message: req.query.msg || null,
    error: null,
    digestSettings: digestSettings || null,
    reportCaps,
    pushDiagnostics,
    pushStats
  });
});

// POST /profile/regenerate-key
router.post('/regenerate-key', requireAuth, async (req, res) => {
  try {
    const newKey = generateApiKey();
    await pool.query(
      'UPDATE users SET api_key = $1, api_key_hash = $2, api_key_last4 = $3 WHERE id = $4',
      [newKey, hashApiKey(newKey), newKey.slice(-4), req.user.id]
    );
    await auditFromRequest(req, {
      action: 'profile.regenerate_api_key',
      entityType: 'user',
      entityId: req.user.id
    });
    res.redirect('/profile?msg=API+key+regenerated');
  } catch (err) {
    console.error(err);
    res.redirect('/profile?msg=Error:+failed+to+regenerate+API+key');
  }
});

// POST /profile/digest — upsert digest_settings
router.post('/digest', requireAuth, async (req, res) => {
  const {
    enabled, frequency, hour, day_of_week, alt_email,
    pdf_report_enabled, pdf_report_frequency
  } = req.body;
  const isEnabled = enabled === '1' || enabled === 'on' || enabled === 'true';
  const freq = ['daily', 'weekly'].includes(frequency) ? frequency : 'daily';
  const requestedPdfEnabled = pdf_report_enabled === '1' || pdf_report_enabled === 'on' || pdf_report_enabled === 'true';
  const reportCaps = getReportPlanCaps(req.userPlan?.name);
  const pdfEnabled = reportCaps.scheduledPdfDigest ? requestedPdfEnabled : false;
  const pdfFrequency = ['weekly', 'monthly'].includes(pdf_report_frequency) ? pdf_report_frequency : 'weekly';
  const h = Math.max(0, Math.min(23, parseInt(hour || '8', 10)));
  const dow = Math.max(0, Math.min(6, parseInt(day_of_week || '1', 10)));

  try {
    await pool.query(`
      INSERT INTO digest_settings (
        user_id, enabled, frequency, hour, day_of_week, alt_email, pdf_report_enabled, pdf_report_frequency
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id) DO UPDATE
        SET enabled = $2, frequency = $3, hour = $4, day_of_week = $5, alt_email = $6,
            pdf_report_enabled = $7, pdf_report_frequency = $8
    `, [req.user.id, isEnabled, freq, h, dow, alt_email?.trim() || null, pdfEnabled, pdfFrequency]);

    if (requestedPdfEnabled && !reportCaps.scheduledPdfDigest) {
      return res.redirect('/profile?msg=PDF+digest+attachments+are+available+on+Starter+plan+or+higher');
    }
    res.redirect('/profile?msg=Digest+settings+saved');
  } catch (err) {
    console.error(err);
    res.redirect('/profile?msg=Error:+failed+to+save+digest+settings');
  }
});

// POST /profile/digest/test — send a test digest immediately
router.post('/digest/test', requireAuth, async (req, res) => {
  const { sendDigest } = require('../mailer');
  const to = req.user.email;
  const now = new Date();
  const periodLabel = `Test digest (${now.toUTCString()})`;

  // Fetch recent data for test
  const { rows: alerts } = await pool.query(
    `SELECT a.*, mu.url, mu.id AS url_id FROM alerts a
     JOIN monitored_urls mu ON mu.id = a.url_id
     WHERE mu.user_id = $1 ORDER BY a.detected_at DESC LIMIT 10`,
    [req.user.id]
  );
  const { rows: incidents } = await pool.query(
    `SELECT ui.*, um.name AS monitor_name, um.url AS monitor_url
     FROM uptime_incidents ui JOIN uptime_monitors um ON um.id = ui.monitor_id
     WHERE um.user_id = $1 ORDER BY ui.started_at DESC LIMIT 5`,
    [req.user.id]
  );

  try {
    await sendDigest({
      to,
      frequency: 'daily',
      periodLabel,
      dateRange: periodLabel,
      alerts,
      incidents,
      sslExpirations: [],
      language: req.user.language
    });
    res.redirect('/profile?msg=Test+digest+sent+to+' + encodeURIComponent(to));
  } catch (err) {
    console.error(err);
    res.redirect('/profile?msg=Error:+failed+to+send+test+digest');
  }
});

// GET /profile/push/public-key
router.get('/push/public-key', requireAuth, async (req, res) => {
  const diagnostics = getPushDiagnostics();
  if (!diagnostics.enabled || !diagnostics.publicKey) {
    return res.status(503).json({
      ok: false,
      error: 'Web Push is not configured on this server.'
    });
  }
  return res.json({
    ok: true,
    publicKey: diagnostics.publicKey
  });
});

// POST /profile/push/subscribe
router.post('/push/subscribe', requireAuth, async (req, res) => {
  try {
    const diagnostics = getPushDiagnostics();
    if (!diagnostics.enabled) {
      return res.status(503).json({ ok: false, error: 'Web Push is not configured on this server.' });
    }

    const subscription = req.body?.subscription || req.body;
    const result = await storePushSubscription({
      userId: req.user.id,
      subscription,
      userAgent: req.headers['user-agent'] || null
    });
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.reason || 'invalid_subscription_payload' });
    }

    await auditFromRequest(req, {
      action: 'profile.push.subscribe',
      entityType: 'user',
      entityId: req.user.id
    });

    return res.json({
      ok: true,
      active_count: result.activeCount,
      total_count: result.totalCount
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Failed to store push subscription' });
  }
});

// POST /profile/push/unsubscribe
router.post('/push/unsubscribe', requireAuth, async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint || '').trim();
    if (!endpoint) {
      return res.status(400).json({ ok: false, error: 'missing_endpoint' });
    }

    const result = await removePushSubscription({
      userId: req.user.id,
      endpoint
    });
    await auditFromRequest(req, {
      action: 'profile.push.unsubscribe',
      entityType: 'user',
      entityId: req.user.id
    });

    return res.json({
      ok: true,
      removed: result.removed || 0,
      active_count: result.activeCount,
      total_count: result.totalCount
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Failed to remove push subscription' });
  }
});

// POST /profile/push/test
router.post('/push/test', requireAuth, async (req, res) => {
  try {
    const diagnostics = getPushDiagnostics();
    if (!diagnostics.enabled) {
      return res.redirect('/profile?msg=Web+Push+is+not+configured+on+this+server');
    }

    const result = await sendPushToUser({
      userId: req.user.id,
      notification: {
        title: 'MetaWatch Test Push',
        body: 'Push notifications are enabled for this browser.',
        url: '/profile',
        tag: 'metawatch-test',
        severity: 'info'
      }
    });

    if (result.sent > 0) {
      return res.redirect(`/profile?msg=Test+push+sent+to+${result.sent}+subscription(s)`);
    }
    return res.redirect(`/profile?msg=No+active+push+subscriptions+(${encodeURIComponent(result.reason || 'none')})`);
  } catch (err) {
    console.error(err);
    return res.redirect('/profile?msg=Error:+failed+to+send+test+push');
  }
});

// POST /profile/preferences — notification defaults + display preferences
router.post('/preferences', requireAuth, async (req, res) => {
  const {
    default_alert_email,
    default_telegram_token,
    default_telegram_chat_id,
    default_webhook_url,
    pref_dashboard_view,
    pref_timezone,
    pref_rows_per_page,
    language
  } = req.body;

  const dashboardView = (pref_dashboard_view === 'projects' || pref_dashboard_view === 'grouped')
    ? 'projects'
    : 'list';
  const timezone = sanitizeTimezone(pref_timezone);
  const rowsPerPage = sanitizeRowsPerPage(pref_rows_per_page);
  const lang = normalizeLanguage(language);

  try {
    await pool.query(
      `UPDATE users SET
         default_alert_email = $1,
         default_telegram_token = $2,
         default_telegram_chat_id = $3,
         default_webhook_url = $4,
         pref_dashboard_view = $5,
         pref_timezone = $6,
         pref_rows_per_page = $7,
         language = $8
       WHERE id = $9`,
      [
        default_alert_email?.trim() || null,
        default_telegram_token?.trim() || null,
        default_telegram_chat_id?.trim() || null,
        default_webhook_url?.trim() || null,
        dashboardView,
        timezone,
        rowsPerPage,
        lang,
        req.user.id
      ]
    );
    await auditFromRequest(req, {
      action: 'profile.update_preferences',
      entityType: 'user',
      entityId: req.user.id
    });
    res.redirect('/profile?msg=Preferences+saved');
  } catch (err) {
    console.error(err);
    res.redirect('/profile?msg=Error:+failed+to+save+preferences');
  }
});

// POST /profile/delete-urls — danger zone
router.post('/delete-urls', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM monitored_urls WHERE user_id = $1', [req.user.id]);
    await auditFromRequest(req, {
      action: 'profile.delete_all_urls',
      entityType: 'user',
      entityId: req.user.id
    });
    res.redirect('/profile?msg=All+URLs+deleted');
  } catch (err) {
    console.error(err);
    res.redirect('/profile?msg=Error:+failed+to+delete+URLs');
  }
});

// POST /profile/delete-account — danger zone
router.post('/delete-account', requireAuth, async (req, res) => {
  const confirmEmail = String(req.body.confirm_email || '').trim().toLowerCase();
  const userEmail = String(req.user.email || '').trim().toLowerCase();
  if (!confirmEmail || confirmEmail !== userEmail) {
    return res.redirect('/profile?msg=Error:+confirmation+email+does+not+match');
  }

  try {
    await auditFromRequest(req, {
      action: 'profile.delete_account',
      entityType: 'user',
      entityId: req.user.id
    });
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    clearAuthCookie(res);
    res.redirect('/register');
  } catch (err) {
    console.error(err);
    res.redirect('/profile?msg=Error:+failed+to+delete+account');
  }
});

// POST /profile/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password, new_password2 } = req.body;

  const renderErr = (msg) => res.render('profile', {
    title: 'My Profile',
    message: null,
    error: msg,
    digestSettings: null,
    reportCaps: getReportPlanCaps(req.userPlan?.name),
    pushDiagnostics: getPushDiagnostics(),
    pushStats: { activeCount: 0, totalCount: 0, lastUpdatedAt: null }
  });

  if (!current_password || !new_password) return renderErr('All fields are required.');
  if (new_password !== new_password2) return renderErr('New passwords do not match.');
  if (new_password.length < 8) return renderErr('Password must be at least 8 characters.');

  try {
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const valid = await comparePassword(current_password, user.password_hash);
    if (!valid) return renderErr('Current password is incorrect.');

    const hash = await hashPassword(new_password);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    await auditFromRequest(req, {
      action: 'profile.change_password',
      entityType: 'user',
      entityId: req.user.id
    });
    res.redirect('/profile?msg=Password+changed+successfully');
  } catch (err) {
    console.error(err);
    renderErr('Failed to change password. Please try again.');
  }
});

module.exports = router;
