const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const https = require('https');

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

async function scrapeWithRetry(fn, retries = 3) {
  let lastErr;
  const delays = [1000, 2000, 4000];
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, delays[i]));
      }
    }
  }
  throw lastErr;
}

async function scrapeUrl(url, options = {}) {
  const ua = options.userAgent ||
    'MetaWatch/2.0 (metadata monitor; +https://metawatch.app/bot)';
  const customText = options.customText || null;

  const result = {
    title: null,
    description: null,
    h1: null,
    body_text_hash: null,
    status_code: null,
    noindex: false,
    redirect_url: null,
    canonical: null,
    hreflang: null,
    og_title: null,
    og_description: null,
    og_image: null,
    custom_text_found: null,
    response_time_ms: null,
    error: null
  };

  let lastRedirectUrl = null;

  try {
    const t0 = Date.now();
    const response = await scrapeWithRetry(() => axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      decompress: true,
      validateStatus: () => true,
      beforeRedirect: (opts, { headers }) => {
        if (headers.location) lastRedirectUrl = headers.location;
      }
    }));

    result.status_code = response.status;
    result.response_time_ms = Date.now() - t0;
    if (lastRedirectUrl) result.redirect_url = lastRedirectUrl;

    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('text/html')) return result;

    const $ = cheerio.load(response.data);

    result.title = $('title').first().text().trim() || null;

    result.description = (
      $('meta[name="description"]').attr('content') ||
      $('meta[name="Description"]').attr('content') ||
      null
    );
    if (result.description) result.description = result.description.trim();

    result.h1 = $('h1').first().text().replace(/\s+/g, ' ').trim() || null;

    // ── Extract all <head>-based data BEFORE removing head ────────────────────

    // noindex
    const robotsMeta = (
      $('meta[name="robots"]').attr('content') ||
      $('meta[name="Robots"]').attr('content') ||
      ''
    ).toLowerCase();
    result.noindex = robotsMeta.includes('noindex');

    // Canonical
    result.canonical = $('link[rel="canonical"]').attr('href')?.trim() || null;

    // hreflang: collect all <link rel="alternate" hreflang="...">
    const hreflangs = [];
    $('link[rel="alternate"][hreflang]').each((_, el) => {
      const lang = $(el).attr('hreflang');
      const href = $(el).attr('href');
      if (lang && href) hreflangs.push({ lang, url: href });
    });
    result.hreflang = hreflangs.length > 0 ? JSON.stringify(hreflangs) : null;

    // OG tags
    result.og_title = $('meta[property="og:title"]').attr('content')?.trim() || null;
    result.og_description = $('meta[property="og:description"]').attr('content')?.trim() || null;
    result.og_image = $('meta[property="og:image"]').attr('content')?.trim() || null;

    // ── Body hash (remove head/scripts first so only visible body text remains) ─
    $('script, style, noscript, head').remove();
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    result.body_text_hash = sha256(bodyText);

    // Custom text search (body only)
    const fullBodyText = $('body').text();
    if (customText) {
      result.custom_text_found = fullBodyText.includes(customText);
    }

    // Multi-rule text monitors
    if (options.textRules && options.textRules.length > 0) {
      result.textRuleResults = options.textRules.map(rule => {
        let matched = false;
        try {
          if (rule.match_type === 'contains') {
            matched = fullBodyText.toLowerCase().includes(rule.text.toLowerCase());
          } else if (rule.match_type === 'not_contains') {
            matched = !fullBodyText.toLowerCase().includes(rule.text.toLowerCase());
          } else if (rule.match_type === 'regex') {
            matched = new RegExp(rule.text, 'i').test(fullBodyText);
          }
        } catch { matched = false; }
        return { id: rule.id, label: rule.label, text: rule.text, match_type: rule.match_type, matched };
      });
    }

  } catch (err) {
    result.error = err.message;
    result.status_code = 0;
  }

  return result;
}

async function fetchRobotsTxt(url, userAgent) {
  const ua = userAgent || 'MetaWatch/2.0';
  try {
    const { hostname, protocol } = new URL(url);
    const robotsUrl = `${protocol}//${hostname}/robots.txt`;

    const response = await scrapeWithRetry(() => axios.get(robotsUrl, {
      timeout: 10000,
      headers: { 'User-Agent': ua },
      validateStatus: () => true,
      responseType: 'text'
    }));

    if (response.status === 200) {
      const raw = String(response.data).substring(0, 10000);
      return { hash: sha256(raw), raw };
    }
  } catch (_) {
    // Silently ignore
  }
  return { hash: null, raw: null };
}

// Check SSL certificate expiry date (returns Date or null)
async function checkSsl(url) {
  if (!url.startsWith('https://')) return null;
  try {
    const { hostname } = new URL(url);
    return await new Promise((resolve) => {
      const req = https.request(
        { host: hostname, port: 443, method: 'HEAD', path: '/', rejectUnauthorized: false, agent: false },
        (res) => {
          const cert = res.socket.getPeerCertificate();
          res.resume();
          resolve(cert && cert.valid_to ? new Date(cert.valid_to) : null);
        }
      );
      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => { req.destroy(); resolve(null); });
      req.end();
    });
  } catch {
    return null;
  }
}

module.exports = { scrapeUrl, fetchRobotsTxt, sha256, checkSsl };
