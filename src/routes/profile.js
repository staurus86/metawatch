const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth, generateApiKey, hashPassword, comparePassword } = require('../auth');

// GET /profile
router.get('/', requireAuth, (req, res) => {
  res.render('profile', {
    title: 'My Profile',
    message: req.query.msg || null,
    error: null
  });
});

// POST /profile/regenerate-key
router.post('/regenerate-key', requireAuth, async (req, res) => {
  try {
    const newKey = generateApiKey();
    await pool.query('UPDATE users SET api_key = $1 WHERE id = $2', [newKey, req.user.id]);
    res.redirect('/profile?msg=API+key+regenerated');
  } catch (err) {
    console.error(err);
    res.redirect('/profile?msg=Error:+' + encodeURIComponent(err.message));
  }
});

// POST /profile/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password, new_password2 } = req.body;

  const renderErr = (msg) => res.render('profile', {
    title: 'My Profile',
    message: null,
    error: msg
  });

  if (!current_password || !new_password) return renderErr('All fields are required.');
  if (new_password !== new_password2) return renderErr('New passwords do not match.');
  if (new_password.length < 8) return renderErr('Password must be at least 8 characters.');

  try {
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const valid = await comparePassword(current_password, user.password_hash);
    if (!valid) return renderErr('Current password is incorrect.');

    const hash = await hashPassword(new_password);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.redirect('/profile?msg=Password+changed+successfully');
  } catch (err) {
    console.error(err);
    renderErr(err.message);
  }
});

module.exports = router;
