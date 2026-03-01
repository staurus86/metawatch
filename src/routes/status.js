const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const { isEmailConfigured } = require('../mailer');
const nodemailer = require('nodemailer');

function fmtDuration(sec) {
  if (!sec) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

// GET /status/:slug — public status page (no auth required)
router.get('/:slug', async (req, res) => {
  try {
    const { rows: [monitor] } = await pool.query(
      'SELECT * FROM uptime_monitors WHERE slug = $1 AND is_public = true',
      [req.params.slug]
    );

    if (!monitor) return res.status(404).render('error', { title: 'Not Found', error: 'Status page not found or not public.' });

    // Latest check
    const { rows: [latestCheck] } = await pool.query(
      'SELECT * FROM uptime_checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 1',
      [monitor.id]
    );

    // Open incident
    const { rows: [openIncident] } = await pool.query(
      'SELECT * FROM uptime_incidents WHERE monitor_id = $1 AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1',
      [monitor.id]
    );

    // Recent incidents (last 90 days)
    const { rows: incidents } = await pool.query(
      `SELECT * FROM uptime_incidents
       WHERE monitor_id = $1 AND started_at > NOW() - INTERVAL '90 days'
       ORDER BY started_at DESC LIMIT 10`,
      [monitor.id]
    );

    // Uptime % last 30 days
    const { rows: [pctRow] } = await pool.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status IN ('up', 'degraded')) AS ok_count
       FROM uptime_checks
       WHERE monitor_id = $1 AND checked_at > NOW() - INTERVAL '30 days'`,
      [monitor.id]
    );
    const pct30d = pctRow.total > 0
      ? Math.round((parseInt(pctRow.ok_count) / parseInt(pctRow.total)) * 1000) / 10
      : null;

    // 90-day daily buckets for bar chart
    const { rows: dailyRows } = await pool.query(
      `SELECT
         DATE(checked_at AT TIME ZONE 'UTC') AS date,
         COUNT(*) AS count,
         COUNT(*) FILTER (WHERE status = 'down') AS down_count,
         COUNT(*) FILTER (WHERE status = 'degraded') AS degraded_count
       FROM uptime_checks
       WHERE monitor_id = $1 AND checked_at > NOW() - INTERVAL '90 days'
       GROUP BY DATE(checked_at AT TIME ZONE 'UTC')
       ORDER BY date ASC`,
      [monitor.id]
    );

    // Build 90-slot array (one per day)
    const dayMap = new Map(dailyRows.map(r => [r.date.toISOString().split('T')[0], r]));
    const dayBuckets = [];
    for (let i = 89; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      const bucket = dayMap.get(key);
      if (!bucket) {
        dayBuckets.push({ date: key, status: 'empty', count: 0 });
      } else if (parseInt(bucket.down_count) > 0) {
        dayBuckets.push({ date: key, status: 'down', count: parseInt(bucket.down_count) });
      } else if (parseInt(bucket.degraded_count) > 0) {
        dayBuckets.push({ date: key, status: 'degraded', count: parseInt(bucket.degraded_count) });
      } else {
        dayBuckets.push({ date: key, status: 'up', count: parseInt(bucket.count) });
      }
    }

    res.render('status', {
      layout: false, // Use standalone template
      monitor,
      latestCheck: latestCheck || null,
      openIncident: openIncident || null,
      incidents,
      pct30d,
      dayBuckets,
      fmtDuration
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// ─── Group status page: GET /status/page/:slug ─────────────────────────────
router.get('/page/:slug', async (req, res, next) => {
  try {
    const { rows: [page] } = await pool.query(
      'SELECT * FROM status_pages WHERE slug = $1 AND is_public = true',
      [req.params.slug]
    );
    if (!page) return res.status(404).render('error', { title: 'Not Found', error: 'Status page not found' });

    if (!page.monitor_ids || page.monitor_ids.length === 0) {
      return res.render('status-group', { layout: false, page, monitors: [], subscriberCount: 0, subscribed: null, message: null });
    }

    // Fetch each monitor with latest check + uptime stats
    const { rows: monitors } = await pool.query(
      `SELECT um.*,
              lc.status AS last_status, lc.response_time_ms AS last_rt, lc.checked_at AS last_checked,
              ROUND((COUNT(uc.id) FILTER (WHERE uc.status IN ('up','degraded'))::float / NULLIF(COUNT(uc.id),0) * 100)::numeric, 1) AS uptime_pct
       FROM uptime_monitors um
       LEFT JOIN LATERAL (
         SELECT status, response_time_ms, checked_at
         FROM uptime_checks WHERE monitor_id = um.id ORDER BY checked_at DESC LIMIT 1
       ) lc ON true
       LEFT JOIN uptime_checks uc ON uc.monitor_id = um.id AND uc.checked_at > NOW() - INTERVAL '24 hours'
       WHERE um.id = ANY($1)
       GROUP BY um.id, lc.status, lc.response_time_ms, lc.checked_at
       ORDER BY um.name`,
      [page.monitor_ids]
    );

    // Overall status
    const hasDown = monitors.some(m => m.last_status === 'down');
    const hasDegraded = monitors.some(m => m.last_status === 'degraded');
    const overallStatus = hasDown ? 'down' : hasDegraded ? 'degraded' : 'up';

    // Active incidents
    const { rows: activeIncidents } = await pool.query(
      `SELECT ui.*, um.name AS monitor_name FROM uptime_incidents ui
       JOIN uptime_monitors um ON um.id = ui.monitor_id
       WHERE ui.monitor_id = ANY($1) AND ui.resolved_at IS NULL
       ORDER BY ui.started_at DESC`,
      [page.monitor_ids]
    );

    // Recent resolved incidents
    const { rows: recentIncidents } = await pool.query(
      `SELECT ui.*, um.name AS monitor_name FROM uptime_incidents ui
       JOIN uptime_monitors um ON um.id = ui.monitor_id
       WHERE ui.monitor_id = ANY($1) AND ui.resolved_at IS NOT NULL
         AND ui.started_at > NOW() - INTERVAL '30 days'
       ORDER BY ui.started_at DESC LIMIT 10`,
      [page.monitor_ids]
    );

    const { rows: [{ cnt: subscriberCount }] } = await pool.query(
      'SELECT COUNT(*) AS cnt FROM uptime_subscribers WHERE status_page_id = $1 AND confirmed_at IS NOT NULL',
      [page.id]
    );

    res.render('status-group', {
      layout: false,
      page,
      monitors,
      overallStatus,
      activeIncidents,
      recentIncidents,
      subscriberCount: parseInt(subscriberCount, 10),
      fmtDuration,
      message: req.query.msg || null,
      subscribed: req.query.subscribed || null
    });
  } catch (err) { next(err); }
});

// POST /status/page/:slug/subscribe
router.post('/page/:slug/subscribe', async (req, res, next) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.redirect(`/status/page/${req.params.slug}?msg=Invalid+email`);

  try {
    const { rows: [page] } = await pool.query(
      'SELECT * FROM status_pages WHERE slug = $1 AND is_public = true',
      [req.params.slug]
    );
    if (!page) return res.status(404).render('error', { title: 'Not Found', error: 'Page not found' });

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO uptime_subscribers (status_page_id, email, token)
       VALUES ($1, $2, $3)
       ON CONFLICT (status_page_id, email) DO UPDATE SET token = $3`,
      [page.id, email.trim().toLowerCase(), token]
    );

    // Send confirmation email
    if (isEmailConfigured()) {
      const confirmUrl = `${process.env.BASE_URL || ''}/status/confirm/${token}`;
      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587', 10),
          secure: process.env.SMTP_PORT === '465',
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
          tls: { rejectUnauthorized: false }
        });
        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'MetaWatch <alerts@metawatch.app>',
          to: email,
          subject: `Confirm subscription to ${page.title}`,
          html: `<p>Click to confirm your subscription to status updates for <strong>${page.title}</strong>:<br><a href="${confirmUrl}">${confirmUrl}</a></p><p><small>If you didn't request this, ignore this email.</small></p>`
        });
      } catch { /* ignore email errors */ }
    }

    res.redirect(`/status/page/${req.params.slug}?subscribed=1`);
  } catch (err) { next(err); }
});

