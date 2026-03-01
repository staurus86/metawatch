const crypto = require('crypto');
const pool = require('./db');
const cron = require('node-cron');
const { scrapeUrl, fetchRobotsTxt, checkSsl } = require('./scraper');
const { notify } = require('./notifier');

const SSL_WARN_DAYS = parseInt(process.env.SSL_WARN_DAYS || '30', 10);
const DEFAULT_ALERT_COOLDOWN_MINUTES = parseInt(process.env.DEFAULT_ALERT_COOLDOWN_MINUTES || '60', 10);

// Check if current time falls inside a maintenance window defined by a cron expression
function isInMaintenanceWindow(maintenanceCron, durationMinutes) {
  if (!maintenanceCron || !durationMinutes || durationMinutes <= 0) return false;
  try {
    if (!cron.validate(maintenanceCron)) return false;
    const now = new Date();
    const [minute, hour, dom, month, dow] = maintenanceCron.split(' ');
    // Walk back up to durationMinutes minutes to find if a cron window started and is still active
    for (let i = 0; i <= durationMinutes; i++) {
      const t = new Date(now.getTime() - i * 60000);
      const minuteMatch = minute === '*' || minute === String(t.getUTCMinutes()) ||
        (minute.startsWith('*/') && t.getUTCMinutes() % parseInt(minute.slice(2), 10) === 0);
      const hourMatch = hour === '*' || hour === String(t.getUTCHours());
      const domMatch = dom === '*' || dom === String(t.getUTCDate());
      const monthMatch = month === '*' || month === String(t.getUTCMonth() + 1);
      const dowMatch = dow === '*' || dow === String(t.getUTCDay());
      if (minuteMatch && hourMatch && domMatch && monthMatch && dowMatch) return true;
    }
  } catch {
    return false;
  }
  return false;
}

// Classify alert severity based on field and values
function classifySeverity(fieldLabel, oldValue, newValue) {
  const critical = ['Response Code', 'noindex', 'SSL Expiry Warning', 'SSL Certificate', 'Soft 404', 'HTTP State', 'Robots Blocking'];
  const warning = ['Title', 'Meta Description', 'Canonical', 'Redirect URL', 'Redirect Chain', 'hreflang', 'Canonical Issue', 'Indexability Conflict'];

  if (critical.includes(fieldLabel)) {
    if (fieldLabel === 'noindex') {
      return (String(newValue) === 'true' || newValue === true) ? 'critical' : 'warning';
    }
    if (fieldLabel === 'Response Code') {
      const nc = parseInt(newValue, 10);
      return (!nc || nc >= 400) ? 'critical' : 'warning';
    }
    if (fieldLabel === 'HTTP State') {
      return String(newValue || '').toLowerCase().includes('recovered') ? 'info' : 'critical';
    }
    return 'critical';
  }
  if (warning.includes(fieldLabel)) return 'warning';
  return 'info';
}

