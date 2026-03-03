const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeForHash } = require('../src/scraper');

test('normalizeForHash strips dynamic date and token patterns', () => {
  const input = [
    'Updated: 2026-03-03 12:34:56',
    'Release v2.14.7',
    'Commit abcdef1234567890abcdef1234567890',
    'UUID 550e8400-e29b-41d4-a716-446655440000',
    'Session abcdefghijklmnopqrstuvwx12345678',
    'Counter 1234567890123'
  ].join(' | ');

  const out = normalizeForHash(input);

  assert.doesNotMatch(out, /\d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(out, /\bv\d+\.\d+/);
  assert.doesNotMatch(out, /\b[0-9a-f]{16,}\b/i);
  assert.doesNotMatch(out, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
  assert.doesNotMatch(out, /\b[a-z0-9_-]{24,}\b/i);
  assert.doesNotMatch(out, /\b\d{10,}\b/);
});

test('normalizeForHash lowercases and collapses whitespace', () => {
  const out = normalizeForHash('  Hello   WORLD   ');
  assert.equal(out, 'hello world');
});
