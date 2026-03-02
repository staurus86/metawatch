#!/usr/bin/env node

const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
const mode = (modeArg ? modeArg.split('=')[1] : 'web').trim().toLowerCase();

const supported = new Set(['web', 'worker']);
if (!supported.has(mode)) {
  console.error(`[env-doctor] Unsupported mode "${mode}". Use --mode=web or --mode=worker`);
  process.exit(2);
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function present(name) {
  return String(process.env[name] || '').trim().length > 0;
}

const errors = [];
const warnings = [];

function requireVar(name, reason) {
  if (!present(name)) errors.push(`${name}: ${reason}`);
}

function warnVar(name, reason) {
  if (!present(name)) warnings.push(`${name}: ${reason}`);
}

requireVar('DATABASE_URL', 'required for PostgreSQL connection');

if (mode === 'web') {
  requireVar('JWT_SECRET', 'required for stable auth sessions across restarts');
  warnVar('BASE_URL', 'recommended for correct links in billing, emails and API docs');

  const enableWeb = envBool('ENABLE_WEB', true);
  const enableScheduler = envBool('ENABLE_SCHEDULER', true);
  const enableWorkers = envBool('ENABLE_QUEUE_WORKERS', false);
  const hasRedis = present('REDIS_URL');

  if (!enableWeb) {
    warnings.push('ENABLE_WEB=false: this process will not serve HTTP traffic');
  }
  if (enableWorkers) {
    warnings.push('ENABLE_QUEUE_WORKERS=true on web service: usually disabled in split web/worker setup');
  }
  if (!enableScheduler && !enableWorkers && !enableWeb) {
    warnings.push('ENABLE_WEB=false + ENABLE_SCHEDULER=false + ENABLE_QUEUE_WORKERS=false -> idle process');
  }
  if (!hasRedis) {
    warnings.push('REDIS_URL not set: queue backend falls back to in-memory');
  }
}

if (mode === 'worker') {
  const enableWeb = envBool('ENABLE_WEB', false);
  const enableScheduler = envBool('ENABLE_SCHEDULER', false);
  const enableWorkers = envBool('ENABLE_QUEUE_WORKERS', true);

  requireVar('REDIS_URL', 'required for BullMQ worker mode');
  if (!enableWorkers) {
    errors.push('ENABLE_QUEUE_WORKERS=false: worker service will not process queue jobs');
  }
  if (enableWeb) {
    warnings.push('ENABLE_WEB=true on worker service: usually disabled in split mode');
  }
  if (enableScheduler) {
    warnings.push('ENABLE_SCHEDULER=true on worker service: can cause duplicate scheduling');
  }
}

const header = `[env-doctor] mode=${mode}`;
console.log(header);
if (errors.length === 0) {
  console.log('[env-doctor] required checks: OK');
} else {
  console.log('[env-doctor] required checks: FAILED');
  for (const e of errors) console.log(`  - ERROR: ${e}`);
}

if (warnings.length > 0) {
  console.log('[env-doctor] warnings:');
  for (const w of warnings) console.log(`  - WARN: ${w}`);
}

process.exit(errors.length === 0 ? 0 : 1);

