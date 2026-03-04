const axios = require('axios');
const { CookieJar, Cookie } = require('tough-cookie');
const cron = require('node-cron');
const pool = require('./db');
const { checkSsl } = require('./scraper');
const { sendTelegram, sendWebhook, sendDiscord, sendPushToUser } = require('./notifier');
const { sendAlert: sendEmail } = require('./mailer');
const { enqueueNotification, isQueueEnabled } = require('./queue');
const { assertSafeOutboundUrl } = require('./net-safety');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ─── Cookie helpers (pure tough-cookie, no ESM wrapper) ──────────────────────

function buildCookieJar(savedCookiesJson) {
  const jar = new CookieJar();
  if (!savedCookiesJson) return jar;
  try {
    const cookies = JSON.parse(savedCookiesJson);
    for (const c of cookies) {
      try {
        const cookie = Cookie.fromJSON(c);
        if (cookie) {
          const url = c.domain ? `https://${c.domain.replace(/^\./, '')}` : 'https://example.com';
          jar.setCookieSync(cookie, url);
        }
      } catch { /* skip bad cookies */ }
    }
  } catch { /* invalid JSON — start fresh */ }
  return jar;
}

function serializeCookieJar(jar) {
  try {
    const serialized = jar.serializeSync();
    return JSON.stringify(serialized.cookies || []);
  } catch { return null; }
}

async function saveCookies(monitorId, jar) {
  const json = serializeCookieJar(jar);
  if (json) {
    await pool.query(
      'UPDATE uptime_monitors SET session_cookies = $1 WHERE id = $2',
      [json, monitorId]
    ).catch(() => {});
  }
}

// Create an axios instance that uses a tough-cookie jar (CommonJS-safe)
function createCookieClient(jar) {
  const client = axios.create();

  // Request interceptor: inject Cookie header from jar
  client.interceptors.request.use((config) => {
    try {
      const cookieString = jar.getCookieStringSync(config.url);
      if (cookieString) {
        config.headers = config.headers || {};
        config.headers['Cookie'] = cookieString;
      }
    } catch { /* ignore */ }
    return config;
  });

  // Response interceptor: store set-cookie headers into jar
  client.interceptors.response.use((response) => {
    try {
      const setCookies = response.headers['set-cookie'];
      if (setCookies) {
        const url = response.config.url;
        const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
        for (const raw of arr) {
          try { jar.setCookieSync(raw, url); } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }
    return response;
  });

  return client;
}

// ─── Persistent browser pool for browser_mode checks ─────────────────────────
let _browser = null;
let _browserLaunching = false;

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_browserLaunching) {
    // Wait for ongoing launch
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (_browser && _browser.isConnected()) return _browser;
    }
    throw new Error('Browser launch timeout');
  }
  _browserLaunching = true;
  try {
    const puppeteer = require('puppeteer');
    _browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--disable-extensions'
      ]
    });
    _browser.on('disconnected', () => { _browser = null; });
    return _browser;
  } finally {
    _browserLaunching = false;
  }
}

