const pool = require('./db');
const { scrapeUrl, fetchRobotsTxt } = require('./scraper');
const { notify } = require('./notifier');

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
  { key: 'custom_text_found',monitorKey: '_custom_text', label: 'Custom Text' }
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

  // Scrape current state
  const scraped = await scrapeUrl(urlRecord.url, {
    userAgent: urlRecord.user_agent || undefined,
    customText: urlRecord.custom_text || undefined
  });

  const robotsData = urlRecord.monitor_robots
    ? await fetchRobotsTxt(urlRecord.url, urlRecord.user_agent)
    : { hash: null, raw: null };

  // Save new snapshot
  const { rows: [snap] } = await pool.query(
    `INSERT INTO snapshots
       (url_id, title, description, h1, body_text_hash, status_code, noindex,
        redirect_url, canonical, robots_txt_hash, raw_robots_txt,
        hreflang, og_title, og_description, og_image, custom_text_found)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
      scraped.custom_text_found
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

    await pool.query(
      `INSERT INTO alerts (url_id, field_changed, old_value, new_value)
       VALUES ($1, $2, $3, $4)`,
      [urlId, field.label, String(rawOld ?? ''), String(rawNew ?? '')]
    );

    alertsGenerated.push(field.label);

    await notify({
      urlRecord,
      field: field.label,
      oldValue: displayOld,
      newValue: displayNew,
      timestamp: new Date()
    });
  }

  if (alertsGenerated.length > 0) {
    console.log(`[Check] URL #${urlId}: ${alertsGenerated.length} change(s) — ${alertsGenerated.join(', ')}`);
  } else {
    console.log(`[Check] URL #${urlId}: No changes detected`);
  }

  return { snapshot: snap, alerts: alertsGenerated };
}

module.exports = { checkUrl, MONITORED_FIELDS };
