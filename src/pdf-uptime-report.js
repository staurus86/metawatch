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

function fmtDurationSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '-';
  if (n < 60) return `${Math.round(n)}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m ${Math.round(n % 60)}s`;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return `${h}h ${m}m`;
}

function pct(ok, total) {
  const okNum = Number(ok || 0);
  const totalNum = Number(total || 0);
  if (!totalNum) return null;
  return Math.round((okNum / totalNum) * 1000) / 10;
}

function normalizeBucket(row) {
  if (!row) return { status: 'empty', count: 0 };
  const down = parseInt(row.down_count || 0, 10) || 0;
  const degraded = parseInt(row.degraded_count || 0, 10) || 0;
  const total = parseInt(row.count || 0, 10) || 0;
  if (down > 0) return { status: 'down', count: down };
  if (degraded > 0) return { status: 'degraded', count: degraded };
  if (total > 0) return { status: 'up', count: total };
  return { status: 'empty', count: 0 };
}

function buildDateBuckets(rowsByDay, daysBack, endDate = new Date()) {
  const byDay = new Map();
  for (const row of rowsByDay) {
    const key = row.date instanceof Date
      ? row.date.toISOString().slice(0, 10)
      : String(row.date || '').slice(0, 10);
    if (key) byDay.set(key, row);
  }

  const out = [];
  for (let i = daysBack - 1; i >= 0; i--) {
    const d = new Date(endDate.getTime() - i * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    const item = normalizeBucket(byDay.get(key));
    out.push({ date: key, ...item });
  }
  return out;
}

function buildHourBuckets(rowsByHour, endDate = new Date()) {
  const byHour = new Map();
  for (const row of rowsByHour) {
    byHour.set(Number(row.hour_epoch), row);
  }

  const out = [];
  const endHour = new Date(endDate);
  endHour.setUTCMinutes(0, 0, 0);

  for (let i = 23; i >= 0; i--) {
    const hourDate = new Date(endHour.getTime() - i * 60 * 60 * 1000);
    const hourEpoch = Math.floor(hourDate.getTime() / 1000);
    const item = normalizeBucket(byHour.get(hourEpoch));
    out.push({
      hour_epoch: hourEpoch,
      hour_label: hourDate.toISOString().slice(11, 16),
      ...item
    });
  }

  return out;
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

function defaultUptimeReportDateRange() {
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - 30 * DAY_MS);
  return { fromDate, toDate };
}

async function getUptimeMonitorReportData({ monitorId, userId, isAdmin = false, fromDate = null, toDate = null }) {
  const params = [monitorId];
  let monitorWhere = 'um.id = $1';
  if (!isAdmin) {
    params.push(userId);
    monitorWhere += ` AND um.user_id = $${params.length}`;
  }

  const { rows: [monitor] } = await pool.query(
    `SELECT
       um.*,
       lc.status AS last_status,
       lc.checked_at AS last_checked_at,
       lc.response_time_ms AS last_response_ms,
       lc.status_code AS last_status_code
     FROM uptime_monitors um
     LEFT JOIN LATERAL (
       SELECT status, checked_at, response_time_ms, status_code
       FROM uptime_checks
       WHERE monitor_id = um.id
       ORDER BY checked_at DESC
       LIMIT 1
     ) lc ON true
     WHERE ${monitorWhere}
     LIMIT 1`,
    params
  );

  if (!monitor) return null;

  const rangeParams = [monitorId];
  const rangeWhere = ['monitor_id = $1'];
  applyDateFilter({ fromDate, toDate, params: rangeParams, clauses: rangeWhere, column: 'checked_at' });

  const incidentParams = [monitorId];
  const incidentWhere = ['monitor_id = $1'];
  applyDateFilter({ fromDate, toDate, params: incidentParams, clauses: incidentWhere, column: 'started_at' });

  const [
    windowRes,
    responseStatsRes,
    checksRes,
    incidentsRes,
    rangeSummaryRes,
    dailyWeekRes,
    hourlyRes,
    latencyRes
  ] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '1 hour')::int AS total_1h,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '1 hour' AND status IN ('up', 'degraded'))::int AS ok_1h,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '24 hours')::int AS total_24h,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '24 hours' AND status IN ('up', 'degraded'))::int AS ok_24h,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '7 days')::int AS total_7d,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '7 days' AND status IN ('up', 'degraded'))::int AS ok_7d,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '30 days')::int AS total_30d,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '30 days' AND status IN ('up', 'degraded'))::int AS ok_30d,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '90 days')::int AS total_90d,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '90 days' AND status IN ('up', 'degraded'))::int AS ok_90d
       FROM uptime_checks
       WHERE monitor_id = $1`,
      [monitorId]
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS samples,
         ROUND(AVG(response_time_ms))::int AS avg_ms,
         MIN(response_time_ms)::int AS min_ms,
         MAX(response_time_ms)::int AS max_ms,
         ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_time_ms))::int AS p50_ms,
         ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms))::int AS p95_ms
       FROM uptime_checks
       WHERE ${rangeWhere.join(' AND ')}
         AND response_time_ms IS NOT NULL`,
      rangeParams
    ),
    pool.query(
      `SELECT checked_at, status, status_code, response_time_ms, error_message
       FROM uptime_checks
       WHERE ${rangeWhere.join(' AND ')}
       ORDER BY checked_at DESC
       LIMIT 5000`,
      rangeParams
    ),
    pool.query(
      `SELECT started_at, resolved_at, duration_seconds, cause, postmortem_text
       FROM uptime_incidents
       WHERE ${incidentWhere.join(' AND ')}
       ORDER BY started_at DESC
       LIMIT 500`,
      incidentParams
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS total_checks,
         COUNT(*) FILTER (WHERE status IN ('up', 'degraded'))::int AS ok_checks,
         COUNT(*) FILTER (WHERE status = 'down')::int AS down_checks,
         ROUND(AVG(response_time_ms))::int AS avg_response_ms
       FROM uptime_checks
       WHERE ${rangeWhere.join(' AND ')}`,
      rangeParams
    ),
    pool.query(
      `SELECT
         DATE(checked_at AT TIME ZONE 'UTC') AS date,
         COUNT(*)::int AS count,
         COUNT(*) FILTER (WHERE status = 'down')::int AS down_count,
         COUNT(*) FILTER (WHERE status = 'degraded')::int AS degraded_count
       FROM uptime_checks
       WHERE monitor_id = $1
         AND checked_at > NOW() - INTERVAL '7 days'
       GROUP BY DATE(checked_at AT TIME ZONE 'UTC')
       ORDER BY date ASC`,
      [monitorId]
    ),
    pool.query(
      `SELECT
         EXTRACT(EPOCH FROM DATE_TRUNC('hour', checked_at AT TIME ZONE 'UTC'))::bigint AS hour_epoch,
         COUNT(*)::int AS count,
         COUNT(*) FILTER (WHERE status = 'down')::int AS down_count,
         COUNT(*) FILTER (WHERE status = 'degraded')::int AS degraded_count
       FROM uptime_checks
       WHERE monitor_id = $1
         AND checked_at > NOW() - INTERVAL '24 hours'
       GROUP BY DATE_TRUNC('hour', checked_at AT TIME ZONE 'UTC')
       ORDER BY hour_epoch ASC`,
      [monitorId]
    ),
    pool.query(
      `SELECT
         EXTRACT(EPOCH FROM DATE_TRUNC('hour', checked_at AT TIME ZONE 'UTC'))::bigint AS hour_epoch,
         ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms))::int AS p95_ms
       FROM uptime_checks
       WHERE monitor_id = $1
         AND checked_at > NOW() - INTERVAL '24 hours'
         AND response_time_ms IS NOT NULL
       GROUP BY DATE_TRUNC('hour', checked_at AT TIME ZONE 'UTC')
       ORDER BY hour_epoch ASC`,
      [monitorId]
    )
  ]);

  const window = windowRes.rows[0] || {};
  const rangeSummary = rangeSummaryRes.rows[0] || {};
  const rangePct = pct(rangeSummary.ok_checks, rangeSummary.total_checks);

  const downtimeSeconds = (incidentsRes.rows || []).reduce((sum, inc) => {
    const v = Number(inc.duration_seconds || 0);
    return sum + (Number.isFinite(v) ? Math.max(0, v) : 0);
  }, 0);

  const weekBuckets = buildDateBuckets(dailyWeekRes.rows || [], 7, new Date());
  const hourBuckets = buildHourBuckets(hourlyRes.rows || [], new Date());

  const p95Map = new Map();
  for (const row of latencyRes.rows || []) {
    p95Map.set(Number(row.hour_epoch), Number(row.p95_ms));
  }

  const threshold = Number(monitor.threshold_ms || 0);
  const latencyBuckets = hourBuckets.map((h) => {
    const p95 = p95Map.has(Number(h.hour_epoch)) ? p95Map.get(Number(h.hour_epoch)) : null;
    let level = 'empty';
    if (Number.isFinite(p95)) {
      if (threshold > 0 && p95 > threshold * 1.5) level = 'hot';
      else if (threshold > 0 && p95 > threshold) level = 'warn';
      else level = 'ok';
    }
    return {
      hour_label: h.hour_label,
      p95_ms: Number.isFinite(p95) ? p95 : null,
      level
    };
  });

  return {
    monitor,
    fromDate,
    toDate,
    checks: checksRes.rows || [],
    incidents: incidentsRes.rows || [],
    responseStats: responseStatsRes.rows[0] || {},
    weekBuckets,
    hourBuckets,
    latencyBuckets,
    summary: {
      rangePct,
      totalChecks: Number(rangeSummary.total_checks || 0),
      downChecks: Number(rangeSummary.down_checks || 0),
      avgResponseMs: Number(rangeSummary.avg_response_ms || 0) || null,
      totalIncidents: (incidentsRes.rows || []).length,
      totalDowntimeMinutes: Math.round(downtimeSeconds / 60),
      lastStatus: monitor.last_status || 'unknown',
      lastCheckedAt: monitor.last_checked_at || null,
      windows: {
        '1h': pct(window.ok_1h, window.total_1h),
        '24h': pct(window.ok_24h, window.total_24h),
        '7d': pct(window.ok_7d, window.total_7d),
        '30d': pct(window.ok_30d, window.total_30d),
        '90d': pct(window.ok_90d, window.total_90d)
      }
    }
  };
}

function ensureSpace(doc, needed = 30) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + needed > bottom) doc.addPage();
}

function drawHeaderBand(doc, title, subtitle, accent = '#0ea5e9') {
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y = doc.y;

  doc.save();
  doc.roundedRect(x, y, w, 82, 10).fill('#f8fbff');
  doc.roundedRect(x, y, 6, 82, 6).fill(accent);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(20).fillColor('#0f172a').text(title, x + 18, y + 14);
  doc.font('Helvetica').fontSize(10).fillColor('#475569').text(subtitle, x + 18, y + 42, { width: w - 26 });
  doc.y = y + 96;
}

function drawKpiCards(doc, items) {
  const cols = 2;
  const gap = 10;
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cardWidth = (usableWidth - gap) / cols;
  const cardHeight = 56;

  for (let i = 0; i < items.length; i += cols) {
    ensureSpace(doc, cardHeight + 8);
    const y = doc.y;
    for (let c = 0; c < cols; c++) {
      const item = items[i + c];
      if (!item) continue;
      const x = doc.page.margins.left + c * (cardWidth + gap);
      doc.save();
      doc.roundedRect(x, y, cardWidth, cardHeight, 8).fillAndStroke('#ffffff', '#dbe7f5');
      doc.restore();
      doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(item.label, x + 10, y + 9, {
        width: cardWidth - 20,
        ellipsis: true
      });
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#0f172a').text(item.value, x + 10, y + 25, {
        width: cardWidth - 20,
        ellipsis: true
      });
    }
    doc.y = y + cardHeight + 8;
  }
}

function drawSectionTitle(doc, title) {
  ensureSpace(doc, 24);
  doc.moveDown(0.2);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#0f172a').text(title);
  doc.moveDown(0.2);
}

function drawTable(doc, headers, rows, widths) {
  const startX = doc.page.margins.left;
  const rowHeight = 19;
  const totalWidth = widths.reduce((sum, w) => sum + w, 0);

  const drawHeader = () => {
    const y = doc.y;
    doc.save();
    doc.roundedRect(startX, y, totalWidth, rowHeight, 4).fill('#0f172a');
    doc.restore();

    let x = startX;
    headers.forEach((h, idx) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff').text(String(h), x + 4, y + 6, {
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
      doc.rect(startX, y, totalWidth, rowHeight).fill('#f8fafc');
      doc.restore();
    }

    let x = startX;
    row.forEach((cell, cIdx) => {
      doc.font('Helvetica').fontSize(8).fillColor('#0f172a').text(String(cell ?? '-'), x + 4, y + 6, {
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
      `MetaWatch uptime report • Page ${i + 1} of ${range.count}`,
      doc.page.margins.left,
      y,
      {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'center'
      }
    );
  }
}

async function buildUptimeMonitorPdfBuffer({ data, userEmail, generatedAt = new Date() }) {
  const monitor = data.monitor;
  const summary = data.summary;
  const fromDate = data.fromDate;
  const toDate = data.toDate;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    drawHeaderBand(
      doc,
      `${monitor.name} — Uptime Report`,
      `${monitor.url}\nPeriod: ${fmtDate(fromDate)} - ${fmtDate(toDate)} • Generated: ${fmtDateTime(generatedAt)} • User: ${userEmail || '-'}`,
      '#0284c7'
    );

    drawKpiCards(doc, [
      { label: 'Uptime (selected period)', value: summary.rangePct == null ? '-' : `${fmtNumber(summary.rangePct)}%` },
      { label: 'Checks in period', value: String(summary.totalChecks || 0) },
      { label: 'Incidents in period', value: String(summary.totalIncidents || 0) },
      { label: 'Downtime', value: `${summary.totalDowntimeMinutes || 0} min` },
      { label: 'Average response', value: summary.avgResponseMs == null ? '-' : `${summary.avgResponseMs} ms` },
      { label: 'Last status', value: String(summary.lastStatus || 'unknown').toUpperCase() }
    ]);

    drawSectionTitle(doc, 'Window Uptime');
    drawTable(
      doc,
      ['Window', 'Uptime %'],
      [
        ['1 hour', summary.windows['1h'] == null ? '-' : `${fmtNumber(summary.windows['1h'])}%`],
        ['24 hours', summary.windows['24h'] == null ? '-' : `${fmtNumber(summary.windows['24h'])}%`],
        ['7 days', summary.windows['7d'] == null ? '-' : `${fmtNumber(summary.windows['7d'])}%`],
        ['30 days', summary.windows['30d'] == null ? '-' : `${fmtNumber(summary.windows['30d'])}%`],
        ['90 days', summary.windows['90d'] == null ? '-' : `${fmtNumber(summary.windows['90d'])}%`]
      ],
      [180, 120]
    );

    doc.addPage();
    drawHeaderBand(doc, 'Last 7 Days — Daily Health', 'Each row summarizes one day of checks.', '#0ea5e9');
    drawTable(
      doc,
      ['Date', 'Health', 'Checks'],
      data.weekBuckets.map((row) => [
        row.date,
        row.status === 'up' ? 'UP' : row.status === 'degraded' ? 'DEGRADED' : row.status === 'down' ? 'DOWN' : 'NO DATA',
        row.count
      ]),
      [180, 140, 80]
    );

    drawSectionTitle(doc, 'Last 24 Hours — Hourly Health');
    drawTable(
      doc,
      ['Hour UTC', 'Health', 'Checks'],
      data.hourBuckets.map((row) => [
        row.hour_label,
        row.status === 'up' ? 'UP' : row.status === 'degraded' ? 'DEGRADED' : row.status === 'down' ? 'DOWN' : 'NO DATA',
        row.count
      ]),
      [120, 170, 110]
    );

    drawSectionTitle(doc, 'Last 24 Hours — p95 Latency');
    drawTable(
      doc,
      ['Hour UTC', 'p95 (ms)', 'Level'],
      data.latencyBuckets.map((row) => [
        row.hour_label,
        row.p95_ms == null ? '-' : row.p95_ms,
        row.level === 'hot' ? 'HIGH' : row.level === 'warn' ? 'WARNING' : row.level === 'ok' ? 'OK' : 'NO DATA'
      ]),
      [120, 120, 160]
    );

    doc.addPage();
    drawHeaderBand(doc, 'Incidents', 'Incident log for selected report period.', '#0284c7');
    drawTable(
      doc,
      ['Started', 'Resolved', 'Duration', 'Cause'],
      (data.incidents || []).map((inc) => [
        fmtDateTime(inc.started_at),
        inc.resolved_at ? fmtDateTime(inc.resolved_at) : 'Open',
        inc.duration_seconds ? fmtDurationSeconds(inc.duration_seconds) : '-',
        inc.cause || '-'
      ]),
      [120, 120, 80, 130]
    );

    drawSectionTitle(doc, 'Recent Checks');
    drawTable(
      doc,
      ['Time', 'Status', 'HTTP', 'Response', 'Error'],
      (data.checks || []).slice(0, 60).map((c) => [
        fmtDateTime(c.checked_at),
        String(c.status || 'unknown').toUpperCase(),
        c.status_code == null ? '-' : c.status_code,
        c.response_time_ms == null ? '-' : `${c.response_time_ms} ms`,
        c.error_message ? String(c.error_message).slice(0, 36) : '-'
      ]),
      [120, 70, 50, 80, 130]
    );

    addFooter(doc);
    doc.end();
  });
}

module.exports = {
  defaultUptimeReportDateRange,
  getUptimeMonitorReportData,
  buildUptimeMonitorPdfBuffer
};
