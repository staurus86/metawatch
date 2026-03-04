const express = require('express');
const router = express.Router();
const Diff = require('diff');
const multer = require('multer');
const XLSX = require('xlsx');
const { XMLParser } = require('fast-xml-parser');
const axios = require('axios');
const pool = require('../db');
const { checkUrl } = require('../checker');
const { detectAccessChallenge } = require('../access-challenge');
const { sendPagerDuty } = require('../notifier');
const { scheduleUrl, unscheduleUrl, triggerUrlCheckNow } = require('../scheduler');
const { requireAuth } = require('../auth');
const { checkSemaphore, domainRateLimit } = require('../queue');
const { scanEmitter, isScanRunning, setScanRunning } = require('../scan-events');
const { assertSafeOutboundUrl } = require('../net-safety');
const { auditFromRequest } = require('../audit');
const {
  getUserUsage,
  isLimitReached,
  isIntervalAllowed,
  minIntervalForPlan,
  limitLabel
} = require('../plans');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const MAX_BULK_IMPORT_URLS = 500;
const BULK_PREVIEW_ROW_LIMIT = 1000;
const SLACK_CHANNEL_CACHE_TTL_MS = Math.max(15 * 1000, parseInt(process.env.SLACK_CHANNEL_CACHE_TTL_MS || '60000', 10) || 60000);
const slackChannelsCache = new Map();
const FIELD_NOTIFICATION_OVERRIDE_KEYS = [
  'title',
  'description',
  'h1',
  'page_content',
  'response_code',
  'noindex',
  'redirect',
  'canonical',
  'robots',
  'hreflang',
  'og',
  'custom_text',
  'ssl',
  'response_time'
];
const ALLOWED_FIELD_NOTIFICATION_MODES = new Set([
  'default',
  'silent',
  'email_only',
  'telegram_only',
  'slack_only',
  'critical_only'
]);
const PAGERDUTY_THRESHOLDS = new Set(['critical_only', 'warning_plus', 'all']);

const ALERT_FIELD_TO_SNAPSHOT_COLUMNS = {
  Title: ['title'],
  'Meta Description': ['description'],
  H1: ['h1'],
  'Page Content': ['body_text_hash', 'normalized_body_hash'],
  'Response Code': ['status_code'],
  'Soft 404': ['soft_404'],
  noindex: ['noindex'],
  'Redirect URL': ['redirect_url'],
  'Redirect Chain': ['redirect_chain'],
  Canonical: ['canonical'],
  'Canonical Issue': ['canonical_issue'],
  'Indexability Conflict': ['indexability_conflict'],
  'robots.txt': ['robots_txt_hash', 'raw_robots_txt'],
  'Robots Blocking': ['robots_blocked'],
  hreflang: ['hreflang'],
  'OG Title': ['og_title'],
  'OG Description': ['og_description'],
  'OG Image': ['og_image'],
  'Custom Text': ['custom_text_found'],
  'SSL Certificate': ['ssl_expires_at']
};

function parseFieldNotificationConfigFromBody(body) {
  const config = {};
  for (const key of FIELD_NOTIFICATION_OVERRIDE_KEYS) {
    const mode = String(body?.[`nf_${key}`] || 'default').trim().toLowerCase();
    if (!ALLOWED_FIELD_NOTIFICATION_MODES.has(mode)) continue;
    if (mode !== 'default') config[key] = mode;
  }
  return config;
}

function normalizePagerDutyThreshold(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return PAGERDUTY_THRESHOLDS.has(normalized) ? normalized : 'critical_only';
}

function normalizeRenderMode(value) {
  return String(value || '').trim().toLowerCase() === 'headless' ? 'headless' : 'static';
}

function canUseHeadless(userPlan) {
  // Puppeteer is bundled — headless available for all plans
  return true;
}

