const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { auditFromRequest } = require('../audit');

const router = express.Router();
const SLACK_STATE_COOKIE = 'mw_slack_oauth_state';

function redirectWithMsg(res, msg) {
  return res.redirect(`/integrations?msg=${encodeURIComponent(msg)}`);
}

function hasSlackEnv() {
  return !!(
    process.env.SLACK_CLIENT_ID &&
    process.env.SLACK_CLIENT_SECRET &&
    process.env.SLACK_REDIRECT_URI
  );
}

function getSlackScopes() {
  return 'chat:write,incoming-webhook,conversations:read';
}

async function loadUserIntegrations(userId) {
  const [{ rows: [slack] }, { rows: [pagerduty] }] = await Promise.all([
    pool.query(
      `SELECT id, workspace_name, workspace_id, channel_id, channel_name, created_at
       FROM slack_integrations
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    ),
    pool.query(
      `SELECT id, service_name, created_at
       FROM pagerduty_integrations
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    )
  ]);

  return {
    slack: slack || null,
    pagerduty: pagerduty || null
  };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const integrations = await loadUserIntegrations(req.user.id);
    res.render('integrations', {
      title: 'Integrations',
      message: req.query.msg || null,
      integrations,
      slackReady: hasSlackEnv()
    });
  } catch (err) {
    console.error('[Integrations] Load failed:', err.message);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// GET /integrations/slack/connect
router.get('/slack/connect', requireAuth, async (req, res) => {
  if (!hasSlackEnv()) {
    return redirectWithMsg(res, 'Slack is not configured on server (missing env vars)');
  }

  const state = crypto.randomBytes(20).toString('hex');
  res.cookie(SLACK_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 10 * 60 * 1000
  });

  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    scope: getSlackScopes(),
    redirect_uri: process.env.SLACK_REDIRECT_URI,
    state
  });

  return res.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
});

// GET /integrations/slack/callback
router.get('/slack/callback', requireAuth, async (req, res) => {
  const error = String(req.query.error || '').trim();
  if (error) {
    return redirectWithMsg(res, `Slack connect cancelled: ${error}`);
  }

  if (!hasSlackEnv()) {
    return redirectWithMsg(res, 'Slack is not configured on server (missing env vars)');
  }

  const code = String(req.query.code || '').trim();
  const state = String(req.query.state || '').trim();
  const stateCookie = String(req.cookies?.[SLACK_STATE_COOKIE] || '').trim();
  res.clearCookie(SLACK_STATE_COOKIE);

  if (!code) return redirectWithMsg(res, 'Slack callback missing code');
  if (!state || !stateCookie || state !== stateCookie) {
    return redirectWithMsg(res, 'Slack callback state mismatch. Please try again.');
  }

  try {
    const response = await axios.post(
      'https://slack.com/api/oauth.v2.access',
      new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: process.env.SLACK_REDIRECT_URI
      }),
      {
        timeout: 10000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );
    const data = response?.data || null;

    if (!data?.ok) {
      const slackError = String(data?.error || 'oauth_failed');
      return redirectWithMsg(res, `Slack OAuth failed: ${slackError}`);
    }

    const workspaceName = data?.team?.name || null;
    const workspaceId = data?.team?.id || null;
    const channelId = data?.incoming_webhook?.channel_id || null;
    const channelNameRaw = data?.incoming_webhook?.channel || null;
    const channelName = channelNameRaw ? String(channelNameRaw).replace(/^#/, '') : null;
    const botToken = data?.access_token || null;

    if (!botToken) {
      return redirectWithMsg(res, 'Slack OAuth did not return bot token');
    }

    await pool.query(
      `INSERT INTO slack_integrations
         (user_id, workspace_name, workspace_id, channel_id, channel_name, bot_token, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         workspace_name = EXCLUDED.workspace_name,
         workspace_id = EXCLUDED.workspace_id,
         channel_id = EXCLUDED.channel_id,
         channel_name = EXCLUDED.channel_name,
         bot_token = EXCLUDED.bot_token,
         created_at = NOW()`,
      [req.user.id, workspaceName, workspaceId, channelId, channelName, botToken]
    );

    await auditFromRequest(req, {
      action: 'integrations.slack.connect',
      entityType: 'integration',
      entityId: `slack:${req.user.id}`,
      meta: { workspace_id: workspaceId, channel_id: channelId }
    });

    if (!channelId) {
      return redirectWithMsg(res, 'Slack connected. Channel not detected from OAuth webhook scope.');
    }
    return redirectWithMsg(res, `Slack connected: ${workspaceName || 'workspace'} / #${channelName || channelId}`);
  } catch (err) {
    console.error('[Integrations] Slack callback failed:', err.message);
    return redirectWithMsg(res, `Slack callback failed: ${err.message}`);
  }
});

// POST /integrations/slack/disconnect
router.post('/slack/disconnect', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM slack_integrations WHERE user_id = $1', [req.user.id]);
    await auditFromRequest(req, {
      action: 'integrations.slack.disconnect',
      entityType: 'integration',
      entityId: `slack:${req.user.id}`
    });
    return redirectWithMsg(res, 'Slack integration disconnected');
  } catch (err) {
    console.error('[Integrations] Slack disconnect failed:', err.message);
    return redirectWithMsg(res, `Slack disconnect failed: ${err.message}`);
  }
});

