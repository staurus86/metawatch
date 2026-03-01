const axios = require('axios');
const { sendAlert: sendEmailAlert } = require('./mailer');

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
    await axios.post(webhookUrl, payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    return true;
  } catch (err) {
    console.error(`[Webhook] Failed: ${err.message}`);
    return false;
  }
}

async function notify({ urlRecord, field, oldValue, newValue, timestamp }) {
  const results = { email: false, telegram: false, webhook: false };

  // Email
  if (urlRecord.email) {
    results.email = await sendEmailAlert({
      to: urlRecord.email,
      url: urlRecord.url,
      field,
      oldValue,
      newValue,
      timestamp
    });
  }

  // Telegram
  if (urlRecord.telegram_bot_token && urlRecord.telegram_chat_id) {
    const oldShort = String(oldValue || '').substring(0, 300);
    const newShort = String(newValue || '').substring(0, 300);
    const message = [
      `🔔 <b>MetaWatch Alert</b>`,
      ``,
      `<b>Field:</b> ${escapeHtml(field)}`,
      `<b>URL:</b> ${escapeHtml(urlRecord.url)}`,
      ``,
      `<b>Previous:</b>`,
      oldShort ? escapeHtml(oldShort) : '<i>(empty)</i>',
      ``,
      `<b>New:</b>`,
      newShort ? escapeHtml(newShort) : '<i>(empty)</i>'
    ].join('\n');

    results.telegram = await sendTelegram({
      botToken: urlRecord.telegram_bot_token,
      chatId: urlRecord.telegram_chat_id,
      message
    });
  }

  // Webhook
  if (urlRecord.webhook_url) {
    results.webhook = await sendWebhook({
      webhookUrl: urlRecord.webhook_url,
      payload: {
        event: 'change_detected',
        url: urlRecord.url,
        url_id: urlRecord.id,
        field,
        old_value: oldValue,
        new_value: newValue,
        timestamp: timestamp instanceof Date ? timestamp.toISOString() : timestamp,
        dashboard_url: process.env.BASE_URL
          ? `${process.env.BASE_URL}/urls/${urlRecord.id}`
          : null
      }
    });
  }

  return results;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { notify, sendTelegram, sendWebhook };
