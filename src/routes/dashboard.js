const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../auth');

const DEFAULT_PER_PAGE = 25;

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

router.get('/', requireAuth, async (req, res) => {
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
    const prefPerPage = [10, 25, 50].includes(parseInt(req.user.pref_rows_per_page, 10))
      ? parseInt(req.user.pref_rows_per_page, 10)
      : DEFAULT_PER_PAGE;
    const reqPerPage = parseInt(req.query.per_page || '', 10);
    const perPage = [10, 25, 50].includes(reqPerPage) ? reqPerPage : prefPerPage;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const offset = (page - 1) * perPage;
    const importedCount = req.query.imported ? parseInt(req.query.imported, 10) : null;
    const importSkipped = req.query.skipped ? parseInt(req.query.skipped, 10) : null;
    const importTag = req.query.import_tag ? String(req.query.import_tag) : null;

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
      WHERE 1=1 ${userWhere}
    `, userParams);

    const stats = {
      total: statsRow?.total || 0,
      ok: statsRow?.ok || 0,
      changed: statsRow?.changed || 0,
      error: statsRow?.error || 0,
      pending: statsRow?.pending || 0
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
        WHERE 1=1 ${userWhere} ${tagWhere} ${projectWhere} ${problemFilter}
      ) sub
    `, scopedParams);

    const totalCount = parseInt(cnt, 10);
    const totalPages = Math.max(1, Math.ceil(totalCount / perPage));

    // ── Paginated URL list with uptime ────────────────────────────────────────
    const limitIdx = scopedParams.length + 1;
    const offsetIdx = scopedParams.length + 2;

    const { rows: urls } = await pool.query(`
      SELECT
        mu.*,
        p.name AS project_name,
        ls.status_code  AS last_status_code,
        ls.checked_at   AS last_checked,
        COALESCE(ac.alert_count, 0)::int AS recent_alert_count,
        CASE WHEN up.total = 0 OR up.total IS NULL THEN NULL
          ELSE ROUND((up.ok_count::float / up.total * 100)::numeric, 1)
        END AS uptime_pct
      FROM monitored_urls mu
      LEFT JOIN projects p ON p.id = mu.project_id
      LEFT JOIN LATERAL (
        SELECT status_code, checked_at FROM snapshots
        WHERE url_id = mu.id ORDER BY checked_at DESC LIMIT 1
      ) ls ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS alert_count FROM alerts
        WHERE url_id = mu.id AND detected_at > NOW() - INTERVAL '24 hours'
      ) ac ON true
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status_code BETWEEN 200 AND 399) AS ok_count
        FROM snapshots
        WHERE url_id = mu.id AND checked_at > NOW() - INTERVAL '30 days'
      ) up ON true
      WHERE 1=1 ${userWhere} ${tagWhere} ${projectWhere} ${problemFilter}
      ORDER BY mu.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `, [...scopedParams, perPage, offset]);

    const urlsWithStatus = urls.map(u => ({ ...u, status: computeStatus(u) }));

    // ── Project view: group URLs under project cards ─────────────────────────
    let projectGroups = [];
    if (view === 'projects') {
      const { rows: projectUrls } = await pool.query(`
        SELECT
          mu.*,
          p.name AS project_name,
          ls.status_code  AS last_status_code,
          ls.checked_at   AS last_checked,
          COALESCE(ac.alert_count, 0)::int AS recent_alert_count,
          CASE WHEN up.total = 0 OR up.total IS NULL THEN NULL
            ELSE ROUND((up.ok_count::float / up.total * 100)::numeric, 1)
          END AS uptime_pct
        FROM monitored_urls mu
        LEFT JOIN projects p ON p.id = mu.project_id
        LEFT JOIN LATERAL (
          SELECT status_code, checked_at FROM snapshots
          WHERE url_id = mu.id ORDER BY checked_at DESC LIMIT 1
        ) ls ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS alert_count FROM alerts
          WHERE url_id = mu.id AND detected_at > NOW() - INTERVAL '24 hours'
        ) ac ON true
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status_code BETWEEN 200 AND 399) AS ok_count
          FROM snapshots
          WHERE url_id = mu.id AND checked_at > NOW() - INTERVAL '30 days'
        ) up ON true
        WHERE 1=1 ${userWhere} ${tagWhere} ${projectWhere} ${problemFilter}
        ORDER BY COALESCE(p.name, 'zzzzzz'), mu.created_at DESC
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
      allTags,
      page,
      totalPages,
      totalCount,
      perPage,
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
