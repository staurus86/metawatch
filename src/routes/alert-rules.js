const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

const FIELD_OPTIONS = [
  'title', 'description', 'h1', 'response_code', 'noindex',
  'canonical', 'redirect_url', 'robots_txt', 'hreflang', 'og_title',
  'og_description', 'og_image', 'custom_text', 'response_time_ms'
];
const OPERATOR_OPTIONS = ['changed', 'equals', 'contains', 'not_contains', 'gt', 'lt'];
const ACTION_OPTIONS   = ['send_email', 'send_telegram', 'send_webhook', 'suppress_alert'];

// GET /alert-rules — list all rules for user
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: rules } = await pool.query(
      'SELECT * FROM alert_rules WHERE user_id = $1 ORDER BY created_at ASC',
      [req.user.id]
    );
    res.render('alert-rules', { title: 'Alert Rules', rules });
  } catch (err) {
    res.status(500).render('error', { message: err.message });
  }
});

// GET /alert-rules/new — rule builder form
router.get('/new', requireAuth, (req, res) => {
  res.render('alert-rules-new', {
    title: 'New Alert Rule',
    rule: null,
    fieldOptions: FIELD_OPTIONS,
    operatorOptions: OPERATOR_OPTIONS,
    actionOptions: ACTION_OPTIONS,
    error: null
  });
});

// POST /alert-rules — create rule
router.post('/', requireAuth, async (req, res) => {
  const { name, conditions_json, actions_json } = req.body;

  let conditions, actions;
  try {
    conditions = JSON.parse(conditions_json || '[]');
    actions    = JSON.parse(actions_json || '[]');
  } catch {
    return res.render('alert-rules-new', {
      title: 'New Alert Rule',
      rule: null,
      fieldOptions: FIELD_OPTIONS,
      operatorOptions: OPERATOR_OPTIONS,
      actionOptions: ACTION_OPTIONS,
      error: 'Invalid JSON in conditions or actions'
    });
  }

  if (!name || !name.trim()) {
    return res.render('alert-rules-new', {
      title: 'New Alert Rule',
      rule: null,
      fieldOptions: FIELD_OPTIONS,
      operatorOptions: OPERATOR_OPTIONS,
      actionOptions: ACTION_OPTIONS,
      error: 'Rule name is required'
    });
  }

  try {
    await pool.query(
      `INSERT INTO alert_rules (user_id, name, conditions, actions)
       VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
      [req.user.id, name.trim(), JSON.stringify(conditions), JSON.stringify(actions)]
    );
    res.redirect('/alert-rules');
  } catch (err) {
    res.status(500).render('error', { message: err.message });
  }
});

// POST /alert-rules/:id/toggle — enable/disable rule
router.post('/:id/toggle', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await pool.query(
      'UPDATE alert_rules SET is_active = NOT is_active WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    res.redirect('/alert-rules');
  } catch (err) {
    res.status(500).render('error', { message: err.message });
  }
});

// POST /alert-rules/:id/delete
router.post('/:id/delete', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await pool.query(
      'DELETE FROM alert_rules WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    res.redirect('/alert-rules');
  } catch (err) {
    res.status(500).render('error', { message: err.message });
  }
});

// GET /alert-rules/:id/edit
router.get('/:id/edit', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rows: [rule] } = await pool.query(
      'SELECT * FROM alert_rules WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (!rule) return res.status(404).render('error', { message: 'Rule not found' });

    res.render('alert-rules-new', {
      title: 'Edit Alert Rule',
      rule,
      fieldOptions: FIELD_OPTIONS,
      operatorOptions: OPERATOR_OPTIONS,
      actionOptions: ACTION_OPTIONS,
      error: null
    });
  } catch (err) {
    res.status(500).render('error', { message: err.message });
  }
});

// POST /alert-rules/:id/edit — save changes
router.post('/:id/edit', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, conditions_json, actions_json } = req.body;

  let conditions, actions;
  try {
    conditions = JSON.parse(conditions_json || '[]');
    actions    = JSON.parse(actions_json || '[]');
  } catch {
    const { rows: [rule] } = await pool.query(
      'SELECT * FROM alert_rules WHERE id = $1 AND user_id = $2', [id, req.user.id]
    );
    return res.render('alert-rules-new', {
      title: 'Edit Alert Rule', rule,
      fieldOptions: FIELD_OPTIONS, operatorOptions: OPERATOR_OPTIONS,
      actionOptions: ACTION_OPTIONS, error: 'Invalid JSON'
    });
  }

  try {
    await pool.query(
      `UPDATE alert_rules SET name=$1, conditions=$2::jsonb, actions=$3::jsonb
       WHERE id=$4 AND user_id=$5`,
      [name.trim(), JSON.stringify(conditions), JSON.stringify(actions), id, req.user.id]
    );
    res.redirect('/alert-rules');
  } catch (err) {
    res.status(500).render('error', { message: err.message });
  }
});

// Export helpers for checker.js to use
module.exports = router;
module.exports.FIELD_OPTIONS = FIELD_OPTIONS;
