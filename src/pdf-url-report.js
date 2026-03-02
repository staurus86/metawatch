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

function parseStatus(statusCode) {
  const n = Number(statusCode);
  if (!Number.isFinite(n)) return 'unknown';
  if (n >= 200 && n < 300) return 'ok';
  if (n >= 300 && n < 400) return 'redirect';
  if (n >= 400 || n === 0) return 'error';
  return 'unknown';
}

function applyDateFilter({ fromDate, toDate, params, clauses, column }) {
  if (fromDate) {
    params.push(fromDate.toISOString());
    clauses.push(`${column} >= $${params.length}`);
  }
  if (toDate) {
    params.push(toDate.toISOString());
    clauses.push(`${column} <= $${params.length}`);
  }
}

function defaultUrlReportDateRange() {
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - 30 * DAY_MS);
  return { fromDate, toDate };
}

async function getUrlReportData({ urlId, userId, isAdmin = false, fromDate = null, toDate = null }) {
  const params = [urlId];
  const where = ['mu.id = $1'];
  if (!isAdmin) {
    params.push(userId);
    where.push(`mu.user_id = $${params.length}`);
  }

  const { rows: [urlRecord] } = await pool.query(
    `SELECT
       mu.*,
       p.name AS project_name,
       ls.status_code AS last_status_code,
       ls.checked_at AS last_checked,
       ls.response_time_ms AS last_response_ms,
       ls.title AS last_title,
       ls.description AS last_description,
       ls.h1 AS last_h1,
       ls.noindex AS last_noindex,
       ls.canonical AS last_canonical
     FROM monitored_urls mu
     LEFT JOIN projects p ON p.id = mu.project_id
     LEFT JOIN LATERAL (
       SELECT status_code, checked_at, response_time_ms, title, description, h1, noindex, canonical
       FROM snapshots
       WHERE url_id = mu.id
       ORDER BY checked_at DESC
       LIMIT 1
     ) ls ON true
     WHERE ${where.join(' AND ')}
     LIMIT 1`,
    params
  );

  if (!urlRecord) return null;

  const snapParams = [urlId];
  const snapWhere = ['url_id = $1'];
  applyDateFilter({ fromDate, toDate, params: snapParams, clauses: snapWhere, column: 'checked_at' });

  const alertParams = [urlId];
  const alertWhere = ['url_id = $1'];
  applyDateFilter({ fromDate, toDate, params: alertParams, clauses: alertWhere, column: 'detected_at' });

  const [snapshotsRes, alertsRes, snapshotAggRes] = await Promise.all([
    pool.query(
      `SELECT checked_at, status_code, response_time_ms, title, h1, noindex
       FROM snapshots
       WHERE ${snapWhere.join(' AND ')}
       ORDER BY checked_at DESC
       LIMIT 800`,
      snapParams
    ),
    pool.query(
      `SELECT detected_at, field_changed, old_value, new_value, severity
       FROM alerts
       WHERE ${alertWhere.join(' AND ')}
       ORDER BY detected_at DESC
       LIMIT 1000`,
      alertParams
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS total_checks,
         COUNT(*) FILTER (WHERE status_code >= 400 OR status_code = 0)::int AS error_checks,
         ROUND(AVG(response_time_ms))::int AS avg_response_ms
       FROM snapshots
       WHERE ${snapWhere.join(' AND ')}`,
      snapParams
    )
  ]);

  const snapshots = snapshotsRes.rows || [];
  const alerts = alertsRes.rows || [];
  const agg = snapshotAggRes.rows[0] || {};

  const fieldCountsMap = new Map();
  let criticalCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  for (const a of alerts) {
    const field = String(a.field_changed || 'unknown');
    fieldCountsMap.set(field, (fieldCountsMap.get(field) || 0) + 1);
    if (a.severity === 'critical') criticalCount += 1;
    else if (a.severity === 'warning') warningCount += 1;
    else infoCount += 1;
  }
  const fieldCounts = [...fieldCountsMap.entries()]
    .map(([field, count]) => ({ field, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const statusMix = {
    ok: 0,
    redirect: 0,
    error: 0,
    unknown: 0
  };
  for (const s of snapshots) {
    statusMix[parseStatus(s.status_code)] += 1;
  }

  return {
    urlRecord,
    fromDate,
    toDate,
    snapshots,
    alerts,
    fieldCounts,
    summary: {
      totalChecks: Number(agg.total_checks || 0),
      errorChecks: Number(agg.error_checks || 0),
      avgResponseMs: agg.avg_response_ms == null ? null : Number(agg.avg_response_ms),
      totalAlerts: alerts.length,
      criticalAlerts: criticalCount,
      warningAlerts: warningCount,
      infoAlerts: infoCount,
      statusMix,
      latest: {
        statusCode: urlRecord.last_status_code,
        checkedAt: urlRecord.last_checked,
        responseMs: urlRecord.last_response_ms,
        title: urlRecord.last_title,
        description: urlRecord.last_description,
        h1: urlRecord.last_h1,
        noindex: urlRecord.last_noindex,
        canonical: urlRecord.last_canonical
      }
    }
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

  doc.font('Helvetica-Bold').fontSize(19).fillColor('#0f172a').text(title, x + 18, y + 14);
  doc.font('Helvetica').fontSize(10).fillColor('#475569').text(subtitle, x + 18, y + 44, {
    width: w - 24,
    lineGap: 1
  });

  doc.y = y + 98;
}

function drawKpis(doc, rows) {
  const cols = 2;
  const gap = 10;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cardWidth = (usableWidth - gap) / cols;
  const cardHeight = 54;

  for (let i = 0; i < rows.length; i += cols) {
    ensureSpace(doc, cardHeight + 8);
    const y = doc.y;
    for (let c = 0; c < cols; c++) {
      const item = rows[i + c];
      if (!item) continue;
      const x = doc.page.margins.left + c * (cardWidth + gap);
      doc.save();
      doc.roundedRect(x, y, cardWidth, cardHeight, 8).fillAndStroke('#ffffff', '#dbe7f5');
      doc.restore();

      doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(item.label, x + 10, y + 8, { width: cardWidth - 20 });
      doc.font('Helvetica-Bold').fontSize(15).fillColor(item.color || '#0f172a').text(item.value, x + 10, y + 24, {
        width: cardWidth - 20,
        ellipsis: true
      });
    }
    doc.y = y + cardHeight + 8;
  }
}

function drawSectionTitle(doc, text) {
  ensureSpace(doc, 26);
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

function drawLatestSnapshot(doc, latest) {
  ensureSpace(doc, 120);
  const x = doc.page.margins.left;
  const y = doc.y;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.roundedRect(x, y, w, 110, 8).fill('#f8fbff');
  doc.restore();

  const rows = [
    ['Status', latest.statusCode == null ? '-' : String(latest.statusCode)],
    ['Last checked', latest.checkedAt ? fmtDateTime(latest.checkedAt) : '-'],
    ['Response', latest.responseMs == null ? '-' : `${latest.responseMs} ms`],
    ['Noindex', latest.noindex ? 'YES' : 'NO'],
    ['Title', latest.title || '-'],
    ['H1', latest.h1 || '-'],
    ['Canonical', latest.canonical || '-']
  ];

  let lineY = y + 10;
  for (const [label, value] of rows) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#1d4ed8').text(label, x + 10, lineY, { width: 100 });
    doc.font('Helvetica').fontSize(9).fillColor('#0f172a').text(truncate(value, 140), x + 112, lineY, { width: w - 124 });
    lineY += 14;
  }

  doc.y = y + 120;
}

function addFooter(doc) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - doc.page.margins.bottom + 10;
    doc.font('Helvetica').fontSize(8).fillColor('#64748b').text(
      `MetaWatch URL report • Page ${i + 1} of ${range.count}`,
      doc.page.margins.left,
      y,
      {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'center'
      }
    );
  }
}

async function buildUrlPdfBuffer({ data, userEmail, generatedAt = new Date() }) {
  const { urlRecord, summary, fromDate, toDate } = data;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    drawHeader(
      doc,
      'URL Monitoring Report',
      `${urlRecord.url}\nPeriod: ${fmtDate(fromDate)} - ${fmtDate(toDate)} • Generated: ${fmtDateTime(generatedAt)} • User: ${userEmail || '-'}${urlRecord.project_name ? ` • Project: ${urlRecord.project_name}` : ''}`,
      '#1d4ed8'
    );

    drawKpis(doc, [
      { label: 'Checks in range', value: String(summary.totalChecks || 0) },
      { label: 'Alerts in range', value: String(summary.totalAlerts || 0), color: summary.totalAlerts > 0 ? '#d97706' : '#16a34a' },
      { label: 'Critical alerts', value: String(summary.criticalAlerts || 0), color: summary.criticalAlerts > 0 ? '#dc2626' : '#16a34a' },
      { label: 'Error checks', value: String(summary.errorChecks || 0), color: summary.errorChecks > 0 ? '#dc2626' : '#16a34a' },
      { label: 'Avg response', value: summary.avgResponseMs == null ? '-' : `${summary.avgResponseMs} ms` },
      { label: 'Current health score', value: urlRecord.health_score == null ? '-' : String(urlRecord.health_score) }
    ]);

    drawSectionTitle(doc, 'Latest Snapshot');
    drawLatestSnapshot(doc, summary.latest || {});

    drawSectionTitle(doc, 'Top Changed Fields');
    drawTable(
      doc,
      ['Field', 'Count'],
      (data.fieldCounts || []).map((r) => [r.field, r.count]),
      [260, 90]
    );

    drawSectionTitle(doc, 'Status Mix (range)');
    drawTable(
      doc,
      ['Type', 'Count'],
      [
        ['OK', summary.statusMix.ok],
        ['Redirect', summary.statusMix.redirect],
        ['Error', summary.statusMix.error],
        ['Unknown', summary.statusMix.unknown]
      ],
      [260, 90]
    );

    doc.addPage();
    drawHeader(doc, 'Recent Alerts', 'Most recent detected changes in selected period.', '#2563eb');
    drawTable(
      doc,
      ['Detected', 'Field', 'Severity', 'Before', 'After'],
      (data.alerts || []).slice(0, 120).map((a) => [
        fmtDateTime(a.detected_at),
        a.field_changed,
        a.severity || 'info',
        truncate(a.old_value, 40),
        truncate(a.new_value, 40)
      ]),
      [105, 70, 55, 95, 95]
    );

    drawSectionTitle(doc, 'Recent Snapshots');
    drawTable(
      doc,
      ['Checked', 'HTTP', 'Title', 'H1', 'Response'],
      (data.snapshots || []).slice(0, 140).map((s) => [
        fmtDateTime(s.checked_at),
        s.status_code == null ? '-' : s.status_code,
        truncate(s.title, 42),
        truncate(s.h1, 30),
        s.response_time_ms == null ? '-' : `${s.response_time_ms} ms`
      ]),
      [105, 50, 115, 85, 65]
    );

    addFooter(doc);
    doc.end();
  });
}

module.exports = {
  defaultUrlReportDateRange,
  getUrlReportData,
  buildUrlPdfBuffer
};