function normalizeImportUrl(value) {
  const url = String(value || '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

function normalizeSitemapPriority(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

async function collectBulkRecords({ source, urlsText, sitemapUrl, column, file }) {
  if (source === 'text') {
    return (urlsText || '').split('\n')
      .map(u => normalizeImportUrl(u))
      .filter(Boolean)
      .map(url => ({ url, priority: null }));
  }

  if (source === 'file' && file) {
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    const colIdx = parseInt(column || '0', 10);
    return rows
      .map(row => normalizeImportUrl(row[colIdx]))
      .filter(Boolean)
      .map(url => ({ url, priority: null }));
  }

  if (source === 'sitemap' && sitemapUrl) {
    return await parseSitemap(sitemapUrl);
  }

  return [];
}

async function getProjectsForUser(userId) {
  if (!userId) return [];
  const { rows } = await pool.query(
    'SELECT id, name FROM projects WHERE user_id = $1 ORDER BY name ASC',
    [userId]
  );
  return rows;
}

async function resolveProjectIdForUser(rawProjectId, userId) {
  const id = parseInt(String(rawProjectId || ''), 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const { rows: [project] } = await pool.query(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return project?.id || null;
}

async function getPagerDutyIntegrationKeyForUser(userId) {
  if (!userId) return null;
  const { rows: [row] } = await pool.query(
    `SELECT integration_key
     FROM pagerduty_integrations
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  return row?.integration_key || null;
}

function normalizeSlackChannelOption(channel, source = 'api') {
  const id = String(channel?.id || channel?.channel_id || '').trim();
  if (!id) return null;
  const rawName = String(channel?.name || channel?.channel_name || '').trim().replace(/^#/, '');
  return {
    id,
    name: rawName || null,
    label: rawName ? `#${rawName}` : id,
    source
  };
}

function mergeSlackChannelOptions(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const raw of Array.isArray(list) ? list : []) {
      const normalized = normalizeSlackChannelOption(raw, raw?.source);
      if (!normalized) continue;
      const existing = byId.get(normalized.id);
      if (!existing || (existing.source !== 'api' && normalized.source === 'api')) {
        byId.set(normalized.id, normalized);
      }
    }
  }
  return [...byId.values()].sort((a, b) => {
    const left = String(a.name || a.id).toLowerCase();
    const right = String(b.name || b.id).toLowerCase();
    return left.localeCompare(right);
  });
}

async function loadSlackChannelsFromApi(botToken) {
  if (!botToken) return { channels: [], error: null };

  try {
    const { data } = await axios.get('https://slack.com/api/conversations.list', {
      timeout: 10000,
      params: {
        limit: 200,
        types: 'public_channel,private_channel',
        exclude_archived: true
      },
      headers: {
        Authorization: `Bearer ${botToken}`
      }
    });

    if (!data?.ok) {
      return { channels: [], error: String(data?.error || 'channels_list_failed') };
    }

    const channels = (Array.isArray(data.channels) ? data.channels : [])
      .map((c) => normalizeSlackChannelOption(c, 'api'))
      .filter(Boolean);
    return { channels, error: null };
  } catch (err) {
    return { channels: [], error: String(err?.message || 'channels_list_failed') };
  }
}

async function getSlackChannelSelectorData(userId) {
  if (!userId) {
    return { connected: false, channels: [], defaultChannelId: '', error: null };
  }

  const cacheKey = String(userId);
  const now = Date.now();
  const cached = slackChannelsCache.get(cacheKey);
  if (cached && (now - cached.ts) < SLACK_CHANNEL_CACHE_TTL_MS) {
    return cached.value;
  }

  const { rows: [integration] } = await pool.query(
    `SELECT channel_id, channel_name, bot_token
     FROM slack_integrations
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );

  if (!integration) {
    const value = { connected: false, channels: [], defaultChannelId: '', error: null };
    slackChannelsCache.set(cacheKey, { ts: now, value });
    return value;
  }

  const defaultChannel = normalizeSlackChannelOption(
    { id: integration.channel_id, name: integration.channel_name },
    'default'
  );
  const { channels: apiChannels, error } = await loadSlackChannelsFromApi(integration.bot_token);
  const channels = mergeSlackChannelOptions(defaultChannel ? [defaultChannel] : [], apiChannels);

  const value = {
    connected: true,
    channels,
    defaultChannelId: defaultChannel?.id || '',
    error
  };
  slackChannelsCache.set(cacheKey, { ts: now, value });
  return value;
}

async function resolvePagerDutyForAcceptedFields({ userId, urlId, url, fields }) {
  if (!userId || !urlId || !url) return;
  const uniqueFields = [...new Set((fields || []).map(f => String(f || '').trim()).filter(Boolean))];
  if (uniqueFields.length === 0) return;
  const integrationKey = await getPagerDutyIntegrationKeyForUser(userId);
  if (!integrationKey) return;

  for (const field of uniqueFields) {
    try {
      await sendPagerDuty({
        integrationKey,
        action: 'resolve',
        alert: {
          urlId,
          url,
          field,
          severity: 'critical',
          oldValue: '',
          newValue: '',
          timestamp: new Date()
        }
      });
    } catch {
      // non-critical
    }
  }
}

// Return SQL + params to fetch a URL with ownership check
function ownedUrlQuery(urlId, req) {
  const isAdmin = req.user?.role === 'admin';
  return {
    query: isAdmin
      ? 'SELECT * FROM monitored_urls WHERE id = $1'
      : 'SELECT * FROM monitored_urls WHERE id = $1 AND user_id = $2',
    params: isAdmin ? [urlId] : [urlId, req.user.id]
  };
}

// GET /urls/add
router.get('/add', requireAuth, async (req, res) => {
  const projects = await getProjectsForUser(req.user.id).catch(() => []);
  const selectedProjectId = await resolveProjectIdForUser(req.query.project_id, req.user.id).catch(() => null);
  const headlessAvailable = canUseHeadless(req.userPlan);
  const currentPlanName = String(req.userPlan?.name || 'Free');
  const slackSelector = await getSlackChannelSelectorData(req.user.id).catch(() => ({
    connected: false,
    channels: [],
    defaultChannelId: '',
    error: null
  }));
  res.render('add-url', {
    title: 'Add URL',
    error: null,
    projects,
    headlessAvailable,
    currentPlanName,
    slackChannels: slackSelector.channels,
    slackConnected: slackSelector.connected,
    slackChannelsError: slackSelector.error,
    slackDefaultChannelId: slackSelector.defaultChannelId,
    values: {
      project_id: selectedProjectId ? String(selectedProjectId) : '',
      email: req.user.default_alert_email || '',
      telegram_bot_token: req.user.default_telegram_token || '',
      telegram_chat_id: req.user.default_telegram_chat_id || '',
      webhook_url: req.user.default_webhook_url || '',
      discord_webhook_url: '',
      send_to_slack: false,
      slack_channel_id: '',
      slack_channel_custom: '',
      pagerduty_threshold: 'critical_only',
      render_mode: 'static',
      check_interval_minutes: '60',
      monitor_title: true,
      monitor_description: true,
      monitor_h1: true,
      monitor_body: true,
      monitor_status_code: true,
      monitor_noindex: true,
      monitor_redirect: true,
      monitor_canonical: true,
      monitor_robots: true,
      monitor_hreflang: false,
      monitor_og: false
    }
  });
});

// POST /urls/add
router.post('/add', requireAuth, async (req, res) => {
  const {
    url, email, check_interval_minutes,
    monitor_title, monitor_description, monitor_h1, monitor_body,
    monitor_status_code, monitor_noindex, monitor_redirect,
    monitor_canonical, monitor_robots, monitor_hreflang, monitor_og,
    monitor_ssl,
    user_agent, ignore_numbers, custom_text,
    render_mode,
    telegram_bot_token, telegram_chat_id, webhook_url, discord_webhook_url,
    send_to_slack, slack_channel_id, pagerduty_threshold,
    project_id,
    tags, notes, response_time_threshold_ms,
    maintenance_cron, maintenance_duration_minutes
  } = req.body;

  const renderError = async (msg, { status = 200, upgradePrompt = null } = {}) => {
    const projects = await getProjectsForUser(req.user.id).catch(() => []);
    const slackSelector = await getSlackChannelSelectorData(req.user.id).catch(() => ({
      connected: false,
      channels: [],
      defaultChannelId: '',
      error: null
    }));
    return res.status(status).render('add-url', {
      title: 'Add URL',
      error: msg,
      projects,
      headlessAvailable: canUseHeadless(req.userPlan),
      currentPlanName: String(req.userPlan?.name || 'Free'),
      slackChannels: slackSelector.channels,
      slackConnected: slackSelector.connected,
      slackChannelsError: slackSelector.error,
      slackDefaultChannelId: slackSelector.defaultChannelId,
      upgradePrompt,
      values: req.body
    });
  };

  if (!url || !url.trim()) return await renderError('URL is required.');
  const trimmedUrl = url.trim();
  if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
    return await renderError('URL must start with http:// or https://');
  }
  let safeUrl;
  try {
    safeUrl = await assertSafeOutboundUrl(trimmedUrl);
  } catch (e) {
    return await renderError(`URL is not allowed: ${e.message}`);
  }

  const interval = parseInt(check_interval_minutes, 10);
  if (isNaN(interval) || interval < 1) return await renderError('Invalid check interval.');
  const currentPlan = req.userPlan || { name: 'Free', max_urls: 10, check_interval_min: 60 };
  const usage = await getUserUsage(req.user.id).catch(() => ({ urls: 0, uptimeMonitors: 0, projects: 0 }));
  if (isLimitReached(usage.urls, currentPlan.max_urls)) {
    return await renderError('URL limit reached for your current plan.', {
      status: 402,
      upgradePrompt: {
        title: 'Upgrade your plan',
        message: `${currentPlan.name} plan allows up to ${limitLabel(currentPlan.max_urls)} URL(s). You currently have ${usage.urls}.`
      }
    });
  }
  if (!isIntervalAllowed(currentPlan, interval)) {
    return await renderError(`Your current plan requires interval >= ${minIntervalForPlan(currentPlan)} minutes.`, {
      status: 402,
      upgradePrompt: {
        title: 'Upgrade your plan',
        message: `${currentPlan.name} plan minimum interval is ${minIntervalForPlan(currentPlan)} minutes.`
      }
    });
  }
  const desiredRenderMode = normalizeRenderMode(render_mode);
  if (desiredRenderMode === 'headless' && !canUseHeadless(currentPlan)) {
    return await renderError('Headless rendering is available on Pro and Agency plans.', {
      status: 402,
      upgradePrompt: {
        title: 'Upgrade to Pro',
        message: `${currentPlan.name} plan does not include JavaScript rendering. Upgrade to Pro or Agency to enable headless checks.`
      }
    });
  }
  const safeProjectId = await resolveProjectIdForUser(project_id, req.user.id).catch(() => null);
  const rtThreshold = parseInt(response_time_threshold_ms, 10) || null;
  const fieldsNotificationConfig = parseFieldNotificationConfigFromBody(req.body);
  const pdThreshold = normalizePagerDutyThreshold(pagerduty_threshold);
  const slackOverrideInput = String(slack_channel_id || '').trim();
  const slackCustomInput = String(req.body.slack_channel_custom || '').trim();
  const normalizedSlackChannelId = slackOverrideInput === '__custom__'
    ? (slackCustomInput || null)
    : (slackOverrideInput || null);
  const maintenanceDuration = parseInt(maintenance_duration_minutes, 10);
  const safeMaintenanceDuration = Number.isFinite(maintenanceDuration) && maintenanceDuration > 0
    ? maintenanceDuration
    : null;

  try {
    const { rows: [newUrl] } = await pool.query(
      `INSERT INTO monitored_urls
         (url, email, check_interval_minutes, user_id, project_id,
          monitor_title, monitor_description, monitor_h1, monitor_body,
          monitor_status_code, monitor_noindex, monitor_redirect,
          monitor_canonical, monitor_robots, monitor_hreflang, monitor_og, monitor_ssl,
          user_agent, ignore_numbers, custom_text, render_mode,
          telegram_bot_token, telegram_chat_id, webhook_url, discord_webhook_url,
          send_to_slack, slack_channel_id, pagerduty_threshold,
          fields_notification_config, tags, notes,
          response_time_threshold_ms, maintenance_cron, maintenance_duration_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
        RETURNING *`,
      [
        safeUrl,
        email?.trim() || req.user.default_alert_email || null,
        interval || 60,
        req.user.id,
        safeProjectId,
        !!monitor_title, !!monitor_description, !!monitor_h1, !!monitor_body,
        !!monitor_status_code, !!monitor_noindex, !!monitor_redirect,
        !!monitor_canonical, !!monitor_robots, !!monitor_hreflang, !!monitor_og, !!monitor_ssl,
        user_agent?.trim() || null,
        !!ignore_numbers,
        custom_text?.trim() || null,
        desiredRenderMode,
        telegram_bot_token?.trim() || req.user.default_telegram_token || null,
        telegram_chat_id?.trim() || req.user.default_telegram_chat_id || null,
        webhook_url?.trim() || req.user.default_webhook_url || null,
        discord_webhook_url?.trim() || null,
        !!send_to_slack,
        normalizedSlackChannelId,
        pdThreshold,
        JSON.stringify(fieldsNotificationConfig),
        normalizeTags(tags),
        notes?.trim() || '',
        rtThreshold,
        maintenance_cron?.trim() || null,
        safeMaintenanceDuration
      ]
    );

    scheduleUrl(newUrl);
    triggerUrlCheckNow(newUrl, 'create').catch(err =>
      console.error(`Initial check failed for URL #${newUrl.id}: ${err.message}`)
    );
    await auditFromRequest(req, {
      action: 'url.create',
      entityType: 'monitored_url',
      entityId: newUrl.id,
      meta: { url: newUrl.url, interval: newUrl.check_interval_minutes }
    });

    res.redirect(`/urls/${newUrl.id}`);
  } catch (err) {
    console.error(err);
    await renderError(err.message);
  }
});

// GET /urls/bulk
router.get('/bulk', requireAuth, async (req, res) => {
  const projects = await getProjectsForUser(req.user.id).catch(() => []);
  const selectedProjectId = await resolveProjectIdForUser(req.query.project_id, req.user.id).catch(() => null);
  res.render('bulk-import', {
    title: 'Bulk Import',
    error: null,
    preview: null,
    projects,
    selectedProjectId: selectedProjectId ? String(selectedProjectId) : '',
    upgradePrompt: null
  });
});

// POST /urls/bulk
router.post('/bulk', requireAuth, upload.single('file'), async (req, res) => {
  const { source, urls_text, sitemap_url, column } = req.body;
  const projects = await getProjectsForUser(req.user.id).catch(() => []);
  const selectedProjectId = await resolveProjectIdForUser(req.body.project_id, req.user.id).catch(() => null);
  const renderBulk = ({ error, preview, status = 200, upgradePrompt = null }) => res.status(status).render('bulk-import', {
    title: 'Bulk Import',
    error: error || null,
    preview: preview || null,
    projects,
    selectedProjectId: selectedProjectId ? String(selectedProjectId) : '',
    upgradePrompt
  });

  try {
    if (req.body.confirm === '1') {
      const interval = parseInt(req.body.check_interval_minutes || '60', 10);
      if (isNaN(interval) || interval < 1) {
        return renderBulk({ error: 'Invalid check interval.', preview: null });
      }
      const currentPlan = req.userPlan || { name: 'Free', max_urls: 10, check_interval_min: 60 };
      if (!isIntervalAllowed(currentPlan, interval)) {
        return renderBulk({
          status: 402,
          error: `Your current plan requires interval >= ${minIntervalForPlan(currentPlan)} minutes.`,
          preview: null,
          upgradePrompt: {
            title: 'Upgrade your plan',
            message: `${currentPlan.name} plan minimum interval is ${minIntervalForPlan(currentPlan)} minutes.`
          }
        });
      }

      let importableUrls = [];
      try {
        importableUrls = JSON.parse(req.body.preview_importable_json || '[]');
      } catch {
        return renderBulk({ error: 'Invalid import payload. Please generate preview again.', preview: null });
      }

      if (!Array.isArray(importableUrls)) importableUrls = [];
      importableUrls = [...new Set(importableUrls.map(normalizeImportUrl).filter(Boolean))].slice(0, MAX_BULK_IMPORT_URLS);

      const selectedRaw = req.body.selected_urls;
      const selectedList = Array.isArray(selectedRaw) ? selectedRaw : (selectedRaw ? [selectedRaw] : []);
      const selectedSet = new Set(selectedList.map(normalizeImportUrl).filter(Boolean));
      const selectedUrls = importableUrls.filter(u => selectedSet.has(u));

      if (selectedUrls.length === 0) {
        return renderBulk({ error: 'No URLs selected for import.', preview: null });
      }

      const usage = await getUserUsage(req.user.id).catch(() => ({ urls: 0, uptimeMonitors: 0, projects: 0 }));
      const planUrlLimit = parseInt(currentPlan.max_urls, 10);
      const hasFiniteLimit = Number.isFinite(planUrlLimit) && planUrlLimit >= 0;
      if (hasFiniteLimit && usage.urls + selectedUrls.length > planUrlLimit) {
        return renderBulk({
          status: 402,
          error: 'Bulk import exceeds your URL limit.',
          preview: null,
          upgradePrompt: {
            title: 'Upgrade your plan',
            message: `${currentPlan.name} plan allows up to ${limitLabel(currentPlan.max_urls)} URL(s). Current usage: ${usage.urls}. Selected: ${selectedUrls.length}.`
          }
        });
      }

      const importTag = `import-${new Date().toISOString().slice(0, 10)}`;
      let imported = 0;

      for (const u of selectedUrls) {
        try {
          const safeImportUrl = await assertSafeOutboundUrl(u).catch(() => null);
          if (!safeImportUrl) {
            continue;
          }
          const { rows: [newRec] } = await pool.query(
            `INSERT INTO monitored_urls
               (url, check_interval_minutes, user_id, project_id, tags,
                monitor_title, monitor_description, monitor_h1, monitor_body,
                monitor_status_code, monitor_noindex, monitor_redirect,
                monitor_canonical, monitor_robots)
             VALUES ($1,$2,$3,$4,$5,true,true,true,true,true,true,true,true,true)
             RETURNING *`,
            [safeImportUrl, interval, req.user.id, selectedProjectId, importTag]
          );
          scheduleUrl(newRec);
          triggerUrlCheckNow(newRec, 'bulk_import').catch(() => {});
          imported++;
        } catch (e) {
          console.error(`Bulk import error for ${u}: ${e.message}`);
        }
      }

      const skipped = importableUrls.length - imported;
      return res.redirect(`/?imported=${imported}&skipped=${skipped}&import_tag=${encodeURIComponent(importTag)}`);
    }

    const rawRecords = await collectBulkRecords({
      source,
      urlsText: urls_text,
      sitemapUrl: sitemap_url,
      column,
      file: req.file
    });

    if (rawRecords.length === 0) {
      return renderBulk({ error: 'No valid URLs found.', preview: null });
    }

    const dedupMap = new Map();
    for (const record of rawRecords) {
      const url = normalizeImportUrl(record.url);
      if (!url) continue;
      const priority = normalizeSitemapPriority(record.priority);
      const prev = dedupMap.get(url);
      if (!prev) {
        dedupMap.set(url, { url, priority });
      } else {
        const prevPriority = prev.priority ?? -1;
        const newPriority = priority ?? -1;
        if (newPriority > prevPriority) prev.priority = priority;
      }
    }

    const uniqueRecords = [...dedupMap.values()];
    const { rows: existingRows } = await pool.query(
      'SELECT url FROM monitored_urls WHERE user_id = $1',
      [req.user.id]
    );
    const existingSet = new Set(existingRows.map(r => r.url));

    const previewRows = uniqueRecords.map(r => ({
      url: r.url,
      priority: r.priority,
      isExisting: existingSet.has(r.url),
      willImport: false,
      overLimit: false
    }));

    previewRows.sort((a, b) => {
      if (a.isExisting !== b.isExisting) return a.isExisting ? 1 : -1;
      const pa = a.priority ?? -1;
      const pb = b.priority ?? -1;
      if (pa !== pb) return pb - pa;
      return a.url.localeCompare(b.url);
    });

    let importableCount = 0;
    for (const row of previewRows) {
      if (row.isExisting) continue;
      if (importableCount < MAX_BULK_IMPORT_URLS) {
        row.willImport = true;
        importableCount++;
      } else {
        row.overLimit = true;
      }
    }

    const importableUrls = previewRows.filter(r => r.willImport).map(r => r.url);
    const existingCount = previewRows.filter(r => r.isExisting).length;
    const overLimitCount = previewRows.filter(r => r.overLimit).length;

    renderBulk({
      error: null,
      preview: {
        all: rawRecords.length,
        uniqueCount: uniqueRecords.length,
        importableCount,
        existingCount,
        overLimitCount,
        rows: previewRows.slice(0, BULK_PREVIEW_ROW_LIMIT),
        rowsTruncated: previewRows.length > BULK_PREVIEW_ROW_LIMIT ? (previewRows.length - BULK_PREVIEW_ROW_LIMIT) : 0,
        importableUrls,
        source,
        urls_text,
        sitemap_url,
        project_id: selectedProjectId ? String(selectedProjectId) : ''
      }
    });
  } catch (err) {
    console.error(err);
    renderBulk({ error: err.message, preview: null });
  }
});

async function parseSitemap(url, depth = 0) {
  if (depth > 3) return [];
  const parser = new XMLParser({ ignoreAttributes: false });
  const safeSitemapUrl = await assertSafeOutboundUrl(url);

  const response = await axios.get(safeSitemapUrl, {
    timeout: 15000,
    headers: { 'User-Agent': 'MetaWatch/2.0 Sitemap-Parser' },
    validateStatus: () => true,
    responseType: 'text'
  });

  if (response.status !== 200) return [];

  const parsed = parser.parse(response.data);
  const records = [];

  // Sitemap index
  const sitemapIndex = parsed.sitemapindex;
  if (sitemapIndex?.sitemap) {
    const sitemaps = Array.isArray(sitemapIndex.sitemap)
      ? sitemapIndex.sitemap : [sitemapIndex.sitemap];
    for (const sm of sitemaps.slice(0, 20)) {
      const loc = sm.loc || sm['#text'];
      if (loc) {
        const nestedUrl = await assertSafeOutboundUrl(String(loc).trim()).catch(() => null);
        if (!nestedUrl) continue;
        const nested = await parseSitemap(nestedUrl, depth + 1);
        records.push(...nested);
      }
    }
    return records;
  }

  // Regular sitemap
  const urlSet = parsed.urlset;
  if (urlSet?.url) {
    const urlEntries = Array.isArray(urlSet.url) ? urlSet.url : [urlSet.url];
    for (const entry of urlEntries) {
      const loc = entry.loc || entry['#text'];
      if (loc) {
        records.push({
          url: String(loc).trim(),
          priority: normalizeSitemapPriority(entry.priority)
        });
      }
    }
  }

  return records;
}

// POST /urls/scan-all
router.post('/scan-all', requireAuth, async (req, res) => {
  if (isScanRunning()) {
    return res.json({ ok: false, error: 'Scan already running' });
  }

  const isAdmin = req.user.role === 'admin';
  const { rows } = await pool.query(
    isAdmin
      ? 'SELECT id, url FROM monitored_urls WHERE is_active = true ORDER BY id'
      : 'SELECT id, url FROM monitored_urls WHERE is_active = true AND user_id = $1 ORDER BY id',
    isAdmin ? [] : [req.user.id]
  );
  const total = rows.length;

  res.json({ ok: true, total });

  setScanRunning(true);
  let done = 0;

  (async () => {
    for (const urlRow of rows) {
      try {
        await checkSemaphore.wrap(async () => {
          await domainRateLimit(urlRow.url);
          await checkUrl(urlRow.id);
        });
        done++;
        scanEmitter.emit('scan-progress', { type: 'progress', total, done, url: urlRow.url, status: 'ok' });
      } catch (err) {
        done++;
        scanEmitter.emit('scan-progress', { type: 'progress', total, done, url: urlRow.url, status: 'error' });
      }
    }
    scanEmitter.emit('scan-done', { type: 'done', total, done });
    setScanRunning(false);
  })();
});

// GET /urls/:id/edit
router.get('/:id/edit', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

  try {
    const { query, params } = ownedUrlQuery(urlId, req);
    const { rows: [urlRecord] } = await pool.query(query, params);
    if (!urlRecord) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });
    const projects = await getProjectsForUser(req.user.id).catch(() => []);
    const slackSelector = await getSlackChannelSelectorData(req.user.id).catch(() => ({
      connected: false,
      channels: [],
      defaultChannelId: '',
      error: null
    }));

    res.render('edit-url', {
      title: 'Edit URL',
      error: null,
      urlRecord,
      projects,
      slackChannels: slackSelector.channels,
      slackConnected: slackSelector.connected,
      slackChannelsError: slackSelector.error,
      slackDefaultChannelId: slackSelector.defaultChannelId,
      cloned: !!req.query.cloned,
      upgradePrompt: null,
      headlessAvailable: canUseHeadless(req.userPlan),
      currentPlanName: String(req.userPlan?.name || 'Free')
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// POST /urls/:id/edit
router.post('/:id/edit', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

  const {
    email, check_interval_minutes,
    monitor_title, monitor_description, monitor_h1, monitor_body,
    monitor_status_code, monitor_noindex, monitor_redirect,
    monitor_canonical, monitor_robots, monitor_hreflang, monitor_og, monitor_ssl,
    user_agent, ignore_numbers, custom_text, render_mode,
    telegram_bot_token, telegram_chat_id, webhook_url, discord_webhook_url,
    send_to_slack, slack_channel_id, pagerduty_threshold,
    project_id,
    silenced_until, tags, notes,
    maintenance_cron, maintenance_duration_minutes
  } = req.body;

  const interval = parseInt(check_interval_minutes, 10);
  if (isNaN(interval) || interval < 1) {
    const { query: q, params: p } = ownedUrlQuery(urlId, req);
    const { rows: [urlRecord] } = await pool.query(q, p);
    const projects = await getProjectsForUser(req.user.id).catch(() => []);
    const slackSelector = await getSlackChannelSelectorData(req.user.id).catch(() => ({
      connected: false,
      channels: [],
      defaultChannelId: '',
      error: null
    }));
    return res.render('edit-url', {
      title: 'Edit URL',
      error: 'Invalid check interval.',
      urlRecord,
      projects,
      slackChannels: slackSelector.channels,
      slackConnected: slackSelector.connected,
      slackChannelsError: slackSelector.error,
      slackDefaultChannelId: slackSelector.defaultChannelId,
      upgradePrompt: null,
      headlessAvailable: canUseHeadless(req.userPlan),
      currentPlanName: String(req.userPlan?.name || 'Free')
    });
  }

  const maintenanceDuration = parseInt(maintenance_duration_minutes, 10);
  const safeMaintenanceDuration = Number.isFinite(maintenanceDuration) && maintenanceDuration > 0
    ? maintenanceDuration
    : null;
  const fieldsNotificationConfig = parseFieldNotificationConfigFromBody(req.body);
  const pdThreshold = normalizePagerDutyThreshold(pagerduty_threshold);
  const slackOverrideInput = String(slack_channel_id || '').trim();
  const slackCustomInput = String(req.body.slack_channel_custom || '').trim();
  const normalizedSlackChannelId = slackOverrideInput === '__custom__'
    ? (slackCustomInput || null)
    : (slackOverrideInput || null);
  const safeProjectId = await resolveProjectIdForUser(project_id, req.user.id).catch(() => null);
  const currentPlan = req.userPlan || { name: 'Free', check_interval_min: 60 };
  const loadSlackSelector = () => getSlackChannelSelectorData(req.user.id).catch(() => ({
    connected: false,
    channels: [],
    defaultChannelId: '',
    error: null
  }));
  const { query: existingQ, params: existingP } = ownedUrlQuery(urlId, req);
  const { rows: [existingRecord] } = await pool.query(existingQ, existingP);
  if (!existingRecord) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });
  const requestedRenderMode = normalizeRenderMode(render_mode || existingRecord.render_mode);
  if (!isIntervalAllowed(currentPlan, interval)) {
    const projects = await getProjectsForUser(req.user.id).catch(() => []);
    const slackSelector = await loadSlackSelector();
    return res.status(402).render('edit-url', {
      title: 'Edit URL',
      error: `Your current plan requires interval >= ${minIntervalForPlan(currentPlan)} minutes.`,
      urlRecord: existingRecord,
      projects,
      slackChannels: slackSelector.channels,
      slackConnected: slackSelector.connected,
      slackChannelsError: slackSelector.error,
      slackDefaultChannelId: slackSelector.defaultChannelId,
      upgradePrompt: {
        title: 'Upgrade your plan',
        message: `${currentPlan.name} plan minimum interval is ${minIntervalForPlan(currentPlan)} minutes.`
      },
      headlessAvailable: canUseHeadless(req.userPlan),
      currentPlanName: String(req.userPlan?.name || 'Free')
    });
  }
  const existingRenderMode = normalizeRenderMode(existingRecord.render_mode);
  if (requestedRenderMode === 'headless' && !canUseHeadless(currentPlan) && existingRenderMode !== 'headless') {
    const projects = await getProjectsForUser(req.user.id).catch(() => []);
    const slackSelector = await loadSlackSelector();
    return res.status(402).render('edit-url', {
      title: 'Edit URL',
      error: 'Headless rendering is available on Pro and Agency plans.',
      urlRecord: existingRecord,
      projects,
      slackChannels: slackSelector.channels,
      slackConnected: slackSelector.connected,
      slackChannelsError: slackSelector.error,
      slackDefaultChannelId: slackSelector.defaultChannelId,
      upgradePrompt: {
        title: 'Upgrade to Pro',
        message: `${currentPlan.name} plan does not include JavaScript rendering. Upgrade to Pro or Agency to enable headless checks.`
      },
      headlessAvailable: canUseHeadless(req.userPlan),
      currentPlanName: String(req.userPlan?.name || 'Free')
    });
  }

  try {
    const { rows: [updated] } = await pool.query(
      `UPDATE monitored_urls SET
         email = $1, check_interval_minutes = $2, project_id = $3,
         monitor_title = $4, monitor_description = $5, monitor_h1 = $6, monitor_body = $7,
         monitor_status_code = $8, monitor_noindex = $9, monitor_redirect = $10,
         monitor_canonical = $11, monitor_robots = $12, monitor_hreflang = $13, monitor_og = $14,
         monitor_ssl = $15,
         user_agent = $16, ignore_numbers = $17, custom_text = $18, render_mode = $19,
         telegram_bot_token = $20, telegram_chat_id = $21, webhook_url = $22, discord_webhook_url = $23,
         fields_notification_config = $24,
         send_to_slack = $25, slack_channel_id = $26, pagerduty_threshold = $27,
         silenced_until = $28, tags = $29, notes = $30,
         maintenance_cron = $31, maintenance_duration_minutes = $32
       WHERE id = $33 ${req.user.role !== 'admin' ? 'AND user_id = $34' : ''}
       RETURNING *`,
      req.user.role !== 'admin'
        ? [
            email?.trim() || null, interval, safeProjectId,
            !!monitor_title, !!monitor_description, !!monitor_h1, !!monitor_body,
            !!monitor_status_code, !!monitor_noindex, !!monitor_redirect,
            !!monitor_canonical, !!monitor_robots, !!monitor_hreflang, !!monitor_og,
            !!monitor_ssl, user_agent?.trim() || null, !!ignore_numbers,
            custom_text?.trim() || null, requestedRenderMode,
            telegram_bot_token?.trim() || null,
            telegram_chat_id?.trim() || null, webhook_url?.trim() || null, discord_webhook_url?.trim() || null,
            JSON.stringify(fieldsNotificationConfig),
            !!send_to_slack, normalizedSlackChannelId, pdThreshold,
            silenced_until?.trim() || null, normalizeTags(tags), notes?.trim() || '',
            maintenance_cron?.trim() || null, safeMaintenanceDuration,
            urlId, req.user.id
          ]
        : [
            email?.trim() || null, interval, safeProjectId,
            !!monitor_title, !!monitor_description, !!monitor_h1, !!monitor_body,
            !!monitor_status_code, !!monitor_noindex, !!monitor_redirect,
            !!monitor_canonical, !!monitor_robots, !!monitor_hreflang, !!monitor_og,
            !!monitor_ssl, user_agent?.trim() || null, !!ignore_numbers,
            custom_text?.trim() || null, requestedRenderMode,
            telegram_bot_token?.trim() || null,
            telegram_chat_id?.trim() || null, webhook_url?.trim() || null, discord_webhook_url?.trim() || null,
            JSON.stringify(fieldsNotificationConfig),
            !!send_to_slack, normalizedSlackChannelId, pdThreshold,
            silenced_until?.trim() || null, normalizeTags(tags), notes?.trim() || '',
            maintenance_cron?.trim() || null, safeMaintenanceDuration,
            urlId
          ]
    );

    if (!updated) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

    // Reschedule if interval changed
    scheduleUrl(updated);
    await auditFromRequest(req, {
      action: 'url.update',
      entityType: 'monitored_url',
      entityId: updated.id,
      meta: { interval: updated.check_interval_minutes, active: updated.is_active }
    });

    res.redirect(`/urls/${urlId}`);
  } catch (err) {
    console.error(err);
    const { query: q, params: p } = ownedUrlQuery(urlId, req);
    const { rows: [urlRecord] } = await pool.query(q, p);
    const projects = await getProjectsForUser(req.user.id).catch(() => []);
    const slackSelector = await loadSlackSelector();
    res.render('edit-url', {
      title: 'Edit URL',
      error: err.message,
      urlRecord,
      projects,
      slackChannels: slackSelector.channels,
      slackConnected: slackSelector.connected,
      slackChannelsError: slackSelector.error,
      slackDefaultChannelId: slackSelector.defaultChannelId,
      upgradePrompt: null,
      headlessAvailable: canUseHeadless(req.userPlan),
      currentPlanName: String(req.userPlan?.name || 'Free')
    });
  }
});

// GET /urls/:id
router.get('/:id', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

  try {
    const { query: ownerQ, params: ownerP } = ownedUrlQuery(urlId, req);
    const { rows: [urlRecord] } = await pool.query(ownerQ, ownerP);
    if (!urlRecord) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

    const { rows: snapshots } = await pool.query(
      'SELECT * FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC LIMIT 50',
      [urlId]
    );

    const { rows: alerts } = await pool.query(
      'SELECT * FROM alerts WHERE url_id = $1 ORDER BY detected_at DESC LIMIT 50',
      [urlId]
    );

    // Compute word diff for each alert
    const alertsWithDiff = alerts.map(alert => {
      const parts = Diff.diffWords(String(alert.old_value || ''), String(alert.new_value || ''));
      let oldHtml = '';
      let newHtml = '';
      for (const part of parts) {
        const esc = escapeHtml(part.value);
        if (part.added) {
          newHtml += `<mark class="diff-word-added">${esc}</mark>`;
        } else if (part.removed) {
          oldHtml += `<mark class="diff-word-removed">${esc}</mark>`;
        } else {
          oldHtml += esc;
          newHtml += esc;
        }
      }
      return { ...alert, diffOldHtml: oldHtml, diffNewHtml: newHtml };
    });

    // Reference snapshot
    let refSnapshot = null;
    if (urlRecord.reference_snapshot_id) {
      const { rows: refRows } = await pool.query(
        'SELECT * FROM snapshots WHERE id = $1', [urlRecord.reference_snapshot_id]
      );
      refSnapshot = refRows[0] || null;
    }

    // robots.txt diff between reference and latest
    let robotsDiff = null;
    if (refSnapshot?.raw_robots_txt && snapshots[0]?.raw_robots_txt) {
      robotsDiff = Diff.diffLines(refSnapshot.raw_robots_txt, snapshots[0].raw_robots_txt);
    }

    const latestSnapshot = snapshots[0] || null;
    const accessChallenge = latestSnapshot
      ? detectAccessChallenge({
        title: latestSnapshot.title,
        description: latestSnapshot.description,
        h1: latestSnapshot.h1,
        statusCode: latestSnapshot.status_code
      })
      : { detected: false, reason: null };

    let nextCheck = null;
    if (snapshots.length > 0) {
      const lastChecked = new Date(snapshots[0].checked_at);
      nextCheck = new Date(lastChecked.getTime() + urlRecord.check_interval_minutes * 60 * 1000);
    }

    // Uptime % over last 30 days
    const { rows: [uptimeRow] } = await pool.query(`
      SELECT
        CASE WHEN COUNT(*) = 0 THEN NULL
          ELSE ROUND((COUNT(*) FILTER (WHERE status_code BETWEEN 200 AND 399)::float / COUNT(*) * 100)::numeric, 1)
        END AS uptime_pct
      FROM snapshots
      WHERE url_id = $1 AND checked_at > NOW() - INTERVAL '30 days'
    `, [urlId]);
    const uptimePct = uptimeRow?.uptime_pct ?? null;

    // Load text rules for this URL
    const { rows: textRules } = await pool.query(
      'SELECT * FROM text_monitors WHERE url_id = $1 ORDER BY created_at ASC',
      [urlId]
    );

    res.render('url-detail', {
      title: urlRecord.url,
      urlRecord,
      snapshots,
      alerts: alertsWithDiff,
      nextCheck,
      refSnapshot,
      robotsDiff,
      activeTab: req.query.tab || 'overview',
      uptimePct,
      textRules,
      accessChallengeDetected: !!accessChallenge.detected,
      accessChallengeReason: accessChallenge.reason || null,
      acceptedCount: req.query.accepted ? parseInt(req.query.accepted, 10) : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// POST /urls/:id/toggle
router.post('/:id/toggle', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  const isAdmin = req.user.role === 'admin';
  try {
    const { rows: [updated] } = await pool.query(
      isAdmin
        ? 'UPDATE monitored_urls SET is_active = NOT is_active WHERE id = $1 RETURNING *'
        : 'UPDATE monitored_urls SET is_active = NOT is_active WHERE id = $1 AND user_id = $2 RETURNING *',
      isAdmin ? [urlId] : [urlId, req.user.id]
    );
    if (!updated) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

    if (updated.is_active) scheduleUrl(updated);
    else unscheduleUrl(urlId);
    await auditFromRequest(req, {
      action: updated.is_active ? 'url.resume' : 'url.pause',
      entityType: 'monitored_url',
      entityId: updated.id
    });

    res.redirect(`/urls/${urlId}`);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// POST /urls/:id/check-now
router.post('/:id/check-now', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  const isAdmin = req.user.role === 'admin';
  try {
    // Verify ownership before checking
    const { rows: [owned] } = await pool.query(
      isAdmin
        ? 'SELECT id, url, user_id FROM monitored_urls WHERE id = $1'
        : 'SELECT id, url, user_id FROM monitored_urls WHERE id = $1 AND user_id = $2',
      isAdmin ? [urlId] : [urlId, req.user.id]
    );
    if (!owned) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });
    await triggerUrlCheckNow(owned, 'manual_check');
    res.redirect(`/urls/${urlId}`);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// POST /urls/:id/accept-changes — set reference_snapshot_id to latest
router.post('/:id/accept-changes', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });
  const isAdmin = req.user.role === 'admin';
  try {
    const { query: ownerQ, params: ownerP } = ownedUrlQuery(urlId, req);
    const { rows: [urlRecord] } = await pool.query(ownerQ, ownerP);
    if (!urlRecord) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

    const { rows } = await pool.query(
      'SELECT id FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC LIMIT 1',
      [urlId]
    );
    let pendingFields = [];
    const { rows: pendingAlerts } = await pool.query(
      'SELECT field_changed FROM alerts WHERE url_id = $1',
      [urlId]
    );
    pendingFields = pendingAlerts.map(a => a.field_changed).filter(Boolean);

    if (rows[0]) {
      await pool.query(
        isAdmin
          ? 'UPDATE monitored_urls SET reference_snapshot_id = $1 WHERE id = $2'
          : 'UPDATE monitored_urls SET reference_snapshot_id = $1 WHERE id = $2 AND user_id = $3',
        isAdmin ? [rows[0].id, urlId] : [rows[0].id, urlId, req.user.id]
      );
    }

    const { rowCount: deletedCount } = await pool.query(
      'DELETE FROM alerts WHERE url_id = $1',
      [urlId]
    );

    await resolvePagerDutyForAcceptedFields({
      userId: urlRecord.user_id,
      urlId,
      url: urlRecord.url,
      fields: pendingFields
    });

    await auditFromRequest(req, {
      action: 'url.accept_all',
      entityType: 'monitored_url',
      entityId: urlId,
      meta: { acceptedCount: deletedCount }
    });
    res.redirect(`/urls/${urlId}`);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// POST /urls/:id/accept-selected — accept specific alert rows only
router.post('/:id/accept-selected', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

  const rawAlertIds = Array.isArray(req.body.alert_ids)
    ? req.body.alert_ids
    : req.body.alert_ids
      ? [req.body.alert_ids]
      : [];
  const alertIds = rawAlertIds.map(v => parseInt(v, 10)).filter(v => Number.isFinite(v) && v > 0);
  if (alertIds.length === 0) return res.redirect(`/urls/${urlId}?tab=changes`);

  try {
    const { query, params } = ownedUrlQuery(urlId, req);
    const { rows: [urlRecord] } = await pool.query(query, params);
    if (!urlRecord) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

    const { rows: [latestSnapshot] } = await pool.query(
      'SELECT * FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC LIMIT 1',
      [urlId]
    );
    if (!latestSnapshot) return res.redirect(`/urls/${urlId}?tab=changes`);

    const { rows: selectedAlerts } = await pool.query(
      `SELECT id, field_changed
       FROM alerts
       WHERE url_id = $1 AND id = ANY($2::int[])`,
      [urlId, alertIds]
    );
    if (selectedAlerts.length === 0) return res.redirect(`/urls/${urlId}?tab=changes`);

    let refSnapshotId = urlRecord.reference_snapshot_id || null;
    let refSnapshot = null;
    if (refSnapshotId) {
      const { rows: [existingRef] } = await pool.query(
        'SELECT id FROM snapshots WHERE id = $1 AND url_id = $2',
        [refSnapshotId, urlId]
      );
      refSnapshot = existingRef || null;
    }
    if (!refSnapshot) {
      refSnapshotId = latestSnapshot.id;
      await pool.query(
        req.user.role === 'admin'
          ? 'UPDATE monitored_urls SET reference_snapshot_id = $1 WHERE id = $2'
          : 'UPDATE monitored_urls SET reference_snapshot_id = $1 WHERE id = $2 AND user_id = $3',
        req.user.role === 'admin' ? [refSnapshotId, urlId] : [refSnapshotId, urlId, req.user.id]
      );
    }

    const columnUpdates = new Map();
    const acceptedFields = new Set();
    for (const alert of selectedAlerts) {
      const cols = ALERT_FIELD_TO_SNAPSHOT_COLUMNS[alert.field_changed];
      if (!cols || cols.length === 0) continue;
      acceptedFields.add(alert.field_changed);
      for (const col of cols) {
        columnUpdates.set(col, latestSnapshot[col]);
      }
    }

    if (columnUpdates.size > 0 && refSnapshotId && refSnapshotId !== latestSnapshot.id) {
      const cols = [...columnUpdates.keys()];
      const values = cols.map(c => columnUpdates.get(c));
      const setSql = cols.map((c, idx) => `${c} = $${idx + 1}`).join(', ');
      await pool.query(
        `UPDATE snapshots SET ${setSql} WHERE id = $${cols.length + 1}`,
        [...values, refSnapshotId]
      );
    }

    const { rowCount: deletedCount } = await pool.query(
      'DELETE FROM alerts WHERE url_id = $1 AND id = ANY($2::int[])',
      [urlId, selectedAlerts.map(a => a.id)]
    );

    await resolvePagerDutyForAcceptedFields({
      userId: urlRecord.user_id,
      urlId,
      url: urlRecord.url,
      fields: selectedAlerts.map(a => a.field_changed)
    });

    await auditFromRequest(req, {
      action: 'url.accept_selected',
      entityType: 'monitored_url',
      entityId: urlId,
      meta: {
        acceptedCount: deletedCount,
        acceptedFields: [...acceptedFields]
      }
    });

    res.redirect(`/urls/${urlId}?tab=changes&accepted=${deletedCount}`);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// POST /urls/accept-all-changes — accept changes for all problem URLs
router.post('/accept-all-changes', requireAuth, async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  try {
    await pool.query(`
      UPDATE monitored_urls mu
      SET reference_snapshot_id = ls.snap_id
      FROM (
        SELECT DISTINCT ON (url_id) url_id, id AS snap_id
        FROM snapshots
        ORDER BY url_id, checked_at DESC
      ) ls
      WHERE mu.id = ls.url_id
      ${isAdmin ? '' : 'AND mu.user_id = $1'}
    `, isAdmin ? [] : [req.user.id]);
    res.redirect('/?tab=problems');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// POST /urls/:id/delete
router.post('/:id/delete', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  const isAdmin = req.user.role === 'admin';
  try {
    const { rowCount } = await pool.query(
      isAdmin
        ? 'DELETE FROM monitored_urls WHERE id = $1'
        : 'DELETE FROM monitored_urls WHERE id = $1 AND user_id = $2',
      isAdmin ? [urlId] : [urlId, req.user.id]
    );
    if (rowCount > 0) unscheduleUrl(urlId);
    if (rowCount > 0) {
      await auditFromRequest(req, {
        action: 'url.delete',
        entityType: 'monitored_url',
        entityId: urlId
      });
    }
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// POST /urls/bulk-action — bulk pause/resume/accept/delete
router.post('/bulk-action', requireAuth, async (req, res) => {
  const { action, ids } = req.body;
  const rawIds = Array.isArray(ids) ? ids : ids ? [ids] : [];
  const urlIds = rawIds.map(i => parseInt(i, 10)).filter(i => !isNaN(i));
  if (urlIds.length === 0) return res.redirect('/');

  const isAdmin = req.user.role === 'admin';
  const ownerWhere = isAdmin ? '' : 'AND user_id = $' + (urlIds.length + 1);
  const ownerParam = isAdmin ? [] : [req.user.id];
  const placeholders = urlIds.map((_, i) => `$${i + 1}`).join(',');

  try {
    if (action === 'pause') {
      await pool.query(
        `UPDATE monitored_urls SET is_active = false WHERE id IN (${placeholders}) ${ownerWhere}`,
        [...urlIds, ...ownerParam]
      );
      // Unschedule each
      for (const id of urlIds) unscheduleUrl(id);
    } else if (action === 'resume') {
      const { rows } = await pool.query(
        `UPDATE monitored_urls SET is_active = true WHERE id IN (${placeholders}) ${ownerWhere} RETURNING *`,
        [...urlIds, ...ownerParam]
      );
      for (const rec of rows) scheduleUrl(rec);
    } else if (action === 'accept') {
      // Set reference_snapshot_id to latest snapshot for each URL
      for (const id of urlIds) {
        const { rows: [latest] } = await pool.query(
          'SELECT id FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC LIMIT 1', [id]
        );
        if (latest) {
          await pool.query(
            `UPDATE monitored_urls SET reference_snapshot_id = $1 WHERE id = $2 ${ownerWhere.replace('AND user_id = $' + (urlIds.length + 1), isAdmin ? '' : 'AND user_id = $3')}`,
            isAdmin ? [latest.id, id] : [latest.id, id, req.user.id]
          );
        }
      }
    } else if (action === 'delete') {
      const { rows: deleted } = await pool.query(
        `DELETE FROM monitored_urls WHERE id IN (${placeholders}) ${ownerWhere} RETURNING id`,
        [...urlIds, ...ownerParam]
      );
      for (const r of deleted) unscheduleUrl(r.id);
    }
  } catch (err) {
    console.error('[Bulk Action]', err.message);
  }

  res.redirect('/');
});

// POST /urls/:id/clone — duplicate a URL with all its settings
router.post('/:id/clone', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

  try {
    const { query, params } = ownedUrlQuery(urlId, req);
    const { rows: [src] } = await pool.query(query, params);
    if (!src) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

    const { rows: [cloned] } = await pool.query(
      `INSERT INTO monitored_urls
         (url, email, check_interval_minutes, user_id, project_id,
          monitor_title, monitor_description, monitor_h1, monitor_body,
          monitor_status_code, monitor_noindex, monitor_redirect,
          monitor_canonical, monitor_robots, monitor_hreflang, monitor_og, monitor_ssl,
          user_agent, ignore_numbers, custom_text, render_mode,
          telegram_bot_token, telegram_chat_id, webhook_url, discord_webhook_url,
          send_to_slack, slack_channel_id, pagerduty_threshold,
          fields_notification_config, tags, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
       RETURNING *`,
      [
        src.url, src.email, src.check_interval_minutes, req.user.id, src.project_id || null,
        src.monitor_title, src.monitor_description, src.monitor_h1, src.monitor_body,
        src.monitor_status_code, src.monitor_noindex, src.monitor_redirect,
        src.monitor_canonical, src.monitor_robots, src.monitor_hreflang, src.monitor_og, src.monitor_ssl,
        src.user_agent, src.ignore_numbers, src.custom_text, normalizeRenderMode(src.render_mode),
        src.telegram_bot_token, src.telegram_chat_id, src.webhook_url, src.discord_webhook_url,
        !!src.send_to_slack, src.slack_channel_id || null, normalizePagerDutyThreshold(src.pagerduty_threshold),
        JSON.stringify(src.fields_notification_config || {}),
        src.tags, src.notes || ''
      ]
    );

    scheduleUrl(cloned);
    triggerUrlCheckNow(cloned, 'clone').catch(() => {});
    res.redirect(`/urls/${cloned.id}/edit?cloned=1`);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// POST /urls/:id/test-notify — send a test notification for this URL
router.post('/:id/test-notify', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(404).json({ error: 'Not found' });

  try {
    const { query, params } = ownedUrlQuery(urlId, req);
    const { rows: [urlRecord] } = await pool.query(query, params);
    if (!urlRecord) return res.status(404).json({ error: 'Not found' });

    let urlWithIntegrations = { ...urlRecord };
    if (urlRecord.user_id) {
      const [{ rows: [slack] }, { rows: [pagerduty] }] = await Promise.all([
        pool.query(
          `SELECT bot_token, channel_id
           FROM slack_integrations
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [urlRecord.user_id]
        ),
        pool.query(
          `SELECT integration_key
           FROM pagerduty_integrations
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [urlRecord.user_id]
        )
      ]);
      urlWithIntegrations = {
        ...urlWithIntegrations,
        slack_bot_token: slack?.bot_token || null,
        slack_default_channel_id: slack?.channel_id || null,
        pagerduty_integration_key: pagerduty?.integration_key || null
      };
    }

    const { notify } = require('../notifier');
    const results = await notify({
      urlRecord: urlWithIntegrations,
      field: 'Test Notification',
      oldValue: 'MetaWatch test',
      newValue: 'This is a test alert — your notifications are working!',
      timestamp: new Date()
    });

    const channels = Object.entries(results)
      .filter(([, ok]) => ok)
      .map(([ch]) => ch);

    if (channels.length === 0) {
      return res.json({ ok: false, message: 'No notification channels configured for this URL.' });
    }
    res.json({ ok: true, message: `Test sent via: ${channels.join(', ')}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Normalize tag string: lowercase, trim, deduplicate, comma-join
function normalizeTags(raw) {
  if (!raw) return '';
  return [...new Set(
    String(raw).split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
  )].join(',');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Text Rules CRUD ──────────────────────────────────────────────────────────

// POST /urls/:id/text-rules — add a text rule
router.post('/:id/text-rules', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

  try {
    const { query, params } = ownedUrlQuery(urlId, req);
    const { rows: [urlRecord] } = await pool.query(query, params);
    if (!urlRecord) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

    const { label, text, match_type } = req.body;
    if (!text || !match_type) return res.redirect(`/urls/${urlId}?tab=text-rules&error=missing`);

    await pool.query(
      `INSERT INTO text_monitors (url_id, label, text, match_type)
       VALUES ($1, $2, $3, $4)`,
      [urlId, label || text, text, match_type]
    );

    res.redirect(`/urls/${urlId}?tab=text-rules`);
  } catch (err) { res.status(500).render('error', { title: 'Error', error: err.message }); }
});

// POST /urls/:id/text-rules/:ruleId/delete — delete a text rule
router.post('/:id/text-rules/:ruleId/delete', requireAuth, async (req, res, next) => {
  const urlId  = parseInt(req.params.id, 10);
  const ruleId = parseInt(req.params.ruleId, 10);
  if (isNaN(urlId) || isNaN(ruleId)) return res.status(404).render('error', { title: 'Not Found', error: 'Not found' });

  try {
    const { query, params } = ownedUrlQuery(urlId, req);
    const { rows: [urlRecord] } = await pool.query(query, params);
    if (!urlRecord) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

    await pool.query(
      'DELETE FROM text_monitors WHERE id = $1 AND url_id = $2',
      [ruleId, urlId]
    );

    res.redirect(`/urls/${urlId}?tab=text-rules`);
  } catch (err) { next(err); }
});

// POST /urls/:id/text-rules/:ruleId/toggle — toggle active state
router.post('/:id/text-rules/:ruleId/toggle', requireAuth, async (req, res, next) => {
  const urlId  = parseInt(req.params.id, 10);
  const ruleId = parseInt(req.params.ruleId, 10);
  if (isNaN(urlId) || isNaN(ruleId)) return res.status(404).render('error', { title: 'Not Found', error: 'Not found' });

  try {
    const { query, params } = ownedUrlQuery(urlId, req);
    const { rows: [urlRecord] } = await pool.query(query, params);
    if (!urlRecord) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

    await pool.query(
      'UPDATE text_monitors SET is_active = NOT is_active WHERE id = $1 AND url_id = $2',
      [ruleId, urlId]
    );

    res.redirect(`/urls/${urlId}?tab=text-rules`);
  } catch (err) { next(err); }
});

// ─── Onboarding complete ──────────────────────────────────────────────────────
router.post('/onboarding-complete', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET onboarding_completed = true WHERE id = $1',
      [req.user.id]
    );
    res.json({ ok: true });
  } catch {
    res.json({ ok: false });
  }
});

module.exports = router;
