const express = require('express');
const router = express.Router();
const pool = require('../db');

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

module.exports = router;
