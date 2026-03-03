#!/usr/bin/env node

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

function parseArgValue(name, fallback = null) {
  const full = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (!full) return fallback;
  return full.slice(name.length + 1);
}

function parseIntArg(name) {
  const raw = parseArgValue(name, null);
  if (raw == null) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function createDbPool() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  return new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10),
    application_name: 'metawatch-db-explain',
    ssl: connectionString.includes('railway')
      ? { rejectUnauthorized: false }
      : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false)
  });
}

function extractPlanJson(explainRows) {
  const raw = explainRows?.[0]?.['QUERY PLAN'];
  if (Array.isArray(raw) && raw[0]) return raw[0];
  return raw || null;
}

function summarizePlan(name, planJson, sql, params) {
  const plan = planJson?.Plan || {};
  return {
    name,
    planning_ms: Number(planJson?.['Planning Time'] || 0),
    execution_ms: Number(planJson?.['Execution Time'] || 0),
    node_type: plan['Node Type'] || null,
    total_cost: plan['Total Cost'] || null,
    plan_rows: plan['Plan Rows'] ?? null,
    actual_rows: plan['Actual Rows'] ?? null,
    shared_hit_blocks: plan['Shared Hit Blocks'] ?? null,
    shared_read_blocks: plan['Shared Read Blocks'] ?? null,
    temp_read_blocks: plan['Temp Read Blocks'] ?? null,
    temp_written_blocks: plan['Temp Written Blocks'] ?? null,
    sql,
    params
  };
}

