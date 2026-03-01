const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { checkMonitor } = require('../uptime-checker');
const { scheduleMonitor, unscheduleMonitor } = require('../scheduler');
const { notify: notifyMeta } = require('../notifier');
const { sendTelegram, sendWebhook } = require('../notifier');
const { sendAlert: sendEmail } = require('../mailer');

function generateSlug() {
  return crypto.randomBytes(6).toString('hex'); // 12-char hex slug
}

function ownedMonitorQuery(monitorId, req) {
  const isAdmin = req.user?.role === 'admin';
  return {
    query: isAdmin
      ? 'SELECT * FROM uptime_monitors WHERE id = $1'
      : 'SELECT * FROM uptime_monitors WHERE id = $1 AND user_id = $2',
    params: isAdmin ? [monitorId] : [monitorId, req.user.id]
  };
}

// Helper: compute uptime % over a period for a given monitor
async function uptimePct(monitorId, intervalSql) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status = 'up' OR status = 'degraded') AS ok_count
     FROM uptime_checks
     WHERE monitor_id = $1 AND checked_at > NOW() - INTERVAL '${intervalSql}'`,
    [monitorId]
  );
  const { total, ok_count } = rows[0];
  if (!total || total === '0') return null;
  return Math.round((parseInt(ok_count) / parseInt(total)) * 1000) / 10; // 1 decimal
}

// Helper: format seconds to human string
function fmtDuration(sec) {
  if (!sec) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

// ─── GET /uptime ────────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const userWhere = isAdmin ? '' : 'WHERE um.user_id = $1';
    const params = isAdmin ? [] : [req.user.id];

    const { rows: monitors } = await pool.query(`
      SELECT
        um.*,
        lc.status AS last_status,
        lc.response_time_ms AS last_response_ms,
        lc.status_code AS last_status_code,
        lc.error_message AS last_error,
        lc.checked_at AS last_checked,
        oi.id AS open_incident_id,
        oi.started_at AS incident_started_at
      FROM uptime_monitors um
      LEFT JOIN LATERAL (
        SELECT status, response_time_ms, status_code, error_message, checked_at
        FROM uptime_checks
        WHERE monitor_id = um.id
        ORDER BY checked_at DESC LIMIT 1
      ) lc ON true
      LEFT JOIN LATERAL (
        SELECT id, started_at FROM uptime_incidents
        WHERE monitor_id = um.id AND resolved_at IS NULL
        ORDER BY started_at DESC LIMIT 1
      ) oi ON true
      ${userWhere}
      ORDER BY um.created_at ASC
    `, params);

    // For each monitor: compute uptime % (24h), last 50 checks for sparkline
    const monitorData = await Promise.all(monitors.map(async (m) => {
      const pct24h = await uptimePct(m.id, '24 hours');

      const { rows: checks } = await pool.query(
        `SELECT status, response_time_ms, checked_at
         FROM uptime_checks
         WHERE monitor_id = $1
         ORDER BY checked_at DESC LIMIT 50`,
        [m.id]
      );

      return { ...m, pct24h, recentChecks: checks.reverse() };
    }));

    // Summary counts
    const up = monitorData.filter(m => m.last_status === 'up').length;
    const down = monitorData.filter(m => m.last_status === 'down').length;
    const degraded = monitorData.filter(m => m.last_status === 'degraded').length;
    const pending = monitorData.filter(m => !m.last_status).length;

    res.render('uptime-dashboard', {
      title: 'Uptime',
      monitors: monitorData,
      summary: { up, down, degraded, pending, total: monitorData.length },
      fmtDuration
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// ─── GET /uptime/add ─────────────────────────────────────────────────────────
router.get('/add', requireAuth, (req, res) => {
  res.render('uptime-add', {
    title: 'Add Monitor',
    error: null,
    values: {
      alert_email: req.user.default_alert_email || '',
      telegram_token: req.user.default_telegram_token || '',
      telegram_chat_id: req.user.default_telegram_chat_id || '',
      webhook_url: req.user.default_webhook_url || ''
    }
  });
});

// ─── POST /uptime/add ────────────────────────────────────────────────────────
router.post('/add', requireAuth, async (req, res) => {
  const {
    name, url, interval_minutes, threshold_ms,
    alert_email, telegram_token, telegram_chat_id, webhook_url,
    is_public, maintenance_cron, maintenance_duration_minutes
  } = req.body;

  if (!name?.trim()) return res.render('uptime-add', { title: 'Add Monitor', error: 'Name is required.', values: req.body });
  if (!url?.trim() || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return res.render('uptime-add', { title: 'Add Monitor', error: 'Valid URL is required (http:// or https://).', values: req.body });
  }

  try {
    const maintenanceDuration = parseInt(maintenance_duration_minutes, 10);
    const safeMaintenanceDuration = Number.isFinite(maintenanceDuration) && maintenanceDuration > 0
      ? maintenanceDuration
      : null;

    const slug = generateSlug();
    const { rows: [monitor] } = await pool.query(
      `INSERT INTO uptime_monitors
         (user_id, name, url, slug, interval_minutes, threshold_ms,
          alert_email, telegram_token, telegram_chat_id, webhook_url, is_public,
          maintenance_cron, maintenance_duration_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        req.user.id, name.trim(), url.trim(), slug,
        parseInt(interval_minutes || '5', 10),
        parseInt(threshold_ms || '3000', 10),
        alert_email?.trim() || req.user.default_alert_email || null,
        telegram_token?.trim() || req.user.default_telegram_token || null,
        telegram_chat_id?.trim() || req.user.default_telegram_chat_id || null,
        webhook_url?.trim() || req.user.default_webhook_url || null,
        !!is_public,
        maintenance_cron?.trim() || null,
        safeMaintenanceDuration
      ]
    );

    scheduleMonitor(monitor);
    checkMonitor(monitor.id).catch(() => {});
    res.redirect(`/uptime/${monitor.id}`);
  } catch (err) {
    console.error(err);
    res.render('uptime-add', { title: 'Add Monitor', error: err.message, values: req.body });
  }
});

