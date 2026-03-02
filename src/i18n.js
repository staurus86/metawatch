const fs = require('fs');
const path = require('path');

const DEFAULT_LANG = 'en';
const SUPPORTED_LANGS = ['en', 'ru'];
const SUPPORTED_SET = new Set(SUPPORTED_LANGS);
const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const localeCache = new Map();

function normalizeLanguage(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return DEFAULT_LANG;
  const base = raw.split(/[-_]/)[0];
  return SUPPORTED_SET.has(base) ? base : DEFAULT_LANG;
}

function detectFromAcceptLanguage(headerValue) {
  const raw = String(headerValue || '').trim();
  if (!raw) return DEFAULT_LANG;

  const parts = raw.split(',')
    .map((item) => {
      const token = String(item || '').trim();
      if (!token) return null;
      const [langPart, qPart] = token.split(';');
      const qRaw = (qPart || '').trim().replace(/^q=/i, '');
      const q = qRaw ? Number(qRaw) : 1;
      return {
        lang: normalizeLanguage(langPart),
        q: Number.isFinite(q) ? q : 1
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.q - a.q);

  for (const part of parts) {
    if (SUPPORTED_SET.has(part.lang)) return part.lang;
  }

  return DEFAULT_LANG;
}

function getNestedValue(obj, dottedKey) {
  const pathParts = String(dottedKey || '').split('.').filter(Boolean);
  let cur = obj;
  for (const part of pathParts) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function applyInterpolation(str, vars) {
  if (!vars || typeof vars !== 'object') return str;
  return String(str).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key];
    return val == null ? '' : String(val);
  });
}

function loadLocale(lang) {
  const normalized = normalizeLanguage(lang);
  if (localeCache.has(normalized)) return localeCache.get(normalized);

  const filePath = path.join(LOCALES_DIR, normalized, 'translation.json');
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[i18n] Failed to load locale ${normalized}: ${err.message}`);
  }
  localeCache.set(normalized, data);
  return data;
}

function translate(lang, key, vars = null) {
  const normalized = normalizeLanguage(lang);
  const primary = getNestedValue(loadLocale(normalized), key);
  const fallback = getNestedValue(loadLocale(DEFAULT_LANG), key);
  const value = primary == null ? fallback : primary;
  if (value == null) return String(key);
  if (typeof value === 'string') return applyInterpolation(value, vars);
  return String(value);
}

function i18nMiddleware(req, res, next) {
  const queryLang = req.query?.lang;
  const userLang = req.user?.language;
  const headerLang = detectFromAcceptLanguage(req.headers['accept-language']);
  const lang = normalizeLanguage(queryLang || userLang || headerLang || DEFAULT_LANG);

  req.lang = lang;
  res.locals.lang = lang;
  res.locals.supportedLangs = SUPPORTED_LANGS;
  res.locals.t = (key, vars = null) => translate(lang, key, vars);
  next();
}

module.exports = {
  DEFAULT_LANG,
  SUPPORTED_LANGS,
  normalizeLanguage,
  detectFromAcceptLanguage,
  translate,
  i18nMiddleware
};
