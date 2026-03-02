const PDFDocument = require('pdfkit');
const pool = require('./db');

const DAY_MS = 24 * 60 * 60 * 1000;

function truncate(value, max = 120) {
  const str = String(value ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}...`;
}

function fmtDate(value) {
  if (!value) return '-';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toISOString().slice(0, 10);
}

function fmtDateTime(value) {
  if (!value) return '-';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function fmtNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 10) / 10);
}

function ensureSpace(doc, needed = 40) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
  }
}

function drawSectionTitle(doc, text) {
  ensureSpace(doc, 28);
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111').text(text);
  doc.moveDown(0.2);
}

function drawTable(doc, headers, rows, colWidths) {
  const startX = doc.page.margins.left;
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  const rowHeight = 20;

  function drawRow(cells, isHeader = false) {
    ensureSpace(doc, rowHeight + 8);

    const y = doc.y;
    let x = startX;

    if (isHeader) {
      doc.save();
      doc.rect(startX, y, totalWidth, rowHeight).fill('#f1f5f9');
      doc.restore();
    }

    for (let i = 0; i < colWidths.length; i++) {
      const width = colWidths[i];
      const text = truncate(cells[i] == null ? '' : String(cells[i]), isHeader ? 80 : 140);
      doc.rect(x, y, width, rowHeight).stroke('#d1d5db');
      doc.font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(9)
        .fillColor('#111')
        .text(text, x + 3, y + 6, { width: width - 6, height: rowHeight - 6, ellipsis: true });
      x += width;
    }

    doc.y = y + rowHeight;
  }

  drawRow(headers, true);

  for (const row of rows) {
    if (doc.y + rowHeight + 8 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawRow(headers, true);
    }
    drawRow(row, false);
  }
}

function applyDateFilter({ aliasColumn, fromDate, toDate, clauses, params }) {
  if (fromDate) {
    params.push(fromDate);
    clauses.push(`${aliasColumn} >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate);
    clauses.push(`${aliasColumn} <= $${params.length}`);
  }
}

function applyOwnerFilter({ isAdmin, userId, alias, clauses, params }) {
  if (isAdmin) return;
  params.push(userId);
  clauses.push(`${alias}.user_id = $${params.length}`);
}

