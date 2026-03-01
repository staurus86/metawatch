const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const { requireAdmin, generateApiKey } = require('../auth');
const { sendAlert } = require('../mailer');

// GET /admin/users
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const { rows: users } = await pool.query(
      'SELECT id, email, role, api_key, created_at FROM users ORDER BY created_at ASC'
    );
    const { rows: invites } = await pool.query(
      `SELECT i.*, u.email AS inviter_email
       FROM invites i
       LEFT JOIN users u ON u.id = i.invited_by_id
       ORDER BY i.created_at DESC LIMIT 20`
    );
    res.render('admin', {
      title: 'Admin — Users',
      users,
      invites,
      inviteLink: null,
      message: req.query.msg || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// POST /admin/invite — create invite link
router.post('/invite', requireAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email || !email.trim()) {
    return res.redirect('/admin/users?msg=Email+is+required');
  }

  try {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO invites (email, token, invited_by_id) VALUES ($1, $2, $3)`,
      [email.trim().toLowerCase(), token, req.user.id]
    );

    const baseUrl = process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 3000);
    const inviteUrl = `${baseUrl}/invite/${token}`;

    // Try to send email
    let emailSent = false;
    if (process.env.SMTP_HOST) {
      emailSent = await sendAlert({
        to: email.trim(),
        url: inviteUrl,
        field: 'Invitation',
        oldValue: '',
        newValue: `You have been invited to MetaWatch. Click here to register: ${inviteUrl}`,
        timestamp: new Date()
      }).catch(() => false);
    }

    const { rows: users } = await pool.query(
      'SELECT id, email, role, api_key, created_at FROM users ORDER BY created_at ASC'
    );
    const { rows: invites } = await pool.query(
      `SELECT i.*, u.email AS inviter_email
       FROM invites i
       LEFT JOIN users u ON u.id = i.invited_by_id
       ORDER BY i.created_at DESC LIMIT 20`
    );

    res.render('admin', {
      title: 'Admin — Users',
      users,
      invites,
      inviteLink: inviteUrl,
      message: emailSent ? 'Invite email sent!' : null
    });
  } catch (err) {
    console.error(err);
    res.redirect('/admin/users?msg=' + encodeURIComponent(err.message));
  }
});

// POST /admin/users/:id/revoke — delete user
router.post('/users/:id/revoke', requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (userId === req.user.id) {
    return res.redirect('/admin/users?msg=Cannot+revoke+your+own+account');
  }
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    res.redirect('/admin/users?msg=User+removed');
  } catch (err) {
    console.error(err);
    res.redirect('/admin/users?msg=' + encodeURIComponent(err.message));
  }
});

// POST /admin/users/:id/role — change role
router.post('/users/:id/role', requireAdmin, async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const { role } = req.body;
  if (!['admin', 'viewer'].includes(role)) {
    return res.redirect('/admin/users?msg=Invalid+role');
  }
  try {
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);
    res.redirect('/admin/users?msg=Role+updated');
  } catch (err) {
    res.redirect('/admin/users?msg=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
