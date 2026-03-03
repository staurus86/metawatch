const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const { requireAdmin } = require('../auth');
const { sendAlert } = require('../mailer');
const { auditFromRequest } = require('../audit');
const { getSchedulerStatus } = require('../scheduler');
const { getQueueStats } = require('../queue');
const { getWorkerStatus } = require('../workers');
const { clearPlanCache } = require('../plans');
const { version: APP_VERSION } = require('../../package.json');

const SUBSCRIPTION_STATUSES = ['active', 'trial', 'expired', 'cancelled'];
const ADMIN_SYSTEM_CACHE_TTL_MS = Math.max(0, parseInt(process.env.ADMIN_SYSTEM_CACHE_TTL_MS || '30000', 10) || 30000);
let adminSystemCache = { ts: 0, snapshot: null };

function getAdminSystemCachedSnapshot() {
  if (ADMIN_SYSTEM_CACHE_TTL_MS <= 0) return null;
  if (!adminSystemCache.snapshot || !adminSystemCache.ts) return null;
  const ageMs = Date.now() - adminSystemCache.ts;
  if (ageMs < 0 || ageMs >= ADMIN_SYSTEM_CACHE_TTL_MS) return null;
  return { snapshot: adminSystemCache.snapshot, ageMs };
}

function saveAdminSystemSnapshot(snapshot) {
  if (ADMIN_SYSTEM_CACHE_TTL_MS <= 0) return;
  adminSystemCache = {
    ts: Date.now(),
    snapshot
  };
}

function buildAdminSystemCacheMeta({ hit, ageMs = 0, forced = false }) {
  return {
    enabled: ADMIN_SYSTEM_CACHE_TTL_MS > 0,
    hit: Boolean(hit),
    forcedRefresh: Boolean(forced),
    ageMs: Math.max(0, Math.round(ageMs)),
    ttlMs: ADMIN_SYSTEM_CACHE_TTL_MS,
    refreshedAt: adminSystemCache.ts ? new Date(adminSystemCache.ts).toISOString() : null
  };
}

async function loadUsersForAdmin() {
  const { rows } = await pool.query(
    `SELECT
       u.id,
       u.email,
       u.role,
       u.created_at,
       COALESCE(u.api_key_last4, RIGHT(u.api_key, 4)) AS api_key_last4,
       cp.plan_id AS current_plan_id,
       cp.plan_name AS current_plan_name,
       cp.status AS subscription_status
     FROM users u
     LEFT JOIN LATERAL (
       SELECT
         s.plan_id,
         p.name AS plan_name,
         s.status
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id = u.id
       ORDER BY
         CASE WHEN s.status IN ('active', 'trial') THEN 0 ELSE 1 END,
         COALESCE(s.updated_at, s.created_at) DESC
       LIMIT 1
     ) cp ON true
     ORDER BY u.created_at ASC`
  );
  return rows;
}

async function loadRecentInvites() {
  const { rows } = await pool.query(
    `SELECT i.*, u.email AS inviter_email
     FROM invites i
     LEFT JOIN users u ON u.id = i.invited_by_id
     ORDER BY i.created_at DESC LIMIT 20`
  );
  return rows;
}

async function loadPlansForAdmin() {
  const { rows } = await pool.query(
    'SELECT id, name, price_usd FROM plans ORDER BY price_usd ASC, id ASC'
  );
  return rows;
}

