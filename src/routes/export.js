const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const pool = require('../db');
const { requireAuth } = require('../auth');
const { buildPdfReportBuffer, defaultPdfDateRange } = require('../pdf-report');
const {
  buildUptimeMonitorPdfBuffer,
  defaultUptimeReportDateRange,
  getUptimeMonitorReportData
} = require('../pdf-uptime-report');
const {
  buildUrlPdfBuffer,
  defaultUrlReportDateRange,
  getUrlReportData
} = require('../pdf-url-report');
const {
  buildUptimePortfolioPdfBuffer,
  defaultUptimePortfolioDateRange,
  getUptimePortfolioReportData
} = require('../pdf-uptime-portfolio-report');
const {
  buildProjectPdfBuffer,
  defaultProjectReportDateRange,
  getProjectReportData
} = require('../pdf-project-report');
const { enforceReportAccess } = require('../report-access');

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

function resolvePdfRange(fromRaw, toRaw) {
  const from = parseDate(fromRaw);
  const to = parseDate(toRaw);
  if (from && to) return { fromDate: from, toDate: to };
  if (from && !to) return { fromDate: from, toDate: new Date() };
  if (!from && to) return { fromDate: new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000), toDate: to };
  return defaultPdfDateRange();
}

function resolveRange(fromRaw, toRaw, fallbackRangeFactory = null) {
  const from = parseDate(fromRaw);
  const to = parseDate(toRaw);
  if (from && to) return { fromDate: from, toDate: to };
  if (from && !to) return { fromDate: from, toDate: new Date() };
  if (!from && to) return { fromDate: new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000), toDate: to };
  if (typeof fallbackRangeFactory === 'function') return fallbackRangeFactory();
  return { fromDate: null, toDate: null };
}

function addDateRangeFilters({ columnSql, fromDate, toDate, whereParts, params }) {
  if (fromDate) {
    params.push(fromDate.toISOString());
    whereParts.push(`${columnSql} >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate.toISOString());
    whereParts.push(`${columnSql} <= $${params.length}`);
  }
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
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).send('Invalid date range: "from" must be <= "to".');
    }
    const access = enforceReportAccess({
      req,
      res,
      featureKey: 'globalXlsx',
      fromDate,
      toDate
    });
    if (!access.allowed) return;

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
      ${userWhereBase}
      ORDER BY mu.id
    `, userParam);

    // Changes (with optional date range)
    const changesParams = [...userParam];
    const changesWhere = ['true'];
    if (!isAdmin) changesWhere.push(`mu.user_id = $${changesParams.length}`);
    addDateRangeFilters({
      columnSql: 'a.detected_at',
      fromDate,
      toDate,
      whereParts: changesWhere,
      params: changesParams
    });

    const { rows: changes } = await pool.query(`
      SELECT a.id, a.detected_at, a.field_changed, a.old_value, a.new_value,
             a.severity, mu.url
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      WHERE ${changesWhere.join(' AND ')}
      ORDER BY a.detected_at DESC
      LIMIT 2000
    `, changesParams);

    // Error snapshots (status ≠ 200, excluding redirects)
    const errorsParams = [...userParam];
    const errorsWhere = ['(s.status_code = 0 OR s.status_code >= 400)'];
    if (!isAdmin) errorsWhere.push(`mu.user_id = $${errorsParams.length}`);
    addDateRangeFilters({
      columnSql: 's.checked_at',
      fromDate,
      toDate,
      whereParts: errorsWhere,
      params: errorsParams
    });

    const { rows: errors } = await pool.query(`
      SELECT DISTINCT ON (mu.id) mu.url, s.status_code, s.checked_at, s.response_time_ms
      FROM snapshots s
      JOIN monitored_urls mu ON mu.id = s.url_id
      WHERE ${errorsWhere.join(' AND ')}
      ORDER BY mu.id, s.checked_at DESC
    `, errorsParams);

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

// GET /export/report.pdf — PDF summary report (default: last 30 days)
router.get('/report.pdf', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const { fromDate, toDate } = resolvePdfRange(req.query.from, req.query.to);
    if (fromDate > toDate) {
      return res.status(400).send('Invalid date range: "from" must be <= "to".');
    }
    const access = enforceReportAccess({
      req,
      res,
      featureKey: 'globalPdf',
      fromDate,
      toDate
    });
    if (!access.allowed) return;

    const pdfBuffer = await buildPdfReportBuffer({
      userId: req.user.id,
      isAdmin,
      userEmail: req.user.email,
      fromDate,
      toDate
    });

    const filename = `metawatch-report-${formatDate(new Date())}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[Export PDF] Failed:', err.message);
    return res.status(500).send('PDF export failed: ' + err.message);
  }
});

// GET /export/url/:id.pdf — single URL summary report
router.get('/url/:id.pdf', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (!Number.isFinite(urlId) || urlId <= 0) {
    return res.status(400).send('Invalid URL ID');
  }

  try {
    const isAdmin = req.user?.role === 'admin';
    const { fromDate, toDate } = resolveRange(req.query.from, req.query.to, defaultUrlReportDateRange);
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).send('Invalid date range: "from" must be <= "to".');
    }
    const access = enforceReportAccess({
      req,
      res,
      featureKey: 'urlPdf',
      fromDate,
      toDate
    });
    if (!access.allowed) return;

    const data = await getUrlReportData({
      urlId,
      userId: req.user.id,
      isAdmin,
      fromDate,
      toDate
    });
    if (!data) return res.status(404).send('URL not found');

    const pdfBuffer = await buildUrlPdfBuffer({
      data,
      userEmail: req.user.email,
      generatedAt: new Date()
    });

    const safeName = String(data.urlRecord.url || `url-${urlId}`)
      .replace(/^https?:\/\//i, '')
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 50);
    const filename = `url-report-${safeName}-${formatDate(new Date())}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[Export URL PDF] Failed:', err.message);
    return res.status(500).send('PDF export failed: ' + err.message);
  }
});