async function collectReportData({ userId, isAdmin, fromDate, toDate }) {
  const buildFilter = ({ ownerAlias, dateColumn }) => {
    const params = [];
    const clauses = ['1=1'];
    applyOwnerFilter({ isAdmin, userId, alias: ownerAlias, clauses, params });
    if (dateColumn) {
      applyDateFilter({ aliasColumn: dateColumn, fromDate, toDate, clauses, params });
    }
    return { sql: clauses.join(' AND '), params };
  };

  const urlFilter = buildFilter({ ownerAlias: 'mu', dateColumn: null });
  const checksFilter = buildFilter({ ownerAlias: 'mu', dateColumn: 's.checked_at' });
  const alertsFilter = buildFilter({ ownerAlias: 'mu', dateColumn: 'a.detected_at' });
  const incidentsFilter = buildFilter({ ownerAlias: 'um', dateColumn: 'ui.started_at' });
  const uptimeFilter = buildFilter({ ownerAlias: 'um', dateColumn: 'uc.checked_at' });

  const [urlSummaryRes, checksRes, changesRes, errorsRes, monitorsRes, uptimeRes, incidentsRes] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total_urls
       FROM monitored_urls mu
       WHERE ${urlFilter.sql}`,
      urlFilter.params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS checks_run
       FROM snapshots s
       JOIN monitored_urls mu ON mu.id = s.url_id
       WHERE ${checksFilter.sql}`,
      checksFilter.params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS changes_detected
       FROM alerts a
       JOIN monitored_urls mu ON mu.id = a.url_id
       WHERE ${alertsFilter.sql}`,
      alertsFilter.params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS errors_count
       FROM snapshots s
       JOIN monitored_urls mu ON mu.id = s.url_id
       WHERE ${checksFilter.sql}
         AND (s.status_code = 0 OR s.status_code >= 400)`,
      checksFilter.params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total_monitors
       FROM uptime_monitors um
       WHERE ${isAdmin ? '1=1' : 'um.user_id = $1'}`,
      isAdmin ? [] : [userId]
    ),
    pool.query(
      `SELECT
         ROUND((COUNT(*) FILTER (WHERE uc.status IN ('up', 'degraded'))::float / NULLIF(COUNT(*), 0) * 100)::numeric, 1) AS avg_uptime_pct,
         COUNT(*)::int AS checks_count,
         ROUND(AVG(uc.response_time_ms)::numeric, 0)::int AS avg_response_ms
       FROM uptime_checks uc
       JOIN uptime_monitors um ON um.id = uc.monitor_id
       WHERE ${uptimeFilter.sql}`,
      uptimeFilter.params
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS incidents_count,
         COALESCE(SUM(ui.duration_seconds), 0)::int AS downtime_seconds
       FROM uptime_incidents ui
       JOIN uptime_monitors um ON um.id = ui.monitor_id
       WHERE ${incidentsFilter.sql}`,
      incidentsFilter.params
    )
  ]);

  const topChangesParams = [];
  const topChangesWhere = ['1=1'];
  applyOwnerFilter({ isAdmin, userId, alias: 'mu', clauses: topChangesWhere, params: topChangesParams });
  applyDateFilter({ aliasColumn: 'a.detected_at', fromDate, toDate, clauses: topChangesWhere, params: topChangesParams });
  const { rows: topChangedUrls } = await pool.query(
    `SELECT
       mu.url,
       COUNT(*)::int AS changes_count,
       MAX(a.detected_at) AS last_changed_at,
       MAX(mu.health_score)::int AS health_score
     FROM alerts a
     JOIN monitored_urls mu ON mu.id = a.url_id
     WHERE ${topChangesWhere.join(' AND ')}
     GROUP BY mu.id, mu.url
     ORDER BY changes_count DESC, last_changed_at DESC
     LIMIT 10`,
    topChangesParams
  );

  const fieldsParams = [];
  const fieldsWhere = ['1=1'];
  applyOwnerFilter({ isAdmin, userId, alias: 'mu', clauses: fieldsWhere, params: fieldsParams });
  applyDateFilter({ aliasColumn: 'a.detected_at', fromDate, toDate, clauses: fieldsWhere, params: fieldsParams });
  const { rows: changesByField } = await pool.query(
    `SELECT a.field_changed AS field, COUNT(*)::int AS count
     FROM alerts a
     JOIN monitored_urls mu ON mu.id = a.url_id
     WHERE ${fieldsWhere.join(' AND ')}
     GROUP BY a.field_changed
     ORDER BY count DESC`,
    fieldsParams
  );

  const errorUrlsParams = [];
  const errorUrlsWhere = ['(s.status_code = 0 OR s.status_code >= 400)'];
  applyOwnerFilter({ isAdmin, userId, alias: 'mu', clauses: errorUrlsWhere, params: errorUrlsParams });
  applyDateFilter({ aliasColumn: 's.checked_at', fromDate, toDate, clauses: errorUrlsWhere, params: errorUrlsParams });
  const { rows: errorUrls } = await pool.query(
    `SELECT DISTINCT ON (mu.id)
       mu.url,
       s.status_code,
       s.checked_at
     FROM snapshots s
     JOIN monitored_urls mu ON mu.id = s.url_id
     WHERE ${errorUrlsWhere.join(' AND ')}
     ORDER BY mu.id, s.checked_at DESC
     LIMIT 20`,
    errorUrlsParams
  );

  const monitorSummaryParams = [];
  let monitorOwnerWhere = '1=1';
  if (!isAdmin) {
    monitorSummaryParams.push(userId);
    monitorOwnerWhere = `um.user_id = $${monitorSummaryParams.length}`;
  }
  let checksDateWhere = '1=1';
  let incidentsDateWhere = '1=1';
  if (fromDate) {
    monitorSummaryParams.push(fromDate);
    checksDateWhere += ` AND uc.checked_at >= $${monitorSummaryParams.length}`;
    incidentsDateWhere += ` AND ui.started_at >= $${monitorSummaryParams.length}`;
  }
  if (toDate) {
    monitorSummaryParams.push(toDate);
    checksDateWhere += ` AND uc.checked_at <= $${monitorSummaryParams.length}`;
    incidentsDateWhere += ` AND ui.started_at <= $${monitorSummaryParams.length}`;
  }

  const { rows: monitorSummary } = await pool.query(
    `SELECT
       um.id,
       um.name,
       um.url,
       lc.status AS current_status,
       (
         SELECT ROUND((COUNT(*) FILTER (WHERE uc.status IN ('up', 'degraded'))::float / NULLIF(COUNT(*), 0) * 100)::numeric, 1)
         FROM uptime_checks uc
         WHERE uc.monitor_id = um.id
           AND ${checksDateWhere}
       ) AS uptime_pct,
       (
         SELECT COUNT(*)::int
         FROM uptime_incidents ui
         WHERE ui.monitor_id = um.id
           AND ${incidentsDateWhere}
       ) AS incidents_count,
       (
         SELECT ROUND(AVG(uc.response_time_ms)::numeric, 0)::int
         FROM uptime_checks uc
         WHERE uc.monitor_id = um.id
           AND uc.response_time_ms IS NOT NULL
           AND ${checksDateWhere}
       ) AS avg_response_ms
     FROM uptime_monitors um
     LEFT JOIN LATERAL (
       SELECT status
       FROM uptime_checks
       WHERE monitor_id = um.id
       ORDER BY checked_at DESC
       LIMIT 1
     ) lc ON true
     WHERE ${monitorOwnerWhere}
     ORDER BY um.name ASC
     LIMIT 100`,
    monitorSummaryParams
  );

  const incidentLogParams = [];
  const incidentLogWhere = ['1=1'];
  applyOwnerFilter({ isAdmin, userId, alias: 'um', clauses: incidentLogWhere, params: incidentLogParams });
  applyDateFilter({ aliasColumn: 'ui.started_at', fromDate, toDate, clauses: incidentLogWhere, params: incidentLogParams });
  const { rows: incidentLog } = await pool.query(
    `SELECT
       um.name AS monitor_name,
       ui.started_at,
       ui.resolved_at,
       ui.duration_seconds,
       ui.cause
     FROM uptime_incidents ui
     JOIN uptime_monitors um ON um.id = ui.monitor_id
     WHERE ${incidentLogWhere.join(' AND ')}
     ORDER BY ui.started_at DESC
     LIMIT 100`,
    incidentLogParams
  );

  return {
    summary: {
      totalUrls: urlSummaryRes.rows[0]?.total_urls || 0,
      checksRun: checksRes.rows[0]?.checks_run || 0,
      changesDetected: changesRes.rows[0]?.changes_detected || 0,
      errors: errorsRes.rows[0]?.errors_count || 0,
      totalMonitors: monitorsRes.rows[0]?.total_monitors || 0,
      avgUptimePct: uptimeRes.rows[0]?.avg_uptime_pct ?? null,
      incidents: incidentsRes.rows[0]?.incidents_count || 0,
      totalDowntimeSeconds: incidentsRes.rows[0]?.downtime_seconds || 0
    },
    topChangedUrls,
    changesByField,
    errorUrls,
    monitorSummary,
    incidentLog
  };
}