// GET /admin/users
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const [users, invites, plans] = await Promise.all([
      loadUsersForAdmin(),
      loadRecentInvites(),
      loadPlansForAdmin()
    ]);
    res.render('admin', {
      title: 'Admin — Users',
      users,
      invites,
      plans,
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
        timestamp: new Date(),
        language: req.user.language
      }).catch(() => false);
    }

    const [users, invites, plans] = await Promise.all([
      loadUsersForAdmin(),
      loadRecentInvites(),
      loadPlansForAdmin()
    ]);

    res.render('admin', {
      title: 'Admin — Users',
      users,
      invites,
      plans,
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

// POST /admin/users/:id/plan — set plan + subscription status manually
router.post('/users/:id/plan', requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const planId = parseInt(req.body.plan_id, 10);
  const status = String(req.body.status || '').trim().toLowerCase();

  if (!Number.isFinite(userId) || userId <= 0) {
    return res.redirect('/admin/users?msg=Invalid+user');
  }
  if (!Number.isFinite(planId) || planId <= 0) {
    return res.redirect('/admin/users?msg=Invalid+plan');
  }
  if (!SUBSCRIPTION_STATUSES.includes(status)) {
    return res.redirect('/admin/users?msg=Invalid+subscription+status');
  }

  try {
    const [{ rows: userRows }, { rows: planRows }] = await Promise.all([
      pool.query('SELECT id, email FROM users WHERE id = $1 LIMIT 1', [userId]),
      pool.query('SELECT id, name FROM plans WHERE id = $1 LIMIT 1', [planId])
    ]);

    const targetUser = userRows[0] || null;
    const plan = planRows[0] || null;
    if (!targetUser) return res.redirect('/admin/users?msg=User+not+found');
    if (!plan) return res.redirect('/admin/users?msg=Plan+not+found');

    let trialEndsAt = null;
    let currentPeriodEnd = null;
    if (status === 'trial') {
      trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      currentPeriodEnd = trialEndsAt;
    } else if (status === 'active') {
      currentPeriodEnd = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE subscriptions
         SET status = 'cancelled',
             updated_at = NOW()
         WHERE user_id = $1
           AND status IN ('active', 'trial')`,
        [userId]
      );

      await client.query(
        `INSERT INTO subscriptions
           (user_id, plan_id, status, trial_ends_at, current_period_end, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
        [userId, planId, status, trialEndsAt, currentPeriodEnd]
      );

      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    clearPlanCache(userId);
    await auditFromRequest(req, {
      action: 'admin.user.plan_change',
      entityType: 'user',
      entityId: userId,
      meta: { plan_id: planId, plan_name: plan.name, status }
    });

    res.redirect('/admin/users?msg=' + encodeURIComponent(`Plan updated: ${targetUser.email} -> ${plan.name} (${status})`));
  } catch (err) {
    console.error(err);
    res.redirect('/admin/users?msg=' + encodeURIComponent(err.message));
  }
});

// GET /admin/system — operational metrics
router.get('/system', requireAdmin, async (req, res) => {
  try {
    const forceRefresh = String(req.query.refresh || '').trim() === '1';
    if (!forceRefresh) {
      const cached = getAdminSystemCachedSnapshot();
      if (cached) {
        return res.render('admin-system', {
          title: 'Admin — System',
          system: {
            ...cached.snapshot,
            cache: buildAdminSystemCacheMeta({ hit: true, ageMs: cached.ageMs })
          }
        });
      }
    }

    const startedAtMs = Date.now();
    const [
      usersRes,
      urlsRes,
      monitorsRes,
      snapRes,
      alertsRes,
      notifRes,
      webhookRes,
      dbSizeRes,
      queueDepthRes,
      schedulerBucketsRes,
      tableSizesRes,
      lastCheckRes,
      queueStats
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
      pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size`),
      pool.query(`
        SELECT COUNT(*)::int AS pending_checks
        FROM monitored_urls mu
        LEFT JOIN LATERAL (
          SELECT checked_at
          FROM snapshots
          WHERE url_id = mu.id
          ORDER BY checked_at DESC
          LIMIT 1
        ) ls ON true
        WHERE mu.is_active = true
          AND (
            ls.checked_at IS NULL
            OR ls.checked_at < NOW() - make_interval(mins => mu.check_interval_minutes)
          )
      `),
      pool.query(`
        SELECT
          mu.check_interval_minutes::int AS interval_min,
          COUNT(*)::int AS urls_scheduled,
          MIN(COALESCE(
            ls.checked_at + make_interval(mins => mu.check_interval_minutes),
            NOW() + make_interval(mins => mu.check_interval_minutes)
          )) AS next_run_at
        FROM monitored_urls mu
        LEFT JOIN LATERAL (
          SELECT checked_at
          FROM snapshots
          WHERE url_id = mu.id
          ORDER BY checked_at DESC
          LIMIT 1
        ) ls ON true
        WHERE mu.is_active = true
        GROUP BY mu.check_interval_minutes
        ORDER BY mu.check_interval_minutes ASC
      `),
      pool.query(`
        SELECT
          relname AS table_name,
          pg_size_pretty(pg_total_relation_size(relid)) AS size_pretty,
          pg_total_relation_size(relid)::bigint AS size_bytes
        FROM pg_catalog.pg_statio_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
        LIMIT 12
      `),
      pool.query(`
        SELECT GREATEST(
          (SELECT MAX(checked_at) FROM snapshots),
          (SELECT MAX(checked_at) FROM uptime_checks)
        ) AS last_check_ran_at
      `),
      getQueueStats().catch(() => null)
    ]);

    const scheduler = getSchedulerStatus();
    const workerStatus = getWorkerStatus();
    const slowQueries = typeof pool.getRecentSlowQueries === 'function'
      ? pool.getRecentSlowQueries(20)
      : [];
    const slowQueryThreshold = typeof pool.getSlowQueryThreshold === 'function'
      ? pool.getSlowQueryThreshold()
      : parseInt(process.env.SLOW_QUERY_MS || '250', 10);

    const systemSnapshot = {
      appVersion: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      generatedAt: new Date().toISOString(),
      collectMs: Date.now() - startedAtMs,
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
      pendingChecks: queueDepthRes.rows[0]?.pending_checks || 0,
      lastCheckRanAt: lastCheckRes.rows[0]?.last_check_ran_at || null,
      schedulerBuckets: schedulerBucketsRes.rows || [],
      tableSizes: tableSizesRes.rows || [],
      queueStats: queueStats || null,
      workerStatus,
      slowQueries,
      slowQueryThreshold,
      dbSize: dbSizeRes.rows[0]?.db_size || 'unknown',
      scheduler
    };
    saveAdminSystemSnapshot(systemSnapshot);

    res.render('admin-system', {
      title: 'Admin — System',
      system: {
        ...systemSnapshot,
        cache: buildAdminSystemCacheMeta({ hit: false, forced: forceRefresh })
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

module.exports = router;