// GET /export/url/:id.xlsx — single URL full history
router.get('/url/:id.xlsx', requireAuth, async (req, res) => {
  const urlId = parseInt(req.params.id, 10);
  if (isNaN(urlId)) return res.status(400).send('Invalid URL ID');
  const access = enforceReportAccess({
    req,
    res,
    featureKey: 'urlXlsx'
  });
  if (!access.allowed) return;

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

// GET /export/project/:id.pdf — project-level report (meta monitoring)
router.get('/project/:id.pdf', requireAuth, async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.status(400).send('Invalid project ID');
  }

  try {
    const isAdmin = req.user?.role === 'admin';
    const { fromDate, toDate } = resolveRange(req.query.from, req.query.to, defaultProjectReportDateRange);
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).send('Invalid date range: "from" must be <= "to".');
    }
    const access = enforceReportAccess({
      req,
      res,
      featureKey: 'projectPdf',
      fromDate,
      toDate
    });
    if (!access.allowed) return;

    const data = await getProjectReportData({
      projectId,
      userId: req.user.id,
      isAdmin,
      fromDate,
      toDate
    });
    if (!data) return res.status(404).send('Project not found');

    const pdfBuffer = await buildProjectPdfBuffer({
      data,
      userEmail: req.user.email,
      generatedAt: new Date()
    });

    const safeName = String(data.project.name || `project-${projectId}`)
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 40);
    const filename = `project-${safeName}-${formatDate(new Date())}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[Export Project PDF] Failed:', err.message);
    return res.status(500).send('PDF export failed: ' + err.message);
  }
});

// GET /export/project/:id.xlsx — project-level XLSX report (meta monitoring)
router.get('/project/:id.xlsx', requireAuth, async (req, res) => {
  const projectId = parseInt(req.params.id, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.status(400).send('Invalid project ID');
  }

  try {
    const isAdmin = req.user?.role === 'admin';
    const { fromDate, toDate } = resolveRange(req.query.from, req.query.to, defaultProjectReportDateRange);
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).send('Invalid date range: "from" must be <= "to".');
    }
    const access = enforceReportAccess({
      req,
      res,
      featureKey: 'projectXlsx',
      fromDate,
      toDate
    });
    if (!access.allowed) return;

    const data = await getProjectReportData({
      projectId,
      userId: req.user.id,
      isAdmin,
      fromDate,
      toDate
    });
    if (!data) return res.status(404).send('Project not found');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MetaWatch';
    workbook.created = new Date();

    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.getColumn(1).width = 32;
    summarySheet.getColumn(2).width = 44;
    const summaryRows = [
      ['Project', data.project.name || '-'],
      ['Created', data.project.created_at ? new Date(data.project.created_at).toISOString().slice(0, 10) : '-'],
      ['Generated', new Date().toISOString()],
      ['Range From', fromDate ? fromDate.toISOString().slice(0, 10) : '-'],
      ['Range To', toDate ? toDate.toISOString().slice(0, 10) : '-'],
      ['Total URLs', data.summary.totalUrls],
      ['Active URLs', data.summary.activeUrls],
      ['Changed URLs (24h)', data.summary.changedUrls],
      ['Error URLs', data.summary.errorUrls],
      ['Pending URLs', data.summary.pendingUrls],
      ['Avg Health Score', data.summary.avgHealth == null ? '-' : data.summary.avgHealth],
      ['Avg Response (ms)', data.summary.avgResponseMs == null ? '-' : data.summary.avgResponseMs],
      ['Alerts in period', data.summary.totalAlertsInPeriod],
      ['Critical alerts', data.summary.criticalAlertsInPeriod],
      ['Warning alerts', data.summary.warningAlertsInPeriod],
      ['Info alerts', data.summary.infoAlertsInPeriod]
    ];
    summaryRows.forEach(([label, value]) => {
      const row = summarySheet.addRow([label, value]);
      row.getCell(1).font = { bold: true };
    });

    const urlsSheet = workbook.addWorksheet('URLs');
    styleHeader(urlsSheet, ['URL', 'Status', 'Health', 'Last HTTP', 'Last Checked', 'Resp (ms)', 'Alerts 24h', 'Alerts Period'], {
      0: 54, 1: 12, 2: 10, 3: 10, 4: 22, 5: 12, 6: 12, 7: 14
    });
    for (const u of data.urls) {
      const row = urlsSheet.addRow([
        u.url,
        u.status,
        u.health_score == null ? '' : u.health_score,
        u.last_status_code == null ? '' : u.last_status_code,
        u.last_checked ? new Date(u.last_checked).toISOString() : '',
        u.last_response_ms == null ? '' : u.last_response_ms,
        u.alert_count_24h || 0,
        u.alert_count_period || 0
      ]);
      if (u.status === 'ERROR') row.eachCell(cell => { cell.fill = RED; });
      else if (u.status === 'CHANGED') row.eachCell(cell => { cell.fill = ORANGE; });
      else if (u.status === 'OK') row.eachCell(cell => { cell.fill = GREEN; });
    }

    const fieldsSheet = workbook.addWorksheet('Fields');
    styleHeader(fieldsSheet, ['Field', 'Count'], { 0: 30, 1: 14 });
    for (const f of data.fieldCounts) {
      fieldsSheet.addRow([f.field, f.count]);
    }

    const alertsSheet = workbook.addWorksheet('Alerts');
    styleHeader(alertsSheet, ['Detected', 'URL', 'Field', 'Severity', 'Old Value', 'New Value'], {
      0: 22, 1: 48, 2: 18, 3: 12, 4: 40, 5: 40
    });
    for (const a of data.alerts) {
      const row = alertsSheet.addRow([
        a.detected_at ? new Date(a.detected_at).toISOString() : '',
        a.url,
        a.field_changed,
        a.severity || 'info',
        a.old_value || '',
        a.new_value || ''
      ]);
      if (a.severity === 'critical') row.eachCell(cell => { cell.fill = RED; });
      else if (a.severity === 'warning') row.eachCell(cell => { cell.fill = ORANGE; });
    }

    const safeName = String(data.project.name || `project-${projectId}`)
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 40);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="project-${safeName}-${formatDate(new Date())}.xlsx"`
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[Export Project XLSX] Failed:', err.message);
    return res.status(500).send('Export failed: ' + err.message);
  }
});

