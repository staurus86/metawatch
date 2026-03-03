const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

const DEFAULT_PER_PAGE = 25;
const STATUS_SORT_SQL = `
  CASE
    WHEN mu.is_active = false THEN 4
    WHEN ls.status_code IS NULL THEN 3
    WHEN ls.status_code = 0 OR ls.status_code >= 400 THEN 0
    WHEN COALESCE(ac.alert_count, 0) > 0 THEN 1
    ELSE 2
  END
`;

const SORT_COLUMNS = {
  last_checked: 'ls.checked_at',
  url: 'mu.url',
  changes: 'COALESCE(ac.alert_count, 0)',
  health_score: 'mu.health_score',
  status: STATUS_SORT_SQL
};
const KEYSET_ORDER_SQL = 'ls.checked_at DESC NULLS LAST, mu.id DESC';
const KEYSET_REVERSE_ORDER_SQL = 'ls.checked_at ASC NULLS FIRST, mu.id ASC';

function normalizeSort(sort) {
  const key = String(sort || '').toLowerCase();
  return SORT_COLUMNS[key] ? key : 'last_checked';
}

function normalizeDir(dir) {
  return String(dir || '').toLowerCase() === 'asc' ? 'asc' : 'desc';
}

function buildOrderSql(sortKey, sortDir) {
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
  const col = SORT_COLUMNS[sortKey] || SORT_COLUMNS.last_checked;

  if (sortKey === 'last_checked' || sortKey === 'health_score') {
    return `${col} ${dir} NULLS LAST, mu.created_at DESC`;
  }
  return `${col} ${dir}, mu.created_at DESC`;
}

