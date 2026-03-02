const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_LANG,
  normalizeLanguage,
  detectFromAcceptLanguage,
  translate
} = require('../src/i18n');

test('normalizeLanguage handles empty and region variants', () => {
  assert.equal(normalizeLanguage(''), DEFAULT_LANG);
  assert.equal(normalizeLanguage('ru-RU'), 'ru');
  assert.equal(normalizeLanguage('en_US'), 'en');
  assert.equal(normalizeLanguage('de-DE'), 'en');
});

test('detectFromAcceptLanguage selects top supported language', () => {
  const lang = detectFromAcceptLanguage('ru-RU;q=0.9, en-US;q=0.7');
  assert.equal(lang, 'ru');
});

test('translate returns localized value and falls back to key', () => {
  assert.equal(translate('ru', 'nav.dashboard'), 'Дашборд');
  assert.equal(translate('en', 'nav.dashboard'), 'Dashboard');
  assert.equal(translate('ru', 'missing.key.path'), 'missing.key.path');
});