// GET /export/uptime-report.xlsx — uptime monitors multi-sheet report
router.get('/uptime-report.pdf', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const { fromDate, toDate } = resolveRange(req.query.from, req.query.to, defaultUptimePortfolioDateRange);
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).send('Invalid date range: "from" must be <= "to".');
    }

    const access = enforceReportAccess({
      req,
      res,
      featureKey: 'uptimeGlobalPdf',
      fromDate,
      toDate
    });
    if (!access.allowed) return;

    const data = await getUptimePortfolioReportData({
      userId: req.user.id,
      isAdmin,
      fromDate,
      toDate
    });
    const pdfBuffer = await buildUptimePortfolioPdfBuffer({
      data,
      userEmail: req.user.email,
      generatedAt: new Date()
    });

    const filename = `uptime-portfolio-${formatDate(new Date())}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[Export Uptime Portfolio PDF] Failed:', err.message);
    return res.status(500).send('PDF export failed: ' + err.message);
  }
});

router.get('/uptime-report.xlsx', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const userId = req.user.id;
    const fromDate = parseDate(req.query.from);
    const toDate   = parseDate(req.query.to);
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).send('Invalid date range: "from" must be <= "to".');
    }
    const access = enforceReportAccess({
      req,
      res,
      featureKey: 'uptimeGlobalXlsx',
      fromDate,
      toDate
    });
    if (!access.allowed) return;

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

    const incidentsParams = [...userParam];
    const incidentsWhere = ['true'];
    if (!isAdmin) incidentsWhere.push(`um.user_id = $${incidentsParams.length}`);
    addDateRangeFilters({
      columnSql: 'ui.started_at',
      fromDate,
      toDate,
      whereParts: incidentsWhere,
      params: incidentsParams
    });

    const { rows: incidents } = await pool.query(`
      SELECT ui.*, um.name AS monitor_name, um.url AS monitor_url
      FROM uptime_incidents ui
      JOIN uptime_monitors um ON um.id = ui.monitor_id
      WHERE ${incidentsWhere.join(' AND ')}
      ORDER BY ui.started_at DESC LIMIT 1000
    `, incidentsParams);

    const checksParams = [...userParam];
    const checksWhere = ['true'];
    if (!isAdmin) checksWhere.push(`um.user_id = $${checksParams.length}`);
    addDateRangeFilters({
      columnSql: 'uc.checked_at',
      fromDate,
      toDate,
      whereParts: checksWhere,
      params: checksParams
    });

    const { rows: checks } = await pool.query(`
      SELECT uc.checked_at, uc.status, uc.response_time_ms, uc.status_code,
             um.name AS monitor_name
      FROM uptime_checks uc
      JOIN uptime_monitors um ON um.id = uc.monitor_id
      WHERE ${checksWhere.join(' AND ')}
      ORDER BY uc.checked_at DESC LIMIT 5000
    `, checksParams);

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

// GET /export/uptime/:id.pdf — single uptime monitor PDF report
router.get('/uptime/:id.pdf', requireAuth, async (req, res) => {
  const monitorId = parseInt(req.params.id, 10);
  if (!Number.isFinite(monitorId) || monitorId <= 0) {
    return res.status(400).send('Invalid monitor ID');
  }

  try {
    const isAdmin = req.user?.role === 'admin';
    const { fromDate, toDate } = resolveRange(req.query.from, req.query.to, defaultUptimeReportDateRange);
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).send('Invalid date range: "from" must be <= "to".');
    }
    const access = enforceReportAccess({
      req,
      res,
      featureKey: 'uptimeSitePdf',
      fromDate,
      toDate
    });
    if (!access.allowed) return;

    const data = await getUptimeMonitorReportData({
      monitorId,
      userId: req.user.id,
      isAdmin,
      fromDate,
      toDate
    });
    if (!data) return res.status(404).send('Monitor not found');

    const pdfBuffer = await buildUptimeMonitorPdfBuffer({
      data,
      userEmail: req.user.email,
      generatedAt: new Date()
    });

    const safeName = String(data.monitor.name || `monitor-${monitorId}`)
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 40);
    const filename = `uptime-${safeName}-${formatDate(new Date())}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[Export Uptime PDF] Failed:', err.message);
    return res.status(500).send('Export failed: ' + err.message);
  }
});

