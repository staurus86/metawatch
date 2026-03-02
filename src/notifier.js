const axios = require('axios');
const crypto = require('crypto');
const { sendAlert: sendEmailAlert } = require('./mailer');
const { enqueueNotification, isQueueEnabled } = require('./queue');
const { assertSafeOutboundUrl } = require('./net-safety');
const { sendPushToUser } = require('./push');

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

function clipText(value, max = 700) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

function getDomainFromUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.hostname || String(url || 'site');
  } catch {
    return String(url || 'site');
  }
}

function toIsoTimestamp(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function discordColorBySeverity(severity) {
  const s = String(severity || 'info').toLowerCase();
  if (s === 'critical') return 0xff0000;
  if (s === 'warning') return 0xffaa00;
  return 0x0099ff;
}

function buildDiscordPayload(alert) {
  const ts = toIsoTimestamp(alert?.timestamp);
  if (alert?.type === 'uptime') {
    const event = String(alert.event || 'down').toLowerCase();
    let color = 0xff0000;
    let title = `${alert.name || 'Monitor'} is DOWN`;
    if (event === 'recovery') {
      color = 0x00cc44;
      title = `${alert.name || 'Monitor'} recovered`;
    } else if (event === 'degraded') {
      color = 0xffaa00;
      title = `${alert.name || 'Monitor'} is DEGRADED`;
    } else if (event === 'info') {
      color = 0x0099ff;
      title = `${alert.name || 'Monitor'} update`;
    } else if (event === 'warning') {
      color = 0xffaa00;
      title = `${alert.name || 'Monitor'} warning`;
    }

    return {
      embeds: [{
        color,
        title,
        description: clipText(alert.body || alert.description || '', 1900),
        url: alert.url || null,
        footer: { text: `MetaWatch • ${ts}` }
      }]
    };
  }

  const severity = String(alert?.severity || 'info').toLowerCase();
  const field = String(alert?.field || 'Field');
  const domain = getDomainFromUrl(alert?.url);
  const oldValue = clipText(alert?.oldValue, 900) || '(empty)';
  const newValue = clipText(alert?.newValue, 900) || '(empty)';

  return {
    embeds: [{
      color: discordColorBySeverity(severity),
      title: `${field} changed on ${domain}`,
      description: `**Before:** ${oldValue}\n**After:** ${newValue}`,
      url: alert?.url || null,
      footer: { text: `MetaWatch • ${ts}` }
    }]
  };
}

async function sendDiscord({ webhookUrl, alert }) {
  if (!webhookUrl) return false;
  try {
    const safeWebhookUrl = await assertSafeOutboundUrl(webhookUrl);
    await axios.post(safeWebhookUrl, buildDiscordPayload(alert), {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'MetaWatch/2.0'
      }
    });
    return true;
  } catch (err) {
    console.error(`[Discord] Failed: ${err.message}`);
    return false;
  }
}

function mapSeverityToPagerDuty(severity) {
  const s = String(severity || 'info').toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'warning') return 'warning';
  return 'info';
}

function severityRank(severity) {
  const s = String(severity || 'info').toLowerCase();
  if (s === 'critical') return 3;
  if (s === 'warning') return 2;
  return 1;
}

function shouldSendPagerDutyByThreshold(threshold, severity) {
  const normalized = String(threshold || 'critical_only').trim().toLowerCase();
  const rank = severityRank(severity);
  if (normalized === 'all') return true;
  if (normalized === 'warning_plus') return rank >= 2;
  return rank >= 3; // critical_only
}

