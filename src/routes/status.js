const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db');
const { isEmailConfigured } = require('../mailer');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

function fmtDuration(sec) {
  if (!sec) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
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

function parseCronField(field, min, max) {
  const value = String(field || '').trim();
  if (!value) return null;
  if (value === '*') return () => true;

  const parts = value.split(',').map(v => v.trim()).filter(Boolean);
  const matchers = parts.map((part) => {
    if (part === '*') return () => true;
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2), 10);
      if (!Number.isFinite(step) || step <= 0) return null;
      return v => v % step === 0;
    }
    if (part.includes('/')) {
      const [range, stepRaw] = part.split('/');
      const step = parseInt(stepRaw, 10);
      if (!Number.isFinite(step) || step <= 0) return null;
      if (range && range.includes('-')) {
        const [a, b] = range.split('-').map(n => parseInt(n, 10));
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        const from = Math.min(a, b);
        const to = Math.max(a, b);
        return v => v >= from && v <= to && ((v - from) % step === 0);
      }
      return v => v % step === 0;
    }
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(n => parseInt(n, 10));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      const from = Math.min(a, b);
      const to = Math.max(a, b);
      return v => v >= from && v <= to;
    }
    const n = parseInt(part, 10);
    if (!Number.isFinite(n)) return null;
    return v => v === n;
  }).filter(Boolean);

  if (matchers.length === 0) return null;
  return (v) => {
    if (!Number.isFinite(v) || v < min || v > max) return false;
    return matchers.some(fn => fn(v));
  };
}

function cronMatchesUtcDate(cronExpr, dateObj) {
  const expr = String(cronExpr || '').trim();
  if (!expr || !cron.validate(expr)) return false;
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) return false;
  const [m, h, dom, mon, dow] = fields;

  const mMatch = parseCronField(m, 0, 59);
  const hMatch = parseCronField(h, 0, 23);
  const domMatch = parseCronField(dom, 1, 31);
  const monMatch = parseCronField(mon, 1, 12);
  const dowMatch = parseCronField(dow, 0, 7);
  if (!mMatch || !hMatch || !domMatch || !monMatch || !dowMatch) return false;

  const minute = dateObj.getUTCMinutes();
  const hour = dateObj.getUTCHours();
  const dayOfMonth = dateObj.getUTCDate();
  const month = dateObj.getUTCMonth() + 1;
  const dayOfWeek = dateObj.getUTCDay();
  const dayOfWeekAlt = dayOfWeek === 0 ? 7 : dayOfWeek;

  return (
    mMatch(minute) &&
    hMatch(hour) &&
    domMatch(dayOfMonth) &&
    monMatch(month) &&
    (dowMatch(dayOfWeek) || dowMatch(dayOfWeekAlt))
  );
}

function isNowInMaintenanceWindow(maintenanceCron, durationMinutes) {
  const duration = parseInt(durationMinutes, 10);
  if (!maintenanceCron || !Number.isFinite(duration) || duration <= 0) return false;

  const now = new Date();
  now.setUTCSeconds(0, 0);
  for (let i = 0; i <= duration; i++) {
    const t = new Date(now.getTime() - i * 60000);
    if (cronMatchesUtcDate(maintenanceCron, t)) return true;
  }
  return false;
}