// GET /export/uptime/:id.xlsx — single uptime monitor XLSX report
router.get('/uptime/:id.xlsx', requireAuth, async (req, res) => {
  const monitorId = parseInt(req.params.id, 10);
  if (!Number.isFinite(monitorId) || monitorId <= 0) {
    return res.status(400).send('Invalid monitor ID');
  }

  try {
    const isAdmin = req.user?.role === 'admin';
    const { fromDate, toDate } = resolveRange(req.query.from, req.query.to, defaultUptimeReportDateRange);
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).send('Invalid date range: "from" must be <= "to".');
    }
    const access = enforceReportAccess({
      req,
      res,
      featureKey: 'uptimeSiteXlsx',
      fromDate,
      toDate
    });
    if (!access.allowed) return;

    const data = await getUptimeMonitorReportData({
      monitorId,
      userId: req.user.id,
      isAdmin,
      fromDate,
      toDate
    });
    if (!data) return res.status(404).send('Monitor not found');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MetaWatch';
    workbook.created = new Date();

    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.getColumn(1).width = 34;
    summarySheet.getColumn(2).width = 40;
    const summaryRows = [
      ['Monitor', data.monitor.name || '-'],
      ['URL', data.monitor.url || '-'],
      ['Generated At', new Date().toISOString()],
      ['Date Range From', fromDate ? fromDate.toISOString().slice(0, 10) : '-'],
      ['Date Range To', toDate ? toDate.toISOString().slice(0, 10) : '-'],
      ['Last Status', String(data.summary.lastStatus || 'unknown').toUpperCase()],
      ['Last Checked', data.summary.lastCheckedAt ? new Date(data.summary.lastCheckedAt).toISOString() : '-'],
      ['Uptime (range)', data.summary.rangePct == null ? '-' : `${data.summary.rangePct}%`],
      ['Checks (range)', data.summary.totalChecks],
      ['Down checks (range)', data.summary.downChecks],
      ['Incidents (range)', data.summary.totalIncidents],
      ['Downtime (range, min)', data.summary.totalDowntimeMinutes],
      ['Avg response (range, ms)', data.summary.avgResponseMs == null ? '-' : data.summary.avgResponseMs],
      ['Uptime 1h', data.summary.windows['1h'] == null ? '-' : `${data.summary.windows['1h']}%`],
      ['Uptime 24h', data.summary.windows['24h'] == null ? '-' : `${data.summary.windows['24h']}%`],
      ['Uptime 7d', data.summary.windows['7d'] == null ? '-' : `${data.summary.windows['7d']}%`],
      ['Uptime 30d', data.summary.windows['30d'] == null ? '-' : `${data.summary.windows['30d']}%`],
      ['Uptime 90d', data.summary.windows['90d'] == null ? '-' : `${data.summary.windows['90d']}%`]
    ];
    summaryRows.forEach(([label, value]) => {
      const row = summarySheet.addRow([label, value]);
      row.getCell(1).font = { bold: true };
    });

    const incidentsSheet = workbook.addWorksheet('Incidents');
    styleHeader(incidentsSheet, ['Started', 'Resolved', 'Duration (min)', 'Cause', 'Post-mortem'], {
      0: 22, 1: 22, 2: 16, 3: 22, 4: 50
    });
    for (const inc of data.incidents) {
      incidentsSheet.addRow([
        inc.started_at ? new Date(inc.started_at).toISOString() : '',
        inc.resolved_at ? new Date(inc.resolved_at).toISOString() : 'Open',
        inc.duration_seconds ? Math.round(Number(inc.duration_seconds || 0) / 60) : '',
        inc.cause || '',
        inc.postmortem_text || ''
      ]);
    }

    const checksSheet = workbook.addWorksheet('Checks');
    styleHeader(checksSheet, ['Checked At', 'Status', 'HTTP', 'Response (ms)', 'Error'], {
      0: 22, 1: 12, 2: 10, 3: 14, 4: 60
    });
    for (const c of data.checks) {
      const row = checksSheet.addRow([
        c.checked_at ? new Date(c.checked_at).toISOString() : '',
        c.status || 'unknown',
        c.status_code || '',
        c.response_time_ms || '',
        c.error_message || ''
      ]);
      if (c.status === 'down') row.eachCell(cell => { cell.fill = RED; });
      else if (c.status === 'degraded') row.eachCell(cell => { cell.fill = ORANGE; });
    }

    const weekSheet = workbook.addWorksheet('Last 7 Days');
    styleHeader(weekSheet, ['Date', 'Health', 'Checks'], { 0: 16, 1: 16, 2: 12 });
    for (const d of data.weekBuckets) {
      const row = weekSheet.addRow([
        d.date,
        d.status === 'up' ? 'UP' : d.status === 'degraded' ? 'DEGRADED' : d.status === 'down' ? 'DOWN' : 'NO DATA',
        d.count || 0
      ]);
      if (d.status === 'down') row.eachCell(cell => { cell.fill = RED; });
      else if (d.status === 'degraded') row.eachCell(cell => { cell.fill = ORANGE; });
      else if (d.status === 'up') row.eachCell(cell => { cell.fill = GREEN; });
    }

    const hourSheet = workbook.addWorksheet('Last 24 Hours');
    styleHeader(hourSheet, ['Hour UTC', 'Health', 'Checks', 'p95 (ms)', 'Latency Level'], {
      0: 14, 1: 14, 2: 12, 3: 12, 4: 16
    });
    for (let i = 0; i < data.hourBuckets.length; i++) {
      const h = data.hourBuckets[i];
      const latency = data.latencyBuckets[i] || null;
      const row = hourSheet.addRow([
        h.hour_label,
        h.status === 'up' ? 'UP' : h.status === 'degraded' ? 'DEGRADED' : h.status === 'down' ? 'DOWN' : 'NO DATA',
        h.count || 0,
        latency?.p95_ms == null ? '' : latency.p95_ms,
        latency?.level || 'empty'
      ]);
      if (h.status === 'down') row.eachCell(cell => { cell.fill = RED; });
      else if (h.status === 'degraded') row.eachCell(cell => { cell.fill = ORANGE; });
    }

    const safeName = String(data.monitor.name || `monitor-${monitorId}`)
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 40);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="uptime-${safeName}-${formatDate(new Date())}.xlsx"`
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[Export Uptime XLSX] Failed:', err.message);
    return res.status(500).send('Export failed: ' + err.message);
  }
});

// GET /export/alerts.csv — all alerts as CSV
router.get('/alerts.csv', requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const fromDate = parseDate(req.query.from);
    const toDate   = parseDate(req.query.to);
    if (fromDate && toDate && fromDate > toDate) {
      return res.status(400).send('Invalid date range: "from" must be <= "to".');
    }
    const access = enforceReportAccess({
      req,
      res,
      featureKey: 'alertsCsv',
      fromDate,
      toDate
    });
    if (!access.allowed) return;

    const alertParams = isAdmin ? [] : [req.user.id];
    const alertWhere = ['true'];
    if (!isAdmin) alertWhere.push(`mu.user_id = $${alertParams.length}`);
    addDateRangeFilters({
      columnSql: 'a.detected_at',
      fromDate,
      toDate,
      whereParts: alertWhere,
      params: alertParams
    });

    const { rows: alerts } = await pool.query(`
      SELECT a.id, a.detected_at, a.field_changed, a.old_value, a.new_value,
             a.severity, mu.url
      FROM alerts a
      JOIN monitored_urls mu ON mu.id = a.url_id
      WHERE ${alertWhere.join(' AND ')}
      ORDER BY a.detected_at DESC
    `, alertParams);

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
