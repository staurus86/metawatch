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

function defaultUptimePortfolioDateRange() {
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - 30 * DAY_MS);
  return { fromDate, toDate };
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

async function getUptimePortfolioReportData({ userId, isAdmin = false, fromDate = null, toDate = null }) {
  const ownerParams = [];
  const ownerWhere = [];
  if (!isAdmin) {
    ownerParams.push(userId);
    ownerWhere.push(`um.user_id = $${ownerParams.length}`);
  }
  const ownerSql = ownerWhere.length ? `WHERE ${ownerWhere.join(' AND ')}` : '';

  const monitorParams = [...ownerParams];
  const monitorDateParts = [];
  if (fromDate) {
    monitorParams.push(fromDate.toISOString());
    monitorDateParts.push(`uc.checked_at >= $${monitorParams.length}`);
  }
  if (toDate) {
    monitorParams.push(toDate.toISOString());
    monitorDateParts.push(`uc.checked_at <= $${monitorParams.length}`);
  }
  const monitorDateSql = monitorDateParts.length ? `AND ${monitorDateParts.join(' AND ')}` : '';

  const incidentsParams = [...ownerParams];
  const incidentWhere = [];
  if (!isAdmin) incidentWhere.push(`um.user_id = $${incidentsParams.length}`);
  applyDateFilter({
    fromDate,
    toDate,
    params: incidentsParams,
    clauses: incidentWhere,
    column: 'ui.started_at'
  });
  const incidentSql = incidentWhere.length ? `WHERE ${incidentWhere.join(' AND ')}` : '';

  const [monitorsRes, incidentsRes, summaryRes] = await Promise.all([
    pool.query(
      `SELECT
         um.id,
         um.name,
         um.url,
         um.is_active,
         lc.status AS current_status,
         ROUND((COUNT(uc7.*) FILTER (WHERE uc7.status IN ('up', 'degraded'))::float / NULLIF(COUNT(uc7.*),0) * 100)::numeric, 1) AS uptime_7d,
         ROUND((COUNT(uc30.*) FILTER (WHERE uc30.status IN ('up', 'degraded'))::float / NULLIF(COUNT(uc30.*),0) * 100)::numeric, 1) AS uptime_30d,
         ROUND(AVG(uc.response_time_ms)::numeric, 0)::int AS avg_response_ms,
         COUNT(uc.*)::int AS checks_in_range,
         COUNT(uc.*) FILTER (WHERE uc.status = 'down')::int AS down_checks_in_range,
         (
           SELECT COUNT(*)::int
           FROM uptime_incidents ui
           WHERE ui.monitor_id = um.id
             ${fromDate ? 'AND ui.started_at >= $' + (monitorParams.length + 1) : ''}
             ${toDate ? 'AND ui.started_at <= $' + (monitorParams.length + (fromDate ? 2 : 1)) : ''}
         ) AS incidents_in_range
       FROM uptime_monitors um
       LEFT JOIN uptime_checks uc7 ON uc7.monitor_id = um.id AND uc7.checked_at > NOW() - INTERVAL '7 days'
       LEFT JOIN uptime_checks uc30 ON uc30.monitor_id = um.id AND uc30.checked_at > NOW() - INTERVAL '30 days'
       LEFT JOIN uptime_checks uc ON uc.monitor_id = um.id ${monitorDateSql}
       LEFT JOIN LATERAL (
         SELECT status FROM uptime_checks WHERE monitor_id = um.id ORDER BY checked_at DESC LIMIT 1
       ) lc ON true
       ${ownerSql}
       GROUP BY um.id, lc.status
       ORDER BY um.name ASC`,
      [
        ...monitorParams,
        ...(fromDate ? [fromDate.toISOString()] : []),
        ...(toDate ? [toDate.toISOString()] : [])
      ]
    ),
    pool.query(
      `SELECT
         ui.monitor_id,
         ui.started_at,
         ui.resolved_at,
         ui.duration_seconds,
         ui.cause,
         um.name AS monitor_name,
         um.url AS monitor_url
       FROM uptime_incidents ui
       JOIN uptime_monitors um ON um.id = ui.monitor_id
       ${incidentSql}
       ORDER BY ui.started_at DESC
       LIMIT 1200`,
      incidentsParams
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS total_monitors,
         COUNT(*) FILTER (WHERE lc.status = 'up')::int AS up_monitors,
         COUNT(*) FILTER (WHERE lc.status = 'degraded')::int AS degraded_monitors,
         COUNT(*) FILTER (WHERE lc.status = 'down')::int AS down_monitors,
         ROUND(AVG(agg.uptime_pct)::numeric, 1) AS avg_uptime_pct,
         ROUND(AVG(agg.avg_response_ms)::numeric, 0)::int AS avg_response_ms
       FROM uptime_monitors um
       LEFT JOIN LATERAL (
         SELECT status FROM uptime_checks WHERE monitor_id = um.id ORDER BY checked_at DESC LIMIT 1
       ) lc ON true
       LEFT JOIN LATERAL (
         SELECT
           (COUNT(*) FILTER (WHERE uc.status IN ('up', 'degraded'))::float / NULLIF(COUNT(*), 0) * 100) AS uptime_pct,
           AVG(uc.response_time_ms) AS avg_response_ms
         FROM uptime_checks uc
         WHERE uc.monitor_id = um.id
           ${fromDate ? 'AND uc.checked_at >= $' + (ownerParams.length + 1) : ''}
           ${toDate ? 'AND uc.checked_at <= $' + (ownerParams.length + (fromDate ? 2 : 1)) : ''}
       ) agg ON true
       ${ownerSql}`,
      [
        ...ownerParams,
        ...(fromDate ? [fromDate.toISOString()] : []),
        ...(toDate ? [toDate.toISOString()] : [])
      ]
    )
  ]);

  const incidents = incidentsRes.rows || [];
  const downtimeSeconds = incidents.reduce((sum, item) => {
    const d = Number(item.duration_seconds || 0);
    return sum + (Number.isFinite(d) ? Math.max(0, d) : 0);
  }, 0);

  const monitors = monitorsRes.rows || [];
  const summary = summaryRes.rows[0] || {};

  const unstable = [...monitors]
    .sort((a, b) => Number(b.incidents_in_range || 0) - Number(a.incidents_in_range || 0))
    .slice(0, 10);

  return {
    fromDate,
    toDate,
    monitors,
    incidents,
    unstable,
    summary: {
      totalMonitors: Number(summary.total_monitors || 0),
      upMonitors: Number(summary.up_monitors || 0),
      degradedMonitors: Number(summary.degraded_monitors || 0),
      downMonitors: Number(summary.down_monitors || 0),
      avgUptimePct: summary.avg_uptime_pct == null ? null : Number(summary.avg_uptime_pct),
      avgResponseMs: summary.avg_response_ms == null ? null : Number(summary.avg_response_ms),
      totalIncidents: incidents.length,
      totalDowntimeMinutes: Math.round(downtimeSeconds / 60)
    }
  };
}

function ensureSpace(doc, needed = 30) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}

function drawHeader(doc, title, subtitle, accent = '#0284c7') {
  const x = doc.page.margins.left;
  const y = doc.y;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.roundedRect(x, y, w, 84, 10).fill('#f8fbff');
  doc.roundedRect(x, y, 7, 84, 7).fill(accent);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(20).fillColor('#0f172a').text(title, x + 18, y + 14);
  doc.font('Helvetica').fontSize(10).fillColor('#475569').text(subtitle, x + 18, y + 44, {
    width: w - 24,
    lineGap: 1
  });

  doc.y = y + 96;
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
      `MetaWatch uptime portfolio report • Page ${i + 1} of ${range.count}`,
      doc.page.margins.left,
      y,
      {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'center'
      }
    );
  }
}

async function buildUptimePortfolioPdfBuffer({ data, userEmail, generatedAt = new Date() }) {
  const { summary, fromDate, toDate } = data;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    drawHeader(
      doc,
      'Uptime Portfolio Report',
      `Period: ${fmtDate(fromDate)} - ${fmtDate(toDate)} • Generated: ${fmtDateTime(generatedAt)} • User: ${userEmail || '-'}`,
      '#0284c7'
    );

    drawKpiCards(doc, [
      { label: 'Total monitors', value: String(summary.totalMonitors || 0) },
      { label: 'UP now', value: String(summary.upMonitors || 0), color: '#16a34a' },
      { label: 'DEGRADED now', value: String(summary.degradedMonitors || 0), color: '#d97706' },
      { label: 'DOWN now', value: String(summary.downMonitors || 0), color: '#dc2626' },
      { label: 'Avg uptime', value: summary.avgUptimePct == null ? '-' : `${fmtNumber(summary.avgUptimePct)}%` },
      { label: 'Avg response', value: summary.avgResponseMs == null ? '-' : `${summary.avgResponseMs} ms` },
      { label: 'Incidents (range)', value: String(summary.totalIncidents || 0), color: summary.totalIncidents > 0 ? '#d97706' : '#16a34a' },
      { label: 'Downtime (range)', value: `${summary.totalDowntimeMinutes || 0} min`, color: summary.totalDowntimeMinutes > 0 ? '#dc2626' : '#16a34a' }
    ]);

    drawSectionTitle(doc, 'Monitor Summary');
    drawTable(
      doc,
      ['Name', 'URL', 'Status', 'Uptime 7d', 'Uptime 30d', 'Checks', 'Down'],
      (data.monitors || []).map((m) => [
        m.name,
        m.url,
        String(m.current_status || 'unknown').toUpperCase(),
        m.uptime_7d == null ? '-' : `${fmtNumber(m.uptime_7d)}%`,
        m.uptime_30d == null ? '-' : `${fmtNumber(m.uptime_30d)}%`,
        m.checks_in_range || 0,
        m.down_checks_in_range || 0
      ]),
      [90, 155, 55, 55, 60, 45, 45]
    );

    drawSectionTitle(doc, 'Most Unstable Monitors');
    drawTable(
      doc,
      ['Name', 'Incidents', 'Avg response', 'Current status'],
      (data.unstable || []).map((m) => [
        m.name,
        m.incidents_in_range || 0,
        m.avg_response_ms == null ? '-' : `${m.avg_response_ms} ms`,
        String(m.current_status || 'unknown').toUpperCase()
      ]),
      [180, 70, 90, 90]
    );

    doc.addPage();
    drawHeader(doc, 'Incident Log', 'Recent incidents in selected period.', '#0ea5e9');
    drawTable(
      doc,
      ['Monitor', 'Started', 'Resolved', 'Duration', 'Cause'],
      (data.incidents || []).slice(0, 220).map((inc) => [
        inc.monitor_name,
        fmtDateTime(inc.started_at),
        inc.resolved_at ? fmtDateTime(inc.resolved_at) : 'Open',
        inc.duration_seconds == null ? '-' : `${fmtNumber(Number(inc.duration_seconds) / 60)} min`,
        inc.cause || '-'
      ]),
      [105, 105, 105, 75, 70]
    );

    addFooter(doc);
    doc.end();
  });
}

module.exports = {
  defaultUptimePortfolioDateRange,
  getUptimePortfolioReportData,
  buildUptimePortfolioPdfBuffer
};
