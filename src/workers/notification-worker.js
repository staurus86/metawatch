const { sendEmail, sendAlert } = require('../mailer');
const { sendWebhook, sendTelegram, sendDiscord, sendSlack, sendPagerDuty, sendPushToUser } = require('../notifier');
const { isQueueEnabled, getRedisConnection, QUEUE_NAMES } = require('../queue');

function getWorkerCtor() {
  try {
    return require('bullmq').Worker;
  } catch {
    return null;
  }
}

async function handleNotificationJob(data) {
  const channel = String(data?.channel || '').trim().toLowerCase();
  const target = data?.target || {};
  const payload = data?.payload || {};

  if (channel === 'webhook') {
    const webhookUrl = target?.webhookUrl || target?.url || target || payload?.webhookUrl;
    if (!webhookUrl) return { skipped: true, reason: 'missing_webhook_url' };
    const ok = await sendWebhook({ webhookUrl, payload: payload?.body || payload });
    return { sent: !!ok, channel };
  }

  if (channel === 'email') {
    const to = target?.to || payload?.to;
    if (!to) return { skipped: true, reason: 'missing_email' };
    let ok = false;
    if (payload?.mode === 'meta_alert' && payload?.url && payload?.field) {
      ok = await sendAlert({
        to,
        url: payload.url,
        field: payload.field,
        oldValue: payload.oldValue,
        newValue: payload.newValue,
        timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
        language: payload.language
      });
    } else {
      ok = await sendEmail({
        to,
        subject: payload?.subject || 'MetaWatch Notification',
        text: payload?.text || '',
        html: payload?.html || ''
      });
    }
    return { sent: !!ok, channel };
  }

  if (channel === 'telegram') {
    const botToken = target?.botToken || payload?.botToken;
    const chatId = target?.chatId || payload?.chatId;
    const message = payload?.message || '';
    if (!botToken || !chatId || !message) {
      return { skipped: true, reason: 'missing_telegram_payload' };
    }
    const ok = await sendTelegram({ botToken, chatId, message });
    return { sent: !!ok, channel };
  }

  if (channel === 'discord') {
    const webhookUrl = target?.webhookUrl || target?.url || target || payload?.webhookUrl;
    if (!webhookUrl) return { skipped: true, reason: 'missing_discord_webhook' };
    const ok = await sendDiscord({
      webhookUrl,
      alert: payload?.alert || payload
    });
    return { sent: !!ok, channel };
  }

  if (channel === 'slack') {
    const botToken = target?.botToken || payload?.botToken;
    const channelId = target?.channelId || payload?.channelId;
    if (!botToken || !channelId) return { skipped: true, reason: 'missing_slack_target' };
    const ok = await sendSlack({
      botToken,
      channelId,
      alert: payload?.alert || payload
    });
    return { sent: !!ok, channel };
  }

  if (channel === 'pagerduty') {
    const integrationKey = target?.integrationKey || payload?.integrationKey;
    if (!integrationKey) return { skipped: true, reason: 'missing_pagerduty_key' };
    const ok = await sendPagerDuty({
      integrationKey,
      action: payload?.action,
      alert: payload?.alert || payload
    });
    return { sent: !!ok, channel };
  }

  if (channel === 'push') {
    const userId = parseInt(target?.userId || payload?.userId, 10);
    if (!Number.isFinite(userId) || userId <= 0) return { skipped: true, reason: 'missing_push_user' };
    const result = await sendPushToUser({
      userId,
      notification: payload?.notification || payload
    });
    return { sent: result.sent > 0, channel, result };
  }

  return { skipped: true, reason: 'unsupported_channel', channel };
}

function startNotificationWorker() {
  if (!isQueueEnabled()) return null;

  const Worker = getWorkerCtor();
  if (!Worker) {
    console.error('[Queue] BullMQ Worker is unavailable; notification worker not started');
    return null;
  }

  const concurrency = Math.max(1, parseInt(process.env.NOTIFICATION_WORKER_CONCURRENCY || '10', 10) || 10);
  const worker = new Worker(
    QUEUE_NAMES.notification,
    async (job) => {
      const result = await handleNotificationJob(job?.data || {});
      return result;
    },
    {
      connection: getRedisConnection(),
      concurrency
    }
  );

  worker.on('failed', (job, err) => {
    const channel = job?.data?.channel || '?';
    console.error(`[Queue] Notification worker failed (${channel}): ${err.message}`);
  });

  worker.on('error', (err) => {
    console.error(`[Queue] Notification worker error: ${err.message}`);
  });

  console.log(`[Queue] Notification worker started (concurrency=${concurrency})`);
  return worker;
}

module.exports = { startNotificationWorker };
