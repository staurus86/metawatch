const PDFDocument = require('pdfkit');
const pool = require('./db');

const DAY_MS = 24 * 60 * 60 * 1000;

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

function truncate(value, max = 80) {
  const str = String(value ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1)}...`;
}

function parseDateRangeFilter({ column, fromDate, toDate, startIndex = 1 }) {
  const params = [];
  const clauses = [];
  let idx = startIndex;

  if (fromDate) {
    params.push(fromDate.toISOString());
    clauses.push(`${column} >= $${idx}`);
    idx += 1;
  }
  if (toDate) {
    params.push(toDate.toISOString());
    clauses.push(`${column} <= $${idx}`);
    idx += 1;
  }

  return {
    sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
    params,
    nextIndex: idx
  };
}

function defaultProjectReportDateRange() {
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - 30 * DAY_MS);
  return { fromDate, toDate };
}

function computeStatus(urlRow) {
  const code = Number(urlRow.last_status_code);
  if (!Number.isFinite(code)) return 'PENDING';
  if (code === 0 || code >= 400) return 'ERROR';
  if (Number(urlRow.alert_count_24h || 0) > 0) return 'CHANGED';
  return 'OK';
}

async function getProjectReportData({ projectId, userId, isAdmin = false, fromDate = null, toDate = null }) {
  const projectParams = [projectId];
  let projectWhere = 'p.id = $1';
  if (!isAdmin) {
    projectParams.push(userId);
    projectWhere += ` AND p.user_id = $${projectParams.length}`;
  }

  const { rows: [project] } = await pool.query(
    `SELECT p.id, p.name, p.user_id, p.created_at
     FROM projects p
     WHERE ${projectWhere}
     LIMIT 1`,
    projectParams
  );

  if (!project) return null;

  const periodFilter = parseDateRangeFilter({
    column: 'a.detected_at',
    fromDate,
    toDate,
    startIndex: 2
  });

  const urlsParams = [projectId, ...periodFilter.params];
  const { rows: urls } = await pool.query(
    `SELECT
       mu.id,
       mu.url,
       mu.is_active,
       mu.check_interval_minutes,
       mu.health_score,
       mu.created_at,
       ls.status_code AS last_status_code,
       ls.checked_at AS last_checked,
       ls.response_time_ms AS last_response_ms,
       ls.title AS last_title,
       ls.h1 AS last_h1,
       ls.noindex AS last_noindex,
       ls.canonical AS last_canonical,
       COALESCE(ap.alert_count_period, 0)::int AS alert_count_period,
       COALESCE(a24.alert_count_24h, 0)::int AS alert_count_24h
     FROM monitored_urls mu
     LEFT JOIN LATERAL (
       SELECT status_code, checked_at, response_time_ms, title, h1, noindex, canonical
       FROM snapshots
       WHERE url_id = mu.id
       ORDER BY checked_at DESC
       LIMIT 1
     ) ls ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS alert_count_period
       FROM alerts a
       WHERE a.url_id = mu.id
         ${periodFilter.sql.replace(/\$([0-9]+)/g, (_, n) => `$${Number(n)}`)}
     ) ap ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS alert_count_24h
       FROM alerts a
       WHERE a.url_id = mu.id
         AND a.detected_at > NOW() - INTERVAL '24 hours'
     ) a24 ON true
     WHERE mu.project_id = $1
     ORDER BY mu.url ASC`,
    urlsParams
  );

  const alertsParams = [projectId, ...periodFilter.params];
  const alertsDateSql = periodFilter.sql.replace(/\$([0-9]+)/g, (_, n) => `$${Number(n)}`);
  const { rows: alerts } = await pool.query(
    `SELECT
       a.detected_at,
       a.field_changed,
       a.old_value,
       a.new_value,
       a.severity,
       mu.url
     FROM alerts a
     JOIN monitored_urls mu ON mu.id = a.url_id
     WHERE mu.project_id = $1
       ${alertsDateSql}
     ORDER BY a.detected_at DESC
     LIMIT 1200`,
    alertsParams
  );

  const fieldCountsParams = [projectId, ...periodFilter.params];
  const { rows: fieldCounts } = await pool.query(
    `SELECT
       a.field_changed AS field,
       COUNT(*)::int AS count
     FROM alerts a
     JOIN monitored_urls mu ON mu.id = a.url_id
     WHERE mu.project_id = $1
       ${alertsDateSql}
     GROUP BY a.field_changed
     ORDER BY count DESC
     LIMIT 20`,
    fieldCountsParams
  );

  const summary = {
    totalUrls: urls.length,
    activeUrls: urls.filter(u => !!u.is_active).length,
    changedUrls: urls.filter(u => Number(u.alert_count_24h || 0) > 0).length,
    errorUrls: urls.filter(u => {
      const code = Number(u.last_status_code);
      return Number.isFinite(code) && (code === 0 || code >= 400);
    }).length,
    pendingUrls: urls.filter(u => !Number.isFinite(Number(u.last_status_code))).length,
    avgHealth: null,
    avgResponseMs: null,
    totalAlertsInPeriod: alerts.length,
    criticalAlertsInPeriod: alerts.filter(a => a.severity === 'critical').length,
    warningAlertsInPeriod: alerts.filter(a => a.severity === 'warning').length,
    infoAlertsInPeriod: alerts.filter(a => !a.severity || a.severity === 'info').length
  };

  const healthScores = urls
    .map(u => Number(u.health_score))
    .filter(v => Number.isFinite(v));
  if (healthScores.length > 0) {
    summary.avgHealth = Math.round((healthScores.reduce((a, b) => a + b, 0) / healthScores.length) * 10) / 10;
  }

  const responseValues = urls
    .map(u => Number(u.last_response_ms))
    .filter(v => Number.isFinite(v) && v > 0);
  if (responseValues.length > 0) {
    summary.avgResponseMs = Math.round(responseValues.reduce((a, b) => a + b, 0) / responseValues.length);
  }

  const urlsWithStatus = urls.map(u => ({ ...u, status: computeStatus(u) }));

  return {
    project,
    fromDate,
    toDate,
    summary,
    urls: urlsWithStatus,
    alerts,
    fieldCounts
  };
}

function ensureSpace(doc, needed = 32) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}

function drawHeader(doc, title, subtitle, accent = '#2563eb') {
  const x = doc.page.margins.left;
  const y = doc.y;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.roundedRect(x, y, w, 86, 10).fill('#f8fbff');
  doc.roundedRect(x, y, 7, 86, 7).fill(accent);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(20).fillColor('#0f172a').text(title, x + 18, y + 14);
  doc.font('Helvetica').fontSize(10).fillColor('#475569').text(subtitle, x + 18, y + 44, {
    width: w - 24,
    lineGap: 1
  });

  doc.y = y + 98;
}

function drawKpiCards(doc, rows) {
  const cols = 2;
  const gap = 10;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cardWidth = (usableWidth - gap) / cols;
  const cardHeight = 56;

  for (let i = 0; i < rows.length; i += cols) {
    ensureSpace(doc, cardHeight + 8);
    const y = doc.y;
    for (let c = 0; c < cols; c++) {
      const item = rows[i + c];
      if (!item) continue;
      const x = doc.page.margins.left + c * (cardWidth + gap);
      doc.save();
      doc.roundedRect(x, y, cardWidth, cardHeight, 8).fillAndStroke('#fff', '#dbe7f5');
      doc.restore();

      doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(item.label, x + 10, y + 8, {
        width: cardWidth - 20
      });
      doc.font('Helvetica-Bold').fontSize(16).fillColor(item.color || '#0f172a').text(item.value, x + 10, y + 25, {
        width: cardWidth - 20,
        ellipsis: true
      });
    }
    doc.y = y + cardHeight + 8;
  }
}

function drawSectionTitle(doc, text) {
  ensureSpace(doc, 24);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#0f172a').text(text);
  doc.moveDown(0.2);
}

function drawTable(doc, headers, rows, widths) {
  const x0 = doc.page.margins.left;
  const rowHeight = 19;
  const totalWidth = widths.reduce((a, b) => a + b, 0);

  const drawHeader = () => {
    const y = doc.y;
    doc.save();
    doc.roundedRect(x0, y, totalWidth, rowHeight, 4).fill('#0f172a');
    doc.restore();

    let x = x0;
    headers.forEach((h, idx) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#fff').text(String(h), x + 4, y + 6, {
        width: widths[idx] - 8,
        ellipsis: true
      });
      x += widths[idx];
    });

    doc.y = y + rowHeight;
  };

  drawHeader();

  rows.forEach((row, idx) => {
    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeader();
    }

    const y = doc.y;
    if (idx % 2 === 0) {
      doc.save();
      doc.rect(x0, y, totalWidth, rowHeight).fill('#f8fafc');
      doc.restore();
    }

    let x = x0;
    row.forEach((cell, cIdx) => {
      doc.font('Helvetica').fontSize(8).fillColor('#0f172a').text(truncate(cell == null ? '' : String(cell), 80), x + 4, y + 6, {
        width: widths[cIdx] - 8,
        ellipsis: true
      });
      x += widths[cIdx];
    });

    doc.y = y + rowHeight;
  });
}

function addFooter(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - doc.page.margins.bottom + 10;
    doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(
      `MetaWatch project report • Page ${i + 1} of ${range.count}`,
      doc.page.margins.left,
      y,
      {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'center'
      }
    );
  }
}

async function buildProjectPdfBuffer({ data, userEmail, generatedAt = new Date() }) {
  const { project, summary, fromDate, toDate } = data;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    drawHeader(
      doc,
      `Project Report: ${project.name}`,
      `Period: ${fmtDate(fromDate)} - ${fmtDate(toDate)} • Generated: ${fmtDateTime(generatedAt)} • User: ${userEmail || '-'} • Created: ${fmtDate(project.created_at)}`,
      '#1d4ed8'
    );

    drawKpiCards(doc, [
      { label: 'Total URLs', value: String(summary.totalUrls || 0) },
      { label: 'Active URLs', value: String(summary.activeUrls || 0), color: '#16a34a' },
      { label: 'Changed URLs (24h)', value: String(summary.changedUrls || 0), color: summary.changedUrls > 0 ? '#d97706' : '#16a34a' },
      { label: 'Error URLs', value: String(summary.errorUrls || 0), color: summary.errorUrls > 0 ? '#dc2626' : '#16a34a' },
      { label: 'Pending URLs', value: String(summary.pendingUrls || 0) },
      { label: 'Avg health score', value: summary.avgHealth == null ? '-' : String(summary.avgHealth) },
      { label: 'Avg response', value: summary.avgResponseMs == null ? '-' : `${summary.avgResponseMs} ms` },
      { label: 'Alerts in period', value: String(summary.totalAlertsInPeriod || 0), color: summary.totalAlertsInPeriod > 0 ? '#d97706' : '#16a34a' }
    ]);

    drawSectionTitle(doc, 'Project URLs');
    drawTable(
      doc,
      ['URL', 'Status', 'Health', 'Last HTTP', 'Resp(ms)', 'Alerts(24h)'],
      data.urls.map((u) => [
        u.url,
        u.status,
        u.health_score == null ? '-' : u.health_score,
        u.last_status_code == null ? '-' : u.last_status_code,
        u.last_response_ms == null ? '-' : u.last_response_ms,
        u.alert_count_24h || 0
      ]),
      [185, 60, 50, 50, 50, 65]
    );

    drawSectionTitle(doc, 'Top Changed Fields');
    drawTable(
      doc,
      ['Field', 'Count'],
      data.fieldCounts.map((f) => [f.field, f.count]),
      [250, 100]
    );

    doc.addPage();
    drawHeader(doc, 'Project Alert Feed', 'Recent project alerts in selected period.', '#2563eb');
    drawTable(
      doc,
      ['Detected', 'URL', 'Field', 'Severity', 'Before', 'After'],
      data.alerts.slice(0, 220).map((a) => [
        fmtDateTime(a.detected_at),
        a.url,
        a.field_changed,
        a.severity || 'info',
        truncate(a.old_value, 30),
        truncate(a.new_value, 30)
      ]),
      [90, 110, 55, 45, 70, 70]
    );

    addFooter(doc);
    doc.end();
  });
}

module.exports = {
  defaultProjectReportDateRange,
  getProjectReportData,
  buildProjectPdfBuffer
};
