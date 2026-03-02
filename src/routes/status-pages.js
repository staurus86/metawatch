const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../auth');

function generateSlug() {
  return crypto.randomBytes(6).toString('hex');
}

function isAgencyPlan(req) {
  return String(req.userPlan?.name || '').toLowerCase() === 'agency';
}

function normalizeCustomDomain(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  let cleaned = value
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
  cleaned = cleaned.replace(/:\d+$/, '');
  if (!cleaned) return null;
  if (cleaned.includes(' ')) return null;
  if (!/^[a-z0-9.-]+$/.test(cleaned)) return null;
  if (!cleaned.includes('.')) return null;
  return cleaned;
}

function normalizePrimaryColor(raw) {
  const value = String(raw || '').trim();
  if (!value) return '#4299e1';
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase();
  return null;
}

function normalizeLogoUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (value.startsWith('data:image/')) return value;
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

function parseMonitorIds(raw) {
  return (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .map(i => parseInt(i, 10))
    .filter(i => !isNaN(i));
}

async function getMonitorsForUser(userId) {
  const { rows } = await pool.query(
    'SELECT id, name, url FROM uptime_monitors WHERE user_id = $1 AND is_active = true ORDER BY name',
    [userId]
  );
  return rows;
}

async function getStatusPageForUser(pageId, userId) {
  const { rows: [page] } = await pool.query(
    'SELECT * FROM status_pages WHERE id = $1 AND user_id = $2',
    [pageId, userId]
  );
  return page || null;
}

async function renderEditPage(req, res, { pageId, status = 200, error = null, pageOverride = null } = {}) {
  const page = pageOverride || await getStatusPageForUser(pageId, req.user.id);
  if (!page) return res.status(404).render('error', { title: 'Not Found', error: 'Page not found' });

  const monitors = await getMonitorsForUser(req.user.id);
  return res.status(status).render('status-pages-edit', {
    title: 'Edit Status Page',
    page,
    monitors,
    error,
    isAgencyPlan: isAgencyPlan(req)
  });
}

router.use(requireAuth);

// GET /status-pages
router.get('/', async (req, res, next) => {
  try {
    const { rows: pages } = await pool.query(
      'SELECT * FROM status_pages WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );

    const { rows: subCounts } = await pool.query(
      `SELECT status_page_id, COUNT(*) AS cnt FROM uptime_subscribers
       WHERE confirmed_at IS NOT NULL
       GROUP BY status_page_id`
    );
    const subMap = {};
    for (const r of subCounts) subMap[r.status_page_id] = parseInt(r.cnt, 10);

    res.render('status-pages', {
      title: 'Status Pages',
      pages,
      subMap,
      message: req.query.msg || null,
      isAgencyPlan: isAgencyPlan(req)
    });
  } catch (err) { next(err); }
});

// GET /status-pages/new
router.get('/new', async (req, res, next) => {
  try {
    const monitors = await getMonitorsForUser(req.user.id);
    res.render('status-pages-new', {
      title: 'New Status Page',
      monitors,
      error: null,
      values: {}
    });
  } catch (err) { next(err); }
});

// POST /status-pages
router.post('/', async (req, res, next) => {
  const { title, description, monitor_ids, is_public } = req.body;
  const ids = parseMonitorIds(monitor_ids);

  if (!title || !title.trim()) {
    const monitors = await getMonitorsForUser(req.user.id);
    return res.render('status-pages-new', {
      title: 'New Status Page',
      monitors,
      error: 'Title is required',
      values: req.body
    });
  }

  try {
    const slug = generateSlug();
    await pool.query(
      `INSERT INTO status_pages (user_id, slug, title, description, monitor_ids, is_public)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.user.id, slug, title.trim(), description?.trim() || '', ids, is_public === 'on']
    );
    res.redirect('/status-pages?msg=Status+page+created');
  } catch (err) { next(err); }
});

// GET /status-pages/:id/edit
router.get('/:id/edit', async (req, res, next) => {
  const pageId = parseInt(req.params.id, 10);
  try {
    await renderEditPage(req, res, { pageId });
  } catch (err) { next(err); }
});

// POST /status-pages/:id/edit
router.post('/:id/edit', async (req, res, next) => {
  const pageId = parseInt(req.params.id, 10);
  const { title, description, monitor_ids, is_public } = req.body;
  const ids = parseMonitorIds(monitor_ids);

  try {
    const existingPage = await getStatusPageForUser(pageId, req.user.id);
    if (!existingPage) return res.status(404).render('error', { title: 'Not Found', error: 'Page not found' });

    const agencyEnabled = isAgencyPlan(req);
    const customDomain = agencyEnabled ? normalizeCustomDomain(req.body.custom_domain) : null;
    const logoUrl = agencyEnabled ? normalizeLogoUrl(req.body.logo_url) : null;
    const primaryColor = agencyEnabled ? normalizePrimaryColor(req.body.primary_color) : '#4299e1';
    const hidePoweredBy = agencyEnabled ? req.body.hide_powered_by === 'on' : false;

    if (agencyEnabled && req.body.custom_domain && !customDomain) {
      const page = { ...existingPage, ...req.body, monitor_ids: ids };
      return renderEditPage(req, res, {
        pageId,
        status: 400,
        error: 'Invalid custom domain format.',
        pageOverride: page
      });
    }

    if (agencyEnabled && req.body.logo_url && !logoUrl) {
      const page = { ...existingPage, ...req.body, monitor_ids: ids };
      return renderEditPage(req, res, {
        pageId,
        status: 400,
        error: 'Logo URL must be https://... or data:image/... value.',
        pageOverride: page
      });
    }

    if (agencyEnabled && primaryColor === null) {
      const page = { ...existingPage, ...req.body, monitor_ids: ids };
      return renderEditPage(req, res, {
        pageId,
        status: 400,
        error: 'Primary color must be in #RRGGBB format.',
        pageOverride: page
      });
    }

    if (customDomain) {
      const { rows: [dupe] } = await pool.query(
        `SELECT id FROM status_pages
         WHERE lower(custom_domain) = lower($1)
           AND id <> $2
         LIMIT 1`,
        [customDomain, pageId]
      );
      if (dupe) {
        const page = { ...existingPage, ...req.body, monitor_ids: ids };
        return renderEditPage(req, res, {
          pageId,
          status: 409,
          error: 'This custom domain is already linked to another status page.',
          pageOverride: page
        });
      }
    }

    await pool.query(
      `UPDATE status_pages
       SET title = $1,
           description = $2,
           monitor_ids = $3,
           is_public = $4,
           custom_domain = $5,
           logo_url = $6,
           primary_color = $7,
           hide_powered_by = $8
       WHERE id = $9 AND user_id = $10`,
      [
        title?.trim() || 'Status Page',
        description?.trim() || '',
        ids,
        is_public === 'on',
        customDomain,
        logoUrl,
        primaryColor || '#4299e1',
        hidePoweredBy,
        pageId,
        req.user.id
      ]
    );

    res.redirect('/status-pages?msg=Saved');
  } catch (err) { next(err); }
});

// POST /status-pages/:id/delete
router.post('/:id/delete', async (req, res, next) => {
  const pageId = parseInt(req.params.id, 10);
  try {
    await pool.query('DELETE FROM status_pages WHERE id = $1 AND user_id = $2', [pageId, req.user.id]);
    res.redirect('/status-pages?msg=Deleted');
  } catch (err) { next(err); }
});

module.exports = router;
