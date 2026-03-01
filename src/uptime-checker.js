const axios = require('axios');
const cron = require('node-cron');
const pool = require('./db');
const { checkSsl } = require('./scraper');
const { sendTelegram, sendWebhook } = require('./notifier');
const { sendAlert: sendEmail } = require('./mailer');
const { assertSafeOutboundUrl } = require('./net-safety');

// Classify a check result
function classifyStatus(statusCode, responseTimeMs, thresholdMs) {
  if (!statusCode || statusCode === 0) return 'down';
  if (statusCode >= 400) return 'down';
  if (responseTimeMs >= thresholdMs) return 'degraded';
  return 'up';
}

// Determine error cause string
function getCause(err, statusCode) {
  if (!err && statusCode) {
    if (statusCode >= 400) return 'non200';
    return null;
  }
  const msg = (err?.message || '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('econnaborted')) return 'timeout';
  if (msg.includes('ssl') || msg.includes('certificate')) return 'ssl_error';
  if (msg.includes('enotfound') || msg.includes('getaddrinfo')) return 'dns_error';
  return 'connection_error';
}

function isInMaintenanceWindow(maintenanceCron, durationMinutes) {
  if (!maintenanceCron || !durationMinutes || durationMinutes <= 0) return false;
  try {
    if (!cron.validate(maintenanceCron)) return false;
    const now = new Date();
    const [minute, hour, dom, month, dow] = maintenanceCron.split(' ');
    for (let i = 0; i <= durationMinutes; i++) {
      const t = new Date(now.getTime() - i * 60000);
      const minuteMatch = minute === '*' || minute === String(t.getUTCMinutes()) ||
        (minute.startsWith('*/') && t.getUTCMinutes() % parseInt(minute.slice(2), 10) === 0);
      const hourMatch  = hour  === '*' || hour  === String(t.getUTCHours());
      const domMatch   = dom   === '*' || dom   === String(t.getUTCDate());
      const monthMatch = month === '*' || month === String(t.getUTCMonth() + 1);
      const dowMatch   = dow   === '*' || dow   === String(t.getUTCDay());
      if (minuteMatch && hourMatch && domMatch && monthMatch && dowMatch) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function sendUptimeNotification({ monitor, subject, body }) {
  const results = {};

  // Email
  if (monitor.alert_email) {
    try {
      await sendEmail({
        to: monitor.alert_email,
        url: monitor.url,
        field: subject,
        oldValue: '',
        newValue: body,
        timestamp: new Date()
      });
      results.email = true;
    } catch { results.email = false; }
  }

  // Telegram (per-monitor or global env)
  const tgToken = monitor.telegram_token || process.env.TELEGRAM_BOT_TOKEN || null;
  if (tgToken && monitor.telegram_chat_id) {
    results.telegram = await sendTelegram({
      botToken: tgToken,
      chatId: monitor.telegram_chat_id,
      message: `${subject}\n\n${body}`
    });
  }

  // Webhook
  if (monitor.webhook_url) {
    results.webhook = await sendWebhook({
      webhookUrl: monitor.webhook_url,
      payload: { event: 'uptime_alert', monitor_id: monitor.id, name: monitor.name, url: monitor.url, subject, body, timestamp: new Date().toISOString() }
    });
  }

  return results;
}

async function checkMonitor(monitorId) {
  const lockKeyA = 9092;
  const lockKeyB = parseInt(monitorId, 10);
  const { rows: [lockRow] } = await pool.query(
    'SELECT pg_try_advisory_lock($1, $2) AS locked',
    [lockKeyA, lockKeyB]
  );
  if (!lockRow?.locked) {
    return { skipped: true, reason: 'already_running' };
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM uptime_monitors WHERE id = $1 AND is_active = true',
      [monitorId]
    );
    const monitor = rows[0];
    if (!monitor) return { skipped: true };

  // Get previous check for incident logic
  const { rows: prevRows } = await pool.query(
    'SELECT * FROM uptime_checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 1',
    [monitorId]
  );
  const prevCheck = prevRows[0] || null;

  // Perform HTTP check
  const start = Date.now();
  let statusCode = 0;
  let responseTimeMs = null;
  let errorMessage = null;
  let fetchErr = null;
  let safeTargetUrl = monitor.url;

  try {
    safeTargetUrl = await assertSafeOutboundUrl(monitor.url);
  } catch (err) {
    fetchErr = err;
    errorMessage = err.message?.substring(0, 200) || 'Target blocked by outbound safety policy';
    responseTimeMs = 0;
  }

  if (!fetchErr) {
    try {
      const resp = await axios.get(safeTargetUrl, {
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: { 'User-Agent': 'MetaWatch-Uptime/2.0' }
      });
      statusCode = resp.status;
      responseTimeMs = Date.now() - start;
    } catch (err) {
      responseTimeMs = Date.now() - start;
      fetchErr = err;
      errorMessage = err.message?.substring(0, 200) || 'Unknown error';
    }
  }

  // SSL check
  let sslExpiresAt = null;
  if (monitor.url.startsWith('https://')) {
    try {
      sslExpiresAt = await checkSsl(monitor.url);
    } catch { /* ignore */ }
  }

  const status = classifyStatus(statusCode, responseTimeMs, monitor.threshold_ms);

  // Save check
  const { rows: [savedCheck] } = await pool.query(
    `INSERT INTO uptime_checks
       (monitor_id, status, response_time_ms, status_code, error_message, ssl_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [monitorId, status, responseTimeMs, statusCode || null, errorMessage, sslExpiresAt]
  );

  // --- Incident management ---
  const manualSilenced = monitor.silenced_until && new Date(monitor.silenced_until) > new Date();
  const cronSilenced = isInMaintenanceWindow(monitor.maintenance_cron, monitor.maintenance_duration_minutes);
  const silenced = manualSilenced || cronSilenced;

  // Find open incident
  const { rows: openIncident } = await pool.query(
    'SELECT * FROM uptime_incidents WHERE monitor_id = $1 AND resolved_at IS NULL',
    [monitorId]
  );
  const incident = openIncident[0] || null;

  // Transition: up → down/degraded → open incident
  if (!incident && status !== 'up') {
    const cause = getCause(fetchErr, statusCode);
    const { rows: [newIncident] } = await pool.query(
      `INSERT INTO uptime_incidents (monitor_id, cause, alert_sent)
       VALUES ($1, $2, $3) RETURNING *`,
      [monitorId, cause || status, false]
    );

    if (!silenced) {
      let subject, body;
      if (status === 'down') {
        subject = `🔴 ${monitor.name} is DOWN`;
        body = `URL: ${monitor.url}\nError: ${errorMessage || `HTTP ${statusCode}`}`;
      } else {
        subject = `🟡 ${monitor.name} is SLOW (DEGRADED)`;
        body = `URL: ${monitor.url}\nResponse time: ${responseTimeMs}ms (threshold: ${monitor.threshold_ms}ms)`;
      }
      await sendUptimeNotification({ monitor, subject, body });
      await pool.query('UPDATE uptime_incidents SET alert_sent = true WHERE id = $1', [newIncident.id]);
    }
  }

  // Transition: down/degraded → up → close incident + recovery alert
  if (incident && status === 'up') {
    const durationSec = Math.floor((Date.now() - new Date(incident.started_at).getTime()) / 1000);
    await pool.query(
      `UPDATE uptime_incidents
       SET resolved_at = NOW(), duration_seconds = $1
       WHERE id = $2`,
      [durationSec, incident.id]
    );

    if (!silenced && incident.alert_sent) {
      const mins = Math.floor(durationSec / 60);
      const secs = durationSec % 60;
      const dur = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      await sendUptimeNotification({
        monitor,
        subject: `🟢 ${monitor.name} is back UP`,
        body: `URL: ${monitor.url}\nDowntime: ${dur}`
      });
    }
  }

  // --- SSL expiry warnings ---
  if (sslExpiresAt) {
    const daysLeft = Math.ceil((new Date(sslExpiresAt) - new Date()) / 86400000);
    const warnAt = [14, 7];
    for (const threshold of warnAt) {
      if (daysLeft <= threshold && daysLeft > 0) {
        // Check if we already warned at this threshold in the last 48h
        const { rows: recent } = await pool.query(
          `SELECT id FROM uptime_incidents
           WHERE monitor_id = $1
             AND cause = 'ssl_expiry_' || $2::text
             AND started_at > NOW() - INTERVAL '48 hours'`,
          [monitorId, threshold]
        );
        if (recent.length === 0 && !silenced) {
          await pool.query(
            `INSERT INTO uptime_incidents (monitor_id, cause, alert_sent, resolved_at)
             VALUES ($1, $2, true, NOW())`,
            [monitorId, `ssl_expiry_${threshold}`]
          );
          await sendUptimeNotification({
            monitor,
            subject: `⚠️ SSL expires in ${daysLeft} days`,
            body: `URL: ${monitor.url}\nSSL certificate expires: ${new Date(sslExpiresAt).toLocaleDateString()}`
          });
        }
        break;
      }
    }
  }

    return { status, responseTimeMs, statusCode };
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1, $2)', [lockKeyA, lockKeyB]).catch(() => {});
  }
}

module.exports = { checkMonitor };