// ─── GET /uptime/:id ─────────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  const monitorId = parseInt(req.params.id, 10);
  if (isNaN(monitorId)) return res.status(404).render('error', { title: 'Not Found', error: 'Monitor not found' });

  try {
    const { query, params } = ownedMonitorQuery(monitorId, req);
    const { rows: [monitor] } = await pool.query(query, params);
    if (!monitor) return res.status(404).render('error', { title: 'Not Found', error: 'Monitor not found' });

    const activeTab = req.query.tab || 'overview';
    const incidentPage = Math.max(1, parseInt(req.query.ipage || '1', 10));
    const IPAGE = 20;

    // Last 200 checks for checks log
    const { rows: checks } = await pool.query(
      `SELECT * FROM uptime_checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 200`,
      [monitorId]
    );

    // Incidents (paginated)
    const { rows: [{ count: totalIncidents }] } = await pool.query(
      'SELECT COUNT(*) FROM uptime_incidents WHERE monitor_id = $1',
      [monitorId]
    );
    const { rows: incidents } = await pool.query(
      `SELECT * FROM uptime_incidents WHERE monitor_id = $1
       ORDER BY started_at DESC LIMIT $2 OFFSET $3`,
      [monitorId, IPAGE, (incidentPage - 1) * IPAGE]
    );

    // Open incident
    const { rows: [openIncident] } = await pool.query(
      'SELECT * FROM uptime_incidents WHERE monitor_id = $1 AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1',
      [monitorId]
    );

    // Uptime stats
    const stats = {
      '1h':  await uptimePct(monitorId, '1 hour'),
      '24h': await uptimePct(monitorId, '24 hours'),
      '7d':  await uptimePct(monitorId, '7 days'),
      '30d': await uptimePct(monitorId, '30 days'),
      '90d': await uptimePct(monitorId, '90 days')
    };

    // Avg/min/max response time (last 24h up checks)
    const { rows: [rtStats] } = await pool.query(
      `SELECT
         ROUND(AVG(response_time_ms))::int AS avg_ms,
         MIN(response_time_ms) AS min_ms,
         MAX(response_time_ms) AS max_ms
       FROM uptime_checks
       WHERE monitor_id = $1 AND response_time_ms IS NOT NULL
         AND checked_at > NOW() - INTERVAL '24 hours'`,
      [monitorId]
    );

    // Last SSL check
    const { rows: [latestCheck] } = await pool.query(
      'SELECT * FROM uptime_checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 1',
      [monitorId]
    );

    res.render('uptime-detail', {
      title: monitor.name,
      monitor,
      checks,
      incidents,
      openIncident: openIncident || null,
      stats,
      rtStats: rtStats || {},
      latestCheck: latestCheck || null,
      activeTab,
      incidentPage,
      totalIncidentPages: Math.max(1, Math.ceil(parseInt(totalIncidents) / IPAGE)),
      fmtDuration,
      savedMsg: !!req.query.saved,
      checkedMsg: !!req.query.checked
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// ─── GET /uptime/:id/edit ────────────────────────────────────────────────────
router.get('/:id/edit', requireAuth, async (req, res) => {
  const monitorId = parseInt(req.params.id, 10);
  try {
    const { query, params } = ownedMonitorQuery(monitorId, req);
    const { rows: [monitor] } = await pool.query(query, params);
    if (!monitor) return res.status(404).render('error', { title: 'Not Found', error: 'Monitor not found' });
    res.render('uptime-edit', { title: 'Edit Monitor', error: null, monitor });
  } catch (err) {
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// ─── POST /uptime/:id/edit ───────────────────────────────────────────────────
router.post('/:id/edit', requireAuth, async (req, res) => {
  const monitorId = parseInt(req.params.id, 10);
  const {
    name, url, interval_minutes, threshold_ms,
    alert_email, telegram_token, telegram_chat_id, webhook_url,
    is_public, silenced_until, maintenance_cron, maintenance_duration_minutes
  } = req.body;

  try {
    const maintenanceDuration = parseInt(maintenance_duration_minutes, 10);
    const safeMaintenanceDuration = Number.isFinite(maintenanceDuration) && maintenanceDuration > 0
      ? maintenanceDuration
      : null;

    const isAdmin = req.user.role === 'admin';
    const { rows: [updated] } = await pool.query(
      `UPDATE uptime_monitors SET
         name = $1, url = $2, interval_minutes = $3, threshold_ms = $4,
         alert_email = $5, telegram_token = $6, telegram_chat_id = $7,
         webhook_url = $8, is_public = $9, silenced_until = $10,
         maintenance_cron = $11, maintenance_duration_minutes = $12
       WHERE id = $13 ${!isAdmin ? 'AND user_id = $14' : ''}
       RETURNING *`,
      !isAdmin
        ? [name?.trim(), url?.trim(), parseInt(interval_minutes || '5', 10),
           parseInt(threshold_ms || '3000', 10), alert_email?.trim() || null,
           telegram_token?.trim() || null, telegram_chat_id?.trim() || null,
           webhook_url?.trim() || null, !!is_public, silenced_until?.trim() || null,
           maintenance_cron?.trim() || null, safeMaintenanceDuration,
           monitorId, req.user.id]
        : [name?.trim(), url?.trim(), parseInt(interval_minutes || '5', 10),
           parseInt(threshold_ms || '3000', 10), alert_email?.trim() || null,
           telegram_token?.trim() || null, telegram_chat_id?.trim() || null,
           webhook_url?.trim() || null, !!is_public, silenced_until?.trim() || null,
           maintenance_cron?.trim() || null, safeMaintenanceDuration,
           monitorId]
    );
    if (!updated) return res.status(404).render('error', { title: 'Not Found', error: 'Monitor not found' });
    scheduleMonitor(updated);
    res.redirect(`/uptime/${monitorId}?saved=1`);
  } catch (err) {
    console.error(err);
    const { rows: [monitor] } = await pool.query('SELECT * FROM uptime_monitors WHERE id = $1', [monitorId]);
    res.render('uptime-edit', { title: 'Edit Monitor', error: err.message, monitor: monitor || {} });
  }
});

// ─── POST /uptime/:id/toggle ─────────────────────────────────────────────────
router.post('/:id/toggle', requireAuth, async (req, res) => {
  const monitorId = parseInt(req.params.id, 10);
  try {
    const { query, params } = ownedMonitorQuery(monitorId, req);
    const { rows: [monitor] } = await pool.query(query, params);
    if (!monitor) return res.status(404).render('error', { title: 'Not Found', error: 'Monitor not found' });

    const { rows: [updated] } = await pool.query(
      'UPDATE uptime_monitors SET is_active = $1 WHERE id = $2 RETURNING *',
      [!monitor.is_active, monitorId]
    );
    if (updated.is_active) scheduleMonitor(updated);
    else unscheduleMonitor(monitorId);
    res.redirect(`/uptime/${monitorId}`);
  } catch (err) {
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// ─── POST /uptime/:id/check-now ──────────────────────────────────────────────
router.post('/:id/check-now', requireAuth, async (req, res) => {
  const monitorId = parseInt(req.params.id, 10);
  try {
    const { query, params } = ownedMonitorQuery(monitorId, req);
    const { rows: [monitor] } = await pool.query(query, params);
    if (!monitor) return res.status(404).render('error', { title: 'Not Found', error: 'Monitor not found' });
    await checkMonitor(monitorId);
    res.redirect(`/uptime/${monitorId}?checked=1`);
  } catch (err) {
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// ─── POST /uptime/:id/test-notify ────────────────────────────────────────────
router.post('/:id/test-notify', requireAuth, async (req, res) => {
  const monitorId = parseInt(req.params.id, 10);
  try {
    const { query, params } = ownedMonitorQuery(monitorId, req);
    const { rows: [monitor] } = await pool.query(query, params);
    if (!monitor) return res.status(404).json({ error: 'Not found' });

    const channels = [];

    if (monitor.alert_email) {
      try {
        await sendEmail({ to: monitor.alert_email, url: monitor.url, field: 'Test Alert', oldValue: '', newValue: 'MetaWatch Uptime test notification — working!', timestamp: new Date() });
        channels.push('email');
      } catch { /* ignore */ }
    }

    const tgToken = monitor.telegram_token || process.env.TELEGRAM_BOT_TOKEN;
    if (tgToken && monitor.telegram_chat_id) {
      const ok = await sendTelegram({ botToken: tgToken, chatId: monitor.telegram_chat_id, message: `🔔 MetaWatch test — ${monitor.name} notifications are working!` });
      if (ok) channels.push('telegram');
    }

    if (monitor.webhook_url) {
      const ok = await sendWebhook({ webhookUrl: monitor.webhook_url, payload: { event: 'test', monitor_id: monitor.id, name: monitor.name } });
      if (ok) channels.push('webhook');
    }

    if (channels.length === 0) return res.json({ ok: false, message: 'No notification channels configured.' });
    res.json({ ok: true, message: `Test sent via: ${channels.join(', ')}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /uptime/:id/delete ─────────────────────────────────────────────────
router.post('/:id/delete', requireAuth, async (req, res) => {
  const monitorId = parseInt(req.params.id, 10);
  try {
    const isAdmin = req.user.role === 'admin';
    const { rowCount } = await pool.query(
      isAdmin
        ? 'DELETE FROM uptime_monitors WHERE id = $1'
        : 'DELETE FROM uptime_monitors WHERE id = $1 AND user_id = $2',
      isAdmin ? [monitorId] : [monitorId, req.user.id]
    );
    if (rowCount > 0) unscheduleMonitor(monitorId);
    res.redirect('/uptime');
  } catch (err) {
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// ─── POST /uptime/:id/incidents/:incidentId/postmortem ───────────────────────
router.post('/:id/incidents/:incidentId/postmortem', requireAuth, async (req, res) => {
  const monitorId  = parseInt(req.params.id, 10);
  const incidentId = parseInt(req.params.incidentId, 10);
  if (isNaN(monitorId) || isNaN(incidentId)) {
    return res.status(404).render('error', { title: 'Not Found', error: 'Not found' });
  }
  try {
    const { query, params } = ownedMonitorQuery(monitorId, req);
    const { rows: [monitor] } = await pool.query(query, params);
    if (!monitor) return res.status(404).render('error', { title: 'Not Found', error: 'Monitor not found' });

    const { postmortem_text } = req.body;
    await pool.query(
      'UPDATE uptime_incidents SET postmortem_text = $1 WHERE id = $2 AND monitor_id = $3',
      [postmortem_text || null, incidentId, monitorId]
    );

    res.redirect(`/uptime/${monitorId}?tab=incidents`);
  } catch (err) {
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

module.exports = router;