// Browser-based HTTP check: real Chrome TLS + JS execution
async function browserCheck(url, ua, timeoutMs) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const start = Date.now();
    const response = await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: timeoutMs || 30000
    });

    let statusCode = response ? response.status() : 0;
    const responseTimeMs = Date.now() - start;

    // If JS challenge page (503/403), wait for it to auto-resolve
    if (statusCode === 503 || statusCode === 403) {
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
        // Re-check final status after challenge resolved
        statusCode = 200; // If navigation succeeded, the challenge passed
      } catch {
        // Navigation didn't happen — still blocked
      }
    }

    // Save cookies from browser for future use
    const cookies = await page.cookies();
    return { statusCode, responseTimeMs, cookies, error: null };
  } catch (err) {
    return { statusCode: 0, responseTimeMs: Date.now(), cookies: [], error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

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

function severityForUptimeEvent(event) {
  const normalized = String(event || '').toLowerCase();
  if (normalized === 'recovery' || normalized === 'info') return 'info';
  if (normalized === 'degraded' || normalized === 'warning') return 'warning';
  return 'critical';
}

async function logNotification({ monitorId, channel, fieldChanged, severity, status, errorMessage }) {
  try {
    await pool.query(
      `INSERT INTO notification_log (monitor_id, channel, field_changed, severity, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [monitorId || null, channel, fieldChanged || null, severity || null, status, errorMessage || null]
    );
  } catch {
    // non-critical
  }
}

function isAsyncNotificationsEnabled() {
  const flag = String(process.env.ENABLE_ASYNC_NOTIFICATIONS || 'false').trim().toLowerCase();
  return flag === 'true' && isQueueEnabled();
}

async function dispatchOrSendUptime({ channel, target, payload, incidentId = null, sendNow }) {
  if (isAsyncNotificationsEnabled()) {
    try {
      const queued = await enqueueNotification({
        channel,
        target,
        payload,
        alertId: incidentId || null
      });
      if (queued?.queued) return true;
    } catch (err) {
      console.error(`[UptimeNotifyQueue] ${channel} enqueue failed: ${err.message}`);
    }
  }
  return !!(await sendNow());
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

async function sendUptimeNotification({ monitor, subject, body, discordEvent = 'down', incidentId = null }) {
  const results = {};

  // Email
  if (monitor.alert_email) {
    try {
      results.email = await dispatchOrSendUptime({
        channel: 'email',
        target: { to: monitor.alert_email },
        incidentId,
        payload: {
          mode: 'meta_alert',
          to: monitor.alert_email,
          url: monitor.url,
          field: subject,
          oldValue: '',
          newValue: body,
          timestamp: new Date().toISOString()
        },
        sendNow: () => sendEmail({
          to: monitor.alert_email,
          url: monitor.url,
          field: subject,
          oldValue: '',
          newValue: body,
          timestamp: new Date()
        })
      });
    } catch { results.email = false; }
  }

  // Telegram (per-monitor or global env)
  const tgToken = monitor.telegram_token || process.env.TELEGRAM_BOT_TOKEN || null;
  if (tgToken && monitor.telegram_chat_id) {
    results.telegram = await dispatchOrSendUptime({
      channel: 'telegram',
      target: { botToken: tgToken, chatId: monitor.telegram_chat_id },
      incidentId,
      payload: {
        botToken: tgToken,
        chatId: monitor.telegram_chat_id,
        message: `${subject}\n\n${body}`
      },
      sendNow: () => sendTelegram({
        botToken: tgToken,
        chatId: monitor.telegram_chat_id,
        message: `${subject}\n\n${body}`
      })
    });
  }

  // Webhook
  if (monitor.webhook_url) {
    const webhookPayload = {
      event: 'uptime_alert',
      monitor_id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      subject,
      body,
      timestamp: new Date().toISOString()
    };
    results.webhook = await dispatchOrSendUptime({
      channel: 'webhook',
      target: { webhookUrl: monitor.webhook_url },
      incidentId,
      payload: webhookPayload,
      sendNow: () => sendWebhook({
        webhookUrl: monitor.webhook_url,
        payload: webhookPayload
      })
    });
  }

  if (monitor.discord_webhook_url) {
    const discordAlert = {
      type: 'uptime',
      event: discordEvent,
      name: monitor.name,
      url: monitor.url,
      body,
      timestamp: new Date()
    };
    results.discord = await dispatchOrSendUptime({
      channel: 'discord',
      target: { webhookUrl: monitor.discord_webhook_url },
      incidentId,
      payload: { alert: discordAlert },
      sendNow: () => sendDiscord({
        webhookUrl: monitor.discord_webhook_url,
        alert: discordAlert
      })
    });
    await logNotification({
      monitorId: monitor.id,
      channel: 'discord',
      fieldChanged: subject,
      severity: severityForUptimeEvent(discordEvent),
      status: results.discord ? 'sent' : 'failed',
      errorMessage: results.discord ? null : 'discord_send_failed'
    });
  }

  const pushSeverity = severityForUptimeEvent(discordEvent);
  if (monitor.user_id && pushSeverity === 'critical') {
    const pushNotification = {
      title: `MetaWatch: ${monitor.name || 'Monitor'} is DOWN`,
      body: body || `${monitor.url} is unreachable`,
      url: `/uptime/${monitor.id}`,
      tag: `metawatch-uptime-${monitor.id}`,
      severity: 'critical'
    };
    results.push = await dispatchOrSendUptime({
      channel: 'push',
      target: { userId: monitor.user_id },
      incidentId,
      payload: { userId: monitor.user_id, notification: pushNotification },
      sendNow: async () => {
        const pushResult = await sendPushToUser({
          userId: monitor.user_id,
          notification: pushNotification
        });
        return pushResult.sent > 0;
      }
    });
    await logNotification({
      monitorId: monitor.id,
      channel: 'push',
      fieldChanged: subject,
      severity: 'critical',
      status: results.push ? 'sent' : 'failed',
      errorMessage: results.push ? null : 'push_send_failed'
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
    const ua = monitor.custom_user_agent || DEFAULT_USER_AGENT;

    if (monitor.browser_mode) {
      // ── Browser mode: real Chromium with JS execution ──
      try {
        const result = await browserCheck(safeTargetUrl, ua, 30000);
        statusCode = result.statusCode;
        responseTimeMs = result.responseTimeMs;
        if (result.error) {
          errorMessage = result.error.substring(0, 200);
        }
        // Save browser cookies for display/debug
        if (result.cookies && result.cookies.length > 0) {
          const jar = new CookieJar();
          for (const c of result.cookies) {
            try {
              const cookieStr = `${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path}` +
                (c.secure ? '; Secure' : '') + (c.httpOnly ? '; HttpOnly' : '');
              const cUrl = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`;
              jar.setCookieSync(cookieStr, cUrl);
            } catch {}
          }
          await saveCookies(monitorId, jar);
        }
      } catch (err) {
        responseTimeMs = Date.now() - start;
        fetchErr = err;
        errorMessage = err.message?.substring(0, 200) || 'Browser check failed';
      }
    } else {
      // ── Standard mode: axios with cookie jar ──
      try {
        const jar = buildCookieJar(monitor.session_cookies);
        const client = createCookieClient(jar);

        const reqConfig = {
          timeout: 15000,
          maxRedirects: 5,
          validateStatus: () => true,
          headers: {
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1'
          },
          decompress: true
        };

        let resp = await client.get(safeTargetUrl, reqConfig);

        // If 503 (anti-bot), wait briefly and retry once with the cookies the server set
        if (resp.status === 503) {
          await new Promise(r => setTimeout(r, 2000));
          resp = await client.get(safeTargetUrl, reqConfig);
        }

        statusCode = resp.status;
        responseTimeMs = Date.now() - start;
        await saveCookies(monitorId, jar);
      } catch (err) {
        responseTimeMs = Date.now() - start;
        fetchErr = err;
        errorMessage = err.message?.substring(0, 200) || 'Unknown error';
      }
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
        await sendUptimeNotification({ monitor, subject, body, discordEvent: 'down', incidentId: newIncident.id });
      } else {
        subject = `🟡 ${monitor.name} is SLOW (DEGRADED)`;
        body = `URL: ${monitor.url}\nResponse time: ${responseTimeMs}ms (threshold: ${monitor.threshold_ms}ms)`;
        await sendUptimeNotification({ monitor, subject, body, discordEvent: 'degraded', incidentId: newIncident.id });
      }
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
        body: `URL: ${monitor.url}\nDowntime: ${dur}`,
        discordEvent: 'recovery',
        incidentId: incident.id
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
            body: `URL: ${monitor.url}\nSSL certificate expires: ${new Date(sslExpiresAt).toLocaleDateString()}`,
            discordEvent: 'warning'
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

