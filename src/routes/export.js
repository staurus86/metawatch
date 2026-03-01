const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth } = require('../auth');

function csvCell(val) {
  const str = String(val ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

// Apply header row style (frozen, dark bg)
function styleHeader(sheet, headers, colWidths = {}) {
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A202C' } };
  headerRow.height = 20;
  sheet.views = [{ state: 'frozen', xSplit: 0, ySplit: 1 }];
  headers.forEach((_, i) => {
    const col = i + 1;
    sheet.getColumn(col).width = colWidths[i] || 22;
  });
  return headerRow;
}

const ORANGE = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
const RED    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFED7D7' } };
const GREEN  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FFF4' } };

// GET /export/report.xlsx — multi-sheet report with optional date range
router.get('/report.xlsx', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const userId = req.user.id;
    const fromDate = parseDate(req.query.from);
    const toDate   = parseDate(req.query.to);

    const userParam = isAdmin ? [] : [userId];
    const userWhere = isAdmin ? '' : 'AND mu.user_id = $1';
    const userWhereBase = isAdmin ? 'WHERE true' : 'WHERE mu.user_id = $1';

    // All URLs with latest snapshot
    const { rows: urls } = await pool.query(`
      SELECT
        mu.id, mu.url, mu.email, mu.check_interval_minutes, mu.is_active,
        mu.created_at, mu.tags, mu.notes,
        ls.title, ls.description, ls.h1, ls.status_code, ls.noindex,
        ls.redirect_url, ls.canonical, ls.checked_at AS last_checked,
        ls.og_title, ls.og_description, ls.og_image, ls.hreflang,
        ls.response_time_ms,
        COALESCE(ac.alert_count, 0)::int AS recent_alert_count
      FROM monitored_urls mu
      LEFT JOIN LATERAL (
        SELECT title, description, h1, status_code, noindex, redirect_url,
               canonical, checked_at, og_title, og_description, og_image, hreflang,
               response_time_ms
        FROM snapshots WHERE url_id = mu.id ORDER BY checked_at DESC LIMIT 1
      ) ls ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS alert_count FROM alerts
        WHERE url_id = mu.id AND detected_at > NOW() - INTERVAL '24 hours'
      ) ac ON true
      ${userWhereBase} ${userWhere.replace('AND', '')}
      ORDER BY mu.id
    `, userParam);

    // Changes (with optional date range)
    const alertDateFilter = fromDate && toDate
      ? `AND a.detected_at BETWEEN '${fromDate.toISOString()}' AND '${toDate.toISOString()}'`
      : fromDate
      ? `AND a.detected_at >= '${fromDate.toISOString()}'`
      : '';

    const { rows: changes } = await pool.query(`
      SELECT a.id, a.detected_at, a.field_changed, a.old_value, a.new_value,
             a.severity, mu.url
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      WHERE true ${userWhere} ${alertDateFilter}
      ORDER BY a.detected_at DESC
      LIMIT 2000
    `, userParam);

    // Error snapshots (status ≠ 200, excluding redirects)
    const { rows: errors } = await pool.query(`
      SELECT DISTINCT ON (mu.id) mu.url, s.status_code, s.checked_at, s.response_time_ms
      FROM snapshots s
      JOIN monitored_urls mu ON mu.id = s.url_id
      WHERE (s.status_code = 0 OR s.status_code >= 400) ${userWhere}
      ORDER BY mu.id, s.checked_at DESC
    `, userParam);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MetaWatch';
    workbook.created = new Date();

    // ─── Sheet 1: Summary ──────────────────────────────────────────────────────
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.getColumn(1).width = 30;
    summarySheet.getColumn(2).width = 20;

    const now = new Date();
    const summaryData = [
      ['Report generated', now.toISOString()],
      ['Date range (from)', fromDate ? fromDate.toISOString().split('T')[0] : 'All time'],
      ['Date range (to)',   toDate   ? toDate.toISOString().split('T')[0]   : 'Now'],
      ['Total URLs', urls.length],
      ['Active URLs', urls.filter(u => u.is_active).length],
      ['URLs with changes (24h)', urls.filter(u => u.recent_alert_count > 0).length],
      ['Error URLs (4xx/5xx)', errors.length],
      ['Total changes in period', changes.length],
      ['Critical changes', changes.filter(c => c.severity === 'critical').length],
      ['Warning changes', changes.filter(c => c.severity === 'warning').length],
    ];
    summaryData.forEach(([label, val]) => {
      const row = summarySheet.addRow([label, val]);
      row.getCell(1).font = { bold: true };
    });

    // ─── Sheet 2: All URLs ──────────────────────────────────────────────────────
    const urlSheet = workbook.addWorksheet('All URLs');
    styleHeader(urlSheet,
      ['ID', 'URL', 'Tags', 'Status', 'Title', 'Description', 'H1', 'noindex',
       'Canonical', 'RT (ms)', 'Last Checked', 'Alerts 24h', 'Active', 'Notes'],
      { 0: 6, 1: 50, 2: 14, 3: 10, 4: 30, 5: 30, 6: 24, 7: 10, 8: 30, 9: 10, 10: 22, 11: 12, 12: 8, 13: 24 }
    );

    for (const u of urls) {
      const row = urlSheet.addRow([
        u.id, u.url, u.tags || '', u.status_code || '',
        u.title || '', u.description || '', u.h1 || '',
        u.noindex ? 'noindex' : 'index',
        u.canonical || '', u.response_time_ms || '',
        u.last_checked ? new Date(u.last_checked).toISOString() : '',
        u.recent_alert_count,
        u.is_active ? 'Yes' : 'No',
        u.notes || ''
      ]);
      if (u.recent_alert_count > 0) row.eachCell(cell => { cell.fill = ORANGE; });
      if (u.status_code >= 400 || u.status_code === 0) row.eachCell(cell => { cell.fill = RED; });
    }

    // ─── Sheet 3: Changes ──────────────────────────────────────────────────────
    const changesSheet = workbook.addWorksheet('Changes');
    styleHeader(changesSheet,
      ['ID', 'Time', 'URL', 'Field', 'Old Value', 'New Value', 'Severity'],
      { 0: 8, 1: 22, 2: 40, 3: 20, 4: 35, 5: 35, 6: 12 }
    );

    for (const c of changes) {
      const row = changesSheet.addRow([
        c.id,
        new Date(c.detected_at).toISOString(),
        c.url, c.field_changed,
        c.old_value || '', c.new_value || '', c.severity || 'info'
      ]);
      if (c.severity === 'critical') row.eachCell(cell => { cell.fill = RED; });
      else if (c.severity === 'warning') row.eachCell(cell => { cell.fill = ORANGE; });
    }

    // ─── Sheet 4: Errors ──────────────────────────────────────────────────────
    const errSheet = workbook.addWorksheet('Errors');
    styleHeader(errSheet,
      ['URL', 'Status Code', 'Last Seen', 'Response Time (ms)'],
      { 0: 50, 1: 14, 2: 22, 3: 18 }
    );

    for (const e of errors) {
      const row = errSheet.addRow([
        e.url, e.status_code || 0,
        e.checked_at ? new Date(e.checked_at).toISOString() : '',
        e.response_time_ms || ''
      ]);
      row.eachCell(cell => { cell.fill = RED; });
    }

    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="metawatch-report-${formatDate(now)}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('Export failed: ' + err.message);
  }
});

