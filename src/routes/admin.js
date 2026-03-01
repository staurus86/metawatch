const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const { requireAdmin, generateApiKey } = require('../auth');
const { sendAlert } = require('../mailer');
const { auditFromRequest } = require('../audit');
const { getSchedulerStatus } = require('../scheduler');

// GET /admin/users
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const { rows: users } = await pool.query(
      `SELECT id, email, role, created_at,
              COALESCE(api_key_last4, RIGHT(api_key, 4)) AS api_key_last4
       FROM users
       ORDER BY created_at ASC`
    );
    const { rows: invites } = await pool.query(
      `SELECT i.*, u.email AS inviter_email
       FROM invites i
       LEFT JOIN users u ON u.id = i.invited_by_id
       ORDER BY i.created_at DESC LIMIT 20`
    );
    res.render('admin', {
      title: 'Admin — Users',
      users,
      invites,
      inviteLink: null,
      message: req.query.msg || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// POST /admin/invite — create invite link
router.post('/invite', requireAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email || !email.trim()) {
    return res.redirect('/admin/users?msg=Email+is+required');
  }

  try {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO invites (email, token, invited_by_id) VALUES ($1, $2, $3)`,
      [email.trim().toLowerCase(), token, req.user.id]
    );
    await auditFromRequest(req, {
      action: 'admin.invite.create',
      entityType: 'invite',
      entityId: token,
      meta: { email: email.trim().toLowerCase() }
    });

    const baseUrl = process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
    const inviteUrl = `${baseUrl}/invite/${token}`;

    // Try to send email
    let emailSent = false;
    if (process.env.SMTP_HOST) {
      emailSent = await sendAlert({
        to: email.trim(),
        url: inviteUrl,
        field: 'Invitation',
        oldValue: '',
        newValue: `You have been invited to MetaWatch. Click here to register: ${inviteUrl}`,
        timestamp: new Date()
      }).catch(() => false);
    }

    const { rows: users } = await pool.query(
      `SELECT id, email, role, created_at,
              COALESCE(api_key_last4, RIGHT(api_key, 4)) AS api_key_last4
       FROM users
       ORDER BY created_at ASC`
    );
    const { rows: invites } = await pool.query(
      `SELECT i.*, u.email AS inviter_email
       FROM invites i
       LEFT JOIN users u ON u.id = i.invited_by_id
       ORDER BY i.created_at DESC LIMIT 20`
    );

    res.render('admin', {
      title: 'Admin — Users',
      users,
      invites,
      inviteLink: inviteUrl,
      message: emailSent ? 'Invite email sent!' : null
    });
  } catch (err) {
    console.error(err);
    res.redirect('/admin/users?msg=' + encodeURIComponent(err.message));
  }
});

// POST /admin/users/:id/revoke — delete user
router.post('/users/:id/revoke', requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (userId === req.user.id) {
    return res.redirect('/admin/users?msg=Cannot+revoke+your+own+account');
  }
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await auditFromRequest(req, {
      action: 'admin.user.revoke',
      entityType: 'user',
      entityId: userId
    });
    res.redirect('/admin/users?msg=User+removed');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/users?msg=' + encodeURIComponent(err.message));
  }
});

// POST /admin/users/:id/role — change role
router.post('/users/:id/role', requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { role } = req.body;
  if (!['admin', 'viewer'].includes(role)) {
    return res.redirect('/admin/users?msg=Invalid+role');
  }
  try {
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
    await auditFromRequest(req, {
      action: 'admin.user.role_change',
      entityType: 'user',
      entityId: userId,
      meta: { role }
    });
    res.redirect('/admin/users?msg=Role+updated');
  } catch (err) {
    res.redirect('/admin/users?msg=' + encodeURIComponent(err.message));
  }
});

// GET /admin/system — operational metrics
router.get('/system', requireAdmin, async (req, res) => {
  try {
    const [
      usersRes,
      urlsRes,
      monitorsRes,
      snapRes,
      alertsRes,
      notifRes,
      webhookRes,
      dbSizeRes
    ] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS total FROM users'),
      pool.query(`SELECT
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE is_active = true)::int AS active
                  FROM monitored_urls`),
      pool.query(`SELECT
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE is_active = true)::int AS active
                  FROM uptime_monitors`),
      pool.query(`SELECT
                    COUNT(*)::bigint AS total,
                    COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '24 hours')::bigint AS last_24h
                  FROM snapshots`),
      pool.query(`SELECT
                    COUNT(*)::bigint AS total,
                    COUNT(*) FILTER (WHERE detected_at > NOW() - INTERVAL '24 hours')::bigint AS last_24h,
                    COUNT(*) FILTER (WHERE detected_at > NOW() - INTERVAL '24 hours' AND severity = 'critical')::bigint AS critical_24h
                  FROM alerts`),
      pool.query(`SELECT
                    COUNT(*)::bigint AS total,
                    COUNT(*) FILTER (WHERE sent_at > NOW() - INTERVAL '24 hours' AND status = 'failed')::bigint AS failed_24h
                  FROM notification_log`),
      pool.query(`SELECT
                    COUNT(*) FILTER (WHERE status = 'pending')::bigint AS pending,
                    COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed
                  FROM webhook_delivery_log`),
      pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`)
    ]);

    const scheduler = getSchedulerStatus();

    res.render('admin-system', {
      title: 'Admin — System',
      system: {
        users: usersRes.rows[0]?.total || 0,
        urlsTotal: urlsRes.rows[0]?.total || 0,
        urlsActive: urlsRes.rows[0]?.active || 0,
        monitorsTotal: monitorsRes.rows[0]?.total || 0,
        monitorsActive: monitorsRes.rows[0]?.active || 0,
        snapshotsTotal: snapRes.rows[0]?.total || 0,
        snapshots24h: snapRes.rows[0]?.last_24h || 0,
        alertsTotal: alertsRes.rows[0]?.total || 0,
        alerts24h: alertsRes.rows[0]?.last_24h || 0,
        alertsCritical24h: alertsRes.rows[0]?.critical_24h || 0,
        notificationsTotal: notifRes.rows[0]?.total || 0,
        notificationsFailed24h: notifRes.rows[0]?.failed_24h || 0,
        webhookPending: webhookRes.rows[0]?.pending || 0,
        webhookFailed: webhookRes.rows[0]?.failed || 0,
        dbSize: dbSizeRes.rows[0]?.db_size || 'unknown',
        scheduler
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

module.exports = router;
