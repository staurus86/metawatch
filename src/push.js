const pool = require('./db');

let webPush = null;
let webPushLoadAttempted = false;

function loadWebPush() {
  if (webPushLoadAttempted) return webPush;
  webPushLoadAttempted = true;
  try {
    webPush = require('web-push');
  } catch (err) {
    webPush = null;
    console.warn(`[Push] web-push package unavailable: ${err.message}`);
  }
  return webPush;
}

function getVapidKeys() {
  return {
    publicKey: String(process.env.VAPID_PUBLIC_KEY || '').trim(),
    privateKey: String(process.env.VAPID_PRIVATE_KEY || '').trim()
  };
}

function getPushSubject() {
  const raw = String(process.env.WEB_PUSH_SUBJECT || '').trim();
  if (raw) return raw;
  const baseUrl = String(process.env.BASE_URL || '').trim();
  if (baseUrl) return baseUrl;
  return 'mailto:alerts@metawatch.app';
}

function getPushDiagnostics() {
  const wp = loadWebPush();
  const keys = getVapidKeys();
  const hasKeys = !!(keys.publicKey && keys.privateKey);
  return {
    packageAvailable: !!wp,
    hasKeys,
    enabled: !!wp && hasKeys,
    publicKey: keys.publicKey || null
  };
}

function ensurePushConfigured() {
  const diagnostics = getPushDiagnostics();
  if (!diagnostics.packageAvailable) {
    return { ok: false, reason: 'web_push_package_missing' };
  }
  if (!diagnostics.hasKeys) {
    return { ok: false, reason: 'vapid_keys_missing' };
  }

  try {
    webPush.setVapidDetails(
      getPushSubject(),
      String(process.env.VAPID_PUBLIC_KEY || '').trim(),
      String(process.env.VAPID_PRIVATE_KEY || '').trim()
    );
  } catch (err) {
    return { ok: false, reason: `vapid_setup_failed:${err.message}` };
  }

  return { ok: true };
}

function normalizeSubscription(input) {
  const src = input && typeof input === 'object' ? input : {};
  const endpoint = String(src.endpoint || '').trim();
  const p256dh = String(src.keys?.p256dh || '').trim();
  const auth = String(src.keys?.auth || '').trim();
  if (!endpoint || !p256dh || !auth) return null;
  return { endpoint, keys: { p256dh, auth } };
}

async function getUserPushStats(userId) {
  const { rows: [row] } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE disabled = false)::int AS active_count,
       COUNT(*)::int AS total_count,
       MAX(updated_at) AS last_updated_at
     FROM push_subscriptions
     WHERE user_id = $1`,
    [userId]
  );
  return {
    activeCount: row?.active_count || 0,
    totalCount: row?.total_count || 0,
    lastUpdatedAt: row?.last_updated_at || null
  };
}

async function storePushSubscription({ userId, subscription, userAgent = null }) {
  const normalized = normalizeSubscription(subscription);
  if (!normalized) {
    return { ok: false, reason: 'invalid_subscription_payload' };
  }

  await pool.query(
    `INSERT INTO push_subscriptions (
       user_id, endpoint, p256dh, auth, user_agent, disabled, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, false, NOW(), NOW())
     ON CONFLICT (user_id, endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           disabled = false,
           updated_at = NOW()`,
    [userId, normalized.endpoint, normalized.keys.p256dh, normalized.keys.auth, userAgent]
  );

  const stats = await getUserPushStats(userId);
  return { ok: true, ...stats };
}

async function removePushSubscription({ userId, endpoint }) {
  const normalizedEndpoint = String(endpoint || '').trim();
  if (!normalizedEndpoint) return { ok: false, reason: 'missing_endpoint' };
  const res = await pool.query(
    'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
    [userId, normalizedEndpoint]
  );
  const stats = await getUserPushStats(userId);
  return { ok: true, removed: res.rowCount || 0, ...stats };
}

async function removeInvalidSubscription(endpoint) {
  const normalizedEndpoint = String(endpoint || '').trim();
  if (!normalizedEndpoint) return;
  await pool.query(
    'DELETE FROM push_subscriptions WHERE endpoint = $1',
    [normalizedEndpoint]
  ).catch(() => {});
}

async function sendPushToUser({ userId, notification }) {
  const cfg = ensurePushConfigured();
  if (!cfg.ok) return { sent: 0, failed: 0, skipped: true, reason: cfg.reason };

  const payload = {
    title: String(notification?.title || 'MetaWatch Alert'),
    body: String(notification?.body || ''),
    url: String(notification?.url || '/dashboard'),
    tag: String(notification?.tag || 'metawatch-alert'),
    severity: String(notification?.severity || 'info'),
    timestamp: new Date().toISOString()
  };

  const { rows } = await pool.query(
    `SELECT id, endpoint, p256dh, auth
     FROM push_subscriptions
     WHERE user_id = $1 AND disabled = false`,
    [userId]
  );
  if (!rows || rows.length === 0) {
    return { sent: 0, failed: 0, skipped: true, reason: 'no_active_subscriptions' };
  }

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const subscription = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth }
    };
    try {
      await webPush.sendNotification(subscription, JSON.stringify(payload), { TTL: 120 });
      sent += 1;
      await pool.query(
        `UPDATE push_subscriptions
         SET last_success_at = NOW(),
             last_error_at = NULL,
             last_error_message = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [row.id]
      ).catch(() => {});
    } catch (err) {
      failed += 1;
      const status = Number(err?.statusCode || 0);
      if (status === 404 || status === 410) {
        await removeInvalidSubscription(row.endpoint);
      } else {
        await pool.query(
          `UPDATE push_subscriptions
           SET last_error_at = NOW(),
               last_error_message = $2,
               updated_at = NOW()
           WHERE id = $1`,
          [row.id, String(err?.message || 'push_send_failed').slice(0, 500)]
        ).catch(() => {});
      }
      console.error(`[Push] Send failed for user #${userId}: ${err.message}`);
    }
  }

  return { sent, failed, skipped: false };
}

module.exports = {
  getPushDiagnostics,
  getUserPushStats,
  storePushSubscription,
  removePushSubscription,
  sendPushToUser
};