// GET /export/url/:id.xlsx — single URL full history
router.get('/url/:id.xlsx', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(400).send('Invalid URL ID');

  try {
    const isAdmin = req.user?.role === 'admin';
    const { rows: [urlRecord] } = await pool.query(
      isAdmin
        ? 'SELECT * FROM monitored_urls WHERE id = $1'
        : 'SELECT * FROM monitored_urls WHERE id = $1 AND user_id = $2',
      isAdmin ? [urlId] : [urlId, req.user.id]
    );
    if (!urlRecord) return res.status(404).send('URL not found');

    const { rows: snapshots } = await pool.query(
      'SELECT * FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC', [urlId]
    );
    const { rows: alerts } = await pool.query(
      'SELECT * FROM alerts WHERE url_id = $1 ORDER BY detected_at DESC', [urlId]
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MetaWatch';

    const snapSheet = workbook.addWorksheet('Snapshots');
    styleHeader(snapSheet,
      ['ID', 'Checked At', 'Status', 'Title', 'Description', 'H1',
       'noindex', 'Canonical', 'Redirect', 'OG Title', 'RT (ms)'],
      { 0: 8, 1: 22, 2: 8, 3: 30, 4: 30, 5: 24, 6: 10, 7: 30, 8: 30, 9: 30, 10: 10 }
    );

    for (const s of snapshots) {
      snapSheet.addRow([
        s.id, s.checked_at ? new Date(s.checked_at).toISOString() : '',
        s.status_code || '', s.title || '', s.description || '', s.h1 || '',
        s.noindex ? 'noindex' : 'index', s.canonical || '', s.redirect_url || '',
        s.og_title || '', s.response_time_ms || ''
      ]);
    }

    const alertSheet = workbook.addWorksheet('Change History');
    styleHeader(alertSheet,
      ['ID', 'Detected At', 'Field', 'Old Value', 'New Value', 'Severity'],
      { 0: 8, 1: 22, 2: 20, 3: 40, 4: 40, 5: 12 }
    );

    for (const a of alerts) {
      const row = alertSheet.addRow([
        a.id, new Date(a.detected_at).toISOString(),
        a.field_changed, a.old_value || '', a.new_value || '', a.severity || 'info'
      ]);
      row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5F5' } };
      row.getCell(5).fill = GREEN;
    }

    const safeName = urlRecord.url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${safeName}-${formatDate(new Date())}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('Export failed: ' + err.message);
  }
});

