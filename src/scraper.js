const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const https = require('https');
const { assertSafeOutboundUrl } = require('./net-safety');

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

function normalizeForHash(text) {
  return String(text || '')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[ t]\d{2}:\d{2}(?::\d{2})?)?\b/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b/gi, ' ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/\b\d{10,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeUrlForCompare(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.endsWith('/') && u.pathname !== '/' ? u.pathname.slice(0, -1) : u.pathname;
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return String(url || '').trim();
  }
}

function detectSoft404({ statusCode, title, bodyText }) {
  if (statusCode !== 200) return false;
  const txt = `${title || ''} ${bodyText || ''}`.toLowerCase();
  if (txt.length < 40) return false;
  const signals = [
    '404',
    'not found',
    'page not found',
    'does not exist',
    'no longer available'
  ];
  const hit = signals.some(s => txt.includes(s));
  return hit && txt.length < 2500;
}

function detectCanonicalIssue(currentUrl, canonicalHref) {
  if (!canonicalHref) return null;
  let canonical;
  try {
    canonical = new URL(canonicalHref, currentUrl);
  } catch {
    return 'invalid_canonical';
  }
  if (!['http:', 'https:'].includes(canonical.protocol)) {
    return 'invalid_canonical';
  }

  const currNorm = normalizeUrlForCompare(currentUrl);
  const canNorm = normalizeUrlForCompare(canonical.toString());
  if (currNorm === canNorm) return null;

  if (canonical.hostname !== new URL(currentUrl).hostname) {
    return 'cross_domain_canonical';
  }
  return 'canonical_mismatch';
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
    normalized_body_hash: null,
    status_code: null,
    noindex: false,
    redirect_url: null,
    redirect_chain: null,
    canonical: null,
    canonical_issue: null,
    indexability_conflict: false,
    hreflang: null,
    og_title: null,
    og_description: null,
    og_image: null,
    custom_text_found: null,
    response_time_ms: null,
    soft_404: false,
    js_rendered: false,
    error: null
  };

  let safeUrl = url;
  let lastRedirectUrl = null;

  try {
    safeUrl = await assertSafeOutboundUrl(url);

    const t0 = Date.now();
    const response = await scrapeWithRetry(() => axios.get(safeUrl, {
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

    const redirectTrailRaw = response.request?._redirectable?._redirects;
    const redirectTrail = Array.isArray(redirectTrailRaw)
      ? redirectTrailRaw.map(v => String(v)).filter(Boolean)
      : [];
    const finalUrl = response.request?.res?.responseUrl || null;

    const chain = [safeUrl, ...redirectTrail];
    if (finalUrl && chain[chain.length - 1] !== finalUrl) {
      chain.push(finalUrl);
    }
    const uniqueChain = [...new Set(chain)];

    if (finalUrl && normalizeUrlForCompare(finalUrl) !== normalizeUrlForCompare(safeUrl)) {
      result.redirect_url = finalUrl;
    } else if (lastRedirectUrl) {
      result.redirect_url = lastRedirectUrl;
    }
    if (uniqueChain.length > 1) {
      result.redirect_chain = JSON.stringify(uniqueChain);
    }

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

    // Head-based signals
    const robotsMeta = (
      $('meta[name="robots"]').attr('content') ||
      $('meta[name="Robots"]').attr('content') ||
      ''
    ).toLowerCase();
    result.noindex = robotsMeta.includes('noindex');

    const canonicalHref = $('link[rel="canonical"]').attr('href')?.trim() || null;
    result.canonical = canonicalHref ? new URL(canonicalHref, finalUrl || safeUrl).toString() : null;
    result.canonical_issue = detectCanonicalIssue(finalUrl || safeUrl, result.canonical);

    // hreflang
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

    // Meta refresh redirects
    const metaRefresh = $('meta[http-equiv="refresh"]').attr('content') || '';
    const metaRefreshMatch = metaRefresh.match(/url\s*=\s*['"]?([^'";\s]+)/i);
    if (metaRefreshMatch && metaRefreshMatch[1]) {
      const refreshUrl = new URL(metaRefreshMatch[1], finalUrl || safeUrl).toString();
      if (!result.redirect_url) result.redirect_url = refreshUrl;
      if (!result.redirect_chain) {
        result.redirect_chain = JSON.stringify([safeUrl, refreshUrl]);
      }
    }

    // Remove known dynamic/noisy elements before body hashing
    const dynamicSelectors = [
      '#cookie-banner', '.cookie-banner', '#cookie-notice', '.cookie-notice',
      '#gdpr-overlay', '.gdpr-overlay', '#gdpr-banner', '.gdpr-banner',
      '#onetrust-banner-sdk', '.cc-window', '#cookiebanner', '.cookiebanner',
      '[id*="cookie"][id*="consent"]', '[class*="cookie-consent"]',
      'time', '[data-time]', '[data-timestamp]', '[data-date]',
      '[class*="timestamp"]', '[id*="timestamp"]', '[class*="time-ago"]',
      '.live-counter', '[class*="counter"]'
    ];
    dynamicSelectors.forEach(sel => {
      try { $(sel).remove(); } catch { /* ignore bad selectors */ }
    });

    $('script, style, noscript, head').remove();
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const normalizedBodyText = normalizeForHash(bodyText);
    result.body_text_hash = sha256(bodyText);
    result.normalized_body_hash = sha256(normalizedBodyText);
    result.soft_404 = detectSoft404({
      statusCode: result.status_code,
      title: result.title,
      bodyText: bodyText
    });

    result.indexability_conflict = !!(
      result.noindex &&
      result.canonical &&
      normalizeUrlForCompare(result.canonical) !== normalizeUrlForCompare(finalUrl || safeUrl)
    );

    // JS-rendered detection: very little text and no title = likely client-rendered
    if (bodyText.length < 500 && !result.title) {
      result.js_rendered = true;
    }

    // Custom text search (body only)
    if (customText) {
      result.custom_text_found = bodyText.includes(customText);
    }

    // Multi-rule text monitors
    if (options.textRules && options.textRules.length > 0) {
      result.textRuleResults = options.textRules.map(rule => {
        let matched = false;
        try {
          if (rule.match_type === 'contains') {
            matched = bodyText.toLowerCase().includes(rule.text.toLowerCase());
          } else if (rule.match_type === 'not_contains') {
            matched = !bodyText.toLowerCase().includes(rule.text.toLowerCase());
          } else if (rule.match_type === 'regex') {
            matched = new RegExp(rule.text, 'i').test(bodyText);
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
    const safeUrl = await assertSafeOutboundUrl(url);
    const { hostname, protocol } = new URL(safeUrl);
    const robotsUrl = await assertSafeOutboundUrl(`${protocol}//${hostname}/robots.txt`);

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
    const safeUrl = await assertSafeOutboundUrl(url);
    const { hostname } = new URL(safeUrl);
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
