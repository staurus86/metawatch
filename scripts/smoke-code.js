#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const failures = [];

function exists(relPath) {
  return fs.existsSync(path.join(root, relPath));
}

function expectFile(relPath) {
  if (!exists(relPath)) failures.push(`Missing file: ${relPath}`);
}

function expectContains(relPath, needle) {
  const abs = path.join(root, relPath);
  if (!fs.existsSync(abs)) {
    failures.push(`Missing file: ${relPath}`);
    return;
  }
  const txt = fs.readFileSync(abs, 'utf8');
  if (!txt.includes(needle)) failures.push(`Expected "${needle}" in ${relPath}`);
}

// Core runtime files
expectFile('src/index.js');
expectFile('src/queue.js');
expectFile('src/workers/index.js');
expectFile('src/routes/api-v2.js');
expectFile('src/routes/export.js');
expectFile('src/report-access.js');

// Core route registrations
expectContains('src/index.js', "app.use('/api/v2', require('./routes/api-v2'))");
expectContains('src/index.js', "app.use('/export', require('./routes/export'))");
expectContains('src/index.js', "app.use('/reports', require('./routes/reports'))");
expectContains('src/index.js', "app.use('/integrations', require('./routes/integrations'))");
expectContains('src/index.js', "app.use('/admin/queues', require('./routes/admin-queues'))");

// API v2 must include required endpoints
expectContains('src/routes/api-v2.js', "router.get('/urls'");
expectContains('src/routes/api-v2.js', "router.post('/urls/:id/check'");
expectContains('src/routes/api-v2.js', "router.put('/urls/:id/accept-changes'");
expectContains('src/routes/api-v2.js', "router.get('/uptime'");
expectContains('src/routes/api-v2.js', "router.get('/alerts'");
expectContains('src/routes/api-v2.js', "router.get('/stats'");

// Reports must include all key exports
expectContains('src/routes/export.js', "router.get('/report.pdf'");
expectContains('src/routes/export.js', "router.get('/report.xlsx'");
expectContains('src/routes/export.js', "router.get('/url/:id.pdf'");
expectContains('src/routes/export.js', "router.get('/project/:id.pdf'");
expectContains('src/routes/export.js', "router.get('/uptime-report.pdf'");
expectContains('src/routes/export.js', "router.get('/uptime/:id.pdf'");
expectContains('src/routes/export.js', "router.get('/alerts.csv'");

// Tariff caps should include all tiers
expectContains('src/report-access.js', 'free:');
expectContains('src/report-access.js', 'starter:');
expectContains('src/report-access.js', 'pro:');
expectContains('src/report-access.js', 'agency:');

if (failures.length > 0) {
  console.error('[smoke-code] FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('[smoke-code] OK');

