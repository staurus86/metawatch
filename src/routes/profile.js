const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth, generateApiKey, hashApiKey, hashPassword, comparePassword, clearAuthCookie } = require('../auth');
const { auditFromRequest } = require('../audit');

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
  const { rows: [digestSettings] } = await pool.query(
    'SELECT * FROM digest_settings WHERE user_id = $1',
    [req.user.id]
  );
  res.render('profile', {
    title: 'My Profile',
    message: req.query.msg || null,
    error: null,
    digestSettings: digestSettings || null
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
    res.redirect('/profile?msg=Error:+' + encodeURIComponent(err.message));
  }
});

// POST /profile/digest — upsert digest_settings
router.post('/digest', requireAuth, async (req, res) => {
  const { enabled, frequency, hour, day_of_week, alt_email } = req.body;
  const isEnabled = enabled === '1' || enabled === 'on' || enabled === 'true';
  const freq = ['daily', 'weekly'].includes(frequency) ? frequency : 'daily';
  const h = Math.max(0, Math.min(23, parseInt(hour || '8', 10)));
  const dow = Math.max(0, Math.min(6, parseInt(day_of_week || '1', 10)));

  try {
    await pool.query(`
      INSERT INTO digest_settings (user_id, enabled, frequency, hour, day_of_week, alt_email)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id) DO UPDATE
        SET enabled = $2, frequency = $3, hour = $4, day_of_week = $5, alt_email = $6
    `, [req.user.id, isEnabled, freq, h, dow, alt_email?.trim() || null]);

    res.redirect('/profile?msg=Digest+settings+saved');
  } catch (err) {
    console.error(err);
    res.redirect('/profile?msg=Error:+' + encodeURIComponent(err.message));
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
    await sendDigest({ to, frequency: 'daily', periodLabel, dateRange: periodLabel, alerts, incidents, sslExpirations: [] });
    res.redirect('/profile?msg=Test+digest+sent+to+' + encodeURIComponent(to));
  } catch (err) {
    res.redirect('/profile?msg=Error:+' + encodeURIComponent(err.message));
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
    pref_rows_per_page
  } = req.body;

  const dashboardView = pref_dashboard_view === 'grouped' ? 'grouped' : 'list';
  const timezone = sanitizeTimezone(pref_timezone);
  const rowsPerPage = sanitizeRowsPerPage(pref_rows_per_page);

  try {
    await pool.query(
      `UPDATE users SET
         default_alert_email = $1,
         default_telegram_token = $2,
         default_telegram_chat_id = $3,
         default_webhook_url = $4,
         pref_dashboard_view = $5,
         pref_timezone = $6,
         pref_rows_per_page = $7
       WHERE id = $8`,
      [
        default_alert_email?.trim() || null,
        default_telegram_token?.trim() || null,
        default_telegram_chat_id?.trim() || null,
        default_webhook_url?.trim() || null,
        dashboardView,
        timezone,
        rowsPerPage,
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
    error: msg
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
    renderErr(err.message);
  }
});

module.exports = router;
