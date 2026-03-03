const test = require('node:test');
const assert = require('node:assert/strict');

const { isRobotsBlocked } = require('../src/checker');

test('robots: allow rule wins by longer match in specific UA group', () => {
  const robots = `
    User-agent: *
    Disallow: /private

    User-agent: MetaWatch
    Disallow: /private
    Allow: /private/public
  `;

  assert.equal(
    isRobotsBlocked(robots, 'https://example.com/private/public/page', 'MetaWatch/2.0'),
    false
  );
  assert.equal(
    isRobotsBlocked(robots, 'https://example.com/private/secret', 'MetaWatch/2.0'),
    true
  );
});

test('robots: wildcard and end-anchor patterns are evaluated correctly', () => {
  const robots = `
    User-agent: *
    Disallow: /*?session=
    Allow: /search$
  `;

  assert.equal(
    isRobotsBlocked(robots, 'https://example.com/path?session=abc', 'MetaWatch/2.0'),
    true
  );
  assert.equal(
    isRobotsBlocked(robots, 'https://example.com/search', 'MetaWatch/2.0'),
    false
  );
});

test('robots: allow wins on equal-length match', () => {
  const robots = `
    User-agent: *
    Disallow: /folder
    Allow: /folder
  `;

  assert.equal(
    isRobotsBlocked(robots, 'https://example.com/folder/page', 'MetaWatch/2.0'),
    false
  );
});

test('robots: wildcard group applies when specific UA group does not match', () => {
  const robots = `
    User-agent: Googlebot
    Disallow: /

    User-agent: *
    Allow: /
  `;

  assert.equal(
    isRobotsBlocked(robots, 'https://example.com/anything', 'MetaWatch/2.0'),
    false
  );
});