function hashState(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function isHttpErrorState(statusCode, soft404) {
  const code = parseInt(statusCode || 0, 10);
  if (soft404) return true;
  return code === 0 || code >= 400;
}

// Write to notification_log
async function logNotification({ urlId, monitorId, channel, fieldChanged, severity, status, errorMessage }) {
  try {
    await pool.query(
      `INSERT INTO notification_log (url_id, monitor_id, channel, field_changed, severity, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [urlId || null, monitorId || null, channel, fieldChanged || null, severity || null, status, errorMessage || null]
    );
  } catch {
    // non-critical
  }
}

// Evaluate alert state/cooldown for duplicate suppression and reminder cadence
async function evaluateAlertState({ urlId, fieldKey, stateValue, cooldownMinutes }) {
  if (String(process.env.ENABLE_ALERT_STATE_ENGINE || 'true').toLowerCase() === 'false') {
    return { notify: true, recordAlert: true, reason: 'engine_disabled' };
  }

  const stateHash = hashState(stateValue);
  const cooldown = Number.isFinite(parseInt(cooldownMinutes, 10))
    ? Math.max(0, parseInt(cooldownMinutes, 10))
    : DEFAULT_ALERT_COOLDOWN_MINUTES;

  const { rows: [current] } = await pool.query(
    'SELECT * FROM alert_state WHERE url_id = $1 AND field_key = $2',
    [urlId, fieldKey]
  );

  if (!current) {
    await pool.query(
      `INSERT INTO alert_state
         (url_id, field_key, state_hash, last_seen_at, last_alert_at, cooldown_until)
       VALUES ($1, $2, $3, NOW(), NOW(), NOW() + make_interval(mins => $4::int))`,
      [urlId, fieldKey, stateHash, cooldown]
    );
    return { notify: true, recordAlert: true, reason: 'new_state' };
  }

  const now = Date.now();
  const cooldownUntil = current.cooldown_until ? new Date(current.cooldown_until).getTime() : 0;
  const sameState = current.state_hash === stateHash;

  if (sameState && cooldownUntil > now) {
    await pool.query(
      'UPDATE alert_state SET last_seen_at = NOW() WHERE id = $1',
      [current.id]
    );
    return { notify: false, recordAlert: false, reason: 'duplicate_in_cooldown' };
  }

  await pool.query(
    `UPDATE alert_state
       SET state_hash = $1,
           last_seen_at = NOW(),
           last_alert_at = NOW(),
           cooldown_until = NOW() + make_interval(mins => $2::int)
     WHERE id = $3`,
    [stateHash, cooldown, current.id]
  );

  return {
    notify: true,
    recordAlert: true,
    reason: sameState ? 'cooldown_elapsed' : 'state_changed'
  };
}

function normalizeRobotsPath(path) {
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function isRobotsBlocked(rawRobotsTxt, pageUrl, userAgent) {
  if (!rawRobotsTxt) return false;
  let targetPath = '/';
  try {
    const u = new URL(pageUrl);
    targetPath = normalizeRobotsPath(u.pathname + (u.search || ''));
  } catch {
    return false;
  }

  const uaToken = String(userAgent || '*').split(/[\/\s]/)[0].toLowerCase();
  const lines = String(rawRobotsTxt).split(/\r?\n/).map(line => line.replace(/#.*/, '').trim()).filter(Boolean);

  let activeMatch = false;
  let hasMatchedGroup = false;
  const allows = [];
  const disallows = [];

  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      const ruleUa = value.toLowerCase();
      activeMatch = (ruleUa === '*') || (uaToken && ruleUa.includes(uaToken));
      hasMatchedGroup = hasMatchedGroup || activeMatch;
      continue;
    }
    if (!activeMatch) continue;
    if (key === 'disallow' && value) disallows.push(value);
    if (key === 'allow' && value) allows.push(value);
  }

  if (!hasMatchedGroup) return false;

  const longestMatch = (rules) => {
    let match = '';
    for (const rule of rules) {
      const norm = normalizeRobotsPath(rule);
      if (targetPath.startsWith(norm) && norm.length > match.length) {
        match = norm;
      }
    }
    return match;
  };

  const bestAllow = longestMatch(allows);
  const bestDisallow = longestMatch(disallows);
  if (!bestDisallow) return false;
  return bestDisallow.length > bestAllow.length;
}

const MONITORED_FIELDS = [
  { key: 'title', monitorKey: 'monitor_title', label: 'Title' },
  { key: 'description', monitorKey: 'monitor_description', label: 'Meta Description' },
  { key: 'h1', monitorKey: 'monitor_h1', label: 'H1' },
  { key: 'body_text_hash', monitorKey: 'monitor_body', label: 'Page Content' },
  { key: 'status_code', monitorKey: 'monitor_status_code', label: 'Response Code' },
  { key: 'soft_404', monitorKey: 'monitor_status_code', label: 'Soft 404' },
  { key: 'noindex', monitorKey: 'monitor_noindex', label: 'noindex' },
  { key: 'redirect_url', monitorKey: 'monitor_redirect', label: 'Redirect URL' },
  { key: 'redirect_chain', monitorKey: 'monitor_redirect', label: 'Redirect Chain' },
  { key: 'canonical', monitorKey: 'monitor_canonical', label: 'Canonical' },
  { key: 'canonical_issue', monitorKey: 'monitor_canonical', label: 'Canonical Issue' },
  { key: 'indexability_conflict', monitorKey: 'monitor_noindex', label: 'Indexability Conflict' },
  { key: 'robots_txt_hash', monitorKey: 'monitor_robots', label: 'robots.txt' },
  { key: 'robots_blocked', monitorKey: 'monitor_robots', label: 'Robots Blocking' },
  { key: 'hreflang', monitorKey: 'monitor_hreflang', label: 'hreflang' },
  { key: 'og_title', monitorKey: 'monitor_og', label: 'OG Title' },
  { key: 'og_description', monitorKey: 'monitor_og', label: 'OG Description' },
  { key: 'og_image', monitorKey: 'monitor_og', label: 'OG Image' },
  { key: 'custom_text_found', monitorKey: '_custom_text', label: 'Custom Text' },
  { key: 'ssl_expires_at', monitorKey: 'monitor_ssl', label: 'SSL Certificate' }
];

// Strip digits from a value when ignore_numbers is enabled
function maybeStripNumbers(val) {
  if (val === null || val === undefined) return val;
  return String(val).replace(/\d+/g, '');
}

async function checkUrl(urlId) {
  const lockId = parseInt(urlId, 10);
  const { rows: [lockRow] } = await pool.query(
    'SELECT pg_try_advisory_lock($1) AS locked',
    [lockId]
  );
  if (!lockRow?.locked) {
    return { skipped: true, reason: 'already_running' };
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM monitored_urls WHERE id = $1 AND is_active = true',
      [urlId]
    );
    const urlRecord = rows[0];
    if (!urlRecord) return { skipped: true };

    // Get latest snapshot (for state transition checks)
    const { rows: prevRows } = await pool.query(
      'SELECT * FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC LIMIT 1',
      [urlId]
    );
    const lastSnapshot = prevRows[0] || null;

    // Get reference snapshot (if set) or latest snapshot as baseline
    let refSnapshot = null;
    if (urlRecord.reference_snapshot_id) {
      const { rows: refRows } = await pool.query(
        'SELECT * FROM snapshots WHERE id = $1',
        [urlRecord.reference_snapshot_id]
      );
      refSnapshot = refRows[0] || null;
    }
    if (!refSnapshot) refSnapshot = lastSnapshot;

    // Load active text rules for this URL
    const { rows: textRules } = await pool.query(
      'SELECT * FROM text_monitors WHERE url_id = $1 AND is_active = true',
      [urlId]
    );

    // Scrape current state
    const scraped = await scrapeUrl(urlRecord.url, {
      userAgent: urlRecord.user_agent || undefined,
      customText: urlRecord.custom_text || undefined,
      textRules: textRules.length > 0 ? textRules : undefined
    });

    const robotsData = urlRecord.monitor_robots
      ? await fetchRobotsTxt(urlRecord.url, urlRecord.user_agent)
      : { hash: null, raw: null };

    const sslExpiresAt = urlRecord.monitor_ssl
      ? await checkSsl(urlRecord.url)
      : null;

    const robotsBlocked = urlRecord.monitor_robots
      ? isRobotsBlocked(robotsData.raw, urlRecord.url, urlRecord.user_agent)
      : false;

    // Serialize text rule results
    const textRulesJson = scraped.textRuleResults && scraped.textRuleResults.length > 0
      ? JSON.stringify(scraped.textRuleResults)
      : null;

    // Save new snapshot
    const { rows: [snap] } = await pool.query(
      `INSERT INTO snapshots
         (url_id, title, description, h1, body_text_hash, normalized_body_hash, status_code, soft_404, noindex,
          redirect_url, redirect_chain, canonical, canonical_issue, indexability_conflict, robots_txt_hash,
          raw_robots_txt, robots_blocked, hreflang, og_title, og_description, og_image, custom_text_found,
          response_time_ms, ssl_expires_at, text_rules_json, js_rendered)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       RETURNING *`,
      [
        urlId,
        scraped.title,
        scraped.description,
        scraped.h1,
        scraped.body_text_hash,
        scraped.normalized_body_hash,
        scraped.status_code,
        !!scraped.soft_404,
        scraped.noindex,
        scraped.redirect_url,
        scraped.redirect_chain,
        scraped.canonical,
        scraped.canonical_issue,
        !!scraped.indexability_conflict,
        robotsData.hash,
        robotsData.raw,
        !!robotsBlocked,
        scraped.hreflang,
        scraped.og_title,
        scraped.og_description,
        scraped.og_image,
        scraped.custom_text_found,
        scraped.response_time_ms ?? null,
        sslExpiresAt ?? null,
        textRulesJson,
        !!scraped.js_rendered
      ]
    );

    // First snapshot: set as reference automatically
    if (!refSnapshot) {
      await pool.query(
        'UPDATE monitored_urls SET reference_snapshot_id = $1 WHERE id = $2',
        [snap.id, urlId]
      );
      console.log(`[Check] First snapshot saved for URL #${urlId} — set as reference`);
      return { snapshot: snap, alerts: [] };
    }

    const alertsGenerated = [];
    const ignoreNums = urlRecord.ignore_numbers;
    const cooldownMinutes = Math.max(
      0,
      parseInt(urlRecord.alert_cooldown_minutes || DEFAULT_ALERT_COOLDOWN_MINUTES, 10) || DEFAULT_ALERT_COOLDOWN_MINUTES
    );

    // Load user's alert rules (for this URL's owner)
    let alertRules = [];
    if (urlRecord.user_id) {
      const { rows: rules } = await pool.query(
        'SELECT * FROM alert_rules WHERE user_id = $1 AND is_active = true',
        [urlRecord.user_id]
      );
      alertRules = rules;
    }

    // Helper: evaluate conditions (AND logic)
    function evalConditions(conditions, field, oldVal, newVal) {
      if (!conditions || conditions.length === 0) return true;
      return conditions.every(cond => {
        const normalizedField = String(field || '').toLowerCase();
        const normalizedCondField = String(cond.field || '').toLowerCase();
        const fieldMatch = !cond.field ||
          normalizedCondField === normalizedField ||
          (normalizedCondField === 'response_code' && normalizedField === 'status_code') ||
          (normalizedCondField === 'description' && normalizedField === 'meta_description');
        if (!fieldMatch) return false;
        const op = cond.operator;
        const v = cond.value;
        const newStr = String(newVal ?? '').toLowerCase();
        const oldStr = String(oldVal ?? '').toLowerCase();
        if (op === 'changed') return oldStr !== newStr;
        if (op === 'equals') return newStr === String(v ?? '').toLowerCase();
        if (op === 'contains') return newStr.includes(String(v ?? '').toLowerCase());
        if (op === 'not_contains') return !newStr.includes(String(v ?? '').toLowerCase());
        if (op === 'gt') return parseFloat(newVal) > parseFloat(v);
        if (op === 'lt') return parseFloat(newVal) < parseFloat(v);
        return true;
      });
    }

    // Helper: find matching rule for a field change
    function findMatchingRule(fieldKey, oldVal, newVal) {
      for (const rule of alertRules) {
        const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
        if (evalConditions(conditions, fieldKey, oldVal, newVal)) return rule;
      }
      return null;
    }

    // Maintenance window check (computed once per checkUrl call)
    const manualSilenced = urlRecord.silenced_until && new Date(urlRecord.silenced_until) > new Date();
    const cronSilenced = isInMaintenanceWindow(urlRecord.maintenance_cron, urlRecord.maintenance_duration_minutes);
    const silenced = manualSilenced || cronSilenced;

    for (const field of MONITORED_FIELDS) {
      // Special handling: custom text monitored only when custom_text is set
      if (field.monitorKey === '_custom_text') {
        if (!urlRecord.custom_text) continue;
      } else if (!urlRecord[field.monitorKey]) {
        continue;
      }

      const oldSource = (field.key === 'body_text_hash')
        ? (refSnapshot.normalized_body_hash || refSnapshot.body_text_hash)
        : refSnapshot[field.key];
      const newSource = (field.key === 'body_text_hash')
        ? (snap.normalized_body_hash || snap.body_text_hash)
        : snap[field.key];

      const compareOld = ignoreNums ? maybeStripNumbers(oldSource) : String(oldSource ?? '');
      const compareNew = ignoreNums ? maybeStripNumbers(newSource) : String(newSource ?? '');
      if (compareOld === compareNew) continue;

      const severity = classifySeverity(field.label, oldSource, newSource);
      const state = await evaluateAlertState({
        urlId,
        fieldKey: field.label,
        stateValue: `${field.label}:${compareNew}`,
        cooldownMinutes
      });

      if (!state.recordAlert) {
        await logNotification({
          urlId,
          channel: 'suppressed',
          fieldChanged: field.label,
          severity,
          status: 'suppressed',
          errorMessage: state.reason
        });
        continue;
      }

      // Determine display values for notifications
      const displayOld = field.key === 'robots_txt_hash'
        ? (refSnapshot.raw_robots_txt ?? oldSource)
        : oldSource;
      const displayNew = field.key === 'robots_txt_hash'
        ? (snap.raw_robots_txt ?? newSource)
        : newSource;

      await pool.query(
        `INSERT INTO alerts (url_id, field_changed, old_value, new_value, severity)
         VALUES ($1, $2, $3, $4, $5)`,
        [urlId, field.label, String(oldSource ?? ''), String(newSource ?? ''), severity]
      );

      alertsGenerated.push(field.label);

      // Check alert rules: find matching rule to override notification behaviour
      const matchingRule = findMatchingRule(field.key, oldSource, newSource);
      const ruleActions = matchingRule
        ? (Array.isArray(matchingRule.actions) ? matchingRule.actions : [])
        : [];
      const suppress = ruleActions.some(a => a.type === 'suppress_alert');

      if (state.notify && !suppress && !silenced) {
        try {
          await notify({
            urlRecord,
            field: field.label,
            oldValue: displayOld,
            newValue: displayNew,
            severity,
            timestamp: new Date(),
            ruleActions: ruleActions.length > 0 ? ruleActions : undefined
          });
          await logNotification({ urlId, channel: 'multi', fieldChanged: field.label, severity, status: 'sent' });
        } catch (notifyErr) {
          await logNotification({
            urlId,
            channel: 'multi',
            fieldChanged: field.label,
            severity,
            status: 'failed',
            errorMessage: notifyErr.message
          });
        }
      } else if (suppress) {
        await logNotification({ urlId, channel: 'suppressed', fieldChanged: field.label, severity, status: 'suppressed' });
      }
    }

    // Transition alert: error state to recovery (and vice versa) based on last check, not baseline
    if (lastSnapshot && urlRecord.monitor_status_code) {
      const prevErr = isHttpErrorState(lastSnapshot.status_code, lastSnapshot.soft_404);
      const currErr = isHttpErrorState(snap.status_code, snap.soft_404);
      if (prevErr !== currErr) {
        const oldVal = prevErr
          ? `Error (${lastSnapshot.status_code || 0}${lastSnapshot.soft_404 ? ', soft-404' : ''})`
          : `OK (${lastSnapshot.status_code || 200})`;
        const newVal = currErr
          ? `Error (${snap.status_code || 0}${snap.soft_404 ? ', soft-404' : ''})`
          : `Recovered (${snap.status_code || 200})`;
        const severity = currErr ? 'critical' : 'info';
        const transitionState = await evaluateAlertState({
          urlId,
          fieldKey: 'HTTP State',
          stateValue: `${oldVal} -> ${newVal}`,
          cooldownMinutes: 0
        });

        if (transitionState.recordAlert) {
          await pool.query(
            `INSERT INTO alerts (url_id, field_changed, old_value, new_value, severity)
             VALUES ($1, 'HTTP State', $2, $3, $4)`,
            [urlId, oldVal, newVal, severity]
          );
          alertsGenerated.push(`HTTP State: ${newVal}`);

          if (transitionState.notify && !silenced) {
            try {
              await notify({
                urlRecord,
                field: 'HTTP State',
                oldValue: oldVal,
                newValue: newVal,
                severity,
                timestamp: new Date()
              });
              await logNotification({ urlId, channel: 'multi', fieldChanged: 'HTTP State', severity, status: 'sent' });
            } catch (err) {
              await logNotification({
                urlId,
                channel: 'multi',
                fieldChanged: 'HTTP State',
                severity,
                status: 'failed',
                errorMessage: err.message
              });
            }
          }
        }
      }
    }

    // JS-rendered warning state (first detection only, then cooldown based)
    if (snap.js_rendered) {
      const jsState = await evaluateAlertState({
        urlId,
        fieldKey: 'JS Render Warning',
        stateValue: 'js_rendered:true',
        cooldownMinutes: cooldownMinutes
      });
      if (jsState.recordAlert) {
        await pool.query(
          `INSERT INTO alerts (url_id, field_changed, old_value, new_value, severity)
           VALUES ($1, 'JS Render Warning', $2, $3, 'info')`,
          [urlId, 'Unknown', 'Page may require JavaScript rendering']
        );
        alertsGenerated.push('JS Render Warning');
      }
    }

    // ── Text rule change detection ────────────────────────────────────────────
    if (textRules.length > 0 && scraped.textRuleResults && refSnapshot) {
      let refRuleResults = [];
      try { refRuleResults = JSON.parse(refSnapshot.text_rules_json || '[]'); } catch { refRuleResults = []; }

      for (const result of scraped.textRuleResults) {
        const prevResult = refRuleResults.find(r => r.id === result.id);
        const prevMatched = prevResult ? prevResult.matched : null;
        if (prevMatched === null || prevMatched === result.matched) continue;

        const label = result.label || result.text;
        const oldVal = prevMatched ? 'Found' : 'Not found';
        const newVal = result.matched ? 'Found' : 'Not found';
        const textState = await evaluateAlertState({
          urlId,
          fieldKey: `Text:${label}`,
          stateValue: `${oldVal}->${newVal}`,
          cooldownMinutes
        });
        if (!textState.recordAlert) continue;

        await pool.query(
          `INSERT INTO alerts (url_id, field_changed, old_value, new_value, severity)
           VALUES ($1, $2, $3, $4, 'info')`,
          [urlId, `Text: ${label}`, oldVal, newVal]
        );
        alertsGenerated.push(`Text: ${label}`);

        if (textState.notify && !silenced) {
          try {
            await notify({
              urlRecord,
              field: `Text Rule: ${label}`,
              oldValue: oldVal,
              newValue: newVal,
              severity: 'info',
              timestamp: new Date()
            });
          } catch {
            // non-critical
          }
        }
      }
    }

    // SSL expiry proactive warning (separate from change detection)
    if (urlRecord.monitor_ssl && sslExpiresAt) {
      const daysLeft = Math.ceil((sslExpiresAt - new Date()) / (1000 * 60 * 60 * 24));
      if (daysLeft <= SSL_WARN_DAYS && daysLeft > 0) {
        // Check if we already sent this warning recently (within 7 days)
        const { rows: recentWarn } = await pool.query(
          `SELECT id FROM alerts
           WHERE url_id = $1 AND field_changed = 'SSL Expiry Warning'
             AND detected_at > NOW() - INTERVAL '7 days'`,
          [urlId]
        );
        if (recentWarn.length === 0) {
          await pool.query(
            `INSERT INTO alerts (url_id, field_changed, old_value, new_value, severity)
             VALUES ($1, 'SSL Expiry Warning', $2, $3, 'critical')`,
            [urlId, `${daysLeft} days remaining`, sslExpiresAt.toISOString()]
          );
          alertsGenerated.push(`SSL Expiry Warning (${daysLeft}d)`);
          if (!silenced) {
            try {
              await notify({
                urlRecord,
                field: 'SSL Expiry Warning',
                oldValue: `${daysLeft} days remaining`,
                newValue: `Certificate expires: ${sslExpiresAt.toUTCString()}`,
                severity: 'critical',
                timestamp: new Date()
              });
              await logNotification({ urlId, channel: 'multi', fieldChanged: 'SSL Expiry Warning', severity: 'critical', status: 'sent' });
            } catch (notifyErr) {
              await logNotification({
                urlId,
                channel: 'multi',
                fieldChanged: 'SSL Expiry Warning',
                severity: 'critical',
                status: 'failed',
                errorMessage: notifyErr.message
              });
            }
          }
        }
      }
    }

    // ── Response time threshold alert ────────────────────────────────────────
    if (urlRecord.response_time_threshold_ms && scraped.response_time_ms != null) {
      const threshold = urlRecord.response_time_threshold_ms;
      if (scraped.response_time_ms > threshold) {
        // Only alert if previous check was not above threshold (state transition)
        const prevRt = lastSnapshot?.response_time_ms ?? null;
        if (prevRt == null || prevRt <= threshold) {
          await pool.query(
            `INSERT INTO alerts (url_id, field_changed, old_value, new_value, severity)
             VALUES ($1, 'Response Time', $2, $3, 'warning')`,
            [urlId, `${threshold}ms threshold`, `${scraped.response_time_ms}ms`]
          );
          alertsGenerated.push(`Slow response (${scraped.response_time_ms}ms)`);
          if (!silenced) {
            try {
              await notify({
                urlRecord,
                field: 'Response Time',
                oldValue: `Threshold: ${threshold}ms`,
                newValue: `Actual: ${scraped.response_time_ms}ms`,
                severity: 'warning',
                timestamp: new Date()
              });
              await logNotification({ urlId, channel: 'multi', fieldChanged: 'Response Time', severity: 'warning', status: 'sent' });
            } catch (e) {
              await logNotification({
                urlId,
                channel: 'multi',
                fieldChanged: 'Response Time',
                severity: 'warning',
                status: 'failed',
                errorMessage: e.message
              });
            }
          }
        }
      }
    }

    if (alertsGenerated.length > 0) {
      console.log(`[Check] URL #${urlId}: ${alertsGenerated.length} change(s) — ${alertsGenerated.join(', ')}`);
    } else {
      console.log(`[Check] URL #${urlId}: No changes detected`);
    }

    return { snapshot: snap, alerts: alertsGenerated };
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => {});
  }
}

module.exports = { checkUrl, MONITORED_FIELDS };