// GET /export/uptime-report.xlsx — uptime monitors multi-sheet report
router.get('/uptime-report.xlsx', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const userId = req.user.id;
    const fromDate = parseDate(req.query.from);
    const toDate   = parseDate(req.query.to);

    const userParam = isAdmin ? [] : [userId];
    const userWhere = isAdmin ? '' : 'WHERE um.user_id = $1';

    const { rows: monitors } = await pool.query(`
      SELECT um.*,
        ROUND((COUNT(uc7.*) FILTER (WHERE uc7.status IN ('up','degraded'))::float / NULLIF(COUNT(uc7.*),0) * 100)::numeric, 1) AS uptime_7d,
        ROUND((COUNT(uc30.*) FILTER (WHERE uc30.status IN ('up','degraded'))::float / NULLIF(COUNT(uc30.*),0) * 100)::numeric, 1) AS uptime_30d,
        ROUND(AVG(uc30.response_time_ms)::numeric, 0) AS avg_rt_ms,
        lc.status AS current_status
      FROM uptime_monitors um
      LEFT JOIN uptime_checks uc7  ON uc7.monitor_id  = um.id AND uc7.checked_at  > NOW() - INTERVAL '7 days'
      LEFT JOIN uptime_checks uc30 ON uc30.monitor_id = um.id AND uc30.checked_at > NOW() - INTERVAL '30 days'
      LEFT JOIN LATERAL (
        SELECT status FROM uptime_checks WHERE monitor_id = um.id ORDER BY checked_at DESC LIMIT 1
      ) lc ON true
      ${userWhere}
      GROUP BY um.id, lc.status
      ORDER BY um.id
    `, userParam);

    const incidentDateFilter = fromDate && toDate
      ? `AND ui.started_at BETWEEN '${fromDate.toISOString()}' AND '${toDate.toISOString()}'`
      : fromDate ? `AND ui.started_at >= '${fromDate.toISOString()}'` : '';

    const { rows: incidents } = await pool.query(`
      SELECT ui.*, um.name AS monitor_name, um.url AS monitor_url
      FROM uptime_incidents ui
      JOIN uptime_monitors um ON um.id = ui.monitor_id
      WHERE true ${isAdmin ? '' : 'AND um.user_id = $1'} ${incidentDateFilter}
      ORDER BY ui.started_at DESC LIMIT 1000
    `, userParam);

    const { rows: checks } = await pool.query(`
      SELECT uc.checked_at, uc.status, uc.response_time_ms, uc.status_code,
             um.name AS monitor_name
      FROM uptime_checks uc
      JOIN uptime_monitors um ON um.id = uc.monitor_id
      WHERE true ${isAdmin ? '' : 'AND um.user_id = $1'}
        ${fromDate ? `AND uc.checked_at >= '${fromDate.toISOString()}'` : ''}
        ${toDate   ? `AND uc.checked_at <= '${toDate.toISOString()}'` : ''}
      ORDER BY uc.checked_at DESC LIMIT 5000
    `, userParam);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MetaWatch';

    // Sheet 1: Monitors
    const monSheet = workbook.addWorksheet('Monitors');
    styleHeader(monSheet,
      ['ID', 'Name', 'URL', 'Status', 'Uptime 7d %', 'Uptime 30d %', 'Avg RT (ms)', 'Active'],
      { 0: 6, 1: 24, 2: 40, 3: 12, 4: 14, 5: 14, 6: 14, 7: 8 }
    );

    for (const m of monitors) {
      const row = monSheet.addRow([
        m.id, m.name, m.url, m.current_status || 'unknown',
        m.uptime_7d || '', m.uptime_30d || '',
        m.avg_rt_ms || '', m.is_active ? 'Yes' : 'No'
      ]);
      if (m.current_status === 'down') row.eachCell(c => { c.fill = RED; });
      else if (m.current_status === 'degraded') row.eachCell(c => { c.fill = ORANGE; });
    }

    // Sheet 2: Incidents
    const incSheet = workbook.addWorksheet('Incidents');
    styleHeader(incSheet,
      ['Monitor', 'Started', 'Resolved', 'Duration (min)', 'Cause', 'Post-mortem'],
      { 0: 24, 1: 22, 2: 22, 3: 16, 4: 16, 5: 40 }
    );

    for (const i of incidents) {
      const dur = i.duration_seconds ? Math.round(i.duration_seconds / 60) : '';
      incSheet.addRow([
        i.monitor_name,
        new Date(i.started_at).toISOString(),
        i.resolved_at ? new Date(i.resolved_at).toISOString() : 'Ongoing',
        dur, i.cause || '', i.postmortem_text || ''
      ]);
    }

    // Sheet 3: Checks
    const checkSheet = workbook.addWorksheet('Checks');
    styleHeader(checkSheet,
      ['Monitor', 'Timestamp', 'Status', 'Response (ms)', 'HTTP Status'],
      { 0: 24, 1: 22, 2: 12, 3: 16, 4: 14 }
    );

    for (const c of checks) {
      const row = checkSheet.addRow([
        c.monitor_name, new Date(c.checked_at).toISOString(),
        c.status, c.response_time_ms || '', c.status_code || ''
      ]);
      if (c.status === 'down') row.eachCell(cell => { cell.fill = RED; });
      else if (c.status === 'degraded') row.eachCell(cell => { cell.fill = ORANGE; });
    }

    const now = new Date();
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="uptime-report-${formatDate(now)}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('Export failed: ' + err.message);
  }
});

