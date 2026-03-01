const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

function computeStatus(u) {
  if (!u.last_status_code && u.last_status_code !== 0) return 'PENDING';
  if (u.last_status_code === 0 || u.last_status_code >= 400) return 'ERROR';
  if (u.recent_alert_count > 0) return 'CHANGED';
  return 'OK';
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const tab = req.query.tab || 'all';
    const fieldFilter = req.query.field || null;

    const { rows: urls } = await pool.query(`
      SELECT
        mu.*,
        ls.status_code  AS last_status_code,
        ls.checked_at   AS last_checked,
        COALESCE(ac.alert_count, 0)::int AS recent_alert_count
      FROM monitored_urls mu
      LEFT JOIN LATERAL (
        SELECT status_code, checked_at
        FROM snapshots
        WHERE url_id = mu.id
        ORDER BY checked_at DESC
        LIMIT 1
      ) ls ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS alert_count
        FROM alerts
        WHERE url_id = mu.id AND detected_at > NOW() - INTERVAL '24 hours'
      ) ac ON true
      ORDER BY mu.created_at DESC
    `);

    let urlsWithStatus = urls.map(u => ({ ...u, status: computeStatus(u) }));

    // Problem tab filter
    if (tab === 'problems') {
      urlsWithStatus = urlsWithStatus.filter(
        u => u.status === 'CHANGED' || u.status === 'ERROR'
      );
    }

    const stats = {
      total: urls.length,
      ok: urls.filter(u => computeStatus(u) === 'OK').length,
      changed: urls.filter(u => computeStatus(u) === 'CHANGED').length,
      error: urls.filter(u => computeStatus(u) === 'ERROR').length,
      pending: urls.filter(u => computeStatus(u) === 'PENDING').length
    };

    // Recent alerts (with optional field filter)
    let alertQuery = `
      SELECT a.*, mu.url
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
    `;
    const alertParams = [];
    if (fieldFilter) {
      alertQuery += ` WHERE a.field_changed = $1`;
      alertParams.push(fieldFilter);
    }
    alertQuery += ` ORDER BY a.detected_at DESC LIMIT 20`;

    const { rows: recentAlerts } = await pool.query(alertQuery, alertParams);

    // Distinct fields for filter dropdown
    const { rows: fieldRows } = await pool.query(
      'SELECT DISTINCT field_changed FROM alerts ORDER BY field_changed'
    );
    const alertFields = fieldRows.map(r => r.field_changed);

    res.render('dashboard', {
      title: 'Dashboard',
      urls: urlsWithStatus,
      recentAlerts,
      stats,
      tab,
      fieldFilter,
      alertFields
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

module.exports = router;
