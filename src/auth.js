const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  const s = crypto.randomBytes(32).toString('hex');
  if (!process.env.JWT_SECRET) {
    console.warn('[Auth] JWT_SECRET not set — using random secret (sessions will not survive restart)');
  }
  return s;
})();

const COOKIE_NAME = 'mw_token';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    maxAge: COOKIE_MAX_AGE,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

async function getUserFromToken(token) {
  try {
    const { userId } = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    return rows[0] || null;
  } catch {
    return null;
  }
}

async function loadUserMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  res.locals.user = null;
  if (token) {
    const user = await getUserFromToken(token);
    if (user) {
      req.user = user;
      res.locals.user = user;
    }
  }
  next();
}

async function requireAuth(req, res, next) {
  if (!req.user) {
    return res.redirect('/login');
  }
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', { title: 'Forbidden', error: 'Admin access required' });
  }
  next();
}

async function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API key required. Pass X-API-Key header.' });
  try {
    const keyHash = hashApiKey(apiKey);
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE api_key = $1 OR api_key_hash = $2',
      [apiKey, keyHash]
    );
    if (!rows[0]) return res.status(401).json({ error: 'Invalid API key.' });
    req.user = rows[0];
    try {
      const { getUserPlanData } = require('./plans');
      const { plan, subscription } = await getUserPlanData(req.user.id);
      req.userPlan = plan;
      req.userSubscription = subscription;
    } catch {
      // non-fatal for API auth
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(String(apiKey || '')).digest('hex');
}

function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}

function comparePassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

module.exports = {
  signToken,
  setAuthCookie,
  clearAuthCookie,
  loadUserMiddleware,
  requireAuth,
  requireAdmin,
  requireApiKey,
  generateApiKey,
  hashApiKey,
  hashPassword,
  comparePassword,
  COOKIE_NAME
};
