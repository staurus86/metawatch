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

    // ALTER: monitored_urls Sprint 4 columns
    const muSprint4 = [
      "ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''"
    ];
    for (const sql of muSprint4) await client.query(sql);

    // ALTER: users digest column
    const userExtra = [
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_frequency VARCHAR(10) DEFAULT NULL",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_email VARCHAR(255) DEFAULT NULL"
    ];
    for (const sql of userExtra) await client.query(sql);

    // ─── uptime_monitors ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS uptime_monitors (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE SET NULL,
        name VARCHAR(255) NOT NULL,
        url TEXT NOT NULL,
        slug VARCHAR(32) UNIQUE NOT NULL,
        interval_minutes INTEGER NOT NULL DEFAULT 5,
        is_active BOOLEAN NOT NULL DEFAULT true,
        is_public BOOLEAN NOT NULL DEFAULT false,
        alert_email VARCHAR(255),
        telegram_token TEXT,
        telegram_chat_id TEXT,
        webhook_url TEXT,
        threshold_ms INTEGER NOT NULL DEFAULT 3000,
        silenced_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── uptime_checks ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS uptime_checks (
        id SERIAL PRIMARY KEY,
        monitor_id INT NOT NULL REFERENCES uptime_monitors(id) ON DELETE CASCADE,
        checked_at TIMESTAMPTZ DEFAULT NOW(),
        status VARCHAR(10) NOT NULL,
        response_time_ms INTEGER,
        status_code INTEGER,
        error_message TEXT,
        ssl_expires_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_uptime_checks_monitor_checked
        ON uptime_checks(monitor_id, checked_at DESC)
    `);

    // ─── uptime_incidents ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS uptime_incidents (
        id SERIAL PRIMARY KEY,
        monitor_id INT NOT NULL REFERENCES uptime_monitors(id) ON DELETE CASCADE,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        duration_seconds INT,
        cause VARCHAR(50),
        alert_sent BOOLEAN NOT NULL DEFAULT false
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_uptime_incidents_monitor
        ON uptime_incidents(monitor_id, started_at DESC)
    `);

    // ─── Sprint 5 additions ───────────────────────────────────────────────────
    // alerts: add severity + notified columns
    const alertExtra = [
      "ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity VARCHAR(10) NOT NULL DEFAULT 'info'",
      "ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notified BOOLEAN NOT NULL DEFAULT false"
    ];
    for (const sql of alertExtra) await client.query(sql);

    // snapshots: text_rules_json for multiple text rule results
    await client.query(
      "ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS text_rules_json TEXT"
    );

    // users: onboarding_completed
    await client.query(
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT false"
    );

    // uptime_incidents: postmortem_text
    await client.query(
      "ALTER TABLE uptime_incidents ADD COLUMN IF NOT EXISTS postmortem_text TEXT"
    );

    // ─── text_monitors ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS text_monitors (
        id SERIAL PRIMARY KEY,
        url_id INT NOT NULL REFERENCES monitored_urls(id) ON DELETE CASCADE,
        label VARCHAR(100) NOT NULL,
        text TEXT NOT NULL,
        match_type VARCHAR(20) NOT NULL DEFAULT 'contains',
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── notification_log ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_log (
        id SERIAL PRIMARY KEY,
        url_id INT REFERENCES monitored_urls(id) ON DELETE CASCADE,
        monitor_id INT REFERENCES uptime_monitors(id) ON DELETE CASCADE,
        channel VARCHAR(20) NOT NULL,
        field_changed VARCHAR(100),
        severity VARCHAR(10),
        status VARCHAR(10) NOT NULL DEFAULT 'sent',
        error_message TEXT,
        sent_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_notification_log_sent ON notification_log(sent_at DESC)`
    );

    // ─── webhook_delivery_log ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_delivery_log (
        id SERIAL PRIMARY KEY,
        url_id INT REFERENCES monitored_urls(id) ON DELETE CASCADE,
        monitor_id INT REFERENCES uptime_monitors(id) ON DELETE CASCADE,
        webhook_url TEXT NOT NULL,
        payload TEXT NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        last_attempt_at TIMESTAMPTZ,
        next_retry_at TIMESTAMPTZ DEFAULT NOW(),
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_webhook_retry ON webhook_delivery_log(next_retry_at) WHERE status = 'pending'`
    );

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

    // ─── Sprint 6 additions ───────────────────────────────────────────────────

    // Response time threshold on monitored_urls
    await client.query(
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS response_time_threshold_ms INTEGER'
    );

    // ─── digest_settings ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS digest_settings (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT false,
        frequency VARCHAR(10) NOT NULL DEFAULT 'daily',
        hour INT NOT NULL DEFAULT 8,
        day_of_week INT NOT NULL DEFAULT 1,
        alt_email VARCHAR(255),
        last_sent_at TIMESTAMPTZ,
        UNIQUE(user_id)
      )
    `);

    // ─── tag_definitions ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tag_definitions (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(50) NOT NULL,
        color VARCHAR(7) NOT NULL DEFAULT '#a0aec0',
        UNIQUE(user_id, name)
      )
    `);

    // ─── status_pages ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS status_pages (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        slug VARCHAR(32) UNIQUE NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT DEFAULT '',
        monitor_ids INTEGER[] NOT NULL DEFAULT '{}',
        is_public BOOLEAN NOT NULL DEFAULT true,
        custom_domain VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── uptime_subscribers ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS uptime_subscribers (
        id SERIAL PRIMARY KEY,
        status_page_id INT NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        token VARCHAR(64) UNIQUE NOT NULL,
        confirmed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(status_page_id, email)
      )
    `);

    // ─── competitor_urls ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS competitor_urls (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        your_url_id INT REFERENCES monitored_urls(id) ON DELETE SET NULL,
        competitor_url TEXT NOT NULL,
        name VARCHAR(255) NOT NULL,
        last_checked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── competitor_snapshots ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS competitor_snapshots (
        id SERIAL PRIMARY KEY,
        competitor_url_id INT NOT NULL REFERENCES competitor_urls(id) ON DELETE CASCADE,
        checked_at TIMESTAMPTZ DEFAULT NOW(),
        status_code INTEGER,
        title TEXT,
        description TEXT,
        h1 TEXT,
        canonical TEXT,
        noindex BOOLEAN,
        redirect_url TEXT,
        og_title TEXT,
        og_description TEXT,
        response_time_ms INTEGER
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_cid ON competitor_snapshots(competitor_url_id, checked_at DESC)`
    );

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