async function runExplain(pool, name, sql, params = []) {
  const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`;
  const { rows } = await pool.query(explainSql, params);
  const planJson = extractPlanJson(rows);
  if (!planJson) {
    throw new Error('No plan JSON returned by EXPLAIN');
  }
  return summarizePlan(name, planJson, sql, params);
}

async function detectSampleIds(pool, forcedUserId, forcedUrlId) {
  let userId = forcedUserId;
  let urlId = forcedUrlId;

  if (!Number.isFinite(userId)) {
    const { rows: [user] } = await pool.query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
    userId = user?.id ?? null;
  }
  if (!Number.isFinite(urlId)) {
    if (Number.isFinite(userId)) {
      const { rows: [url] } = await pool.query(
        'SELECT id FROM monitored_urls WHERE user_id = $1 ORDER BY id ASC LIMIT 1',
        [userId]
      );
      urlId = url?.id ?? null;
    }
    if (!Number.isFinite(urlId)) {
      const { rows: [urlAny] } = await pool.query(
        'SELECT id FROM monitored_urls ORDER BY id ASC LIMIT 1'
      );
      urlId = urlAny?.id ?? null;
    }
  }

  return {
    userId: Number.isFinite(userId) ? userId : null,
    urlId: Number.isFinite(urlId) ? urlId : null
  };
}

function getCases({ userId, urlId, perPage }) {
  const cases = [
    {
      name: 'admin.pending_checks',
      sql: `
        SELECT COUNT(*)::int AS pending_checks
        FROM monitored_urls mu
        LEFT JOIN LATERAL (
          SELECT checked_at
          FROM snapshots
          WHERE url_id = mu.id
          ORDER BY checked_at DESC
          LIMIT 1
        ) ls ON true
        WHERE mu.is_active = true
          AND (
            ls.checked_at IS NULL
            OR ls.checked_at < NOW() - make_interval(mins => mu.check_interval_minutes)
          )
      `,
      params: []
    },
    {
      name: 'api_v2.urls.admin_list',
      sql: `
        SELECT
          mu.id,
          mu.url,
          ls.checked_at AS last_checked,
          ls.status_code,
          COALESCE(ch.change_count, 0)::int AS changes_count
        FROM monitored_urls mu
        LEFT JOIN LATERAL (
          SELECT s.checked_at, s.status_code
          FROM snapshots s
          WHERE s.url_id = mu.id
          ORDER BY s.checked_at DESC
          LIMIT 1
        ) ls ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS change_count
          FROM alerts a
          WHERE a.url_id = mu.id
            AND a.detected_at > NOW() - INTERVAL '24 hours'
        ) ch ON true
        ORDER BY ls.checked_at DESC NULLS LAST, mu.id DESC
        LIMIT $1
      `,
      params: [perPage]
    }
  ];

  if (Number.isFinite(userId)) {
    cases.push({
      name: 'api_v2.urls.user_list',
      sql: `
        SELECT
          mu.id,
          mu.url,
          ls.checked_at AS last_checked,
          ls.status_code,
          COALESCE(ch.change_count, 0)::int AS changes_count
        FROM monitored_urls mu
        LEFT JOIN LATERAL (
          SELECT s.checked_at, s.status_code
          FROM snapshots s
          WHERE s.url_id = mu.id
          ORDER BY s.checked_at DESC
          LIMIT 1
        ) ls ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS change_count
          FROM alerts a
          WHERE a.url_id = mu.id
            AND a.detected_at > NOW() - INTERVAL '24 hours'
        ) ch ON true
        WHERE mu.user_id = $1
        ORDER BY ls.checked_at DESC NULLS LAST, mu.id DESC
        LIMIT $2
      `,
      params: [userId, perPage]
    });

    cases.push({
      name: 'api_v2.stats.summary_user',
      sql: `
        WITH latest AS (
          SELECT DISTINCT ON (s.url_id)
            s.url_id,
            COALESCE(s.status_code, 0) AS status_code,
            COALESCE(s.noindex, false) AS noindex
          FROM snapshots s
          JOIN monitored_urls mu ON mu.id = s.url_id
          WHERE mu.user_id = $1
          ORDER BY s.url_id, s.checked_at DESC
        ),
        changed AS (
          SELECT DISTINCT a.url_id
          FROM alerts a
          JOIN monitored_urls mu ON mu.id = a.url_id
          WHERE a.detected_at > NOW() - INTERVAL '24 hours'
            AND mu.user_id = $1
        )
        SELECT
          (SELECT COUNT(*)::int FROM monitored_urls WHERE user_id = $1) AS total_urls,
          (SELECT ROUND(AVG(health_score)::numeric, 1) FROM monitored_urls WHERE user_id = $1) AS avg_health_score,
          (SELECT COUNT(*)::int FROM latest) AS latest_count,
          (SELECT COUNT(*)::int FROM latest WHERE status_code = 0 OR status_code >= 400) AS error_count,
          (SELECT COUNT(*)::int FROM latest WHERE noindex = true) AS noindex_count,
          (SELECT COUNT(*)::int FROM latest WHERE noindex = false) AS indexed_count,
          (SELECT COUNT(*)::int
            FROM latest l
            JOIN changed c ON c.url_id = l.url_id
            WHERE l.status_code BETWEEN 1 AND 399) AS changed_count
      `,
      params: [userId]
    });

    cases.push({
      name: 'api_v2.alerts.feed_user',
      sql: `
        SELECT a.id, a.url_id, a.field_changed, a.detected_at, mu.url
        FROM alerts a
        JOIN monitored_urls mu ON mu.id = a.url_id
        WHERE mu.user_id = $1
        ORDER BY a.detected_at DESC
        LIMIT $2
      `,
      params: [userId, perPage]
    });
  }

  if (Number.isFinite(urlId)) {
    cases.push({
      name: 'api_v2.url.snapshots',
      sql: `
        SELECT s.id, s.url_id, s.checked_at, s.status_code
        FROM snapshots s
        WHERE s.url_id = $1
        ORDER BY s.checked_at DESC
        LIMIT $2
      `,
      params: [urlId, perPage]
    });
  }

  return cases;
}

async function main() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    console.error('[db-explain] DATABASE_URL is not set');
    process.exit(1);
  }

  const userIdArg = parseIntArg('--user-id');
  const urlIdArg = parseIntArg('--url-id');
  const perPage = Math.max(1, Math.min(500, parseIntArg('--limit') || 25));
  const outRaw = parseArgValue('--out', path.join(process.cwd(), 'db-explain-report.json'));
  const outPath = path.resolve(outRaw);
  const failFast = envBool('DB_EXPLAIN_FAIL_FAST', false);

  const pool = createDbPool();
  const startedAt = Date.now();

  try {
    const sample = await detectSampleIds(pool, userIdArg, urlIdArg);
    const cases = getCases({ ...sample, perPage });

    console.log(`[db-explain] Running ${cases.length} case(s) ...`);
    const results = [];
    const failures = [];

    for (const c of cases) {
      try {
        const summary = await runExplain(pool, c.name, c.sql, c.params);
        results.push(summary);
        console.log(
          `  ✓ ${c.name}: exec=${summary.execution_ms.toFixed(2)}ms plan=${summary.planning_ms.toFixed(2)}ms`
        );
      } catch (err) {
        const msg = String(err?.message || err);
        failures.push({ name: c.name, error: msg });
        console.log(`  ✕ ${c.name}: ${msg}`);
        if (failFast) throw err;
      }
    }

    const sorted = [...results].sort((a, b) => b.execution_ms - a.execution_ms);
    const report = {
      generated_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      options: {
        per_page: perPage,
        user_id: sample.userId,
        url_id: sample.urlId
      },
      totals: {
        cases: cases.length,
        succeeded: results.length,
        failed: failures.length
      },
      slowest_first: sorted,
      failures
    };

    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    console.log(`[db-explain] Report saved to: ${outPath}`);

    if (failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[db-explain] Fatal:', err.message);
  process.exit(1);
});