function findNextMaintenanceWindows(maintenanceCron, durationMinutes, limit = 3, horizonDays = 14) {
  const duration = parseInt(durationMinutes, 10);
  if (!maintenanceCron || !Number.isFinite(duration) || duration <= 0) return [];
  if (!cron.validate(String(maintenanceCron || '').trim())) return [];

  const result = [];
  const cursor = new Date();
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const horizonMs = horizonDays * 24 * 60 * 60 * 1000;
  const endTs = cursor.getTime() + horizonMs;

  while (cursor.getTime() <= endTs && result.length < limit) {
    if (cronMatchesUtcDate(maintenanceCron, cursor)) {
      const startsAt = new Date(cursor.getTime());
      const endsAt = new Date(cursor.getTime() + duration * 60000);
      result.push({ startsAt, endsAt });
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  return result;
}

function calcSlo(intervalDays, targetPct, achievedPct) {
  const totalMinutes = intervalDays * 24 * 60;
  const allowedDowntimeMin = (totalMinutes * (100 - targetPct)) / 100;
  if (achievedPct == null) {
    return {
      intervalDays,
      targetPct,
      achievedPct: null,
      allowedDowntimeMin,
      usedDowntimeMin: null,
      budgetLeftMin: null,
      burnRate: null,
      healthy: null
    };
  }

  const usedDowntimeMin = (totalMinutes * (100 - Number(achievedPct))) / 100;
  const budgetLeftMin = Math.max(0, allowedDowntimeMin - usedDowntimeMin);
  const burnRate = allowedDowntimeMin > 0 ? usedDowntimeMin / allowedDowntimeMin : null;

  return {
    intervalDays,
    targetPct,
    achievedPct: Number(achievedPct),
    allowedDowntimeMin,
    usedDowntimeMin,
    budgetLeftMin,
    burnRate,
    healthy: Number(achievedPct) >= targetPct
  };
}

function calcReliability(periodDays, incidents) {
  const nowTs = Date.now();
  const periodSeconds = periodDays * 24 * 60 * 60;
  const periodStartTs = nowTs - periodSeconds * 1000;
  const list = Array.isArray(incidents) ? incidents : [];

  let incidentCount = 0;
  let resolvedCount = 0;
  let downtimeSec = 0;
  let longestIncidentSec = 0;
  let resolvedDurationTotalSec = 0;

  for (const inc of list) {
    const startedTs = new Date(inc.started_at).getTime();
    if (!Number.isFinite(startedTs)) continue;

    const hasResolvedAt = !!inc.resolved_at;
    const resolvedTs = hasResolvedAt ? new Date(inc.resolved_at).getTime() : null;
    const endTs = Number.isFinite(resolvedTs) ? resolvedTs : nowTs;
    if (endTs <= periodStartTs || startedTs >= nowTs) continue;

    const overlapStartTs = Math.max(startedTs, periodStartTs);
    const overlapEndTs = Math.min(endTs, nowTs);
    const overlapSec = Math.max(0, Math.round((overlapEndTs - overlapStartTs) / 1000));

    incidentCount += 1;
    downtimeSec += overlapSec;
    if (overlapSec > longestIncidentSec) longestIncidentSec = overlapSec;

    if (Number.isFinite(resolvedTs) && resolvedTs >= periodStartTs && resolvedTs <= nowTs) {
      const reportedDuration = Number(inc.duration_seconds);
      const fullDurationSec = Number.isFinite(reportedDuration) && reportedDuration >= 0
        ? Math.round(reportedDuration)
        : Math.max(0, Math.round((resolvedTs - startedTs) / 1000));
      resolvedCount += 1;
      resolvedDurationTotalSec += fullDurationSec;
    }
  }

  const mttrSec = resolvedCount > 0
    ? Math.round(resolvedDurationTotalSec / resolvedCount)
    : null;
  const mtbfSec = incidentCount > 0
    ? Math.max(0, Math.round((periodSeconds - downtimeSec) / incidentCount))
    : null;
  const incidentRatePerWeek = Math.round((incidentCount / periodDays) * 70) / 10;

  return {
    periodDays,
    incidents: incidentCount,
    resolved: resolvedCount,
    downtimeSec,
    mttrSec,
    mtbfSec,
    longestIncidentSec: longestIncidentSec || null,
    incidentRatePerWeek
  };
}

// GET /status/:slug — public status page (no auth required)
router.get('/:slug', async (req, res) => {
  try {
    const { rows: [monitor] } = await pool.query(
      'SELECT * FROM uptime_monitors WHERE slug = $1 AND is_public = true',
      [req.params.slug]
    );

    if (!monitor) return res.status(404).render('error', { title: 'Not Found', error: 'Status page not found or not public.' });

    // Latest check
    const { rows: [latestCheck] } = await pool.query(
      'SELECT * FROM uptime_checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 1',
      [monitor.id]
    );

    // Open incident
    const { rows: [openIncident] } = await pool.query(
      'SELECT * FROM uptime_incidents WHERE monitor_id = $1 AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1',
      [monitor.id]
    );

    // Recent incidents (last 90 days)
    const { rows: incidents } = await pool.query(
      `SELECT * FROM uptime_incidents
       WHERE monitor_id = $1 AND started_at > NOW() - INTERVAL '90 days'
       ORDER BY started_at DESC LIMIT 20`,
      [monitor.id]
    );

    // Uptime windows
    const { rows: [windowRow] } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '24 hours')::int AS total_24h,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '24 hours' AND status IN ('up', 'degraded'))::int AS ok_24h,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '7 days')::int AS total_7d,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '7 days' AND status IN ('up', 'degraded'))::int AS ok_7d,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '30 days')::int AS total_30d,
         COUNT(*) FILTER (WHERE checked_at > NOW() - INTERVAL '30 days' AND status IN ('up', 'degraded'))::int AS ok_30d
       FROM uptime_checks
       WHERE monitor_id = $1`,
      [monitor.id]
    );
    const calcPct = (ok, total) => {
      if (!total || Number(total) <= 0) return null;
      return Math.round((Number(ok) / Number(total)) * 1000) / 10;
    };
    const uptimeWindows = {
      '24h': calcPct(windowRow?.ok_24h, windowRow?.total_24h),
      '7d': calcPct(windowRow?.ok_7d, windowRow?.total_7d),
      '30d': calcPct(windowRow?.ok_30d, windowRow?.total_30d)
    };
    const pct30d = uptimeWindows['30d'];

    // Response-time stats (24h)
    const { rows: [responseStats] } = await pool.query(
      `SELECT
         COUNT(*)::int AS samples_24h,
         ROUND(AVG(response_time_ms))::int AS avg_ms,
         MIN(response_time_ms)::int AS min_ms,
         MAX(response_time_ms)::int AS max_ms,
         ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_time_ms))::int AS p50_ms,
         ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms))::int AS p95_ms
       FROM uptime_checks
       WHERE monitor_id = $1
          AND response_time_ms IS NOT NULL
          AND checked_at > NOW() - INTERVAL '24 hours'`,
      [monitor.id]
    );

    // Recent check log
    const { rows: recentChecks } = await pool.query(
      `SELECT checked_at, status, status_code, response_time_ms, error_message
       FROM uptime_checks
       WHERE monitor_id = $1
       ORDER BY checked_at DESC
       LIMIT 20`,
      [monitor.id]
    );

    const reliability30d = calcReliability(30, incidents);

    // 90-day daily buckets for bar chart
    const { rows: dailyRows } = await pool.query(
      `SELECT
         DATE(checked_at AT TIME ZONE 'UTC') AS date,
         COUNT(*) AS count,
         COUNT(*) FILTER (WHERE status = 'down') AS down_count,
         COUNT(*) FILTER (WHERE status = 'degraded') AS degraded_count
       FROM uptime_checks
       WHERE monitor_id = $1 AND checked_at > NOW() - INTERVAL '90 days'
       GROUP BY DATE(checked_at AT TIME ZONE 'UTC')
       ORDER BY date ASC`,
      [monitor.id]
    );

    // Build 90-slot array (one per day)
    const dayMap = new Map(dailyRows.map(r => [r.date.toISOString().split('T')[0], r]));
    const dayBuckets = [];
    for (let i = 89; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      const bucket = dayMap.get(key);
      const normalized = normalizeBucket(bucket);
      dayBuckets.push({ date: key, ...normalized });
    }

    // Build 7-day daily buckets (including today)
    const weekBuckets = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      const bucket = dayMap.get(key);
      const normalized = normalizeBucket(bucket);
      weekBuckets.push({ date: key, ...normalized });
    }

    // 24-hour hourly buckets for chart
    const { rows: hourlyRows } = await pool.query(
      `SELECT
         EXTRACT(EPOCH FROM DATE_TRUNC('hour', checked_at AT TIME ZONE 'UTC'))::bigint AS hour_epoch,
         COUNT(*) AS count,
         COUNT(*) FILTER (WHERE status = 'down') AS down_count,
         COUNT(*) FILTER (WHERE status = 'degraded') AS degraded_count
       FROM uptime_checks
       WHERE monitor_id = $1
         AND checked_at > NOW() - INTERVAL '24 hours'
       GROUP BY DATE_TRUNC('hour', checked_at AT TIME ZONE 'UTC')
       ORDER BY hour_epoch ASC`,
      [monitor.id]
    );
    const hourMap = new Map(hourlyRows.map(r => [Number(r.hour_epoch), r]));

    // 24-hour latency distribution (p50/p95 per hour)
    const { rows: hourlyLatencyRows } = await pool.query(
      `SELECT
         EXTRACT(EPOCH FROM DATE_TRUNC('hour', checked_at AT TIME ZONE 'UTC'))::bigint AS hour_epoch,
         COUNT(*)::int AS samples,
         ROUND(AVG(response_time_ms))::int AS avg_ms,
         ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_time_ms))::int AS p50_ms,
         ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms))::int AS p95_ms
       FROM uptime_checks
       WHERE monitor_id = $1
         AND response_time_ms IS NOT NULL
         AND checked_at > NOW() - INTERVAL '24 hours'
       GROUP BY DATE_TRUNC('hour', checked_at AT TIME ZONE 'UTC')
       ORDER BY hour_epoch ASC`,
      [monitor.id]
    );
    const latencyMap = new Map(hourlyLatencyRows.map(r => [Number(r.hour_epoch), r]));
    const thresholdMs = Number.isFinite(Number(monitor.threshold_ms)) && Number(monitor.threshold_ms) > 0
      ? Number(monitor.threshold_ms)
      : null;
    const hourBuckets = [];
    const latencyBuckets = [];
    const nowHourUtc = new Date();
    nowHourUtc.setUTCMinutes(0, 0, 0);
    for (let i = 23; i >= 0; i--) {
      const hourDate = new Date(nowHourUtc.getTime() - i * 60 * 60 * 1000);
      const hourEpoch = Math.floor(hourDate.getTime() / 1000);
      const bucket = hourMap.get(hourEpoch);
      const normalized = normalizeBucket(bucket);
      hourBuckets.push({
        hour_epoch: hourEpoch,
        hour_label: hourDate.toISOString().slice(11, 16),
        ...normalized
      });

      const latency = latencyMap.get(hourEpoch);
      const p95 = latency?.p95_ms != null ? Number(latency.p95_ms) : null;
      let latencyLevel = 'empty';
      if (p95 != null) {
        if (thresholdMs != null && p95 > thresholdMs * 1.5) latencyLevel = 'hot';
        else if (thresholdMs != null && p95 > thresholdMs) latencyLevel = 'warn';
        else latencyLevel = 'ok';
      }
      latencyBuckets.push({
        hour_epoch: hourEpoch,
        hour_label: hourDate.toISOString().slice(11, 16),
        samples: latency?.samples != null ? Number(latency.samples) : 0,
        avg_ms: latency?.avg_ms != null ? Number(latency.avg_ms) : null,
        p50_ms: latency?.p50_ms != null ? Number(latency.p50_ms) : null,
        p95_ms: p95,
        level: latencyLevel
      });
    }
    const filledLatency = latencyBuckets.filter(b => b.p95_ms != null);
    const maxP95 = filledLatency.reduce((max, b) => Math.max(max, Number(b.p95_ms || 0)), 0);
    const slowHours = thresholdMs == null ? 0 : filledLatency.filter(b => Number(b.p95_ms) > thresholdMs).length;
    const worstHour = filledLatency.reduce((worst, b) => {
      if (!worst) return b;
      return Number(b.p95_ms) > Number(worst.p95_ms) ? b : worst;
    }, null);
    const latencyOverview = {
      thresholdMs,
      slowHours,
      maxP95: maxP95 || thresholdMs || 1000,
      worstHour: worstHour ? { hour_label: worstHour.hour_label, p95_ms: worstHour.p95_ms } : null
    };

    // SLA/SLO snapshot (informational)
    const monthlyTarget = Number(process.env.PUBLIC_SLO_TARGET_30D || 99.9);
    const weeklyTarget = Number(process.env.PUBLIC_SLO_TARGET_7D || 99.5);
    const slo30d = calcSlo(30, monthlyTarget, uptimeWindows['30d']);
    const slo7d = calcSlo(7, weeklyTarget, uptimeWindows['7d']);

    // Incident timeline events (started + resolved points)
    const timelineEvents = [];
    for (const inc of incidents) {
      if (inc.started_at) {
        timelineEvents.push({
          at: inc.started_at,
          event: 'started',
          cause: inc.cause || 'outage',
          duration_seconds: null,
          ongoing: !inc.resolved_at
        });
      }
      if (inc.resolved_at) {
        timelineEvents.push({
          at: inc.resolved_at,
          event: 'resolved',
          cause: inc.cause || 'outage',
          duration_seconds: inc.duration_seconds || null,
          ongoing: false
        });
      }
    }
    timelineEvents.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const timeline = timelineEvents.slice(0, 24);

    // Planned maintenance visibility
    const hasRecurringMaintenance = !!(monitor.maintenance_cron && monitor.maintenance_duration_minutes);
    const isManualSilenceActive = !!(monitor.silenced_until && new Date(monitor.silenced_until) > new Date());
    const isCronMaintenanceActive = hasRecurringMaintenance
      ? isNowInMaintenanceWindow(monitor.maintenance_cron, monitor.maintenance_duration_minutes)
      : false;
    const maintenanceWindows = hasRecurringMaintenance
      ? findNextMaintenanceWindows(monitor.maintenance_cron, monitor.maintenance_duration_minutes, 3, 14)
      : [];
    const maintenanceInfo = {
      hasRecurringMaintenance,
      isManualSilenceActive,
      isCronMaintenanceActive,
      silencedUntil: monitor.silenced_until || null,
      cron: monitor.maintenance_cron || null,
      durationMinutes: monitor.maintenance_duration_minutes || null,
      nextWindows: maintenanceWindows
    };

    res.render('status', {
      layout: false, // Use standalone template
      monitor,
      latestCheck: latestCheck || null,
      openIncident: openIncident || null,
      incidents,
      pct30d,
      uptimeWindows,
      responseStats: responseStats || {},
      recentChecks,
      reliability30d,
      dayBuckets,
      weekBuckets,
      hourBuckets,
      latencyBuckets,
      latencyOverview,
      slo30d,
      slo7d,
      timeline,
      maintenanceInfo,
      fmtDuration
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

// ─── Group status page: GET /status/page/:slug ─────────────────────────────
router.get('/page/:slug', async (req, res, next) => {
  try {
    const { rows: [page] } = await pool.query(
      'SELECT * FROM status_pages WHERE slug = $1 AND is_public = true',
      [req.params.slug]
    );
    if (!page) return res.status(404).render('error', { title: 'Not Found', error: 'Status page not found' });

    if (!page.monitor_ids || page.monitor_ids.length === 0) {
      return res.render('status-group', { layout: false, page, monitors: [], subscriberCount: 0, subscribed: null, message: null });
    }

    // Fetch each monitor with latest check + uptime stats
    const { rows: monitors } = await pool.query(
      `SELECT um.*,
              lc.status AS last_status, lc.response_time_ms AS last_rt, lc.checked_at AS last_checked,
              u24.uptime_24h,
              u7.uptime_7d,
              rt.avg_rt_24h
       FROM uptime_monitors um
       LEFT JOIN LATERAL (
         SELECT status, response_time_ms, checked_at
         FROM uptime_checks WHERE monitor_id = um.id ORDER BY checked_at DESC LIMIT 1
       ) lc ON true
       LEFT JOIN LATERAL (
         SELECT
           ROUND((COUNT(*) FILTER (WHERE status IN ('up','degraded'))::float / NULLIF(COUNT(*),0) * 100)::numeric, 1) AS uptime_24h
         FROM uptime_checks
         WHERE monitor_id = um.id AND checked_at > NOW() - INTERVAL '24 hours'
       ) u24 ON true
       LEFT JOIN LATERAL (
         SELECT
           ROUND((COUNT(*) FILTER (WHERE status IN ('up','degraded'))::float / NULLIF(COUNT(*),0) * 100)::numeric, 1) AS uptime_7d
         FROM uptime_checks
         WHERE monitor_id = um.id AND checked_at > NOW() - INTERVAL '7 days'
       ) u7 ON true
       LEFT JOIN LATERAL (
         SELECT ROUND(AVG(response_time_ms))::int AS avg_rt_24h
         FROM uptime_checks
         WHERE monitor_id = um.id
           AND checked_at > NOW() - INTERVAL '24 hours'
           AND response_time_ms IS NOT NULL
       ) rt ON true
       WHERE um.id = ANY($1)
       ORDER BY um.name`,
      [page.monitor_ids]
    );

    // Overall status
    const hasDown = monitors.some(m => m.last_status === 'down');
    const hasDegraded = monitors.some(m => m.last_status === 'degraded');
    const overallStatus = hasDown ? 'down' : hasDegraded ? 'degraded' : 'up';

    // Active incidents
    const { rows: activeIncidents } = await pool.query(
      `SELECT ui.*, um.name AS monitor_name FROM uptime_incidents ui
       JOIN uptime_monitors um ON um.id = ui.monitor_id
       WHERE ui.monitor_id = ANY($1) AND ui.resolved_at IS NULL
       ORDER BY ui.started_at DESC`,
      [page.monitor_ids]
    );

    // Recent resolved incidents
    const { rows: recentIncidents } = await pool.query(
      `SELECT ui.*, um.name AS monitor_name FROM uptime_incidents ui
       JOIN uptime_monitors um ON um.id = ui.monitor_id
       WHERE ui.monitor_id = ANY($1) AND ui.resolved_at IS NOT NULL
         AND ui.started_at > NOW() - INTERVAL '30 days'
       ORDER BY ui.started_at DESC LIMIT 10`,
      [page.monitor_ids]
    );

    const { rows: [summary] } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'down')::int AS down_checks_24h,
         COUNT(*) FILTER (WHERE status = 'degraded')::int AS degraded_checks_24h,
         COUNT(*) FILTER (WHERE status IN ('up','degraded'))::int AS ok_checks_24h,
         COUNT(*)::int AS total_checks_24h
       FROM uptime_checks
       WHERE monitor_id = ANY($1)
         AND checked_at > NOW() - INTERVAL '24 hours'`,
      [page.monitor_ids]
    );

    const { rows: [{ cnt: subscriberCount }] } = await pool.query(
      'SELECT COUNT(*) AS cnt FROM uptime_subscribers WHERE status_page_id = $1 AND confirmed_at IS NOT NULL',
      [page.id]
    );

    res.render('status-group', {
      layout: false,
      page,
      monitors,
      overallStatus,
      activeIncidents,
      recentIncidents,
      summary: summary || { down_checks_24h: 0, degraded_checks_24h: 0, ok_checks_24h: 0, total_checks_24h: 0 },
      subscriberCount: parseInt(subscriberCount, 10),
      fmtDuration,
      message: req.query.msg || null,
      subscribed: req.query.subscribed || null
    });
  } catch (err) { next(err); }
});

