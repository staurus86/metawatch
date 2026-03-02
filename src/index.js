require('dotenv').config();
const express = require('express');
const ejsLayouts = require('express-ejs-layouts');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const path = require('path');
const pool = require('./db');
const migrate = require('./migrate');
const { startScheduler } = require('./scheduler');
const { loadUserMiddleware } = require('./auth');
const { loadUserPlanMiddleware } = require('./plans');
const { i18nMiddleware } = require('./i18n');

const app = express();
const PORT = process.env.PORT || 3000;
const CUSTOM_DOMAIN_CACHE_TTL_MS = 60 * 1000;
const customDomainCache = new Map();

function normalizeHostHeader(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.replace(/:\d+$/, '').replace(/\.$/, '');
}

async function resolveStatusSlugByHost(host) {
  const now = Date.now();
  const cached = customDomainCache.get(host);
  if (cached && cached.expiresAt > now) return cached.slug;

  const { rows: [row] } = await pool.query(
    `SELECT slug
     FROM status_pages
     WHERE is_public = true
       AND custom_domain IS NOT NULL
       AND lower(custom_domain) = lower($1)
     LIMIT 1`,
    [host]
  );
  const slug = row?.slug || null;
  customDomainCache.set(host, { slug, expiresAt: now + CUSTOM_DOMAIN_CACHE_TTL_MS });
  return slug;
}

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(ejsLayouts);
app.set('layout', 'layout');

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'cdn.jsdelivr.net'],
      scriptSrcAttr: ["'none'"],
      styleSrc:  ["'self'", "'unsafe-inline'"],
      imgSrc:    ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'cdn.jsdelivr.net'],
      fontSrc:   ["'self'", 'data:']
    }
  }
}));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/billing/webhook')) {
      req.rawBody = buf.toString('utf8');
    }
  }
}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Load current user into req.user + res.locals.user for all routes
app.use(loadUserMiddleware);
app.use(loadUserPlanMiddleware);
app.use(i18nMiddleware);

// Custom-domain status pages: rewrite root requests to matching status page.
app.use(async (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  if (req.path !== '/') return next();

  const host = normalizeHostHeader(req.headers.host);
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return next();

  try {
    const slug = await resolveStatusSlugByHost(host);
    if (!slug) return next();
    req.url = `/status/page/${slug}`;
    return next();
  } catch (err) {
    console.error('[StatusDomain] Host lookup failed:', err.message);
    return next();
  }
});

// Routes — auth (no auth required)
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/landing'));
app.use('/', require('./routes/help'));

// Routes — protected
app.use('/', require('./routes/dashboard'));
app.use('/urls', require('./routes/urls'));
app.use('/projects', require('./routes/projects'));
app.use('/billing', require('./routes/billing'));
app.use('/uptime', require('./routes/uptime'));
app.use('/export', require('./routes/export'));
app.use('/notifications', require('./routes/notifications'));
app.use('/tags', require('./routes/tags'));
app.use('/status-pages', require('./routes/status-pages'));
app.use('/competitors', require('./routes/competitors'));
app.use('/integrations', require('./routes/integrations'));
app.use('/alert-rules', require('./routes/alert-rules'));
app.use('/admin', require('./routes/admin'));
app.use('/profile', require('./routes/profile'));
app.use('/api/v2', require('./routes/api-v2'));
app.use('/api', require('./routes/api'));

// Public status page — no auth
app.use('/status', require('./routes/status'));

// 404
app.use((req, res) => {
  res.status(404).render('error', { title: 'Not Found', error: 'Page not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { title: 'Error', error: err.message });
});

async function start() {
  try {
    await migrate();
    const schedulerEnabled = String(process.env.ENABLE_SCHEDULER || 'true').toLowerCase() !== 'false';
    if (schedulerEnabled) {
      await startScheduler();
    } else {
      console.log('[Scheduler] Disabled by ENABLE_SCHEDULER=false');
    }
    app.listen(PORT, () => {
      console.log(`✓ MetaWatch v2 running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

start();
