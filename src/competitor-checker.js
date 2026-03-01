const pool = require('./db');
const { scrapeUrl } = require('./scraper');

async function checkCompetitor(competitorId) {
  const { rows: [comp] } = await pool.query(
    'SELECT * FROM competitor_urls WHERE id = $1',
    [competitorId]
  );
  if (!comp) return;

  try {
    const scraped = await scrapeUrl(comp.competitor_url);

    await pool.query(
      `INSERT INTO competitor_snapshots
         (competitor_url_id, status_code, title, description, h1, canonical,
          noindex, redirect_url, og_title, og_description, response_time_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        competitorId,
        scraped.status_code,
        scraped.title,
        scraped.description,
        scraped.h1,
        scraped.canonical,
        scraped.noindex,
        scraped.redirect_url,
        scraped.og_title,
        scraped.og_description,
        scraped.response_time_ms ?? null
      ]
    );

    await pool.query(
      'UPDATE competitor_urls SET last_checked_at = NOW() WHERE id = $1',
      [competitorId]
    );

    console.log(`[Competitor] Checked ${comp.competitor_url}`);
  } catch (err) {
    console.error(`[Competitor] Error checking #${competitorId}: ${err.message}`);
  }
}

module.exports = { checkCompetitor };