function addFooterToBufferedPages(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - doc.page.margins.bottom + 14;
    doc.font('Helvetica')
      .fontSize(9)
      .fillColor('#666')
      .text(
        `Generated by MetaWatch • Page ${i + 1} of ${range.count}`,
        doc.page.margins.left,
        y,
        {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          align: 'center'
        }
      );
  }
}

async function buildPdfReportBuffer({ userId, isAdmin = false, userEmail, fromDate, toDate }) {
  const data = await collectReportData({ userId, isAdmin, fromDate, toDate });
  const now = new Date();

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true });
    const chunks = [];

    doc.on('data', c => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    // Page 1: Cover
    doc.font('Helvetica-Bold').fontSize(28).fillColor('#0f172a').text('MetaWatch', { align: 'center' });
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111').text('Monitoring Report', { align: 'center' });
    doc.moveDown(1.3);
    doc.font('Helvetica').fontSize(12).fillColor('#374151')
      .text(`Period: ${fmtDate(fromDate)} - ${fmtDate(toDate)}`, { align: 'center' });
    doc.moveDown(0.2);
    doc.text(`Generated: ${fmtDateTime(now)}`, { align: 'center' });
    doc.moveDown(0.2);
    doc.text(`User: ${userEmail || '-'}`, { align: 'center' });

    // Page 2: Executive Summary
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111').text('Executive Summary');
    doc.moveDown(0.7);
    doc.font('Helvetica').fontSize(12);
    doc.text(`Total URLs: ${fmtNumber(data.summary.totalUrls)}`);
    doc.text(`Checks Run: ${fmtNumber(data.summary.checksRun)}`);
    doc.text(`Changes Detected: ${fmtNumber(data.summary.changesDetected)}`);
    doc.text(`Errors: ${fmtNumber(data.summary.errors)}`);
    doc.moveDown(0.6);
    doc.text(`Uptime Monitors: ${fmtNumber(data.summary.totalMonitors)}`);
    doc.text(`Avg Uptime %: ${data.summary.avgUptimePct == null ? '-' : fmtNumber(data.summary.avgUptimePct) + '%'}`);
    doc.text(`Incidents: ${fmtNumber(data.summary.incidents)}`);
    doc.text(`Total Downtime: ${fmtNumber((data.summary.totalDowntimeSeconds || 0) / 60)} min`);
    doc.moveDown(0.8);
    doc.text(
      `During this period, ${fmtNumber(data.summary.checksRun)} checks were performed across ` +
      `${fmtNumber(data.summary.totalUrls)} monitored URLs.`,
      { lineGap: 2 }
    );

    // Page 3: Meta Monitoring
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111').text('Meta Monitoring');
    drawSectionTitle(doc, 'Top 10 Most Changed URLs');
    drawTable(
      doc,
      ['URL', 'Changes', 'Last Changed', 'Health Score'],
      data.topChangedUrls.map(r => [r.url, r.changes_count, fmtDateTime(r.last_changed_at), r.health_score ?? '-']),
      [250, 70, 120, 70]
    );

    drawSectionTitle(doc, 'Changes by Field Type');
    const totalFieldChanges = data.changesByField.reduce((sum, r) => sum + Number(r.count || 0), 0);
    drawTable(
      doc,
      ['Field', 'Count', '% of total'],
      data.changesByField.map(r => {
        const pct = totalFieldChanges > 0 ? ((Number(r.count || 0) / totalFieldChanges) * 100) : 0;
        return [r.field, r.count, `${fmtNumber(pct)}%`];
      }),
      [280, 90, 90]
    );

    drawSectionTitle(doc, 'Error URLs (non-200)');
    drawTable(
      doc,
      ['URL', 'Status Code', 'Last Checked'],
      data.errorUrls.map(r => [r.url, r.status_code ?? '-', fmtDateTime(r.checked_at)]),
      [280, 90, 90]
    );

    // Page 4+: Uptime
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111').text('Uptime Monitoring');
    drawSectionTitle(doc, 'Monitor Summary');
    drawTable(
      doc,
      ['Name', 'URL', 'Status', 'Uptime %', 'Incidents', 'Avg Response'],
      data.monitorSummary.map(r => [
        r.name,
        r.url,
        r.current_status || 'unknown',
        r.uptime_pct == null ? '-' : `${fmtNumber(r.uptime_pct)}%`,
        r.incidents_count || 0,
        r.avg_response_ms == null ? '-' : `${r.avg_response_ms} ms`
      ]),
      [95, 180, 60, 60, 60, 65]
    );

    drawSectionTitle(doc, 'Incident Log');
    drawTable(
      doc,
      ['Monitor', 'Started', 'Resolved', 'Duration', 'Cause'],
      data.incidentLog.map(r => [
        r.monitor_name,
        fmtDateTime(r.started_at),
        r.resolved_at ? fmtDateTime(r.resolved_at) : 'Open',
        r.duration_seconds == null ? '-' : `${fmtNumber(r.duration_seconds / 60)} min`,
        r.cause || '-'
      ]),
      [120, 110, 110, 70, 80]
    );

    addFooterToBufferedPages(doc);
    doc.end();
  });
}

function defaultPdfDateRange() {
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - 30 * DAY_MS);
  return { fromDate, toDate };
}

module.exports = {
  buildPdfReportBuffer,
  defaultPdfDateRange
};
