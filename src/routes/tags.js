const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

const TAG_PALETTE = [
  '#4299e1','#48bb78','#ed8936','#e53e3e','#9f7aea',
  '#38b2ac','#ed64a6','#ecc94b','#667eea','#f6ad55'
];

function randomColor() {
  return TAG_PALETTE[Math.floor(Math.random() * TAG_PALETTE.length)];
}

router.use(requireAuth);

// GET /tags
router.get('/', async (req, res, next) => {
  try {
    const { rows: tags } = await pool.query(
      'SELECT * FROM tag_definitions WHERE user_id = $1 ORDER BY name',
      [req.user.id]
    );

    // Count URLs per tag
    const { rows: counts } = await pool.query(
      `SELECT unnest(string_to_array(tags, ',')) AS tag, COUNT(*) AS cnt
       FROM monitored_urls WHERE user_id = $1 AND tags != ''
       GROUP BY 1`,
      [req.user.id]
    );
    const countMap = {};
    for (const r of counts) countMap[r.tag] = parseInt(r.cnt, 10);

    res.render('tags', {
      title: 'Tags',
      tags,
      countMap,
      palette: TAG_PALETTE,
      message: req.query.msg || null
    });
  } catch (err) { next(err); }
});

// POST /tags — create new tag
router.post('/', async (req, res, next) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) return res.redirect('/tags?msg=Name+required');

  const normalName = name.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '').substring(0, 30);
  const col = /^#[0-9a-fA-F]{6}$/.test(color) ? color : randomColor();

  try {
    await pool.query(
      `INSERT INTO tag_definitions (user_id, name, color) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, name) DO UPDATE SET color = $3`,
      [req.user.id, normalName, col]
    );
    res.redirect('/tags?msg=Tag+saved');
  } catch (err) { next(err); }
});

// POST /tags/:id/update — rename or recolor
router.post('/:id/update', async (req, res, next) => {
  const tagId = parseInt(req.params.id, 10);
  const { name, color } = req.body;
  const col = /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
  const normalName = name ? name.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '').substring(0, 30) : null;

  try {
    if (col) await pool.query('UPDATE tag_definitions SET color = $1 WHERE id = $2 AND user_id = $3', [col, tagId, req.user.id]);
    if (normalName) await pool.query('UPDATE tag_definitions SET name = $1 WHERE id = $2 AND user_id = $3', [normalName, tagId, req.user.id]);
    res.redirect('/tags?msg=Updated');
  } catch (err) { next(err); }
});

// POST /tags/:id/delete
router.post('/:id/delete', async (req, res, next) => {
  const tagId = parseInt(req.params.id, 10);
  try {
    const { rows: [tag] } = await pool.query(
      'DELETE FROM tag_definitions WHERE id = $1 AND user_id = $2 RETURNING name',
      [tagId, req.user.id]
    );
    if (tag) {
      // Remove from all URLs of this user
      await pool.query(
        `UPDATE monitored_urls
         SET tags = array_to_string(
           ARRAY(SELECT t FROM unnest(string_to_array(tags, ',')) t WHERE t != $1),
           ','
         )
         WHERE user_id = $2`,
        [tag.name, req.user.id]
      );
    }
    res.redirect('/tags?msg=Tag+deleted');
  } catch (err) { next(err); }
});

// POST /tags/ensure — auto-ensure tag_definitions exist for tags on add/edit
// Called internally; also used by auto-tagging
async function ensureTagDefs(userId, tagNames) {
  for (const name of tagNames) {
    if (!name) continue;
    await pool.query(
      `INSERT INTO tag_definitions (user_id, name, color) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, name) DO NOTHING`,
      [userId, name, randomColor()]
    );
  }
}

module.exports = router;
module.exports.ensureTagDefs = ensureTagDefs;
module.exports.randomColor = randomColor;
