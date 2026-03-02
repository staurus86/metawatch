const axios = require('axios');
const crypto = require('crypto');
const { sendAlert: sendEmailAlert } = require('./mailer');
const { assertSafeOutboundUrl } = require('./net-safety');

function buildWebhookSignature(payload, secret) {
  const raw = JSON.stringify(payload || {});
  return crypto
    .createHmac('sha256', secret)
    .update(raw)
    .digest('hex');
}

async function sendTelegram({ botToken, chatId, message }) {
  if (!botToken || !chatId) return false;
  try {
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text: message, parse_mode: 'HTML' },
      { timeout: 10000 }
    );
    return true;
  } catch (err) {
    console.error(`[Telegram] Failed: ${err.message}`);
    return false;
  }
}

async function sendWebhook({ webhookUrl, payload }) {
  if (!webhookUrl) return false;
  try {
    const safeWebhookUrl = await assertSafeOutboundUrl(webhookUrl);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'MetaWatch/2.0'
    };
    const signingSecret = String(process.env.WEBHOOK_SIGNING_SECRET || '').trim();
    headers['X-MetaWatch-Timestamp'] = new Date().toISOString();
    if (signingSecret) {
      headers['X-MetaWatch-Signature'] = `sha256=${buildWebhookSignature(payload, signingSecret)}`;
    }
    await axios.post(safeWebhookUrl, payload, {
      timeout: 10000,
      headers
    });
    return true;
  } catch (err) {
    console.error(`[Webhook] Failed: ${err.message}`);
    return false;
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildTgMessage(field, url, oldValue, newValue) {
  const oldShort = String(oldValue || '').substring(0, 300);
  const newShort = String(newValue || '').substring(0, 300);
  return [
    `🔔 <b>MetaWatch Alert</b>`,
    ``,
    `<b>Field:</b> ${escapeHtml(field)}`,
    `<b>URL:</b> ${escapeHtml(url)}`,
    ``,
    `<b>Previous:</b>`,
    oldShort ? escapeHtml(oldShort) : '<i>(empty)</i>',
    ``,
    `<b>New:</b>`,
    newShort ? escapeHtml(newShort) : '<i>(empty)</i>'
  ].join('\n');
}

/**
 * Dispatch notifications for a field change.
 * If ruleActions is provided (from alert_rules), it overrides URL-level channels.
 * ruleActions format: [{ type: 'send_email'|'send_telegram'|'send_webhook'|'suppress_alert', value: string }]
 *   - send_email:    value = email address
 *   - send_telegram: value = "botToken:chatId"
 *   - send_webhook:  value = webhook URL
 */
async function notify({ urlRecord, field, oldValue, newValue, severity, timestamp, ruleActions }) {
  const results = { email: false, telegram: false, webhook: false };

  const hasRuleOverride = Array.isArray(ruleActions) && ruleActions.length > 0;

  // ─── Email ────────────────────────────────────────────────────────────────
  const ruleEmails = hasRuleOverride
    ? ruleActions.filter(a => a.type === 'send_email').map(a => a.value).filter(Boolean)
    : [];
  const emailTargets = ruleEmails.length > 0
    ? ruleEmails
    : (urlRecord.email ? [urlRecord.email] : []);

  for (const to of emailTargets) {
    results.email = await sendEmailAlert({
      to,
      url: urlRecord.url,
      field,
      oldValue,
      newValue,
      timestamp,
      language: urlRecord.user_language
    });
  }

  // ─── Telegram ─────────────────────────────────────────────────────────────
  const ruleTgActions = hasRuleOverride
    ? ruleActions.filter(a => a.type === 'send_telegram')
    : [];

  if (ruleTgActions.length > 0) {
    const msg = buildTgMessage(field, urlRecord.url, oldValue, newValue);
    for (const a of ruleTgActions) {
      // value format: "botToken:chatId"
      const sep = (a.value || '').indexOf(':');
      if (sep === -1) continue;
      const botToken = a.value.substring(0, sep);
      const chatId   = a.value.substring(sep + 1);
      results.telegram = await sendTelegram({ botToken, chatId, message: msg });
    }
  } else {
    const tgToken = urlRecord.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || null;
    if (tgToken && urlRecord.telegram_chat_id) {
      const msg = buildTgMessage(field, urlRecord.url, oldValue, newValue);
      results.telegram = await sendTelegram({
        botToken: tgToken,
        chatId: urlRecord.telegram_chat_id,
        message: msg
      });
    }
  }

  // ─── Webhook ──────────────────────────────────────────────────────────────
  const ruleWebhooks = hasRuleOverride
    ? ruleActions.filter(a => a.type === 'send_webhook').map(a => a.value).filter(Boolean)
    : [];
  const webhookTargets = ruleWebhooks.length > 0
    ? ruleWebhooks
    : (urlRecord.webhook_url ? [urlRecord.webhook_url] : []);

  const webhookPayload = {
    event: 'change_detected',
    url: urlRecord.url,
    url_id: urlRecord.id,
    field,
    old_value: oldValue,
    new_value: newValue,
    severity: severity || 'info',
    timestamp: timestamp instanceof Date ? timestamp.toISOString() : timestamp,
    dashboard_url: process.env.BASE_URL
      ? `${process.env.BASE_URL}/urls/${urlRecord.id}`
      : null
  };

  for (const wUrl of webhookTargets) {
    results.webhook = await sendWebhook({ webhookUrl: wUrl, payload: webhookPayload });
  }

  return results;
}

module.exports = { notify, sendTelegram, sendWebhook };
