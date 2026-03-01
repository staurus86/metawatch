const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../auth');
const { checkCompetitor } = require('../competitor-checker');

const COMPARE_FIELDS = [
  { key: 'title',       label: 'Title' },
  { key: 'description', label: 'Meta Description' },
  { key: 'h1',          label: 'H1' },
  { key: 'canonical',   label: 'Canonical' },
  { key: 'noindex',     label: 'noindex' },
  { key: 'redirect_url',label: 'Redirect URL' },
  { key: 'og_title',    label: 'OG Title' },
  { key: 'og_description', label: 'OG Description' }
];

router.use(requireAuth);

// GET /competitors
router.get('/', async (req, res, next) => {
  try {
    const { rows: competitors } = await pool.query(
      `SELECT cu.*, mu.url AS your_url
       FROM competitor_urls cu
       LEFT JOIN monitored_urls mu ON mu.id = cu.your_url_id
       WHERE cu.user_id = $1
       ORDER BY cu.created_at DESC`,
      [req.user.id]
    );
    res.render('competitors', {
      title: 'Competitor Monitoring',
      competitors,
      message: req.query.msg || null
    });
  } catch (err) { next(err); }
});

// GET /competitors/add
router.get('/add', async (req, res, next) => {
  try {
    const { rows: myUrls } = await pool.query(
      'SELECT id, url FROM monitored_urls WHERE user_id = $1 AND is_active = true ORDER BY url',
      [req.user.id]
    );
    res.render('competitor-add', {
      title: 'Add Competitor',
      myUrls,
      error: null,
      values: {}
    });
  } catch (err) { next(err); }
});

// POST /competitors
router.post('/', async (req, res, next) => {
  const { your_url_id, competitor_url, name } = req.body;
  if (!competitor_url || !name) {
    const { rows: myUrls } = await pool.query(
      'SELECT id, url FROM monitored_urls WHERE user_id = $1 AND is_active = true ORDER BY url',
      [req.user.id]
    );
    return res.render('competitor-add', {
      title: 'Add Competitor', myUrls,
      error: 'Competitor URL and name are required', values: req.body
    });
  }

  try {
    const { rows: [comp] } = await pool.query(
      `INSERT INTO competitor_urls (user_id, your_url_id, competitor_url, name)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.user.id, your_url_id ? parseInt(your_url_id, 10) : null, competitor_url.trim(), name.trim()]
    );
    // Kick off immediate check
    checkCompetitor(comp.id).catch(() => {});
    res.redirect(`/competitors/${comp.id}`);
  } catch (err) { next(err); }
});

// GET /competitors/:id
router.get('/:id', async (req, res, next) => {
  const compId = parseInt(req.params.id, 10);
  try {
    const { rows: [comp] } = await pool.query(
      `SELECT cu.*, mu.url AS your_url, mu.id AS your_url_id_val
       FROM competitor_urls cu
       LEFT JOIN monitored_urls mu ON mu.id = cu.your_url_id
       WHERE cu.id = $1 AND cu.user_id = $2`,
      [compId, req.user.id]
    );
    if (!comp) return res.status(404).render('error', { title: 'Not Found', error: 'Not found' });

    // Latest competitor snapshot
    const { rows: [compSnap] } = await pool.query(
      'SELECT * FROM competitor_snapshots WHERE competitor_url_id = $1 ORDER BY checked_at DESC LIMIT 1',
      [compId]
    );

    // Latest your snapshot
    let yourSnap = null;
    if (comp.your_url_id) {
      const { rows: [s] } = await pool.query(
        'SELECT * FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC LIMIT 1',
        [comp.your_url_id]
      );
      yourSnap = s || null;
    }

    // Build comparison
    const comparison = COMPARE_FIELDS.map(f => {
      const yourVal = yourSnap ? String(yourSnap[f.key] ?? '') : null;
      const compVal = compSnap ? String(compSnap[f.key] ?? '') : null;
      let status = 'same';
      if (yourVal === null && compVal !== null) status = 'you-missing';
      else if (compVal === null && yourVal !== null) status = 'they-missing';
      else if (yourVal !== compVal) status = 'different';
      return { label: f.label, yourVal, compVal, status };
    });

    // History: title length over last 30 snapshots (yours vs competitor)
    const { rows: yourHistory } = comp.your_url_id ? await pool.query(
      `SELECT checked_at, COALESCE(LENGTH(title), 0) AS title_len
       FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC LIMIT 30`,
      [comp.your_url_id]
    ) : { rows: [] };
    const { rows: compHistory } = await pool.query(
      `SELECT checked_at, COALESCE(LENGTH(title), 0) AS title_len
       FROM competitor_snapshots WHERE competitor_url_id = $1 ORDER BY checked_at DESC LIMIT 30`,
      [compId]
    );

    res.render('competitor-detail', {
      title: comp.name,
      comp,
      compSnap,
      yourSnap,
      comparison,
      yourHistory: yourHistory.reverse(),
      compHistory: compHistory.reverse(),
      fields: COMPARE_FIELDS
    });
  } catch (err) { next(err); }
});

// POST /competitors/:id/check-now
router.post('/:id/check-now', async (req, res, next) => {
  const compId = parseInt(req.params.id, 10);
  try {
    const { rows: [comp] } = await pool.query(
      'SELECT * FROM competitor_urls WHERE id = $1 AND user_id = $2',
      [compId, req.user.id]
    );
    if (!comp) return res.status(404).json({ error: 'Not found' });
    await checkCompetitor(compId);
    res.redirect(`/competitors/${compId}?msg=Checked`);
  } catch (err) { next(err); }
});

// POST /competitors/:id/delete
router.post('/:id/delete', async (req, res, next) => {
  const compId = parseInt(req.params.id, 10);
  try {
    await pool.query('DELETE FROM competitor_urls WHERE id = $1 AND user_id = $2', [compId, req.user.id]);
    res.redirect('/competitors?msg=Deleted');
  } catch (err) { next(err); }
});

module.exports = router;
