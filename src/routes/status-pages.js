const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { sendAlert: sendEmail, isEmailConfigured } = require('../mailer');

function generateSlug() {
  return crypto.randomBytes(6).toString('hex');
}

router.use(requireAuth);

// GET /status-pages
router.get('/', async (req, res, next) => {
  try {
    const { rows: pages } = await pool.query(
      'SELECT * FROM status_pages WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    // Subscriber counts
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
      message: req.query.msg || null
    });
  } catch (err) { next(err); }
});

// GET /status-pages/new
router.get('/new', async (req, res, next) => {
  try {
    const { rows: monitors } = await pool.query(
      'SELECT id, name, url FROM uptime_monitors WHERE user_id = $1 AND is_active = true ORDER BY name',
      [req.user.id]
    );
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
  const ids = (Array.isArray(monitor_ids) ? monitor_ids : monitor_ids ? [monitor_ids] : [])
    .map(i => parseInt(i, 10)).filter(i => !isNaN(i));

  if (!title || !title.trim()) {
    const { rows: monitors } = await pool.query(
      'SELECT id, name, url FROM uptime_monitors WHERE user_id = $1 AND is_active = true ORDER BY name',
      [req.user.id]
    );
    return res.render('status-pages-new', {
      title: 'New Status Page',
      monitors, error: 'Title is required', values: req.body
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
    const { rows: [page] } = await pool.query(
      'SELECT * FROM status_pages WHERE id = $1 AND user_id = $2',
      [pageId, req.user.id]
    );
    if (!page) return res.status(404).render('error', { title: 'Not Found', error: 'Page not found' });

    const { rows: monitors } = await pool.query(
      'SELECT id, name, url FROM uptime_monitors WHERE user_id = $1 AND is_active = true ORDER BY name',
      [req.user.id]
    );
    res.render('status-pages-edit', {
      title: 'Edit Status Page',
      page, monitors, error: null
    });
  } catch (err) { next(err); }
});

// POST /status-pages/:id/edit
router.post('/:id/edit', async (req, res, next) => {
  const pageId = parseInt(req.params.id, 10);
  const { title, description, monitor_ids, is_public } = req.body;
  const ids = (Array.isArray(monitor_ids) ? monitor_ids : monitor_ids ? [monitor_ids] : [])
    .map(i => parseInt(i, 10)).filter(i => !isNaN(i));

  try {
    await pool.query(
      `UPDATE status_pages SET title = $1, description = $2, monitor_ids = $3, is_public = $4
       WHERE id = $5 AND user_id = $6`,
      [title?.trim() || 'Status Page', description?.trim() || '', ids, is_public === 'on', pageId, req.user.id]
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