// POST /status/page/:slug/subscribe
router.post('/page/:slug/subscribe', async (req, res, next) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.redirect(`/status/page/${req.params.slug}?msg=Invalid+email`);

  try {
    const { rows: [page] } = await pool.query(
      'SELECT * FROM status_pages WHERE slug = $1 AND is_public = true',
      [req.params.slug]
    );
    if (!page) return res.status(404).render('error', { title: 'Not Found', error: 'Page not found' });

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO uptime_subscribers (status_page_id, email, token)
       VALUES ($1, $2, $3)
       ON CONFLICT (status_page_id, email) DO UPDATE SET token = $3`,
      [page.id, email.trim().toLowerCase(), token]
    );

    // Send confirmation email
    if (isEmailConfigured()) {
      const confirmUrl = `${process.env.BASE_URL || ''}/status/confirm/${token}`;
      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST, port: parseInt(process.env.SMTP_PORT || '587', 10),
          secure: process.env.SMTP_PORT === '465',
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
          tls: { rejectUnauthorized: false }
        });
        await transporter.sendMail({
          from: process.env.SMTP_FROM || 'MetaWatch <alerts@metawatch.app>',
          to: email,
          subject: `Confirm subscription to ${page.title}`,
          html: `<p>Click to confirm your subscription to status updates for <strong>${page.title}</strong>:<br><a href="${confirmUrl}">${confirmUrl}</a></p><p><small>If you didn't request this, ignore this email.</small></p>`
        });
      } catch { /* ignore email errors */ }
    }

    res.redirect(`/status/page/${req.params.slug}?subscribed=1`);
  } catch (err) { next(err); }
});

