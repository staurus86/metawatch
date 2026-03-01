const pool = require('./db');
const { scrapeUrl, fetchRobotsTxt, checkSsl } = require('./scraper');
const { notify } = require('./notifier');

const SSL_WARN_DAYS = parseInt(process.env.SSL_WARN_DAYS || '30', 10);

// Classify alert severity based on field and values
function classifySeverity(fieldLabel, oldValue, newValue) {
  const critical = ['Response Code', 'noindex', 'SSL Expiry Warning', 'SSL Certificate'];
  const warning  = ['Title', 'Meta Description', 'Canonical', 'Redirect URL', 'hreflang'];
  const info     = ['H1', 'Page Content', 'robots.txt', 'OG Title', 'OG Description', 'OG Image', 'Custom Text'];

  if (critical.includes(fieldLabel)) {
    // noindex: only critical when it appears (false→true)
    if (fieldLabel === 'noindex') {
      return (String(newValue) === 'true' || newValue === true) ? 'critical' : 'warning';
    }
    // Response Code: critical if going to/from error
    if (fieldLabel === 'Response Code') {
      const nc = parseInt(newValue, 10);
      return (!nc || nc >= 400) ? 'critical' : 'warning';
    }
    return 'critical';
  }
  if (warning.includes(fieldLabel)) {
    // Title: critical if new value is empty
    if (fieldLabel === 'Title' && (!newValue || newValue === 'null' || newValue === '')) {
      return 'critical';
    }
    return 'warning';
  }
  return 'info';
}