// GET /export/alerts.csv — all alerts as CSV
router.get('/alerts.csv', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const fromDate = parseDate(req.query.from);
    const toDate   = parseDate(req.query.to);

    const userParam = isAdmin ? [] : [req.user.id];
    const userWhere = isAdmin ? '' : 'AND mu.user_id = $1';
    const dateFilter = fromDate && toDate
      ? `AND a.detected_at BETWEEN '${fromDate.toISOString()}' AND '${toDate.toISOString()}'`
      : fromDate ? `AND a.detected_at >= '${fromDate.toISOString()}'` : '';

    const { rows: alerts } = await pool.query(`
      SELECT a.id, a.detected_at, a.field_changed, a.old_value, a.new_value,
             a.severity, mu.url
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      WHERE true ${userWhere} ${dateFilter}
      ORDER BY a.detected_at DESC
    `, userParam);

    const lines = [
      ['ID', 'Detected At', 'URL', 'Field', 'Old Value', 'New Value', 'Severity']
        .map(csvCell).join(',')
    ];

    for (const a of alerts) {
      lines.push([
        a.id, new Date(a.detected_at).toISOString(),
        a.url, a.field_changed,
        a.old_value || '', a.new_value || '', a.severity || 'info'
      ].map(csvCell).join(','));
    }

    const now = new Date();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="metawatch-alerts-${formatDate(now)}.csv"`);
    res.send('\uFEFF' + lines.join('\r\n'));
  } catch (err) {
    console.error(err);
    res.status(500).send('Export failed: ' + err.message);
  }
});

module.exports = router;