function buildSlackPayload({ channelId, alert }) {
  const field = String(alert?.field || 'Field');
  const domain = getDomainFromUrl(alert?.url);
  const severity = String(alert?.severity || 'info').toLowerCase();
  const ts = toIsoTimestamp(alert?.timestamp);
  const oldValue = clipText(alert?.oldValue, 600) || '(empty)';
  const newValue = clipText(alert?.newValue, 600) || '(empty)';
  const detailsUrl = alert?.detailsUrl || alert?.url || null;
  const label = severity === 'critical' ? 'Critical' : severity === 'warning' ? 'Warning' : 'Info';

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${field}* changed on \`${domain}\``
      }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Before*\\n${oldValue}` },
        { type: 'mrkdwn', text: `*After*\\n${newValue}` },
        { type: 'mrkdwn', text: `*Severity*\\n${label}` },
        { type: 'mrkdwn', text: `*Time*\\n${ts}` }
      ]
    }
  ];

  if (detailsUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View Details' },
          url: detailsUrl
        }
      ]
    });
  }

  return {
    channel: channelId,
    text: `${field} changed on ${domain}`,
    blocks
  };
}

async function sendSlack({ botToken, channelId, alert }) {
  if (!botToken || !channelId) return false;
  try {
    const payload = buildSlackPayload({ channelId, alert });
    const { data } = await axios.post(
      'https://slack.com/api/chat.postMessage',
      payload,
      {
        timeout: 10000,
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    if (!data?.ok) {
      console.error(`[Slack] Failed: ${data?.error || 'unknown_error'}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[Slack] Failed: ${err.message}`);
    return false;
  }
}

async function sendPagerDuty({ integrationKey, alert, action = 'trigger' }) {
  if (!integrationKey) return false;
  const eventAction = action === 'resolve' ? 'resolve' : 'trigger';
  const fieldSlug = String(alert?.field || 'field').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const dedupKey = alert?.dedupKey || `metawatch-${alert?.urlId || 'url'}-${fieldSlug}`;

  try {
    const payload = {
      routing_key: integrationKey,
      event_action: eventAction,
      dedup_key: dedupKey,
      payload: {
        summary: `${alert?.field || 'Field'} changed on ${alert?.url || 'URL'}`,
        severity: mapSeverityToPagerDuty(alert?.severity),
        source: alert?.url || 'MetaWatch',
        custom_details: {
          old_value: alert?.oldValue ?? null,
          new_value: alert?.newValue ?? null,
          url: alert?.url ?? null,
          field: alert?.field ?? null,
          detected_at: toIsoTimestamp(alert?.timestamp)
        }
      }
    };
    const { data } = await axios.post(
      'https://events.pagerduty.com/v2/enqueue',
      payload,
      {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    const ok = data?.status === 'success';
    if (!ok) {
      console.error(`[PagerDuty] Failed: ${data?.message || 'request_failed'}`);
    }
    return ok;
  } catch (err) {
    console.error(`[PagerDuty] Failed: ${err.message}`);
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

function isAsyncNotificationsEnabled() {
  const flag = String(process.env.ENABLE_ASYNC_NOTIFICATIONS || 'false').trim().toLowerCase();
  return flag === 'true' && isQueueEnabled();
}

async function dispatchOrSend({ channel, target, payload, alertId, sendNow }) {
  if (isAsyncNotificationsEnabled()) {
    try {
      const queued = await enqueueNotification({
        channel,
        target,
        payload,
        alertId: alertId || null
      });
      if (queued?.queued) {
        return true;
      }
    } catch (err) {
      console.error(`[NotifyQueue] ${channel} enqueue failed: ${err.message}`);
    }
  }

  return !!(await sendNow());
}

/**
 * Dispatch notifications for a field change.
 * If ruleActions is provided (from alert_rules), it overrides URL-level channels.
 * ruleActions format:
 *   [{ type: 'send_email'|'send_telegram'|'send_webhook'|'send_discord'|'send_slack'|'send_pagerduty'|'suppress_alert', value: string }]
 *   - send_email:    value = email address
 *   - send_telegram: value = "botToken:chatId"
 *   - send_webhook:  value = webhook URL
 */
async function notify({ urlRecord, field, oldValue, newValue, severity, timestamp, ruleActions, alertId = null }) {
  const results = {
    email: false,
    telegram: false,
    webhook: false,
    discord: false,
    slack: false,
    pagerduty: false,
    push: false
  };

  const hasRuleOverride = Array.isArray(ruleActions) && ruleActions.length > 0;
  const normalizedActions = hasRuleOverride
    ? ruleActions.filter(a => a && typeof a.type === 'string')
    : [];
  const byType = (type) => normalizedActions.filter(a => a.type === type);
  const detailsUrl = process.env.BASE_URL
    ? `${process.env.BASE_URL}/urls/${urlRecord.id}`
    : null;

  // ─── Email ────────────────────────────────────────────────────────────────
  const ruleEmails = byType('send_email').map(a => a.value).filter(Boolean);
  const emailTargets = hasRuleOverride
    ? ruleEmails
    : (urlRecord.email ? [urlRecord.email] : []);

  for (const to of emailTargets) {
    const sent = await dispatchOrSend({
      channel: 'email',
      target: { to },
      alertId,
      payload: {
        mode: 'meta_alert',
        to,
        url: urlRecord.url,
        field,
        oldValue,
        newValue,
        timestamp: timestamp instanceof Date ? timestamp.toISOString() : timestamp,
        language: urlRecord.user_language
      },
      sendNow: () => sendEmailAlert({
        to,
        url: urlRecord.url,
        field,
        oldValue,
        newValue,
        timestamp,
        language: urlRecord.user_language
      })
    });
    results.email = results.email || sent;
  }

  // ─── Telegram ─────────────────────────────────────────────────────────────
  const ruleTgActions = byType('send_telegram');

  if (ruleTgActions.length > 0) {
    const msg = buildTgMessage(field, urlRecord.url, oldValue, newValue);
    for (const a of ruleTgActions) {
      // value format: "botToken:chatId"
      const sep = (a.value || '').indexOf(':');
      if (sep === -1) continue;
      const botToken = a.value.substring(0, sep);
      const chatId   = a.value.substring(sep + 1);
      const sent = await dispatchOrSend({
        channel: 'telegram',
        target: { botToken, chatId },
        alertId,
        payload: { botToken, chatId, message: msg },
        sendNow: () => sendTelegram({ botToken, chatId, message: msg })
      });
      results.telegram = results.telegram || sent;
    }
  } else if (!hasRuleOverride) {
    const tgToken = urlRecord.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || null;
    if (tgToken && urlRecord.telegram_chat_id) {
      const msg = buildTgMessage(field, urlRecord.url, oldValue, newValue);
      const sent = await dispatchOrSend({
        channel: 'telegram',
        target: { botToken: tgToken, chatId: urlRecord.telegram_chat_id },
        alertId,
        payload: { botToken: tgToken, chatId: urlRecord.telegram_chat_id, message: msg },
        sendNow: () => sendTelegram({
          botToken: tgToken,
          chatId: urlRecord.telegram_chat_id,
          message: msg
        })
      });
      results.telegram = results.telegram || sent;
    }
  }

  // ─── Webhook ──────────────────────────────────────────────────────────────
  const ruleWebhooks = byType('send_webhook').map(a => a.value).filter(Boolean);
  const webhookTargets = hasRuleOverride
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
    dashboard_url: detailsUrl
  };

  for (const wUrl of webhookTargets) {
    const sent = await dispatchOrSend({
      channel: 'webhook',
      target: { webhookUrl: wUrl },
      alertId,
      payload: webhookPayload,
      sendNow: () => sendWebhook({ webhookUrl: wUrl, payload: webhookPayload })
    });
    results.webhook = results.webhook || sent;
  }

  // ─── Discord Webhook ───────────────────────────────────────────────────────
  const ruleDiscordTargets = byType('send_discord').map(a => a.value).filter(Boolean);
  const discordTargets = hasRuleOverride
    ? ruleDiscordTargets
    : (urlRecord.discord_webhook_url ? [urlRecord.discord_webhook_url] : []);
  for (const webhookUrl of discordTargets) {
    const discordAlert = {
      type: 'meta',
      field,
      url: urlRecord.url,
      oldValue,
      newValue,
      severity: severity || 'info',
      timestamp: timestamp instanceof Date ? timestamp : new Date(timestamp || Date.now())
    };
    const sent = await dispatchOrSend({
      channel: 'discord',
      target: { webhookUrl },
      alertId,
      payload: { alert: discordAlert },
      sendNow: () => sendDiscord({
        webhookUrl,
        alert: discordAlert
      })
    });
    results.discord = results.discord || sent;
  }

  // ─── Slack ────────────────────────────────────────────────────────────────
  const ruleSlackActions = byType('send_slack');
  const defaultSlackChannel = urlRecord.slack_channel_id || urlRecord.slack_default_channel_id || null;
  if (ruleSlackActions.length > 0) {
    for (const action of ruleSlackActions) {
      const channelId = String(action.value || defaultSlackChannel || '').trim();
      if (!urlRecord.slack_bot_token || !channelId) continue;
      const slackAlert = {
        field,
        url: urlRecord.url,
        oldValue,
        newValue,
        severity: severity || 'info',
        timestamp: timestamp instanceof Date ? timestamp : new Date(timestamp || Date.now()),
        detailsUrl
      };
      const sent = await dispatchOrSend({
        channel: 'slack',
        target: { botToken: urlRecord.slack_bot_token, channelId },
        alertId,
        payload: { alert: slackAlert },
        sendNow: () => sendSlack({
          botToken: urlRecord.slack_bot_token,
          channelId,
          alert: slackAlert
        })
      });
      results.slack = results.slack || sent;
    }
  } else if (!hasRuleOverride && urlRecord.send_to_slack) {
    if (urlRecord.slack_bot_token && defaultSlackChannel) {
      const slackAlert = {
        field,
        url: urlRecord.url,
        oldValue,
        newValue,
        severity: severity || 'info',
        timestamp: timestamp instanceof Date ? timestamp : new Date(timestamp || Date.now()),
        detailsUrl
      };
      const sent = await dispatchOrSend({
        channel: 'slack',
        target: { botToken: urlRecord.slack_bot_token, channelId: defaultSlackChannel },
        alertId,
        payload: { alert: slackAlert },
        sendNow: () => sendSlack({
          botToken: urlRecord.slack_bot_token,
          channelId: defaultSlackChannel,
          alert: slackAlert
        })
      });
      results.slack = results.slack || sent;
    }
  }

  // ─── PagerDuty ────────────────────────────────────────────────────────────
  const rulePagerDutyActions = byType('send_pagerduty');
  if (rulePagerDutyActions.length > 0) {
    if (urlRecord.pagerduty_integration_key) {
      const pagerAlert = {
        urlId: urlRecord.id,
        field,
        url: urlRecord.url,
        oldValue,
        newValue,
        severity: severity || 'info',
        timestamp: timestamp instanceof Date ? timestamp : new Date(timestamp || Date.now())
      };
      const sent = await dispatchOrSend({
        channel: 'pagerduty',
        target: { integrationKey: urlRecord.pagerduty_integration_key },
        alertId,
        payload: { action: 'trigger', alert: pagerAlert },
        sendNow: () => sendPagerDuty({
          integrationKey: urlRecord.pagerduty_integration_key,
          alert: pagerAlert
        })
      });
      results.pagerduty = results.pagerduty || sent;
    }
  } else if (!hasRuleOverride && urlRecord.pagerduty_integration_key) {
    if (shouldSendPagerDutyByThreshold(urlRecord.pagerduty_threshold, severity || 'info')) {
      const pagerAlert = {
        urlId: urlRecord.id,
        field,
        url: urlRecord.url,
        oldValue,
        newValue,
        severity: severity || 'info',
        timestamp: timestamp instanceof Date ? timestamp : new Date(timestamp || Date.now())
      };
      const sent = await dispatchOrSend({
        channel: 'pagerduty',
        target: { integrationKey: urlRecord.pagerduty_integration_key },
        alertId,
        payload: { action: 'trigger', alert: pagerAlert },
        sendNow: () => sendPagerDuty({
          integrationKey: urlRecord.pagerduty_integration_key,
          alert: pagerAlert
        })
      });
      results.pagerduty = results.pagerduty || sent;
    }
  }

  // ─── Web Push (critical only, user-level) ─────────────────────────────────
  if (!hasRuleOverride && String(severity || '').toLowerCase() === 'critical' && urlRecord.user_id) {
    const pushNotification = {
      title: 'MetaWatch Critical Alert',
      body: `${field} changed on ${getDomainFromUrl(urlRecord.url)}`,
      url: detailsUrl || `/urls/${urlRecord.id}`,
      tag: `metawatch-url-${urlRecord.id}`,
      severity: 'critical'
    };
    const sent = await dispatchOrSend({
      channel: 'push',
      target: { userId: urlRecord.user_id },
      alertId,
      payload: { userId: urlRecord.user_id, notification: pushNotification },
      sendNow: async () => {
        const result = await sendPushToUser({
          userId: urlRecord.user_id,
          notification: pushNotification
        });
        return result.sent > 0;
      }
    });
    results.push = results.push || sent;
  }

  return results;
}

module.exports = {
  notify,
  sendTelegram,
  sendWebhook,
  sendDiscord,
  sendSlack,
  sendPagerDuty,
  sendPushToUser
};
