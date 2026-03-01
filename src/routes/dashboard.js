const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

const PER_PAGE = 25;

function computeStatus(u) {
  if (!u.last_status_code && u.last_status_code !== 0) return 'PENDING';
  if (u.last_status_code === 0 || u.last_status_code >= 400) return 'ERROR';
  if (u.recent_alert_count > 0) return 'CHANGED';
  return 'OK';
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const tab         = req.query.tab   || 'all';
    const fieldFilter = req.query.field || null;
    const page        = Math.max(1, parseInt(req.query.page || '1', 10));
    const offset      = (page - 1) * PER_PAGE;
    const isAdmin     = req.user.role === 'admin';

    // Ownership filter
    const userParams = isAdmin ? [] : [req.user.id];
    const userWhere  = isAdmin ? '' : 'AND mu.user_id = $1';

    // Problem-tab filter (applied in SQL so pagination works correctly)
    const problemFilter = tab === 'problems'
      ? `AND ls.status_code IS NOT NULL
         AND (ls.status_code = 0 OR ls.status_code >= 400 OR COALESCE(ac.alert_count,0) > 0)`
      : '';

    // ── Stats: light query over ALL user's URLs (no pagination) ──────────────
    const { rows: allForStats } = await pool.query(`
      SELECT
        ls.status_code AS last_status_code,
        COALESCE(ac.alert_count, 0)::int AS recent_alert_count
      FROM monitored_urls mu
      LEFT JOIN LATERAL (
        SELECT status_code FROM snapshots
        WHERE url_id = mu.id ORDER BY checked_at DESC LIMIT 1
      ) ls ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS alert_count FROM alerts
        WHERE url_id = mu.id AND detected_at > NOW() - INTERVAL '24 hours'
      ) ac ON true
      WHERE 1=1 ${userWhere}
    `, userParams);

    const stats = {
      total:   allForStats.length,
      ok:      allForStats.filter(u => computeStatus(u) === 'OK').length,
      changed: allForStats.filter(u => computeStatus(u) === 'CHANGED').length,
      error:   allForStats.filter(u => computeStatus(u) === 'ERROR').length,
      pending: allForStats.filter(u => computeStatus(u) === 'PENDING').length
    };

    // ── Count for pagination ─────────────────────────────────────────────────
    const { rows: [{ cnt }] } = await pool.query(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT mu.id FROM monitored_urls mu
        LEFT JOIN LATERAL (
          SELECT status_code FROM snapshots
          WHERE url_id = mu.id ORDER BY checked_at DESC LIMIT 1
        ) ls ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS alert_count FROM alerts
          WHERE url_id = mu.id AND detected_at > NOW() - INTERVAL '24 hours'
        ) ac ON true
        WHERE 1=1 ${userWhere} ${problemFilter}
      ) sub
    `, userParams);

    const totalCount = parseInt(cnt, 10);
    const totalPages = Math.max(1, Math.ceil(totalCount / PER_PAGE));

    // ── Paginated URL list with uptime ────────────────────────────────────────
    const limitIdx  = userParams.length + 1;
    const offsetIdx = userParams.length + 2;

    const { rows: urls } = await pool.query(`
      SELECT
        mu.*,
        ls.status_code  AS last_status_code,
        ls.checked_at   AS last_checked,
        COALESCE(ac.alert_count, 0)::int AS recent_alert_count,
        CASE WHEN up.total = 0 OR up.total IS NULL THEN NULL
          ELSE ROUND((up.ok_count::float / up.total * 100)::numeric, 1)
        END AS uptime_pct
      FROM monitored_urls mu
      LEFT JOIN LATERAL (
        SELECT status_code, checked_at FROM snapshots
        WHERE url_id = mu.id ORDER BY checked_at DESC LIMIT 1
      ) ls ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS alert_count FROM alerts
        WHERE url_id = mu.id AND detected_at > NOW() - INTERVAL '24 hours'
      ) ac ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status_code BETWEEN 200 AND 399) AS ok_count
        FROM snapshots
        WHERE url_id = mu.id AND checked_at > NOW() - INTERVAL '30 days'
      ) up ON true
      WHERE 1=1 ${userWhere} ${problemFilter}
      ORDER BY mu.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, [...userParams, PER_PAGE, offset]);

    const urlsWithStatus = urls.map(u => ({ ...u, status: computeStatus(u) }));

    // ── Recent alerts (scoped to user's URLs) ────────────────────────────────
    const alertParams = [...userParams];
    let alertQuery = `
      SELECT a.*, mu.url
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      WHERE 1=1 ${userWhere}
    `;
    if (fieldFilter) {
      alertParams.push(fieldFilter);
      alertQuery += ` AND a.field_changed = $${alertParams.length}`;
    }
    alertQuery += ` ORDER BY a.detected_at DESC LIMIT 20`;

    const { rows: recentAlerts } = await pool.query(alertQuery, alertParams);

    // Distinct alert field names (for user's URLs)
    const { rows: fieldRows } = await pool.query(`
      SELECT DISTINCT a.field_changed
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      WHERE 1=1 ${userWhere}
      ORDER BY a.field_changed
    `, userParams);
    const alertFields = fieldRows.map(r => r.field_changed);

    res.render('dashboard', {
      title: 'Dashboard',
      urls: urlsWithStatus,
      recentAlerts,
      stats,
      tab,
      fieldFilter,
      alertFields,
      page,
      totalPages,
      totalCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

module.exports = router;
