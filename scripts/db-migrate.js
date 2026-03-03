#!/usr/bin/env node

require('dotenv').config();
const migrate = require('../src/migrate');
const pool = require('../src/db');

async function main() {
  if (!String(process.env.DATABASE_URL || '').trim()) {
    console.error('[db-migrate] DATABASE_URL is not set');
    process.exit(1);
  }

  try {
    console.log('[db-migrate] Running migrations...');
    await migrate();
    console.log('[db-migrate] Migrations completed');
  } catch (err) {
    console.error('[db-migrate] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
