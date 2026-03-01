require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false)
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

const SLOW_QUERY_MS = parseInt(process.env.SLOW_QUERY_MS || '250', 10);
const originalQuery = pool.query.bind(pool);
pool.query = async (...args) => {
  const started = Date.now();
  try {
    return await originalQuery(...args);
  } finally {
    const ms = Date.now() - started;
    if (ms >= SLOW_QUERY_MS) {
      const sql = typeof args[0] === 'string' ? args[0] : String(args[0] || '');
      const briefSql = sql.replace(/\s+/g, ' ').trim().slice(0, 220);
      console.warn(`[DB] Slow query (${ms}ms): ${briefSql}`);
    }
  }
};

module.exports = pool;
