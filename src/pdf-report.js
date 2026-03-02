const PDFDocument = require('pdfkit');
const pool = require('./db');

const DAY_MS = 24 * 60 * 60 * 1000;

const COLORS = {
  ink: '#0f172a',
  muted: '#475569',
  border: '#d7e3f4',
  soft: '#f8fbff',
  accent: '#2563eb',
  ok: '#16a34a',
  warn: '#d97706',
  error: '#dc2626'
};

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

function fmtNumber(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  const p = Math.pow(10, digits);
  return String(Math.round(n * p) / p);
}

function ensureSpace(doc, needed = 40) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) {
    doc.addPage();
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

function drawHeaderBand(doc, title, subtitle, accent = COLORS.accent) {
  const x = doc.page.margins.left;
  const y = doc.y;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.roundedRect(x, y, w, 84, 10).fill(COLORS.soft);
  doc.roundedRect(x, y, 7, 84, 7).fill(accent);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(22).fillColor(COLORS.ink).text(title, x + 18, y + 14);
  doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted).text(subtitle, x + 18, y + 44, {
    width: w - 24,
    lineGap: 1
  });

  doc.y = y + 98;
}

function drawCover(doc, { userEmail, fromDate, toDate, generatedAt }) {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y = doc.y;

  doc.save();
  doc.roundedRect(x, y, w, 220, 14).fill('#f6faff');
  doc.roundedRect(x, y, w, 74, 14).fill('#dbeafe');
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(32).fillColor('#1e3a8a').text('MetaWatch', x + 20, y + 16);
  doc.font('Helvetica-Bold').fontSize(22).fillColor(COLORS.ink).text('Monitoring Report', x + 20, y + 50);

  doc.font('Helvetica').fontSize(11).fillColor(COLORS.muted).text('Executive summary of metadata and uptime monitoring.', x + 20, y + 84);

  const metaX = x + 20;
  let lineY = y + 128;
  const rows = [
    ['Period', `${fmtDate(fromDate)} - ${fmtDate(toDate)}`],
    ['Generated', fmtDateTime(generatedAt)],
    ['User', userEmail || '-'],
    ['Report Type', 'Portfolio overview (Meta + Uptime)']
  ];
  for (const [label, value] of rows) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#1d4ed8').text(label, metaX, lineY, { width: 120 });
    doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink).text(value, metaX + 124, lineY, { width: w - 170 });
    lineY += 22;
  }

  doc.y = y + 244;
}

function drawKpiCards(doc, items) {
  const cols = 2;
  const gap = 10;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cardWidth = (usableWidth - gap) / cols;
  const cardHeight = 58;

  for (let i = 0; i < items.length; i += cols) {
    ensureSpace(doc, cardHeight + 8);
    const y = doc.y;
    for (let c = 0; c < cols; c++) {
      const item = items[i + c];
      if (!item) continue;
      const x = doc.page.margins.left + c * (cardWidth + gap);
      doc.save();
      doc.roundedRect(x, y, cardWidth, cardHeight, 8).fillAndStroke('#ffffff', COLORS.border);
      doc.restore();

      doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted).text(item.label, x + 10, y + 9, {
        width: cardWidth - 20,
        ellipsis: true
      });

      const valueColor = item.tone === 'ok'
        ? COLORS.ok
        : item.tone === 'warn'
        ? COLORS.warn
        : item.tone === 'error'
        ? COLORS.error
        : COLORS.ink;

      doc.font('Helvetica-Bold').fontSize(16).fillColor(valueColor).text(item.value, x + 10, y + 26, {
        width: cardWidth - 20,
        ellipsis: true
      });
    }
    doc.y = y + cardHeight + 8;
  }
}

function drawSummaryNarrative(doc, text) {
  ensureSpace(doc, 60);
  const x = doc.page.margins.left;
  const y = doc.y;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.save();
  doc.roundedRect(x, y, w, 56, 8).fill('#eff6ff');
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#1d4ed8').text('Key Takeaway', x + 10, y + 10);
  doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink).text(text, x + 10, y + 24, {
    width: w - 20,
    lineGap: 1
  });
  doc.y = y + 66;
}

function drawSectionTitle(doc, title) {
  ensureSpace(doc, 26);
  doc.moveDown(0.2);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.ink).text(title);
  doc.moveDown(0.2);
}

function drawTable(doc, headers, rows, colWidths) {
  const startX = doc.page.margins.left;
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  const rowHeight = 20;

  function drawHeader() {
    const y = doc.y;
    doc.save();
    doc.roundedRect(startX, y, totalWidth, rowHeight, 4).fill(COLORS.ink);
    doc.restore();
    let x = startX;
    for (let i = 0; i < colWidths.length; i++) {
      const width = colWidths[i];
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff')
        .text(String(headers[i] || ''), x + 4, y + 6, { width: width - 8, ellipsis: true });
      x += width;
    }
    doc.y = y + rowHeight;
  }

  drawHeader();

  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader();
    }

    const y = doc.y;
    if (rIdx % 2 === 0) {
      doc.save();
      doc.rect(startX, y, totalWidth, rowHeight).fill('#f8fafc');
      doc.restore();
    }

    let x = startX;
    const row = rows[rIdx];
    for (let i = 0; i < colWidths.length; i++) {
      const width = colWidths[i];
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.ink)
        .text(truncate(row[i] == null ? '' : String(row[i]), 70), x + 4, y + 6, { width: width - 8, ellipsis: true });
      x += width;
    }

    doc.y = y + rowHeight;
  }
}

