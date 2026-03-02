const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../auth');
const { getReportPlanCaps } = require('../report-access');

const DAY_MS = 24 * 60 * 60 * 1000;

function formatInputDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function defaultRange() {
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - 30 * DAY_MS);
  return {
    from: formatInputDate(fromDate),
    to: formatInputDate(toDate)
  };
}

function parseDateInput(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return value;
}

function buildQuery(from, to) {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const query = params.toString();
  return query ? `?${query}` : '';
}

async function listEntities(req) {
  const isAdmin = req.user?.role === 'admin';

  const urlQuery = isAdmin
    ? `SELECT id, url FROM monitored_urls ORDER BY created_at DESC LIMIT 300`
    : `SELECT id, url FROM monitored_urls WHERE user_id = $1 ORDER BY created_at DESC LIMIT 300`;

  const monitorQuery = isAdmin
    ? `SELECT id, name, url FROM uptime_monitors ORDER BY created_at DESC LIMIT 300`
    : `SELECT id, name, url FROM uptime_monitors WHERE user_id = $1 ORDER BY created_at DESC LIMIT 300`;

  const projectQuery = isAdmin
    ? `SELECT id, name FROM projects ORDER BY created_at DESC LIMIT 300`
    : `SELECT id, name FROM projects WHERE user_id = $1 ORDER BY created_at DESC LIMIT 300`;

  const params = isAdmin ? [] : [req.user.id];

  const [urlRes, monitorRes, projectRes] = await Promise.all([
    pool.query(urlQuery, params),
    pool.query(monitorQuery, params),
    pool.query(projectQuery, params)
  ]);

  return {
    urls: urlRes.rows || [],
    monitors: monitorRes.rows || [],
    projects: projectRes.rows || []
  };
}

async function ensureOwned({ req, table, id }) {
  const isAdmin = req.user?.role === 'admin';
  const allowed = new Set(['monitored_urls', 'uptime_monitors', 'projects']);
  const safeTable = allowed.has(table) ? table : null;
  if (!safeTable) return false;

  if (isAdmin) {
    const { rows: [row] } = await pool.query(`SELECT id FROM ${safeTable} WHERE id = $1 LIMIT 1`, [id]);
    return !!row;
  }

  const { rows: [row] } = await pool.query(
    `SELECT id FROM ${safeTable} WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [id, req.user.id]
  );
  return !!row;
}

router.use(requireAuth);

// GET /reports — reports center
router.get('/', async (req, res) => {
  try {
    const defaults = defaultRange();
    const from = parseDateInput(req.query.from) || defaults.from;
    const to = parseDateInput(req.query.to) || defaults.to;
    const entities = await listEntities(req);
    const planCaps = getReportPlanCaps(req.userPlan?.name);

    res.render('reports', {
      title: 'Reports Center',
      message: req.query.msg || null,
      error: req.query.error || null,
      from,
      to,
      urls: entities.urls,
      monitors: entities.monitors,
      projects: entities.projects,
      planCaps,
      currentPlan: req.userPlan || { name: 'Free' }
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// GET /reports/url-pdf?id=...&from=...&to=...
router.get('/url-pdf', async (req, res) => {
  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.redirect('/reports?error=Invalid+URL+ID');

  try {
    const owned = await ensureOwned({ req, table: 'monitored_urls', id });
    if (!owned) return res.redirect('/reports?error=URL+not+found');
    const query = buildQuery(parseDateInput(req.query.from), parseDateInput(req.query.to));
    return res.redirect(`/export/url/${id}.pdf${query}`);
  } catch (err) {
    return res.redirect('/reports?error=' + encodeURIComponent(err.message));
  }
});

router.get('/url-xlsx', async (req, res) => {
  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.redirect('/reports?error=Invalid+URL+ID');

  try {
    const owned = await ensureOwned({ req, table: 'monitored_urls', id });
    if (!owned) return res.redirect('/reports?error=URL+not+found');
    const query = buildQuery(parseDateInput(req.query.from), parseDateInput(req.query.to));
    return res.redirect(`/export/url/${id}.xlsx${query}`);
  } catch (err) {
    return res.redirect('/reports?error=' + encodeURIComponent(err.message));
  }
});

router.get('/uptime-pdf', async (req, res) => {
  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.redirect('/reports?error=Invalid+monitor+ID');

  try {
    const owned = await ensureOwned({ req, table: 'uptime_monitors', id });
    if (!owned) return res.redirect('/reports?error=Monitor+not+found');
    const query = buildQuery(parseDateInput(req.query.from), parseDateInput(req.query.to));
    return res.redirect(`/export/uptime/${id}.pdf${query}`);
  } catch (err) {
    return res.redirect('/reports?error=' + encodeURIComponent(err.message));
  }
});

router.get('/uptime-xlsx', async (req, res) => {
  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.redirect('/reports?error=Invalid+monitor+ID');

  try {
    const owned = await ensureOwned({ req, table: 'uptime_monitors', id });
    if (!owned) return res.redirect('/reports?error=Monitor+not+found');
    const query = buildQuery(parseDateInput(req.query.from), parseDateInput(req.query.to));
    return res.redirect(`/export/uptime/${id}.xlsx${query}`);
  } catch (err) {
    return res.redirect('/reports?error=' + encodeURIComponent(err.message));
  }
});

router.get('/project-pdf', async (req, res) => {
  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.redirect('/reports?error=Invalid+project+ID');

  try {
    const owned = await ensureOwned({ req, table: 'projects', id });
    if (!owned) return res.redirect('/reports?error=Project+not+found');
    const query = buildQuery(parseDateInput(req.query.from), parseDateInput(req.query.to));
    return res.redirect(`/export/project/${id}.pdf${query}`);
  } catch (err) {
    return res.redirect('/reports?error=' + encodeURIComponent(err.message));
  }
});

router.get('/project-xlsx', async (req, res) => {
  const id = parseInt(req.query.id, 10);
  if (!Number.isFinite(id) || id <= 0) return res.redirect('/reports?error=Invalid+project+ID');

  try {
    const owned = await ensureOwned({ req, table: 'projects', id });
    if (!owned) return res.redirect('/reports?error=Project+not+found');
    const query = buildQuery(parseDateInput(req.query.from), parseDateInput(req.query.to));
    return res.redirect(`/export/project/${id}.xlsx${query}`);
  } catch (err) {
    return res.redirect('/reports?error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