// GET /status/confirm/:token
router.get('/confirm/:token', async (req, res, next) => {
  try {
    const { rows: [sub] } = await pool.query(
      `UPDATE uptime_subscribers SET confirmed_at = NOW()
       WHERE token = $1 AND confirmed_at IS NULL RETURNING *`,
      [req.params.token]
    );
    if (!sub) return res.render('error', { title: 'Error', error: 'Invalid or already confirmed token.' });

    const { rows: [page] } = await pool.query('SELECT * FROM status_pages WHERE id = $1', [sub.status_page_id]);
    res.redirect(`/status/page/${page?.slug || ''}?msg=Subscription+confirmed`);
  } catch (err) { next(err); }
});

// GET /status/unsubscribe/:token
router.get('/unsubscribe/:token', async (req, res, next) => {
  try {
    const { rows: [sub] } = await pool.query(
      'DELETE FROM uptime_subscribers WHERE token = $1 RETURNING *',
      [req.params.token]
    );
    if (!sub) return res.render('error', { title: 'Error', error: 'Invalid unsubscribe link.' });
    const { rows: [page] } = await pool.query('SELECT * FROM status_pages WHERE id = $1', [sub.status_page_id]);
    res.redirect(`/status/page/${page?.slug || ''}?msg=Unsubscribed`);
  } catch (err) { next(err); }
});

module.exports = router;