function encodeListCursor(row) {
  if (!row) return null;
  const id = parseInt(row.id, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  const payload = {
    id,
    lc: row.last_checked ? new Date(row.last_checked).toISOString() : null
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeListCursor(token) {
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    const id = parseInt(payload?.id, 10);
    if (!Number.isFinite(id) || id <= 0) return null;

    if (payload?.lc == null) {
      return { id, lc: null };
    }

    const parsed = new Date(payload.lc);
    if (Number.isNaN(parsed.getTime())) return null;
    return { id, lc: parsed.toISOString() };
  } catch {
    return null;
  }
}

function canUseKeysetPagination({ view, sort, dir }) {
  return view === 'list' && sort === 'last_checked' && dir === 'desc';
}

function buildKeysetWhereClause(cursor, cursorDir, startIndex) {
  if (!cursor) return { clause: '', params: [] };
  const isPrev = cursorDir === 'prev';

  if (cursor.lc) {
    const tsIdx = startIndex;
    const idIdx = startIndex + 1;
    if (isPrev) {
      return {
        clause: `
          AND (
            ls.checked_at IS NOT NULL
            AND (
              ls.checked_at > $${tsIdx}
              OR (ls.checked_at = $${tsIdx} AND mu.id > $${idIdx})
            )
          )
        `,
        params: [cursor.lc, cursor.id]
      };
    }
    return {
      clause: `
        AND (
          (
            ls.checked_at IS NOT NULL
            AND (
              ls.checked_at < $${tsIdx}
              OR (ls.checked_at = $${tsIdx} AND mu.id < $${idIdx})
            )
          )
          OR ls.checked_at IS NULL
        )
      `,
      params: [cursor.lc, cursor.id]
    };
  }

  const idIdx = startIndex;
  if (isPrev) {
    return {
      clause: `
        AND (
          ls.checked_at IS NOT NULL
          OR (ls.checked_at IS NULL AND mu.id > $${idIdx})
        )
      `,
      params: [cursor.id]
    };
  }
  return {
    clause: `AND (ls.checked_at IS NULL AND mu.id < $${idIdx})`,
    params: [cursor.id]
  };
}

function computeStatus(u) {
  if (!u.last_status_code && u.last_status_code !== 0) return 'PENDING';
  if (u.last_status_code === 0 || u.last_status_code >= 400) return 'ERROR';
  if (u.recent_alert_count > 0) return 'CHANGED';
  return 'OK';
}

function buildProjectGroups(urls) {
  const groups = new Map();

  for (const url of urls) {
    const key = url.project_id == null ? 'none' : String(url.project_id);
    if (!groups.has(key)) {
      groups.set(key, {
        id: url.project_id,
        name: url.project_name || 'Unassigned',
        urls: [],
        total: 0,
        ok: 0,
        changed: 0,
        error: 0,
        pending: 0
      });
    }

    const group = groups.get(key);
    group.urls.push(url);
    group.total += 1;
    if (url.status === 'OK') group.ok += 1;
    else if (url.status === 'CHANGED') group.changed += 1;
    else if (url.status === 'ERROR') group.error += 1;
    else group.pending += 1;
  }

  return [...groups.values()].sort((a, b) => {
    if (a.id == null && b.id != null) return 1;
    if (a.id != null && b.id == null) return -1;
    return a.name.localeCompare(b.name);
  });
}

router.get(['/', '/dashboard'], requireAuth, async (req, res) => {
  try {
    const tab = req.query.tab || 'all';
    const fieldFilter = req.query.field || null;
    const tagFilter = req.query.tag || null;
    const isAdmin = req.user.role === 'admin';

    const prefView = (req.user.pref_dashboard_view === 'projects' || req.user.pref_dashboard_view === 'grouped')
      ? 'projects'
      : 'list';
    const view = req.query.view === 'list' ? 'list' : req.query.view === 'projects' ? 'projects' : prefView;

    const rawProjectFilter = String(req.query.project || '');
    const q = String(req.query.q || '').trim();
    const rawStatusFilter = String(req.query.status || '').trim().toLowerCase();
    const statusFilter = ['ok', 'changed', 'error', 'paused'].includes(rawStatusFilter)
      ? rawStatusFilter
      : '';
    const unhealthyOnly = String(req.query.unhealthy || '').trim() === '1';
    const sort = normalizeSort(req.query.sort);
    const dir = normalizeDir(req.query.dir);
    const prefPerPage = [10, 25, 50].includes(parseInt(req.user.pref_rows_per_page, 10))
      ? parseInt(req.user.pref_rows_per_page, 10)
      : DEFAULT_PER_PAGE;
    const reqPerPage = parseInt(req.query.per_page || '', 10);
    const perPage = [10, 25, 50].includes(reqPerPage) ? reqPerPage : prefPerPage;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const cursorToken = String(req.query.cursor || '').trim();
    const cursorDir = String(req.query.cursor_dir || 'next').trim().toLowerCase() === 'prev' ? 'prev' : 'next';
    const decodedCursor = decodeListCursor(cursorToken);
    const shouldUseKeyset = canUseKeysetPagination({ view, sort, dir });
    const keysetPagination = shouldUseKeyset && (decodedCursor || (!cursorToken && page <= 1));
    const importedCount = req.query.imported ? parseInt(req.query.imported, 10) : null;
    const importSkipped = req.query.skipped ? parseInt(req.query.skipped, 10) : null;
    const importTag = req.query.import_tag ? String(req.query.import_tag) : null;
    const orderSql = buildOrderSql(sort, dir);

    // Ownership filter
    const userParams = isAdmin ? [] : [req.user.id];
    const userWhere = isAdmin ? '' : 'AND mu.user_id = $1';

    // Tag + project filters for URL-scoped queries
    const scopedParams = [...userParams];
    let tagWhere = '';
    if (tagFilter) {
      scopedParams.push(tagFilter);
      tagWhere = `AND $${scopedParams.length} = ANY(string_to_array(mu.tags, ','))`;
    }

    let projectFilterValue = '';
    let projectWhere = '';
    if (rawProjectFilter === 'none') {
      projectFilterValue = 'none';
      projectWhere = 'AND mu.project_id IS NULL';
    } else {
      const parsedProjectId = parseInt(rawProjectFilter, 10);
      if (Number.isFinite(parsedProjectId) && parsedProjectId > 0) {
        projectFilterValue = String(parsedProjectId);
        scopedParams.push(parsedProjectId);
        projectWhere = `AND mu.project_id = $${scopedParams.length}`;
      }
    }

    let searchWhere = '';
    if (q) {
      scopedParams.push(`%${q}%`);
      searchWhere = `AND mu.url ILIKE $${scopedParams.length}`;
    }

    let statusWhere = '';
    if (statusFilter === 'ok') {
      statusWhere = `
        AND mu.is_active = true
        AND ls.status_code BETWEEN 1 AND 399
        AND COALESCE(ac.alert_count, 0) = 0
      `;
    } else if (statusFilter === 'changed') {
      statusWhere = `
        AND mu.is_active = true
        AND ls.status_code BETWEEN 1 AND 399
        AND COALESCE(ac.alert_count, 0) > 0
      `;
    } else if (statusFilter === 'error') {
      statusWhere = `
        AND mu.is_active = true
        AND (ls.status_code = 0 OR ls.status_code >= 400)
      `;
    } else if (statusFilter === 'paused') {
      statusWhere = 'AND mu.is_active = false';
    }
    const healthWhere = unhealthyOnly ? 'AND COALESCE(mu.health_score, 100) < 70' : '';

    // Problem-tab filter (applied in SQL so pagination works correctly)
    const problemFilter = tab === 'problems'
      ? `AND ls.status_code IS NOT NULL
         AND (ls.status_code = 0 OR ls.status_code >= 400 OR COALESCE(ac.alert_count,0) > 0)`
      : '';

    // ── Collect all tags used by this user (for tag filter UI) ───────────────
    const { rows: tagRows } = await pool.query(`
      SELECT DISTINCT unnest(string_to_array(tags, ',')) AS tag
      FROM monitored_urls
      WHERE tags != '' ${userWhere.replace('mu.', '')}
      ORDER BY tag
    `, userParams);
    const allTags = tagRows.map(r => r.tag).filter(Boolean);

    // ── Collect all projects used by this user (for filters + UI) ────────────
    const projectListQuery = isAdmin
      ? `
        SELECT p.id, p.name, COUNT(mu.id)::int AS url_count
        FROM projects p
        LEFT JOIN monitored_urls mu ON mu.project_id = p.id
        GROUP BY p.id
        ORDER BY p.name
      `
      : `
        SELECT p.id, p.name, COUNT(mu.id)::int AS url_count
        FROM projects p
        LEFT JOIN monitored_urls mu ON mu.project_id = p.id AND mu.user_id = $1
        WHERE p.user_id = $1
        GROUP BY p.id
        ORDER BY p.name
      `;
    const { rows: projectOptions } = await pool.query(projectListQuery, isAdmin ? [] : [req.user.id]);
    const { rows: [unassignedRow] } = await pool.query(
      isAdmin
        ? 'SELECT COUNT(*)::int AS cnt FROM monitored_urls WHERE project_id IS NULL'
        : 'SELECT COUNT(*)::int AS cnt FROM monitored_urls WHERE user_id = $1 AND project_id IS NULL',
      isAdmin ? [] : [req.user.id]
    );
    const unassignedCount = unassignedRow?.cnt || 0;

    // ── Stats: aggregate in SQL (faster than loading all rows in JS) ─────────
    const { rows: [statsRow] } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        ROUND(AVG(mu.health_score)::numeric, 1) AS avg_health_score,
        COUNT(*) FILTER (
          WHERE ls.status_code IS NULL
        )::int AS pending,
        COUNT(*) FILTER (
          WHERE ls.status_code = 0 OR ls.status_code >= 400
        )::int AS error,
        COUNT(*) FILTER (
          WHERE ls.status_code BETWEEN 1 AND 399 AND COALESCE(ac.alert_count, 0) > 0
        )::int AS changed,
        COUNT(*) FILTER (
          WHERE ls.status_code BETWEEN 1 AND 399 AND COALESCE(ac.alert_count, 0) = 0
        )::int AS ok
      FROM monitored_urls mu
      LEFT JOIN LATERAL (
        SELECT status_code FROM snapshots
        WHERE url_id = mu.id ORDER BY checked_at DESC LIMIT 1
      ) ls ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS alert_count FROM alerts
        WHERE url_id = mu.id AND detected_at > NOW() - INTERVAL '24 hours'
      ) ac ON true
      WHERE 1=1 ${userWhere} ${healthWhere}
    `, userParams);

    const stats = {
      total: statsRow?.total || 0,
      ok: statsRow?.ok || 0,
      changed: statsRow?.changed || 0,
      error: statsRow?.error || 0,
      pending: statsRow?.pending || 0,
      avgHealthScore: statsRow?.avg_health_score != null ? Number(statsRow.avg_health_score) : null
    };

    // ── Count for pagination ─────────────────────────────────────────────────
    const { rows: [{ cnt }] } = await pool.query(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT mu.id FROM monitored_urls mu
        LEFT JOIN LATERAL (
          SELECT status_code FROM snapshots
          WHERE url_id = mu.id ORDER BY checked_at DESC LIMIT 1
        ) ls ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS alert_count FROM alerts
          WHERE url_id = mu.id AND detected_at > NOW() - INTERVAL '24 hours'
        ) ac ON true
        WHERE 1=1 ${userWhere} ${tagWhere} ${projectWhere} ${searchWhere} ${statusWhere} ${healthWhere} ${problemFilter}
      ) sub
    `, scopedParams);

    const totalCount = parseInt(cnt, 10);
    const totalPages = Math.max(1, Math.ceil(totalCount / perPage));

    const listSelectSql = `
      SELECT
        mu.*,
        p.name AS project_name,
        ls.status_code AS last_status_code,
        ls.checked_at AS last_checked,
        COALESCE(ac.alert_count, 0)::int AS recent_alert_count,
        ARRAY_REMOVE(ARRAY[
          CASE WHEN ls.status_code IS NOT NULL AND ls.status_code != 200 THEN '-20: response code != 200' END,
          CASE WHEN ls.noindex = true THEN '-15: noindex enabled' END,
          CASE WHEN hc.title_changed_7d THEN '-10: title changed in last 7d' END,
          CASE WHEN hc.canonical_changed_7d THEN '-10: canonical changed in last 7d' END,
          CASE WHEN ls.redirect_url IS NOT NULL AND BTRIM(ls.redirect_url) <> '' THEN '-10: redirect is present' END,
          CASE WHEN ls.description IS NULL OR BTRIM(ls.description) = '' THEN '-5: description missing' END,
          CASE WHEN ls.h1 IS NULL OR BTRIM(ls.h1) = '' THEN '-5: H1 missing' END,
          CASE WHEN ls.ssl_expires_at IS NOT NULL AND ls.ssl_expires_at < NOW() + INTERVAL '30 days' THEN '-5: SSL expires in <30d' END,
          CASE WHEN ls.response_time_ms IS NOT NULL AND ls.response_time_ms > 2000 THEN '-5: response time > 2000ms' END
        ], NULL) AS health_reasons,
        CASE WHEN up.total = 0 OR up.total IS NULL THEN NULL
          ELSE ROUND((up.ok_count::float / up.total * 100)::numeric, 1)
        END AS uptime_pct
      FROM monitored_urls mu
      LEFT JOIN projects p ON p.id = mu.project_id
      LEFT JOIN LATERAL (
        SELECT status_code, checked_at, noindex, description, h1, ssl_expires_at, response_time_ms, redirect_url
        FROM snapshots
        WHERE url_id = mu.id ORDER BY checked_at DESC LIMIT 1
      ) ls ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS alert_count FROM alerts
        WHERE url_id = mu.id AND detected_at > NOW() - INTERVAL '24 hours'
      ) ac ON true
      LEFT JOIN LATERAL (
        SELECT
          BOOL_OR(field_changed = 'Title') AS title_changed_7d,
          BOOL_OR(field_changed = 'Canonical') AS canonical_changed_7d
        FROM alerts
        WHERE url_id = mu.id
          AND detected_at > NOW() - INTERVAL '7 days'
          AND field_changed IN ('Title', 'Canonical')
      ) hc ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status_code BETWEEN 200 AND 399) AS ok_count
        FROM snapshots
        WHERE url_id = mu.id AND checked_at > NOW() - INTERVAL '30 days'
      ) up ON true
      WHERE 1=1 ${userWhere} ${tagWhere} ${projectWhere} ${searchWhere} ${statusWhere} ${healthWhere} ${problemFilter}
    `;

    // ── Paginated URL list with uptime ────────────────────────────────────────
    let urls = [];
    const paginationMode = keysetPagination ? 'keyset' : 'offset';
    let hasNextPage = false;
    let hasPrevPage = false;
    let nextCursor = null;
    let prevCursor = null;

    if (keysetPagination) {
      const keysetParams = [...scopedParams];
      const { clause: keysetWhere, params: keysetValues } = buildKeysetWhereClause(
        decodedCursor,
        cursorDir,
        keysetParams.length + 1
      );
      keysetParams.push(...keysetValues);
      const keysetLimitIdx = keysetParams.length + 1;
      const keysetOrderSql = cursorDir === 'prev' ? KEYSET_REVERSE_ORDER_SQL : KEYSET_ORDER_SQL;
      const { rows: keysetRowsRaw } = await pool.query(`
        ${listSelectSql}
        ${keysetWhere}
        ORDER BY ${keysetOrderSql}
        LIMIT $${keysetLimitIdx}
      `, [...keysetParams, perPage + 1]);

      const hasExtra = keysetRowsRaw.length > perPage;
      let keysetRows = keysetRowsRaw.slice(0, perPage);
      if (cursorDir === 'prev') {
        keysetRows = keysetRows.reverse();
        hasPrevPage = hasExtra;
        hasNextPage = Boolean(decodedCursor);
      } else {
        hasPrevPage = Boolean(decodedCursor);
        hasNextPage = hasExtra;
      }
      urls = keysetRows;
      if (urls.length > 0) {
        prevCursor = encodeListCursor(urls[0]);
        nextCursor = encodeListCursor(urls[urls.length - 1]);
      }
    } else {
      const offset = (page - 1) * perPage;
      const limitIdx = scopedParams.length + 1;
      const offsetIdx = scopedParams.length + 2;
      const { rows: offsetRows } = await pool.query(`
        ${listSelectSql}
        ORDER BY ${orderSql}
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `, [...scopedParams, perPage, offset]);
      urls = offsetRows;
      hasPrevPage = page > 1;
      hasNextPage = page < totalPages;
    }

    const urlsWithStatus = urls.map(u => ({ ...u, status: computeStatus(u) }));

    // ── Project view: group URLs under project cards ─────────────────────────
    let projectGroups = [];
    if (view === 'projects') {
      const { rows: projectUrls } = await pool.query(`
        SELECT
          mu.*,
          p.name AS project_name,
          ls.status_code AS last_status_code,
          ls.checked_at AS last_checked,
          COALESCE(ac.alert_count, 0)::int AS recent_alert_count,
          ARRAY_REMOVE(ARRAY[
            CASE WHEN ls.status_code IS NOT NULL AND ls.status_code != 200 THEN '-20: response code != 200' END,
            CASE WHEN ls.noindex = true THEN '-15: noindex enabled' END,
            CASE WHEN hc.title_changed_7d THEN '-10: title changed in last 7d' END,
            CASE WHEN hc.canonical_changed_7d THEN '-10: canonical changed in last 7d' END,
            CASE WHEN ls.redirect_url IS NOT NULL AND BTRIM(ls.redirect_url) <> '' THEN '-10: redirect is present' END,
            CASE WHEN ls.description IS NULL OR BTRIM(ls.description) = '' THEN '-5: description missing' END,
            CASE WHEN ls.h1 IS NULL OR BTRIM(ls.h1) = '' THEN '-5: H1 missing' END,
            CASE WHEN ls.ssl_expires_at IS NOT NULL AND ls.ssl_expires_at < NOW() + INTERVAL '30 days' THEN '-5: SSL expires in <30d' END,
            CASE WHEN ls.response_time_ms IS NOT NULL AND ls.response_time_ms > 2000 THEN '-5: response time > 2000ms' END
          ], NULL) AS health_reasons,
          CASE WHEN up.total = 0 OR up.total IS NULL THEN NULL
            ELSE ROUND((up.ok_count::float / up.total * 100)::numeric, 1)
          END AS uptime_pct
        FROM monitored_urls mu
        LEFT JOIN projects p ON p.id = mu.project_id
        LEFT JOIN LATERAL (
          SELECT status_code, checked_at, noindex, description, h1, ssl_expires_at, response_time_ms, redirect_url
          FROM snapshots
          WHERE url_id = mu.id ORDER BY checked_at DESC LIMIT 1
        ) ls ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS alert_count FROM alerts
          WHERE url_id = mu.id AND detected_at > NOW() - INTERVAL '24 hours'
        ) ac ON true
        LEFT JOIN LATERAL (
          SELECT
            BOOL_OR(field_changed = 'Title') AS title_changed_7d,
            BOOL_OR(field_changed = 'Canonical') AS canonical_changed_7d
          FROM alerts
          WHERE url_id = mu.id
            AND detected_at > NOW() - INTERVAL '7 days'
            AND field_changed IN ('Title', 'Canonical')
        ) hc ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status_code BETWEEN 200 AND 399) AS ok_count
          FROM snapshots
          WHERE url_id = mu.id AND checked_at > NOW() - INTERVAL '30 days'
        ) up ON true
        WHERE 1=1 ${userWhere} ${tagWhere} ${projectWhere} ${searchWhere} ${statusWhere} ${healthWhere} ${problemFilter}
        ORDER BY COALESCE(p.name, 'zzzzzz') ASC, ${orderSql}
      `, scopedParams);
      projectGroups = buildProjectGroups(projectUrls.map(u => ({ ...u, status: computeStatus(u) })));
    }

    // ── Recent alerts (scoped to user's URLs) ────────────────────────────────
    const alertParams = [...userParams];
    let alertQuery = `
      SELECT a.*, mu.url
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      WHERE 1=1 ${userWhere}
    `;
    if (fieldFilter) {
      alertParams.push(fieldFilter);
      alertQuery += ` AND a.field_changed = $${alertParams.length}`;
    }
    alertQuery += ' ORDER BY a.detected_at DESC LIMIT 20';

    const { rows: recentAlerts } = await pool.query(alertQuery, alertParams);

    // Distinct alert field names (for user's URLs)
    const { rows: fieldRows } = await pool.query(`
      SELECT DISTINCT a.field_changed
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      WHERE 1=1 ${userWhere}
      ORDER BY a.field_changed
    `, userParams);
    const alertFields = fieldRows.map(r => r.field_changed);

    // Uptime summary for this user
    let uptimeSummary = { total: 0, up: 0, down: 0, degraded: 0 };
    try {
      const { rows: uptimeRows } = await pool.query(`
        SELECT lc.status
        FROM uptime_monitors um
        LEFT JOIN LATERAL (
          SELECT status FROM uptime_checks WHERE monitor_id = um.id ORDER BY checked_at DESC LIMIT 1
        ) lc ON true
        WHERE um.is_active = true ${userWhere.replace('mu.', 'um.')}
      `, userParams);
      uptimeSummary.total = uptimeRows.length;
      uptimeSummary.up = uptimeRows.filter(r => r.status === 'up').length;
      uptimeSummary.down = uptimeRows.filter(r => r.status === 'down').length;
      uptimeSummary.degraded = uptimeRows.filter(r => r.status === 'degraded').length;
    } catch {
      // table may not exist yet
    }

    res.render('dashboard', {
      title: 'Dashboard',
      view,
      urls: urlsWithStatus,
      projectGroups,
      projectOptions,
      projectFilter: projectFilterValue,
      unassignedCount,
      recentAlerts,
      stats,
      tab,
      fieldFilter,
      alertFields,
      tagFilter,
      q,
      statusFilter,
      unhealthyOnly,
      sort,
      dir,
      allTags,
      page,
      totalPages,
      totalCount,
      perPage,
      paginationMode,
      hasNextPage,
      hasPrevPage,
      nextCursor,
      prevCursor,
      importedCount,
      importSkipped,
      importTag,
      uptimeSummary
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

module.exports = router;
