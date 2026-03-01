const express = require('express');
const router = express.Router();
const Diff = require('diff');
const multer = require('multer');
const XLSX = require('xlsx');
const { XMLParser } = require('fast-xml-parser');
const axios = require('axios');
const pool = require('../db');
const { checkUrl } = require('../checker');
const { scheduleUrl, unscheduleUrl } = require('../scheduler');
const { requireAuth } = require('../auth');
const { checkSemaphore, domainRateLimit } = require('../queue');
const { scanEmitter, isScanRunning, setScanRunning } = require('../scan-events');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const MAX_BULK_IMPORT_URLS = 500;
const BULK_PREVIEW_ROW_LIMIT = 1000;

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
router.get('/add', requireAuth, (req, res) => {
  res.render('add-url', {
    title: 'Add URL',
    error: null,
    values: {
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
    telegram_bot_token, telegram_chat_id, webhook_url,
    tags, notes, response_time_threshold_ms
  } = req.body;

  const renderError = (msg) => res.render('add-url', {
    title: 'Add URL',
    error: msg,
    values: req.body
  });

  if (!url || !url.trim()) return renderError('URL is required.');
  const trimmedUrl = url.trim();
  if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
    return renderError('URL must start with http:// or https://');
  }

  const interval = parseInt(check_interval_minutes, 10);
  if (isNaN(interval) || interval < 1) return renderError('Invalid check interval.');
  const rtThreshold = parseInt(response_time_threshold_ms, 10) || null;

  try {
    const { rows: [newUrl] } = await pool.query(
      `INSERT INTO monitored_urls
         (url, email, check_interval_minutes, user_id,
          monitor_title, monitor_description, monitor_h1, monitor_body,
          monitor_status_code, monitor_noindex, monitor_redirect,
          monitor_canonical, monitor_robots, monitor_hreflang, monitor_og, monitor_ssl,
          user_agent, ignore_numbers, custom_text,
          telegram_bot_token, telegram_chat_id, webhook_url, tags, notes,
          response_time_threshold_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       RETURNING *`,
      [
        trimmedUrl,
        email?.trim() || null,
        interval || 60,
        req.user.id,
        !!monitor_title, !!monitor_description, !!monitor_h1, !!monitor_body,
        !!monitor_status_code, !!monitor_noindex, !!monitor_redirect,
        !!monitor_canonical, !!monitor_robots, !!monitor_hreflang, !!monitor_og, !!monitor_ssl,
        user_agent?.trim() || null,
        !!ignore_numbers,
        custom_text?.trim() || null,
        telegram_bot_token?.trim() || null,
        telegram_chat_id?.trim() || null,
        webhook_url?.trim() || null,
        normalizeTags(tags),
        notes?.trim() || '',
        rtThreshold
      ]
    );

    scheduleUrl(newUrl);
    checkUrl(newUrl.id).catch(err =>
      console.error(`Initial check failed for URL #${newUrl.id}: ${err.message}`)
    );

    res.redirect(`/urls/${newUrl.id}`);
  } catch (err) {
    console.error(err);
    renderError(err.message);
  }
});

// GET /urls/bulk
router.get('/bulk', requireAuth, (req, res) => {
  res.render('bulk-import', { title: 'Bulk Import', error: null, preview: null });
});

// POST /urls/bulk
router.post('/bulk', requireAuth, upload.single('file'), async (req, res) => {
  const { source, urls_text, sitemap_url, column } = req.body;

  try {
    if (req.body.confirm === '1') {
      const interval = parseInt(req.body.check_interval_minutes || '60', 10);
      if (isNaN(interval) || interval < 1) {
        return res.render('bulk-import', {
          title: 'Bulk Import',
          error: 'Invalid check interval.',
          preview: null
        });
      }

      let importableUrls = [];
      try {
        importableUrls = JSON.parse(req.body.preview_importable_json || '[]');
      } catch {
        return res.render('bulk-import', {
          title: 'Bulk Import',
          error: 'Invalid import payload. Please generate preview again.',
          preview: null
        });
      }

      if (!Array.isArray(importableUrls)) importableUrls = [];
      importableUrls = [...new Set(importableUrls.map(normalizeImportUrl).filter(Boolean))].slice(0, MAX_BULK_IMPORT_URLS);

      const selectedRaw = req.body.selected_urls;
      const selectedList = Array.isArray(selectedRaw) ? selectedRaw : (selectedRaw ? [selectedRaw] : []);
      const selectedSet = new Set(selectedList.map(normalizeImportUrl).filter(Boolean));
      const selectedUrls = importableUrls.filter(u => selectedSet.has(u));

      if (selectedUrls.length === 0) {
        return res.render('bulk-import', {
          title: 'Bulk Import',
          error: 'No URLs selected for import.',
          preview: null
        });
      }

      const importTag = `import-${new Date().toISOString().slice(0, 10)}`;
      let imported = 0;

      for (const u of selectedUrls) {
        try {
          const { rows: [newRec] } = await pool.query(
            `INSERT INTO monitored_urls
               (url, check_interval_minutes, user_id, tags,
                monitor_title, monitor_description, monitor_h1, monitor_body,
                monitor_status_code, monitor_noindex, monitor_redirect,
                monitor_canonical, monitor_robots)
             VALUES ($1,$2,$3,$4,true,true,true,true,true,true,true,true,true)
             RETURNING *`,
            [u, interval, req.user.id, importTag]
          );
          scheduleUrl(newRec);
          checkUrl(newRec.id).catch(() => {});
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
      return res.render('bulk-import', {
        title: 'Bulk Import',
        error: 'No valid URLs found.',
        preview: null
      });
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

    res.render('bulk-import', {
      title: 'Bulk Import',
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
        sitemap_url
      }
    });
  } catch (err) {
    console.error(err);
    res.render('bulk-import', { title: 'Bulk Import', error: err.message, preview: null });
  }
});

async function parseSitemap(url, depth = 0) {
  if (depth > 3) return [];
  const parser = new XMLParser({ ignoreAttributes: false });

  const response = await axios.get(url, {
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
        const nested = await parseSitemap(String(loc).trim(), depth + 1);
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

    res.render('edit-url', { title: 'Edit URL', error: null, urlRecord, cloned: !!req.query.cloned });
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
    user_agent, ignore_numbers, custom_text,
    telegram_bot_token, telegram_chat_id, webhook_url,
    silenced_until, tags, notes
  } = req.body;

  const interval = parseInt(check_interval_minutes, 10);
  if (isNaN(interval) || interval < 1) {
    const { query: q, params: p } = ownedUrlQuery(urlId, req);
    const { rows: [urlRecord] } = await pool.query(q, p);
    return res.render('edit-url', { title: 'Edit URL', error: 'Invalid check interval.', urlRecord });
  }

  try {
    const { rows: [updated] } = await pool.query(
      `UPDATE monitored_urls SET
         email = $1, check_interval_minutes = $2,
         monitor_title = $3, monitor_description = $4, monitor_h1 = $5, monitor_body = $6,
         monitor_status_code = $7, monitor_noindex = $8, monitor_redirect = $9,
         monitor_canonical = $10, monitor_robots = $11, monitor_hreflang = $12, monitor_og = $13,
         monitor_ssl = $14,
         user_agent = $15, ignore_numbers = $16, custom_text = $17,
         telegram_bot_token = $18, telegram_chat_id = $19, webhook_url = $20,
         silenced_until = $21, tags = $22, notes = $23
       WHERE id = $24 ${req.user.role !== 'admin' ? 'AND user_id = $25' : ''}
       RETURNING *`,
      req.user.role !== 'admin'
        ? [
            email?.trim() || null, interval,
            !!monitor_title, !!monitor_description, !!monitor_h1, !!monitor_body,
            !!monitor_status_code, !!monitor_noindex, !!monitor_redirect,
            !!monitor_canonical, !!monitor_robots, !!monitor_hreflang, !!monitor_og,
            !!monitor_ssl, user_agent?.trim() || null, !!ignore_numbers,
            custom_text?.trim() || null, telegram_bot_token?.trim() || null,
            telegram_chat_id?.trim() || null, webhook_url?.trim() || null,
            silenced_until?.trim() || null, normalizeTags(tags), notes?.trim() || '',
            urlId, req.user.id
          ]
        : [
            email?.trim() || null, interval,
            !!monitor_title, !!monitor_description, !!monitor_h1, !!monitor_body,
            !!monitor_status_code, !!monitor_noindex, !!monitor_redirect,
            !!monitor_canonical, !!monitor_robots, !!monitor_hreflang, !!monitor_og,
            !!monitor_ssl, user_agent?.trim() || null, !!ignore_numbers,
            custom_text?.trim() || null, telegram_bot_token?.trim() || null,
            telegram_chat_id?.trim() || null, webhook_url?.trim() || null,
            silenced_until?.trim() || null, normalizeTags(tags), notes?.trim() || '',
            urlId
          ]
    );

    if (!updated) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });

    // Reschedule if interval changed
    scheduleUrl(updated);

    res.redirect(`/urls/${urlId}`);
  } catch (err) {
    console.error(err);
    const { query: q, params: p } = ownedUrlQuery(urlId, req);
    const { rows: [urlRecord] } = await pool.query(q, p);
    res.render('edit-url', { title: 'Edit URL', error: err.message, urlRecord });
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
      textRules
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
        ? 'SELECT id FROM monitored_urls WHERE id = $1'
        : 'SELECT id FROM monitored_urls WHERE id = $1 AND user_id = $2',
      isAdmin ? [urlId] : [urlId, req.user.id]
    );
    if (!owned) return res.status(404).render('error', { title: 'Not Found', error: 'URL not found' });
    await checkUrl(urlId);
    res.redirect(`/urls/${urlId}`);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// POST /urls/:id/accept-changes — set reference_snapshot_id to latest
router.post('/:id/accept-changes', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  const isAdmin = req.user.role === 'admin';
  try {
    const { rows } = await pool.query(
      'SELECT id FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC LIMIT 1',
      [urlId]
    );
    if (rows[0]) {
      await pool.query(
        isAdmin
          ? 'UPDATE monitored_urls SET reference_snapshot_id = $1 WHERE id = $2'
          : 'UPDATE monitored_urls SET reference_snapshot_id = $1 WHERE id = $2 AND user_id = $3',
        isAdmin ? [rows[0].id, urlId] : [rows[0].id, urlId, req.user.id]
      );
    }
    res.redirect(`/urls/${urlId}`);
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
         (url, email, check_interval_minutes, user_id,
          monitor_title, monitor_description, monitor_h1, monitor_body,
          monitor_status_code, monitor_noindex, monitor_redirect,
          monitor_canonical, monitor_robots, monitor_hreflang, monitor_og, monitor_ssl,
          user_agent, ignore_numbers, custom_text,
          telegram_bot_token, telegram_chat_id, webhook_url, tags, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING *`,
      [
        src.url, src.email, src.check_interval_minutes, req.user.id,
        src.monitor_title, src.monitor_description, src.monitor_h1, src.monitor_body,
        src.monitor_status_code, src.monitor_noindex, src.monitor_redirect,
        src.monitor_canonical, src.monitor_robots, src.monitor_hreflang, src.monitor_og, src.monitor_ssl,
        src.user_agent, src.ignore_numbers, src.custom_text,
        src.telegram_bot_token, src.telegram_chat_id, src.webhook_url,
        src.tags, src.notes || ''
      ]
    );

    scheduleUrl(cloned);
    checkUrl(cloned.id).catch(() => {});
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

    const { notify } = require('../notifier');
    const results = await notify({
      urlRecord,
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
