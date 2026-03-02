const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const pool = require('../db');
const { requireApiKey, hashApiKey } = require('../auth');
const { checkUrl } = require('../checker');
const { sendPagerDuty } = require('../notifier');

const router = express.Router();
const MAX_PER_PAGE = 100;
const API_RATE_LIMIT_WINDOW_MS = Math.max(1000, parseInt(process.env.API_RATE_LIMIT_WINDOW_MS || '60000', 10) || 60000);
const API_RATE_LIMIT_MAX = Math.max(1, parseInt(process.env.API_RATE_LIMIT_MAX || '100', 10) || 100);

const apiLimiter = rateLimit({
  windowMs: API_RATE_LIMIT_WINDOW_MS,
  max: API_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const apiKey = String(req.headers['x-api-key'] || '').trim();
    if (apiKey) return `api:${hashApiKey(apiKey)}`;
    return `ip:${ipKeyGenerator(req.ip)}`;
  },
  message: { error: `Too many requests. Limit: ${API_RATE_LIMIT_MAX} per ${Math.round(API_RATE_LIMIT_WINDOW_MS / 1000)}s per API key or IP.` }
});

router.use(apiLimiter);
router.use(requireApiKey);

function isAdminUser(req) {
  return req.user?.role === 'admin';
}

function ok(res, data, meta = null) {
  return res.json({ data, meta, error: null });
}

function fail(res, status, message) {
  return res.status(status).json({
    data: null,
    meta: null,
    error: { message }
  });
}

function parsePagination(query) {
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  const perPageRaw = parseInt(String(query.per_page || '25'), 10) || 25;
  const perPage = Math.max(1, Math.min(MAX_PER_PAGE, perPageRaw));
  return { page, perPage, offset: (page - 1) * perPage };
}

function buildMeta(total, page, perPage) {
  const pages = Math.max(1, Math.ceil((total || 0) / perPage));
  return { total: total || 0, page, per_page: perPage, pages };
}

