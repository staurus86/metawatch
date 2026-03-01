const pool = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ─── users ───────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'viewer',
        api_key VARCHAR(64) UNIQUE,
        invited_by_id INT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── invites ─────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS invites (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        token VARCHAR(64) UNIQUE NOT NULL,
        invited_by_id INT REFERENCES users(id) ON DELETE SET NULL,
        used BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── projects ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── monitored_urls ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitored_urls (
        id SERIAL PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
        url TEXT NOT NULL,
        email VARCHAR(255),
        check_interval_minutes INTEGER NOT NULL DEFAULT 60,
        is_active BOOLEAN NOT NULL DEFAULT true,
        monitor_title BOOLEAN NOT NULL DEFAULT true,
        monitor_description BOOLEAN NOT NULL DEFAULT true,
        monitor_h1 BOOLEAN NOT NULL DEFAULT true,
        monitor_body BOOLEAN NOT NULL DEFAULT true,
        monitor_status_code BOOLEAN NOT NULL DEFAULT true,
        monitor_noindex BOOLEAN NOT NULL DEFAULT true,
        monitor_redirect BOOLEAN NOT NULL DEFAULT true,
        monitor_canonical BOOLEAN NOT NULL DEFAULT true,
        monitor_robots BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── snapshots ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id SERIAL PRIMARY KEY,
        url_id INTEGER NOT NULL REFERENCES monitored_urls(id) ON DELETE CASCADE,
        checked_at TIMESTAMPTZ DEFAULT NOW(),
        title TEXT,
        description TEXT,
        h1 TEXT,
        body_text_hash VARCHAR(64),
        status_code INTEGER,
        noindex BOOLEAN,
        redirect_url TEXT,
        canonical TEXT,
        robots_txt_hash VARCHAR(64),
        raw_robots_txt TEXT
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_snapshots_url_checked
        ON snapshots(url_id, checked_at DESC)
    `);

    // ─── alerts ───────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id SERIAL PRIMARY KEY,
        url_id INTEGER NOT NULL REFERENCES monitored_urls(id) ON DELETE CASCADE,
        field_changed VARCHAR(100) NOT NULL,
        old_value TEXT,
        new_value TEXT,
        detected_at TIMESTAMPTZ DEFAULT NOW(),
        email_sent BOOLEAN NOT NULL DEFAULT false
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_alerts_url_detected
        ON alerts(url_id, detected_at DESC)
    `);

    // ─── ALTER: monitored_urls new columns ────────────────────────────────────
    const muCols = [
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE SET NULL',
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS user_agent TEXT',
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS ignore_numbers BOOLEAN NOT NULL DEFAULT false',
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS custom_text TEXT',
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS monitor_hreflang BOOLEAN NOT NULL DEFAULT false',
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS monitor_og BOOLEAN NOT NULL DEFAULT false',
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT',
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT',
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS webhook_url TEXT',
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS reference_snapshot_id INT REFERENCES snapshots(id) ON DELETE SET NULL'
    ];
    for (const sql of muCols) await client.query(sql);

    // ─── ALTER: snapshots new columns ────────────────────────────────────────
    const snapCols = [
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS hreflang TEXT',
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS og_title TEXT',
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS og_description TEXT',
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS og_image TEXT',
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS custom_text_found BOOLEAN',
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS response_time_ms INTEGER',
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS ssl_expires_at TIMESTAMPTZ'
    ];
    for (const sql of snapCols) await client.query(sql);

    // ALTER: monitored_urls maintenance + SSL + tags columns
    const muExtra = [
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS silenced_until TIMESTAMPTZ',
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS monitor_ssl BOOLEAN NOT NULL DEFAULT false',
      "ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT ''"
    ];
    for (const sql of muExtra) await client.query(sql);

    // ALTER: users digest column
    const userExtra = [
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_frequency VARCHAR(10) DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_email VARCHAR(255) DEFAULT NULL"
    ];
    for (const sql of userExtra) await client.query(sql);

    // ─── users self-ref FK (invited_by_id) ────────────────────────────────────
    // Add FK only if it doesn't already exist
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'users_invited_by_id_fkey'
          AND table_name = 'users'
        ) THEN
          ALTER TABLE users
            ADD CONSTRAINT users_invited_by_id_fkey
            FOREIGN KEY (invited_by_id) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
      END$$
    `);

    await client.query('COMMIT');
    console.log('✓ Database migrations completed');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = migrate;