function addFooterToBufferedPages(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - doc.page.margins.bottom + 14;
    doc.font('Helvetica')
      .fontSize(8)
      .fillColor(COLORS.muted)
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
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
    const chunks = [];

    doc.on('data', c => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    // Cover
    drawCover(doc, {
      userEmail,
      fromDate,
      toDate,
      generatedAt: now
    });

    // Executive summary
    doc.addPage();
    drawHeaderBand(
      doc,
      'Executive Summary',
      `Scope: ${fmtDate(fromDate)} - ${fmtDate(toDate)} • Portfolio-wide performance snapshot`,
      '#1d4ed8'
    );

    drawKpiCards(doc, [
      { label: 'Total URLs', value: fmtNumber(data.summary.totalUrls, 0) },
      { label: 'Checks run', value: fmtNumber(data.summary.checksRun, 0) },
      { label: 'Changes detected', value: fmtNumber(data.summary.changesDetected, 0), tone: data.summary.changesDetected > 0 ? 'warn' : 'ok' },
      { label: 'Errors (non-200)', value: fmtNumber(data.summary.errors, 0), tone: data.summary.errors > 0 ? 'error' : 'ok' },
      { label: 'Uptime monitors', value: fmtNumber(data.summary.totalMonitors, 0) },
      { label: 'Avg uptime %', value: data.summary.avgUptimePct == null ? '-' : `${fmtNumber(data.summary.avgUptimePct)}%`, tone: data.summary.avgUptimePct != null && Number(data.summary.avgUptimePct) < 99 ? 'warn' : 'ok' },
      { label: 'Incidents', value: fmtNumber(data.summary.incidents, 0), tone: data.summary.incidents > 0 ? 'warn' : 'ok' },
      { label: 'Total downtime', value: `${fmtNumber((data.summary.totalDowntimeSeconds || 0) / 60)} min`, tone: (data.summary.totalDowntimeSeconds || 0) > 0 ? 'warn' : 'ok' }
    ]);

    const narrative =
      `During this period, ${fmtNumber(data.summary.checksRun, 0)} checks were executed across ` +
      `${fmtNumber(data.summary.totalUrls, 0)} URLs. ` +
      `${fmtNumber(data.summary.changesDetected, 0)} metadata changes and ${fmtNumber(data.summary.incidents, 0)} uptime incidents were recorded.`;
    drawSummaryNarrative(doc, narrative);

    // Meta section
    doc.addPage();
    drawHeaderBand(doc, 'Meta Monitoring', 'Top changes, field distribution, and URLs with response issues.', '#2563eb');

    drawSectionTitle(doc, 'Top 10 Most Changed URLs');
    drawTable(
      doc,
      ['URL', 'Changes', 'Last Changed', 'Health'],
      data.topChangedUrls.map(r => [
        r.url,
        r.changes_count,
        fmtDateTime(r.last_changed_at),
        r.health_score == null ? '-' : r.health_score
      ]),
      [245, 70, 130, 65]
    );

    drawSectionTitle(doc, 'Changes by Field Type');
    const totalFieldChanges = data.changesByField.reduce((sum, r) => sum + Number(r.count || 0), 0);
    drawTable(
      doc,
      ['Field', 'Count', 'Share'],
      data.changesByField.map(r => {
        const pct = totalFieldChanges > 0 ? (Number(r.count || 0) / totalFieldChanges) * 100 : 0;
        return [r.field, r.count, `${fmtNumber(pct)}%`];
      }),
      [270, 80, 90]
    );

    drawSectionTitle(doc, 'Error URLs (non-200)');
    drawTable(
      doc,
      ['URL', 'Status', 'Last Checked'],
      data.errorUrls.map(r => [r.url, r.status_code ?? '-', fmtDateTime(r.checked_at)]),
      [280, 80, 100]
    );

    // Uptime section
    doc.addPage();
    drawHeaderBand(doc, 'Uptime Monitoring', 'Current monitor health, uptime, incidents, and response profile.', '#0ea5e9');

    drawSectionTitle(doc, 'Monitor Summary');
    drawTable(
      doc,
      ['Name', 'URL', 'Status', 'Uptime %', 'Incidents', 'Avg Response'],
      data.monitorSummary.map(r => [
        r.name,
        r.url,
        String(r.current_status || 'unknown').toUpperCase(),
        r.uptime_pct == null ? '-' : `${fmtNumber(r.uptime_pct)}%`,
        r.incidents_count || 0,
        r.avg_response_ms == null ? '-' : `${r.avg_response_ms} ms`
      ]),
      [90, 170, 70, 70, 60, 75]
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
      [115, 105, 105, 75, 95]
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
