const crypto = require('crypto');

const COOKIE_NAME = 'mw_csrf';
const HEADER_NAME = 'x-csrf-token';
const BODY_FIELD = '_csrf';
const TOKEN_BYTES = 32;

// Secret per process (regenerated on restart — acceptable for CSRF)
const SECRET = crypto.randomBytes(32);

function generateToken() {
  const nonce = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  const hmac = crypto.createHmac('sha256', SECRET).update(nonce).digest('hex');
  return nonce + '.' + hmac;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [nonce, hmac] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(nonce).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * CSRF middleware — Double Submit Cookie pattern.
 * Skips: API routes (authenticated via X-API-Key), Stripe webhook, public status endpoints.
 */
function csrfProtection(req, res, next) {
  // Skip paths that use alternative auth (API key, webhook signature)
  if (req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/billing/webhook')) return next();
  if (req.path.startsWith('/status/') && req.path.includes('/subscribe')) return next();

  // For GET/HEAD/OPTIONS — set token if missing
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    let token = req.cookies?.[COOKIE_NAME];
    if (!token || !verifyToken(token)) {
      token = generateToken();
      res.cookie(COOKIE_NAME, token, {
        httpOnly: false,   // JS needs to read it for fetch headers
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/'
      });
    }
    res.locals.csrfToken = token;
    return next();
  }

  // For POST/PUT/DELETE/PATCH — validate token
  const cookieToken = req.cookies?.[COOKIE_NAME];
  const submittedToken = req.body?.[BODY_FIELD] || req.headers[HEADER_NAME];

  if (!cookieToken || !submittedToken) {
    return res.status(403).render('error', {
      title: 'Forbidden',
      error: 'Missing CSRF token. Please refresh the page and try again.'
    });
  }

  if (cookieToken !== submittedToken || !verifyToken(cookieToken)) {
    return res.status(403).render('error', {
      title: 'Forbidden',
      error: 'Invalid CSRF token. Please refresh the page and try again.'
    });
  }

  // Valid — make token available for re-renders
  res.locals.csrfToken = cookieToken;
  next();
}

module.exports = { csrfProtection, COOKIE_NAME };