function parseDateParam(value) {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

async function getOwnedUrl(urlId, req) {
  const isAdmin = isAdminUser(req);
  const { rows: [url] } = await pool.query(
    isAdmin
      ? 'SELECT * FROM monitored_urls WHERE id = $1'
      : 'SELECT * FROM monitored_urls WHERE id = $1 AND user_id = $2',
    isAdmin ? [urlId] : [urlId, req.user.id]
  );
  return url || null;
}

async function getOwnedMonitor(monitorId, req) {
  const isAdmin = isAdminUser(req);
  const { rows: [monitor] } = await pool.query(
    isAdmin
      ? 'SELECT * FROM uptime_monitors WHERE id = $1'
      : 'SELECT * FROM uptime_monitors WHERE id = $1 AND user_id = $2',
    isAdmin ? [monitorId] : [monitorId, req.user.id]
  );
  return monitor || null;
}

async function buildStatsPayload(req) {
  const isAdmin = isAdminUser(req);
  const summarySql = isAdmin ? `
      WITH latest AS (
        SELECT DISTINCT ON (s.url_id)
          s.url_id,
          COALESCE(s.status_code, 0) AS status_code,
          COALESCE(s.noindex, false) AS noindex
        FROM snapshots s
        JOIN monitored_urls mu ON mu.id = s.url_id
        ORDER BY s.url_id, s.checked_at DESC
      ),
      changed AS (
        SELECT DISTINCT a.url_id
        FROM alerts a
        JOIN monitored_urls mu ON mu.id = a.url_id
        WHERE a.detected_at > NOW() - INTERVAL '24 hours'
      )
      SELECT
        (SELECT COUNT(*)::int FROM monitored_urls) AS total_urls,
        (SELECT ROUND(AVG(health_score)::numeric, 1) FROM monitored_urls) AS avg_health_score,
        (SELECT COUNT(*)::int FROM latest) AS latest_count,
        (SELECT COUNT(*)::int FROM latest WHERE status_code = 0 OR status_code >= 400) AS error_count,
        (SELECT COUNT(*)::int FROM latest WHERE noindex = true) AS noindex_count,
        (SELECT COUNT(*)::int FROM latest WHERE noindex = false) AS indexed_count,
        (SELECT COUNT(*)::int
           FROM latest l
           JOIN changed c ON c.url_id = l.url_id
          WHERE l.status_code BETWEEN 1 AND 399) AS changed_count
    ` : `
      WITH latest AS (
        SELECT DISTINCT ON (s.url_id)
          s.url_id,
          COALESCE(s.status_code, 0) AS status_code,
          COALESCE(s.noindex, false) AS noindex
        FROM snapshots s
        JOIN monitored_urls mu ON mu.id = s.url_id
        WHERE mu.user_id = $1
        ORDER BY s.url_id, s.checked_at DESC
      ),
      changed AS (
        SELECT DISTINCT a.url_id
        FROM alerts a
        JOIN monitored_urls mu ON mu.id = a.url_id
        WHERE a.detected_at > NOW() - INTERVAL '24 hours'
          AND mu.user_id = $1
      )
      SELECT
        (SELECT COUNT(*)::int FROM monitored_urls WHERE user_id = $1) AS total_urls,
        (SELECT ROUND(AVG(health_score)::numeric, 1) FROM monitored_urls WHERE user_id = $1) AS avg_health_score,
        (SELECT COUNT(*)::int FROM latest) AS latest_count,
        (SELECT COUNT(*)::int FROM latest WHERE status_code = 0 OR status_code >= 400) AS error_count,
        (SELECT COUNT(*)::int FROM latest WHERE noindex = true) AS noindex_count,
        (SELECT COUNT(*)::int FROM latest WHERE noindex = false) AS indexed_count,
        (SELECT COUNT(*)::int
           FROM latest l
           JOIN changed c ON c.url_id = l.url_id
          WHERE l.status_code BETWEEN 1 AND 399) AS changed_count
    `;

  const statusSql = isAdmin ? `
      WITH latest AS (
        SELECT DISTINCT ON (s.url_id)
          s.url_id,
          COALESCE(s.status_code, 0) AS status_code
        FROM snapshots s
        JOIN monitored_urls mu ON mu.id = s.url_id
        ORDER BY s.url_id, s.checked_at DESC
      )
      SELECT status_code, COUNT(*)::int AS cnt
      FROM latest
      GROUP BY status_code
    ` : `
      WITH latest AS (
        SELECT DISTINCT ON (s.url_id)
          s.url_id,
          COALESCE(s.status_code, 0) AS status_code
        FROM snapshots s
        JOIN monitored_urls mu ON mu.id = s.url_id
        WHERE mu.user_id = $1
        ORDER BY s.url_id, s.checked_at DESC
      )
      SELECT status_code, COUNT(*)::int AS cnt
      FROM latest
      GROUP BY status_code
    `;

  const params = isAdmin ? [] : [req.user.id];
  const { rows: [summary] } = await pool.query(summarySql, params);
  const { rows: statusRows } = await pool.query(statusSql, params);

  const statusCodes = {};
  for (const row of statusRows) {
    statusCodes[String(row.status_code)] = parseInt(row.cnt, 10);
  }

  const totalUrls = summary?.total_urls || 0;
  const totalFromLatest = summary?.latest_count || 0;
  const changedCount = summary?.changed_count || 0;
  const unchangedCount = Math.max(0, totalFromLatest - changedCount);
  const errorCount = summary?.error_count || 0;
  const indexed = summary?.indexed_count || 0;
  const noindex = summary?.noindex_count || 0;
  const pendingCount = Math.max(0, totalUrls - totalFromLatest);
  const okCount = Math.max(0, totalUrls - errorCount - changedCount - pendingCount);

  const alertsParams = isAdmin ? [] : [req.user.id];
  const alertsUserWhere = isAdmin ? '' : 'AND mu.user_id = $1';
  const { rows: alertsPerDay } = await pool.query(`
      SELECT DATE(a.detected_at AT TIME ZONE 'UTC') AS date,
             COUNT(*) AS count
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      WHERE a.detected_at > NOW() - INTERVAL '30 days' ${alertsUserWhere}
      GROUP BY DATE(a.detected_at AT TIME ZONE 'UTC')
      ORDER BY date ASC
    `, alertsParams);

  return {
    statusCodes,
    summary: {
      total: totalUrls,
      ok: okCount,
      changed: changedCount,
      error: errorCount,
      pending: pendingCount,
      avg_health_score: summary?.avg_health_score != null ? Number(summary.avg_health_score) : null
    },
    indexability: { indexed, noindex },
    changeStatus: { changed: changedCount, unchanged: unchangedCount },
    alertsPerDay: alertsPerDay.map(r => ({
      date: r.date,
      count: parseInt(r.count, 10)
    }))
  };
}

// GET /api/v2/urls
router.get('/urls', async (req, res) => {
  const { page, perPage, offset } = parsePagination(req.query);
  const isAdmin = isAdminUser(req);

  const q = String(req.query.q || '').trim().toLowerCase();
  const tag = String(req.query.tag || '').trim();
  const status = String(req.query.status || '').trim().toLowerCase();
  const sort = String(req.query.sort || 'last_checked').trim().toLowerCase();
  const dir = String(req.query.dir || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const rawProjectId = String(req.query.project_id || '').trim();
  const projectId = rawProjectId ? parseInt(rawProjectId, 10) : null;
  if (rawProjectId && !Number.isFinite(projectId)) {
    return fail(res, 400, 'Invalid project_id');
  }
  if (status && !['ok', 'changed', 'error', 'paused'].includes(status)) {
    return fail(res, 400, 'Invalid status filter');
  }

  const statusExpr = `
    CASE
      WHEN NOT mu.is_active THEN 'paused'
      WHEN ls.status_code IS NULL THEN 'ok'
      WHEN ls.status_code = 0 OR ls.status_code >= 400 THEN 'error'
      WHEN COALESCE(ch.change_count, 0) > 0 THEN 'changed'
      ELSE 'ok'
    END
  `;

  const sortMap = {
    last_checked: 'ls.checked_at',
    health_score: 'mu.health_score',
    url: 'mu.url'
  };
  const sortSql = sortMap[sort] || sortMap.last_checked;

  const params = [];
  const where = [];
  if (!isAdmin) {
    params.push(req.user.id);
    where.push(`mu.user_id = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`LOWER(mu.url) LIKE $${params.length}`);
  }
  if (tag) {
    params.push(`%${tag}%`);
    where.push(`mu.tags ILIKE $${params.length}`);
  }
  if (Number.isFinite(projectId)) {
    params.push(projectId);
    where.push(`mu.project_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    where.push(`${statusExpr} = $${params.length}`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const fromSql = `
      FROM monitored_urls mu
      LEFT JOIN LATERAL (
        SELECT s.checked_at, s.status_code, s.response_time_ms, s.noindex, s.redirect_url
        FROM snapshots s
        WHERE s.url_id = mu.id
        ORDER BY s.checked_at DESC
        LIMIT 1
      ) ls ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS change_count
        FROM alerts a
        WHERE a.url_id = mu.id
          AND a.detected_at > NOW() - INTERVAL '24 hours'
      ) ch ON true
      ${whereSql}
    `;

    const { rows: [countRow] } = await pool.query(`SELECT COUNT(*)::int AS count ${fromSql}`, params);
    const total = countRow?.count || 0;

    const listParams = [...params, perPage, offset];
    const { rows } = await pool.query(
      `SELECT
         mu.id,
         mu.url,
         mu.project_id,
         mu.tags,
         mu.is_active,
         mu.render_mode,
         mu.health_score,
         mu.check_interval_minutes,
         mu.created_at,
         ls.checked_at AS last_checked,
         ls.status_code,
         ls.response_time_ms,
         ls.noindex,
         ls.redirect_url,
         COALESCE(ch.change_count, 0)::int AS changes_count,
         ${statusExpr} AS status
       ${fromSql}
       ORDER BY ${sortSql} ${dir} NULLS LAST, mu.id DESC
       LIMIT $${listParams.length - 1}
       OFFSET $${listParams.length}`,
      listParams
    );

    return ok(res, rows, buildMeta(total, page, perPage));
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

// GET /api/v2/urls/:id/snapshots
router.get('/urls/:id/snapshots', async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (!Number.isFinite(urlId)) return fail(res, 400, 'Invalid URL id');

  const from = parseDateParam(req.query.from);
  const to = parseDateParam(req.query.to);
  if (from === undefined || to === undefined) return fail(res, 400, 'Invalid from/to date');
  if (from && to && from > to) return fail(res, 400, 'from must be <= to');

  const owned = await getOwnedUrl(urlId, req);
  if (!owned) return fail(res, 404, 'URL not found');

  const { page, perPage, offset } = parsePagination(req.query);
  const params = [urlId];
  let whereSql = 'WHERE s.url_id = $1';
  if (from) {
    params.push(from);
    whereSql += ` AND s.checked_at >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    whereSql += ` AND s.checked_at <= $${params.length}`;
  }

  try {
    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM snapshots s ${whereSql}`,
      params
    );
    const total = countRow?.count || 0;

    const listParams = [...params, perPage, offset];
    const { rows } = await pool.query(
      `SELECT s.*
       FROM snapshots s
       ${whereSql}
       ORDER BY s.checked_at DESC
       LIMIT $${listParams.length - 1}
       OFFSET $${listParams.length}`,
      listParams
    );

    return ok(res, rows, buildMeta(total, page, perPage));
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

// GET /api/v2/urls/:id/alerts
router.get('/urls/:id/alerts', async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (!Number.isFinite(urlId)) return fail(res, 400, 'Invalid URL id');

  const severity = String(req.query.severity || '').trim().toLowerCase();
  if (severity && !['critical', 'warning', 'info'].includes(severity)) {
    return fail(res, 400, 'Invalid severity');
  }
  const from = parseDateParam(req.query.from);
  const to = parseDateParam(req.query.to);
  if (from === undefined || to === undefined) return fail(res, 400, 'Invalid from/to date');
  if (from && to && from > to) return fail(res, 400, 'from must be <= to');

  const owned = await getOwnedUrl(urlId, req);
  if (!owned) return fail(res, 404, 'URL not found');

  const { page, perPage, offset } = parsePagination(req.query);
  const params = [urlId];
  let whereSql = 'WHERE a.url_id = $1';
  if (severity) {
    params.push(severity);
    whereSql += ` AND a.severity = $${params.length}`;
  }
  if (from) {
    params.push(from);
    whereSql += ` AND a.detected_at >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    whereSql += ` AND a.detected_at <= $${params.length}`;
  }

  try {
    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM alerts a ${whereSql}`,
      params
    );
    const total = countRow?.count || 0;

    const listParams = [...params, perPage, offset];
    const { rows } = await pool.query(
      `SELECT a.*
       FROM alerts a
       ${whereSql}
       ORDER BY a.detected_at DESC
       LIMIT $${listParams.length - 1}
       OFFSET $${listParams.length}`,
      listParams
    );

    return ok(res, rows, buildMeta(total, page, perPage));
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

// GET /api/v2/urls/:id/change-heatmap
router.get('/urls/:id/change-heatmap', async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (!Number.isFinite(urlId)) return fail(res, 400, 'Invalid URL id');

  const owned = await getOwnedUrl(urlId, req);
  if (!owned) return fail(res, 404, 'URL not found');

  try {
    const { rows } = await pool.query(
      `SELECT DATE(detected_at AT TIME ZONE 'UTC') AS d, COUNT(*)::int AS cnt
       FROM alerts
       WHERE url_id = $1
         AND detected_at >= NOW() - INTERVAL '365 days'
       GROUP BY DATE(detected_at AT TIME ZONE 'UTC')
       ORDER BY d ASC`,
      [urlId]
    );

    const out = {};
    for (const row of rows) {
      const key = row.d instanceof Date
        ? row.d.toISOString().slice(0, 10)
        : String(row.d || '').slice(0, 10);
      if (key) out[key] = parseInt(row.cnt, 10) || 0;
    }
    return ok(res, out, null);
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

// GET /api/v2/urls/:id
router.get('/urls/:id', async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (!Number.isFinite(urlId)) return fail(res, 400, 'Invalid URL id');

  const owned = await getOwnedUrl(urlId, req);
  if (!owned) return fail(res, 404, 'URL not found');

  try {
    const { rows: [latestSnapshot] } = await pool.query(
      'SELECT * FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC LIMIT 1',
      [urlId]
    );
    return ok(res, {
      url: owned,
      latest_snapshot: latestSnapshot || null
    }, null);
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

// POST /api/v2/urls/:id/check
router.post('/urls/:id/check', async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (!Number.isFinite(urlId)) return fail(res, 400, 'Invalid URL id');

  const owned = await getOwnedUrl(urlId, req);
  if (!owned) return fail(res, 404, 'URL not found');

  const checkId = crypto.randomUUID();
  setImmediate(() => {
    checkUrl(urlId).catch(err => {
      console.error(`[API v2] check failed for URL #${urlId}: ${err.message}`);
    });
  });

  return ok(res, { queued: true, check_id: checkId }, null);
});

// PUT /api/v2/urls/:id/accept-changes
router.put('/urls/:id/accept-changes', async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (!Number.isFinite(urlId)) return fail(res, 400, 'Invalid URL id');

  const owned = await getOwnedUrl(urlId, req);
  if (!owned) return fail(res, 404, 'URL not found');

  try {
    const { rows: pendingAlerts } = await pool.query(
      'SELECT field_changed FROM alerts WHERE url_id = $1',
      [urlId]
    );
    const pendingFields = [...new Set(pendingAlerts.map(a => String(a.field_changed || '').trim()).filter(Boolean))];

    const { rows: [latest] } = await pool.query(
      'SELECT id FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC LIMIT 1',
      [urlId]
    );

    if (latest?.id) {
      const isAdmin = isAdminUser(req);
      await pool.query(
        isAdmin
          ? 'UPDATE monitored_urls SET reference_snapshot_id = $1 WHERE id = $2'
          : 'UPDATE monitored_urls SET reference_snapshot_id = $1 WHERE id = $2 AND user_id = $3',
        isAdmin ? [latest.id, urlId] : [latest.id, urlId, req.user.id]
      );
      await pool.query('DELETE FROM alerts WHERE url_id = $1', [urlId]);

      if (owned.user_id && pendingFields.length > 0) {
        const { rows: [pagerduty] } = await pool.query(
          `SELECT integration_key
           FROM pagerduty_integrations
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [owned.user_id]
        );
        const integrationKey = pagerduty?.integration_key || null;
        if (integrationKey) {
          for (const field of pendingFields) {
            try {
              await sendPagerDuty({
                integrationKey,
                action: 'resolve',
                alert: {
                  urlId,
                  url: owned.url,
                  field,
                  severity: 'critical',
                  oldValue: '',
                  newValue: '',
                  timestamp: new Date()
                }
              });
            } catch {
              // non-critical
            }
          }
        }
      }
    }

    return ok(res, { accepted: true }, null);
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

// GET /api/v2/uptime
router.get('/uptime', async (req, res) => {
  const isAdmin = isAdminUser(req);
  const params = isAdmin ? [] : [req.user.id];
  const whereSql = isAdmin ? '' : 'WHERE um.user_id = $1';

  try {
    const { rows } = await pool.query(
      `SELECT
         um.*,
         lc.status AS current_status,
         lc.response_time_ms AS current_response_ms,
         lc.status_code AS current_status_code,
         lc.checked_at AS last_checked,
         u1.pct_1h,
         u24.pct_24h,
         u7.pct_7d,
         u30.pct_30d
       FROM uptime_monitors um
       LEFT JOIN LATERAL (
         SELECT status, response_time_ms, status_code, checked_at
         FROM uptime_checks
         WHERE monitor_id = um.id
         ORDER BY checked_at DESC
         LIMIT 1
       ) lc ON true
       LEFT JOIN LATERAL (
         SELECT ROUND((COUNT(*) FILTER (WHERE status IN ('up','degraded'))::float / NULLIF(COUNT(*),0) * 100)::numeric, 1) AS pct_1h
         FROM uptime_checks
         WHERE monitor_id = um.id AND checked_at > NOW() - INTERVAL '1 hour'
       ) u1 ON true
       LEFT JOIN LATERAL (
         SELECT ROUND((COUNT(*) FILTER (WHERE status IN ('up','degraded'))::float / NULLIF(COUNT(*),0) * 100)::numeric, 1) AS pct_24h
         FROM uptime_checks
         WHERE monitor_id = um.id AND checked_at > NOW() - INTERVAL '24 hours'
       ) u24 ON true
       LEFT JOIN LATERAL (
         SELECT ROUND((COUNT(*) FILTER (WHERE status IN ('up','degraded'))::float / NULLIF(COUNT(*),0) * 100)::numeric, 1) AS pct_7d
         FROM uptime_checks
         WHERE monitor_id = um.id AND checked_at > NOW() - INTERVAL '7 days'
       ) u7 ON true
       LEFT JOIN LATERAL (
         SELECT ROUND((COUNT(*) FILTER (WHERE status IN ('up','degraded'))::float / NULLIF(COUNT(*),0) * 100)::numeric, 1) AS pct_30d
         FROM uptime_checks
         WHERE monitor_id = um.id AND checked_at > NOW() - INTERVAL '30 days'
       ) u30 ON true
       ${whereSql}
       ORDER BY um.created_at ASC`,
      params
    );

    return ok(res, rows, null);
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

// GET /api/v2/uptime/:id/incidents
router.get('/uptime/:id/incidents', async (req, res) => {
  const monitorId = parseInt(req.params.id, 10);
  if (!Number.isFinite(monitorId)) return fail(res, 400, 'Invalid monitor id');

  const monitor = await getOwnedMonitor(monitorId, req);
  if (!monitor) return fail(res, 404, 'Monitor not found');

  const status = String(req.query.status || '').trim().toLowerCase();
  if (status && !['open', 'resolved'].includes(status)) {
    return fail(res, 400, 'Invalid status filter');
  }

  const { page, perPage, offset } = parsePagination(req.query);
  const params = [monitorId];
  let whereSql = 'WHERE monitor_id = $1';
  if (status === 'open') whereSql += ' AND resolved_at IS NULL';
  if (status === 'resolved') whereSql += ' AND resolved_at IS NOT NULL';

  try {
    const { rows: [countRow] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM uptime_incidents ${whereSql}`,
      params
    );
    const total = countRow?.count || 0;

    const listParams = [...params, perPage, offset];
    const { rows } = await pool.query(
      `SELECT *
       FROM uptime_incidents
       ${whereSql}
       ORDER BY started_at DESC
       LIMIT $${listParams.length - 1}
       OFFSET $${listParams.length}`,
      listParams
    );
    return ok(res, rows, buildMeta(total, page, perPage));
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

// GET /api/v2/uptime/:id
router.get('/uptime/:id', async (req, res) => {
  const monitorId = parseInt(req.params.id, 10);
  if (!Number.isFinite(monitorId)) return fail(res, 400, 'Invalid monitor id');

  const monitor = await getOwnedMonitor(monitorId, req);
  if (!monitor) return fail(res, 404, 'Monitor not found');

  try {
    const [
      { rows: [latestCheck] },
      { rows: [uptime] },
      { rows: [avgRt] },
      { rows: [incidentSummary] }
    ] = await Promise.all([
      pool.query(
        'SELECT * FROM uptime_checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 1',
        [monitorId]
      ),
      pool.query(
        `SELECT
           ROUND((COUNT(*) FILTER (WHERE status IN ('up','degraded') AND checked_at > NOW() - INTERVAL '1 hour')::float
             / NULLIF(COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '1 hour'),0) * 100)::numeric, 1) AS p1h,
           ROUND((COUNT(*) FILTER (WHERE status IN ('up','degraded') AND checked_at > NOW() - INTERVAL '24 hours')::float
             / NULLIF(COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '24 hours'),0) * 100)::numeric, 1) AS p24h,
           ROUND((COUNT(*) FILTER (WHERE status IN ('up','degraded') AND checked_at > NOW() - INTERVAL '7 days')::float
             / NULLIF(COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '7 days'),0) * 100)::numeric, 1) AS p7d,
           ROUND((COUNT(*) FILTER (WHERE status IN ('up','degraded') AND checked_at > NOW() - INTERVAL '30 days')::float
             / NULLIF(COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '30 days'),0) * 100)::numeric, 1) AS p30d
         FROM uptime_checks
         WHERE monitor_id = $1`,
        [monitorId]
      ),
      pool.query(
        `SELECT ROUND(AVG(response_time_ms))::int AS avg_response_ms
         FROM uptime_checks
         WHERE monitor_id = $1
           AND response_time_ms IS NOT NULL
           AND checked_at > NOW() - INTERVAL '24 hours'`,
        [monitorId]
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE resolved_at IS NULL)::int AS open_incidents,
           COUNT(*)::int AS total_incidents
         FROM uptime_incidents
         WHERE monitor_id = $1`,
        [monitorId]
      )
    ]);

    return ok(res, {
      monitor,
      current_status: latestCheck?.status || null,
      last_checked: latestCheck?.checked_at || null,
      uptime: {
        '1h': uptime?.p1h ?? null,
        '24h': uptime?.p24h ?? null,
        '7d': uptime?.p7d ?? null,
        '30d': uptime?.p30d ?? null
      },
      avg_response_ms: avgRt?.avg_response_ms ?? null,
      incidents: {
        open: incidentSummary?.open_incidents ?? 0,
        total: incidentSummary?.total_incidents ?? 0
      }
    }, null);
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

// GET /api/v2/alerts
router.get('/alerts', async (req, res) => {
  const { page, perPage, offset } = parsePagination(req.query);
  const isAdmin = isAdminUser(req);

  const severity = String(req.query.severity || '').trim().toLowerCase();
  if (severity && !['critical', 'warning', 'info'].includes(severity)) {
    return fail(res, 400, 'Invalid severity');
  }
  const field = String(req.query.field || '').trim();
  const from = parseDateParam(req.query.from);
  const to = parseDateParam(req.query.to);
  if (from === undefined || to === undefined) return fail(res, 400, 'Invalid from/to date');
  if (from && to && from > to) return fail(res, 400, 'from must be <= to');

  const rawUrlId = String(req.query.url_id || '').trim();
  const urlId = rawUrlId ? parseInt(rawUrlId, 10) : null;
  if (rawUrlId && !Number.isFinite(urlId)) return fail(res, 400, 'Invalid url_id');

  const params = [];
  const where = [];
  if (!isAdmin) {
    params.push(req.user.id);
    where.push(`mu.user_id = $${params.length}`);
  }
  if (severity) {
    params.push(severity);
    where.push(`a.severity = $${params.length}`);
  }
  if (field) {
    params.push(field);
    where.push(`a.field_changed = $${params.length}`);
  }
  if (from) {
    params.push(from);
    where.push(`a.detected_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`a.detected_at <= $${params.length}`);
  }
  if (Number.isFinite(urlId)) {
    params.push(urlId);
    where.push(`a.url_id = $${params.length}`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const fromSql = `
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      ${whereSql}
    `;
    const { rows: [countRow] } = await pool.query(`SELECT COUNT(*)::int AS count ${fromSql}`, params);
    const total = countRow?.count || 0;

    const listParams = [...params, perPage, offset];
    const { rows } = await pool.query(
      `SELECT
         a.*,
         mu.url
       ${fromSql}
       ORDER BY a.detected_at DESC
       LIMIT $${listParams.length - 1}
       OFFSET $${listParams.length}`,
      listParams
    );
    return ok(res, rows, buildMeta(total, page, perPage));
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

// GET /api/v2/stats
router.get('/stats', async (req, res) => {
  try {
    const payload = await buildStatsPayload(req);
    return ok(res, payload, null);
  } catch (err) {
    return fail(res, 500, err.message);
  }
});

module.exports = router;
