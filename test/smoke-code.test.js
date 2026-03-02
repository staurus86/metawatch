const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('smoke-code script contains required checks', () => {
  const filePath = path.join(process.cwd(), 'scripts', 'smoke-code.js');
  const code = fs.readFileSync(filePath, 'utf8');

  assert.match(code, /app\.use\('\/api\/v2'/);
  assert.match(code, /router\.get\('\/report\.pdf'/);
  assert.match(code, /router\.post\('\/push\/subscribe'/);
});