// Write to notification_log
async function logNotification({ urlId, monitorId, channel, fieldChanged, severity, status, errorMessage }) {
  try {
    await pool.query(
      `INSERT INTO notification_log (url_id, monitor_id, channel, field_changed, severity, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [urlId || null, monitorId || null, channel, fieldChanged || null, severity || null, status, errorMessage || null]
    );
  } catch { /* non-critical */ }
}

const MONITORED_FIELDS = [
  { key: 'title',            monitorKey: 'monitor_title',       label: 'Title' },
  { key: 'description',      monitorKey: 'monitor_description', label: 'Meta Description' },
  { key: 'h1',               monitorKey: 'monitor_h1',          label: 'H1' },
  { key: 'body_text_hash',   monitorKey: 'monitor_body',        label: 'Page Content' },
  { key: 'status_code',      monitorKey: 'monitor_status_code', label: 'Response Code' },
  { key: 'noindex',          monitorKey: 'monitor_noindex',     label: 'noindex' },
  { key: 'redirect_url',     monitorKey: 'monitor_redirect',    label: 'Redirect URL' },
  { key: 'canonical',        monitorKey: 'monitor_canonical',   label: 'Canonical' },
  { key: 'robots_txt_hash',  monitorKey: 'monitor_robots',      label: 'robots.txt' },
  { key: 'hreflang',         monitorKey: 'monitor_hreflang',    label: 'hreflang' },
  { key: 'og_title',         monitorKey: 'monitor_og',          label: 'OG Title' },
  { key: 'og_description',   monitorKey: 'monitor_og',          label: 'OG Description' },
  { key: 'og_image',         monitorKey: 'monitor_og',          label: 'OG Image' },
  { key: 'custom_text_found',monitorKey: '_custom_text',  label: 'Custom Text' },
  { key: 'ssl_expires_at',   monitorKey: 'monitor_ssl',   label: 'SSL Certificate' }
];

// Strip digits from a value when ignore_numbers is enabled
function maybeStripNumbers(val) {
  if (val === null || val === undefined) return val;
  return String(val).replace(/\d+/g, '');
}

async function checkUrl(urlId) {
  const { rows } = await pool.query(
    'SELECT * FROM monitored_urls WHERE id = $1 AND is_active = true',
    [urlId]
  );
  const urlRecord = rows[0];
  if (!urlRecord) return { skipped: true };

  // Get reference snapshot (if set) or last snapshot
  let refSnapshot = null;
  if (urlRecord.reference_snapshot_id) {
    const { rows: refRows } = await pool.query(
      'SELECT * FROM snapshots WHERE id = $1',
      [urlRecord.reference_snapshot_id]
    );
    refSnapshot = refRows[0] || null;
  }

  if (!refSnapshot) {
    // Fall back to most recent snapshot
    const { rows: prevRows } = await pool.query(
      'SELECT * FROM snapshots WHERE url_id = $1 ORDER BY checked_at DESC LIMIT 1',
      [urlId]
    );
    refSnapshot = prevRows[0] || null;
  }

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

  // Serialize text rule results
  const textRulesJson = scraped.textRuleResults && scraped.textRuleResults.length > 0
    ? JSON.stringify(scraped.textRuleResults)
    : null;

  // Save new snapshot
  const { rows: [snap] } = await pool.query(
    `INSERT INTO snapshots
       (url_id, title, description, h1, body_text_hash, status_code, noindex,
        redirect_url, canonical, robots_txt_hash, raw_robots_txt,
        hreflang, og_title, og_description, og_image, custom_text_found,
        response_time_ms, ssl_expires_at, text_rules_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [
      urlId,
      scraped.title,
      scraped.description,
      scraped.h1,
      scraped.body_text_hash,
      scraped.status_code,
      scraped.noindex,
      scraped.redirect_url,
      scraped.canonical,
      robotsData.hash,
      robotsData.raw,
      scraped.hreflang,
      scraped.og_title,
      scraped.og_description,
      scraped.og_image,
      scraped.custom_text_found,
      scraped.response_time_ms ?? null,
      sslExpiresAt ?? null,
      textRulesJson
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

  for (const field of MONITORED_FIELDS) {
    // Special handling: custom text monitored only when custom_text is set
    if (field.monitorKey === '_custom_text') {
      if (!urlRecord.custom_text) continue;
    } else {
      if (!urlRecord[field.monitorKey]) continue;
    }

    const rawOld = refSnapshot[field.key];
    const rawNew = snap[field.key];

    const compareOld = ignoreNums ? maybeStripNumbers(rawOld) : String(rawOld ?? '');
    const compareNew = ignoreNums ? maybeStripNumbers(rawNew) : String(rawNew ?? '');

    if (compareOld === compareNew) continue;

    // Determine display values for notifications
    const displayOld = field.key === 'robots_txt_hash'
      ? (refSnapshot.raw_robots_txt ?? rawOld)
      : rawOld;
    const displayNew = field.key === 'robots_txt_hash'
      ? (snap.raw_robots_txt ?? rawNew)
      : rawNew;

    const severity = classifySeverity(field.label, rawOld, rawNew);

    await pool.query(
      `INSERT INTO alerts (url_id, field_changed, old_value, new_value, severity)
       VALUES ($1, $2, $3, $4, $5)`,
      [urlId, field.label, String(rawOld ?? ''), String(rawNew ?? ''), severity]
    );

    alertsGenerated.push(field.label);

    // Skip notifications if URL is in maintenance window
    const silenced = urlRecord.silenced_until && new Date(urlRecord.silenced_until) > new Date();
    if (!silenced) {
      try {
        await notify({
          urlRecord,
          field: field.label,
          oldValue: displayOld,
          newValue: displayNew,
          severity,
          timestamp: new Date()
        });
        await logNotification({ urlId, channel: 'email', fieldChanged: field.label, severity, status: 'sent' });
      } catch (notifyErr) {
        await logNotification({ urlId, channel: 'email', fieldChanged: field.label, severity, status: 'failed', errorMessage: notifyErr.message });
      }
    }
  }

  // ── Text rule change detection ──────────────────────────────────────────────
  if (textRules.length > 0 && scraped.textRuleResults && refSnapshot) {
    let refRuleResults = [];
    try { refRuleResults = JSON.parse(refSnapshot.text_rules_json || '[]'); } catch { refRuleResults = []; }

    for (const result of scraped.textRuleResults) {
      const prevResult = refRuleResults.find(r => r.id === result.id);
      const prevMatched = prevResult ? prevResult.matched : null;

      if (prevMatched !== null && prevMatched !== result.matched) {
        const label = result.label || result.text;
        const oldVal = prevMatched ? 'Found' : 'Not found';
        const newVal = result.matched ? 'Found' : 'Not found';

        await pool.query(
          `INSERT INTO alerts (url_id, field_changed, old_value, new_value, severity)
           VALUES ($1, $2, $3, $4, 'info')`,
          [urlId, `Text: ${label}`, oldVal, newVal]
        );
        alertsGenerated.push(`Text: ${label}`);

        const silenced2 = urlRecord.silenced_until && new Date(urlRecord.silenced_until) > new Date();
        if (!silenced2) {
          try {
            await notify({
              urlRecord,
              field: `Text Rule: ${label}`,
              oldValue: oldVal,
              newValue: newVal,
              severity: 'info',
              timestamp: new Date()
            });
          } catch { /* non-critical */ }
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
        const silenced = urlRecord.silenced_until && new Date(urlRecord.silenced_until) > new Date();
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
            await logNotification({ urlId, channel: 'email', fieldChanged: 'SSL Expiry Warning', severity: 'critical', status: 'sent' });
          } catch (notifyErr) {
            await logNotification({ urlId, channel: 'email', fieldChanged: 'SSL Expiry Warning', severity: 'critical', status: 'failed', errorMessage: notifyErr.message });
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
}

module.exports = { checkUrl, MONITORED_FIELDS };