// POST /integrations/slack/test
router.post('/slack/test', requireAuth, async (req, res) => {
  try {
    const { rows: [integration] } = await pool.query(
      `SELECT workspace_name, channel_id, channel_name, bot_token
       FROM slack_integrations
       WHERE user_id = $1
       LIMIT 1`,
      [req.user.id]
    );

    if (!integration) return redirectWithMsg(res, 'Slack is not connected');
    if (!integration.bot_token || !integration.channel_id) {
      return redirectWithMsg(res, 'Slack integration has no default channel');
    }

    const payload = {
      channel: integration.channel_id,
      text: 'MetaWatch test alert',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*MetaWatch test message*\\nSlack integration is active.'
          }
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Workspace: ${integration.workspace_name || 'unknown'}`
            }
          ]
        }
      ]
    };

    const response = await axios.post('https://slack.com/api/chat.postMessage', payload, {
      timeout: 10000,
      headers: {
        'Authorization': `Bearer ${integration.bot_token}`,
        'Content-Type': 'application/json'
      }
    });
    const data = response?.data || null;
    if (!data?.ok) {
      const slackError = String(data?.error || 'post_failed');
      return redirectWithMsg(res, `Slack test failed: ${slackError}`);
    }

    await auditFromRequest(req, {
      action: 'integrations.slack.test',
      entityType: 'integration',
      entityId: `slack:${req.user.id}`
    });
    return redirectWithMsg(res, `Slack test sent to #${integration.channel_name || integration.channel_id}`);
  } catch (err) {
    console.error('[Integrations] Slack test failed:', err.message);
    return redirectWithMsg(res, `Slack test failed: ${err.message}`);
  }
});

// POST /integrations/pagerduty/connect
router.post('/pagerduty/connect', requireAuth, async (req, res) => {
  const integrationKey = String(req.body.integration_key || '').trim();
  const serviceName = String(req.body.service_name || '').trim();

  if (!integrationKey) return redirectWithMsg(res, 'PagerDuty integration key is required');
  if (!serviceName) return redirectWithMsg(res, 'PagerDuty service name is required');

  try {
    await pool.query(
      `INSERT INTO pagerduty_integrations (user_id, integration_key, service_name, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         integration_key = EXCLUDED.integration_key,
         service_name = EXCLUDED.service_name,
         created_at = NOW()`,
      [req.user.id, integrationKey, serviceName]
    );

    await auditFromRequest(req, {
      action: 'integrations.pagerduty.connect',
      entityType: 'integration',
      entityId: `pagerduty:${req.user.id}`,
      meta: { service_name: serviceName }
    });
    return redirectWithMsg(res, `PagerDuty connected: ${serviceName}`);
  } catch (err) {
    console.error('[Integrations] PagerDuty connect failed:', err.message);
    return redirectWithMsg(res, `PagerDuty connect failed: ${err.message}`);
  }
});

// POST /integrations/pagerduty/disconnect
router.post('/pagerduty/disconnect', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM pagerduty_integrations WHERE user_id = $1', [req.user.id]);
    await auditFromRequest(req, {
      action: 'integrations.pagerduty.disconnect',
      entityType: 'integration',
      entityId: `pagerduty:${req.user.id}`
    });
    return redirectWithMsg(res, 'PagerDuty integration disconnected');
  } catch (err) {
    console.error('[Integrations] PagerDuty disconnect failed:', err.message);
    return redirectWithMsg(res, `PagerDuty disconnect failed: ${err.message}`);
  }
});

// POST /integrations/pagerduty/test
router.post('/pagerduty/test', requireAuth, async (req, res) => {
  try {
    const { rows: [integration] } = await pool.query(
      `SELECT integration_key, service_name
       FROM pagerduty_integrations
       WHERE user_id = $1
       LIMIT 1`,
      [req.user.id]
    );
    if (!integration) return redirectWithMsg(res, 'PagerDuty is not connected');

    const payload = {
      routing_key: integration.integration_key,
      event_action: 'trigger',
      dedup_key: `metawatch-test-${req.user.id}-${Date.now()}`,
      payload: {
        summary: `MetaWatch test incident for ${integration.service_name}`,
        severity: 'critical',
        source: 'MetaWatch',
        custom_details: {
          type: 'test',
          user_id: req.user.id,
          email: req.user.email,
          timestamp: new Date().toISOString()
        }
      }
    };

    const response = await axios.post('https://events.pagerduty.com/v2/enqueue', payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    const data = response?.data || null;
    const accepted = data?.status === 'success';
    if (!accepted) {
      const pdError = String(data?.message || response.statusText || 'request_failed');
      return redirectWithMsg(res, `PagerDuty test failed: ${pdError}`);
    }

    await auditFromRequest(req, {
      action: 'integrations.pagerduty.test',
      entityType: 'integration',
      entityId: `pagerduty:${req.user.id}`,
      meta: { service_name: integration.service_name }
    });
    return redirectWithMsg(res, `PagerDuty test triggered for ${integration.service_name}`);
  } catch (err) {
    console.error('[Integrations] PagerDuty test failed:', err.message);
    return redirectWithMsg(res, `PagerDuty test failed: ${err.message}`);
  }
});

module.exports = router;
