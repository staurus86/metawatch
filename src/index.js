require('dotenv').config();
const express = require('express');
const ejsLayouts = require('express-ejs-layouts');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const pool = require('./db');
const migrate = require('./migrate');
const { startScheduler } = require('./scheduler');
const { isQueueEnabled } = require('./queue');
const { startQueueWorkers, isQueueWorkersEnabled } = require('./workers');
const { loadUserMiddleware } = require('./auth');
const { loadUserPlanMiddleware } = require('./plans');
const { i18nMiddleware } = require('./i18n');
const { csrfProtection } = require('./csrf');

const app = express();
const PORT = process.env.PORT || 3000;
const CUSTOM_DOMAIN_CACHE_TTL_MS = 60 * 1000;
const CUSTOM_DOMAIN_CACHE_MAX = 500;
const customDomainCache = new Map();

// Periodic cleanup of expired entries to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of customDomainCache) {
    if (value.expiresAt <= now) customDomainCache.delete(key);
  }
  // Hard cap: evict oldest if still over limit
  if (customDomainCache.size > CUSTOM_DOMAIN_CACHE_MAX) {
    const excess = customDomainCache.size - CUSTOM_DOMAIN_CACHE_MAX;
    const keys = [...customDomainCache.keys()].slice(0, excess);
    for (const k of keys) customDomainCache.delete(k);
  }
}, 5 * 60 * 1000).unref();

function parseEnvBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

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

// Gzip/Brotli compression — reduces network egress ~80%
app.use(compression({ threshold: 512 }));

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
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '7d',
  etag: true
}));

// Load current user into req.user + res.locals.user for all routes
app.use(loadUserMiddleware);
app.use(loadUserPlanMiddleware);
app.use(i18nMiddleware);
app.use(csrfProtection);

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
app.use('/reports', require('./routes/reports'));
app.use('/uptime', require('./routes/uptime'));
app.use('/export', require('./routes/export'));
app.use('/notifications', require('./routes/notifications'));
app.use('/tags', require('./routes/tags'));
app.use('/status-pages', require('./routes/status-pages'));
app.use('/competitors', require('./routes/competitors'));
app.use('/integrations', require('./routes/integrations'));
app.use('/alert-rules', require('./routes/alert-rules'));
app.use('/admin/queues', require('./routes/admin-queues'));
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
  console.error(`[Error] ${req.method} ${req.originalUrl} user=${req.user?.id || 'anon'}`, err.stack);
  const userMessage = process.env.NODE_ENV === 'production'
    ? 'An internal error occurred. Please try again later.'
    : err.message;
  res.status(500).render('error', { title: 'Error', error: userMessage });
});

async function start() {
  try {
    await migrate();
    const schedulerEnabled = parseEnvBool(process.env.ENABLE_SCHEDULER, true);
    const queueEnabled = isQueueEnabled();
    const queueWorkersEnabled = isQueueWorkersEnabled();
    const implicitWorkerOnlyMode = queueEnabled && queueWorkersEnabled && !schedulerEnabled;
    const webEnabled = parseEnvBool(process.env.ENABLE_WEB, !implicitWorkerOnlyMode);

    if (queueEnabled && queueWorkersEnabled) {
      await startQueueWorkers();
    }

    if (!webEnabled) {
      const modeSource = process.env.ENABLE_WEB == null || process.env.ENABLE_WEB === ''
        ? 'auto'
        : 'explicit';
      console.log(`[Web] Disabled (${modeSource} mode). Web server is not started.`);
      if (!schedulerEnabled && !queueWorkersEnabled) {
        console.log('[Runtime] ENABLE_SCHEDULER=false and ENABLE_QUEUE_WORKERS=false; process is idle.');
      }
      return;
    }

    if (schedulerEnabled) {
      await startScheduler();
    } else {
      console.log('[Scheduler] Disabled by ENABLE_SCHEDULER=false');
    }
    const server = app.listen(PORT, () => {
      console.log(`✓ MetaWatch v2 running on http://localhost:${PORT}`);
    });

    // Graceful shutdown
    let shuttingDown = false;
    async function gracefulShutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n[Shutdown] ${signal} received — closing server...`);

      server.close(() => {
        console.log('[Shutdown] HTTP server closed');
      });

      // Close headless browsers to free RAM
      try {
        const { closeHeadlessBrowser } = require('./headless-scraper');
        await closeHeadlessBrowser();
        console.log('[Shutdown] Headless browser closed');
      } catch { /* may not be running */ }

      // Close queue connections
      try {
        const { closeBullQueues } = require('./queue');
        await closeBullQueues();
        console.log('[Shutdown] Queue connections closed');
      } catch { /* queue may not be enabled */ }

      // Drain DB pool
      try {
        await pool.end();
        console.log('[Shutdown] DB pool drained');
      } catch { /* already closed */ }

      process.exit(0);
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

// Process-level error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err);
  process.exit(1);
});

start();