// GET /status/confirm/:token
router.get('/confirm/:token', async (req, res, next) => {
  try {
    const { rows: [sub] } = await pool.query(
      `UPDATE uptime_subscribers SET confirmed_at = NOW()
       WHERE token = $1 AND confirmed_at IS NULL RETURNING *`,
      [req.params.token]
    );
    if (!sub) return res.render('error', { title: 'Error', error: 'Invalid or already confirmed token.' });

    const { rows: [page] } = await pool.query('SELECT * FROM status_pages WHERE id = $1', [sub.status_page_id]);
    res.redirect(`/status/page/${page?.slug || ''}?msg=Subscription+confirmed`);
  } catch (err) { next(err); }
});

// GET /status/unsubscribe/:token
router.get('/unsubscribe/:token', async (req, res, next) => {
  try {
    const { rows: [sub] } = await pool.query(
      'DELETE FROM uptime_subscribers WHERE token = $1 RETURNING *',
      [req.params.token]
    );
    if (!sub) return res.render('error', { title: 'Error', error: 'Invalid unsubscribe link.' });
    const { rows: [page] } = await pool.query('SELECT * FROM status_pages WHERE id = $1', [sub.status_page_id]);
    res.redirect(`/status/page/${page?.slug || ''}?msg=Unsubscribed`);
  } catch (err) { next(err); }
});

module.exports = router;
