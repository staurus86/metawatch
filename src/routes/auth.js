const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const {
  signToken, setAuthCookie, clearAuthCookie,
  hashPassword, comparePassword, generateApiKey, hashApiKey
} = require('../auth');

// Simple in-memory rate limiter for login: max 10 attempts per 15 min per IP
const loginAttempts = new Map();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPTS_MAX_TRACKED = 50000;

function pruneLoginAttempts(now = Date.now()) {
  for (const [key, entry] of loginAttempts.entries()) {
    if (!entry || now > entry.resetAt) {
      loginAttempts.delete(key);
    }
  }
  if (loginAttempts.size <= LOGIN_ATTEMPTS_MAX_TRACKED) return;
  const oldestKeys = [...loginAttempts.entries()]
    .sort((a, b) => (a[1]?.resetAt || 0) - (b[1]?.resetAt || 0))
    .slice(0, loginAttempts.size - LOGIN_ATTEMPTS_MAX_TRACKED)
    .map(([ip]) => ip);
  oldestKeys.forEach(ip => loginAttempts.delete(ip));
}

const loginAttemptsCleanupTimer = setInterval(() => {
  pruneLoginAttempts();
}, 5 * 60 * 1000);
if (typeof loginAttemptsCleanupTimer.unref === 'function') {
  loginAttemptsCleanupTimer.unref();
}

function isRateLimited(ip) {
  const now = Date.now();
  pruneLoginAttempts(now);
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// GET /login
router.get('/login', (req, res) => {
  if (res.locals.user) return res.redirect('/');
  res.render('login', { title: 'Login', error: null, layout: 'layout-auth' });
});

// POST /login
router.post('/login', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).render('login', {
      title: 'Login',
      error: 'Too many login attempts. Please wait 15 minutes.',
      layout: 'layout-auth'
    });
  }

  const { email, password } = req.body;
  if (!email || !password) {
    return res.render('login', { title: 'Login', error: 'Email and password are required.', layout: 'layout-auth' });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    const user = rows[0];
    if (!user) {
      return res.render('login', { title: 'Login', error: 'Invalid email or password.', layout: 'layout-auth' });
    }

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) {
      return res.render('login', { title: 'Login', error: 'Invalid email or password.', layout: 'layout-auth' });
    }

    const token = signToken(user.id);
    setAuthCookie(res, token);
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('login', { title: 'Login', error: err.message });
  }
});

// POST /logout
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.redirect('/login');
});

// GET /register
router.get('/register', async (req, res) => {
  if (res.locals.user) return res.redirect('/');

  try {
    const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM users');
    const isFirstUser = parseInt(rows[0].cnt, 10) === 0;

    if (!isFirstUser) {
      // Registration only allowed via invite link
      return res.redirect('/login');
    }

    res.render('register', {
      title: 'Create Account',
      error: null,
      email: '',
      inviteToken: null,
      isFirstUser: true,
      layout: 'layout-auth'
    });
  } catch (err) {
    console.error(err);
    res.render('error', { title: 'Error', error: err.message });
  }
});

// POST /register
router.post('/register', async (req, res) => {
  if (res.locals.user) return res.redirect('/');

  const { email, password, password2 } = req.body;

  const renderErr = (msg) => res.render('register', {
    title: 'Create Account',
    error: msg,
    email: email || '',
    inviteToken: null,
    isFirstUser: true,
    layout: 'layout-auth'
  });

  if (!email || !password) return renderErr('Email and password are required.');
  if (password !== password2) return renderErr('Passwords do not match.');
  if (password.length < 8) return renderErr('Password must be at least 8 characters.');

  try {
    const { rows: countRows } = await pool.query('SELECT COUNT(*) AS cnt FROM users');
    const isFirstUser = parseInt(countRows[0].cnt, 10) === 0;

    if (!isFirstUser) return res.redirect('/login');

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (existing.rows[0]) return renderErr('Email already registered.');

    const hash = await hashPassword(password);
    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);
    const apiKeyLast4 = apiKey.slice(-4);

    const { rows: [user] } = await pool.query(
      `INSERT INTO users (email, password_hash, role, api_key, api_key_hash, api_key_last4)
       VALUES ($1, $2, 'admin', $3, $4, $5) RETURNING *`,
      [email.trim().toLowerCase(), hash, apiKey, apiKeyHash, apiKeyLast4]
    );

    const token = signToken(user.id);
    setAuthCookie(res, token);
    res.redirect('/');
  } catch (err) {
    console.error(err);
    renderErr(err.message);
  }
});

// GET /invite/:token
router.get('/invite/:token', async (req, res) => {
  if (res.locals.user) return res.redirect('/');

  try {
    const { rows } = await pool.query(
      'SELECT * FROM invites WHERE token = $1 AND used = false',
      [req.params.token]
    );
    const invite = rows[0];
    if (!invite) {
      return res.render('error', { title: 'Invalid Invite', error: 'This invite link is invalid or has already been used.' });
    }

    res.render('register', {
      title: 'Accept Invitation',
      error: null,
      email: invite.email,
      inviteToken: invite.token,
      isFirstUser: false,
      layout: 'layout-auth'
    });
  } catch (err) {
    console.error(err);
    res.render('error', { title: 'Error', error: err.message });
  }
});

// POST /invite/:token
router.post('/invite/:token', async (req, res) => {
  if (res.locals.user) return res.redirect('/');

  const { email, password, password2 } = req.body;
  const token = req.params.token;

  const renderErr = (msg) => res.render('register', {
    title: 'Accept Invitation',
    error: msg,
    email: email || '',
    inviteToken: token,
    isFirstUser: false,
    layout: 'layout-auth'
  });

  try {
    const { rows } = await pool.query(
      'SELECT * FROM invites WHERE token = $1 AND used = false',
      [token]
    );
    const invite = rows[0];
    if (!invite) return res.render('error', { title: 'Invalid Invite', error: 'Invalid or expired invite link.' });

    if (!email || !password) return renderErr('Email and password are required.');
    if (password !== password2) return renderErr('Passwords do not match.');
    if (password.length < 8) return renderErr('Password must be at least 8 characters.');

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (existing.rows[0]) return renderErr('Email already registered.');

    const hash = await hashPassword(password);
    const apiKey = generateApiKey();
    const apiKeyHash = hashApiKey(apiKey);
    const apiKeyLast4 = apiKey.slice(-4);

    const { rows: [user] } = await pool.query(
      `INSERT INTO users (email, password_hash, role, api_key, api_key_hash, api_key_last4, invited_by_id)
       VALUES ($1, $2, 'viewer', $3, $4, $5, $6) RETURNING *`,
      [email.trim().toLowerCase(), hash, apiKey, apiKeyHash, apiKeyLast4, invite.invited_by_id]
    );

    await pool.query('UPDATE invites SET used = true WHERE id = $1', [invite.id]);

    const jwtToken = signToken(user.id);
    setAuthCookie(res, jwtToken);
    res.redirect('/');
  } catch (err) {
    console.error(err);
    renderErr(err.message);
  }
});

module.exports = router;