// ─── Refresh session via headless browser ────────────────────────────────────
// Launches Puppeteer, navigates to the URL, waits for JS challenges to resolve,
// then extracts cookies and saves them for future axios-based checks.

async function refreshSession(monitorId) {
  const { rows } = await pool.query(
    'SELECT * FROM uptime_monitors WHERE id = $1',
    [monitorId]
  );
  const monitor = rows[0];
  if (!monitor) return { ok: false, error: 'Monitor not found' };

  let safeUrl;
  try {
    safeUrl = await assertSafeOutboundUrl(monitor.url);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const ua = monitor.custom_user_agent || DEFAULT_USER_AGENT;

  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    return { ok: false, error: 'Puppeteer is not installed on this server' };
  }

  let browser;
  try {
    const fs = require('fs');
    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ];

    // Use only PUPPETEER_EXECUTABLE_PATH env if set; otherwise let Puppeteer
    // use its own bundled Chromium (system chromium is a snap stub on Ubuntu)
    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || null;

    browser = await puppeteer.launch({
      headless: 'new',
      args: launchArgs,
      ...(execPath ? { executablePath: execPath } : {})
    });

    const page = await browser.newPage();
    await page.setUserAgent(ua);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9'
    });

    // Navigate and wait for network to settle (JS challenges need time)
    const response = await page.goto(safeUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    const statusCode = response ? response.status() : 0;

    // If we got a challenge page, wait extra time for it to resolve
    if (statusCode === 403 || statusCode === 503) {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    }

    const finalStatus = (await page.evaluate(() => {
      // Check if we're on a real page or still on challenge
      return document.title;
    }));

    // Extract all cookies from the browser
    const browserCookies = await page.cookies();

    // Convert browser cookies to tough-cookie format and save
    const jar = new CookieJar();
    for (const c of browserCookies) {
      try {
        const cookieStr = `${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path}` +
          (c.secure ? '; Secure' : '') +
          (c.httpOnly ? '; HttpOnly' : '') +
          (c.sameSite && c.sameSite !== 'None' ? `; SameSite=${c.sameSite}` : '') +
          (c.expires > 0 ? `; Expires=${new Date(c.expires * 1000).toUTCString()}` : '');
        const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path}`;
        jar.setCookieSync(cookieStr, url);
      } catch { /* skip problematic cookies */ }
    }

    await saveCookies(monitorId, jar);
    await browser.close();

    const cookieCount = browserCookies.length;
    const currentStatus = response ? response.status() : 0;
    return {
      ok: true,
      statusCode: currentStatus,
      cookiesSaved: cookieCount,
      pageTitle: finalStatus || null,
      message: currentStatus < 400
        ? `Browser session OK (HTTP ${currentStatus}) — ${cookieCount} cookie(s) saved`
        : `Browser got HTTP ${currentStatus} — ${cookieCount} cookie(s) saved. Anti-bot may require manual cookies.`
    };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, error: err.message };
  }
}

module.exports = { checkMonitor, refreshSession };
