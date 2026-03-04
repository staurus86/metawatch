const cheerio = require('cheerio');
const crypto = require('crypto');
const { detectAccessChallenge } = require('./access-challenge');
const { assertSafeOutboundUrl } = require('./net-safety');

const DEFAULT_USER_AGENT = 'MetaWatch/2.0 (metadata monitor; +https://metawatch.app/bot)';
const MAX_HEADLESS_PAGES = Math.max(1, parseInt(process.env.HEADLESS_MAX_PAGES || '2', 10) || 2);

let browser = null;
let launchPromise = null;
let activePages = 0;
const pageWaiters = [];

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
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
  const signals = ['404', 'not found', 'page not found', 'does not exist', 'no longer available'];
  return signals.some(s => txt.includes(s)) && txt.length < 2500;
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

async function acquirePageSlot() {
  if (activePages < MAX_HEADLESS_PAGES) {
    activePages += 1;
    return () => releasePageSlot();
  }

  await new Promise(resolve => pageWaiters.push(resolve));
  activePages += 1;
  return () => releasePageSlot();
}

function releasePageSlot() {
  activePages = Math.max(0, activePages - 1);
  const next = pageWaiters.shift();
  if (next) next();
}

function buildTextRuleResults(bodyText, textRules) {
  if (!Array.isArray(textRules) || textRules.length === 0) return undefined;
  const lowerBody = String(bodyText || '').toLowerCase();
  return textRules.map(rule => {
    let matched = false;
    try {
      const text = String(rule.text || '');
      if (rule.match_type === 'contains') matched = lowerBody.includes(text.toLowerCase());
      else if (rule.match_type === 'not_contains') matched = !lowerBody.includes(text.toLowerCase());
      else if (rule.match_type === 'regex') matched = new RegExp(text, 'i').test(bodyText || '');
    } catch {
      matched = false;
    }
    return {
      id: rule.id,
      label: rule.label,
      text: rule.text,
      match_type: rule.match_type,
      matched
    };
  });
}

async function loadPuppeteer() {
  try {
    // Lazy-load so the app still runs when Puppeteer isn't installed.
    // eslint-disable-next-line global-require
    return require('puppeteer');
  } catch (err) {
    const e = new Error('Puppeteer is not installed');
    e.code = 'HEADLESS_UNAVAILABLE';
    e.cause = err;
    throw e;
  }
}

async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    const puppeteer = await loadPuppeteer();
    const launched = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--disable-extensions'
      ]
    });
    launched.on('disconnected', () => {
      browser = null;
    });
    browser = launched;
    return browser;
  })();

  try {
    return await launchPromise;
  } finally {
    launchPromise = null;
  }
}

async function closeHeadlessBrowser() {
  if (!browser) return;
  try {
    await browser.close();
  } catch {
    // ignore
  } finally {
    browser = null;
  }
}

async function scrapeUrlHeadless(url, options = {}) {
  const ua = options.userAgent || DEFAULT_USER_AGENT;
  const customText = options.customText || null;
  const safeUrl = await assertSafeOutboundUrl(url);

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
    js_rendered: true,
    challenge_detected: false,
    challenge_reason: null,
    error: null
  };

  const releaseSlot = await acquirePageSlot();
  let page = null;
  try {
    const b = await ensureBrowser();
    page = await b.newPage();
    await page.setUserAgent(ua);

    const t0 = Date.now();
    const response = await page.goto(safeUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    result.response_time_ms = Date.now() - t0;
    result.status_code = response ? response.status() : 0;

    // If JS anti-bot challenge (503/403), wait for it to auto-resolve
    if (result.status_code === 503 || result.status_code === 403) {
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 });
        result.status_code = 200; // challenge passed
        result.response_time_ms = Date.now() - t0;
      } catch { /* still on challenge page */ }
    }

    const finalUrl = page.url();
    if (finalUrl && normalizeUrlForCompare(finalUrl) !== normalizeUrlForCompare(safeUrl)) {
      result.redirect_url = finalUrl;
    }

    const redirectChain = response?.request?.().redirectChain?.() || [];
    if (Array.isArray(redirectChain) && redirectChain.length > 0) {
      const chain = [safeUrl, ...redirectChain.map(req => req.url()), finalUrl].filter(Boolean);
      const unique = [...new Set(chain)];
      if (unique.length > 1) result.redirect_chain = JSON.stringify(unique);
    }

    const headers = response?.headers ? response.headers() : {};
    const contentType = String(headers['content-type'] || '');
    const html = await page.content();
    if (contentType && !contentType.includes('text/html')) {
      return result;
    }

    const $ = cheerio.load(html);

    result.title = $('title').first().text().trim() || null;
    result.description = (
      $('meta[name="description"]').attr('content') ||
      $('meta[name="Description"]').attr('content') ||
      null
    );
    if (result.description) result.description = result.description.trim();
    result.h1 = $('h1').first().text().replace(/\s+/g, ' ').trim() || null;

    const robotsMeta = (
      $('meta[name="robots"]').attr('content') ||
      $('meta[name="Robots"]').attr('content') ||
      ''
    ).toLowerCase();
    result.noindex = robotsMeta.includes('noindex');

    const canonicalHref = $('link[rel="canonical"]').attr('href')?.trim() || null;
    result.canonical = canonicalHref ? new URL(canonicalHref, finalUrl || safeUrl).toString() : null;
    result.canonical_issue = detectCanonicalIssue(finalUrl || safeUrl, result.canonical);

    const hreflangs = [];
    $('link[rel="alternate"][hreflang]').each((_, el) => {
      const lang = $(el).attr('hreflang');
      const href = $(el).attr('href');
      if (lang && href) hreflangs.push({ lang, url: href });
    });
    result.hreflang = hreflangs.length > 0 ? JSON.stringify(hreflangs) : null;

    result.og_title = $('meta[property="og:title"]').attr('content')?.trim() || null;
    result.og_description = $('meta[property="og:description"]').attr('content')?.trim() || null;
    result.og_image = $('meta[property="og:image"]').attr('content')?.trim() || null;

    $('script, style, noscript, head').remove();
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const normalizedBodyText = normalizeForHash(bodyText);
    result.body_text_hash = sha256(bodyText);
    result.normalized_body_hash = sha256(normalizedBodyText);
    result.soft_404 = detectSoft404({
      statusCode: result.status_code,
      title: result.title,
      bodyText
    });

    result.indexability_conflict = !!(
      result.noindex &&
      result.canonical &&
      normalizeUrlForCompare(result.canonical) !== normalizeUrlForCompare(finalUrl || safeUrl)
    );

    const challenge = detectAccessChallenge({
      title: result.title,
      description: result.description,
      h1: result.h1,
      bodyText,
      statusCode: result.status_code
    });
    result.challenge_detected = challenge.detected;
    result.challenge_reason = challenge.reason;

    if (customText) {
      result.custom_text_found = bodyText.includes(customText);
    }

    const textRuleResults = buildTextRuleResults(bodyText, options.textRules);
    if (textRuleResults) {
      result.textRuleResults = textRuleResults;
    }
  } catch (err) {
    result.error = err.message;
    if (result.status_code == null) result.status_code = 0;
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
    releaseSlot();
  }

  return result;
}

for (const signal of ['SIGINT', 'SIGTERM', 'beforeExit']) {
  process.once(signal, () => {
    closeHeadlessBrowser().catch(() => {});
  });
}

module.exports = {
  scrapeUrlHeadless,
  closeHeadlessBrowser
};
