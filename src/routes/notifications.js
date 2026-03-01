const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

router.use(requireAuth);

// GET /notifications — notification history
router.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = 50;
    const offset = (page - 1) * perPage;

    const channel = req.query.channel || '';
    const severity = req.query.severity || '';
    const status   = req.query.status || '';

    // Build filter clauses
    const params = [];
    const clauses = [];

    // Scope to user's URLs / monitors
    if (req.user.role !== 'admin') {
      params.push(req.user.id);
      clauses.push(`(
        (nl.url_id IS NULL OR EXISTS (SELECT 1 FROM monitored_urls mu WHERE mu.id = nl.url_id AND mu.user_id = $${params.length}))
        AND
        (nl.monitor_id IS NULL OR EXISTS (SELECT 1 FROM uptime_monitors um WHERE um.id = nl.monitor_id AND um.user_id = $${params.length}))
      )`);
    }

    if (channel) { params.push(channel); clauses.push(`nl.channel = $${params.length}`); }
    if (severity) { params.push(severity); clauses.push(`nl.severity = $${params.length}`); }
    if (status)   { params.push(status);   clauses.push(`nl.status   = $${params.length}`); }

    const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM notification_log nl ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].count, 10);
    const totalPages = Math.ceil(total / perPage);

    params.push(perPage, offset);
    const { rows: notifications } = await pool.query(
      `SELECT nl.*,
              mu.url AS url_url,
              um.name AS monitor_name, um.url AS monitor_url
       FROM notification_log nl
       LEFT JOIN monitored_urls mu ON mu.id = nl.url_id
       LEFT JOIN uptime_monitors um ON um.id = nl.monitor_id
       ${where}
       ORDER BY nl.sent_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.render('notifications', {
      title: 'Notification History',
      notifications,
      page,
      totalPages,
      total,
      filters: { channel, severity, status }
    });
  } catch (err) { next(err); }
});

module.exports = router;
