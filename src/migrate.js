const pool = require('./db');
const crypto = require('crypto');

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

    // ─── plans ───────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        max_urls INTEGER,
        max_uptime_monitors INTEGER,
        max_projects INTEGER,
        check_interval_min INTEGER NOT NULL DEFAULT 60,
        price_usd INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      INSERT INTO plans (name, max_urls, max_uptime_monitors, max_projects, check_interval_min, price_usd)
      VALUES
        ('Free', 10, 2, 1, 60, 0),
        ('Starter', 50, 10, 5, 15, 19),
        ('Pro', 200, 50, NULL, 5, 49),
        ('Agency', NULL, NULL, NULL, 1, 99)
      ON CONFLICT (name) DO UPDATE SET
        max_urls = EXCLUDED.max_urls,
        max_uptime_monitors = EXCLUDED.max_uptime_monitors,
        max_projects = EXCLUDED.max_projects,
        check_interval_min = EXCLUDED.check_interval_min,
        price_usd = EXCLUDED.price_usd
    `);

    // ─── subscriptions ───────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id INT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
        status VARCHAR(20) NOT NULL DEFAULT 'trial',
        trial_ends_at TIMESTAMPTZ,
        current_period_end TIMESTAMPTZ,
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status ON subscriptions(user_id, status, created_at DESC)'
    );

    // Backfill all users with Free plan if no active/trial subscription exists
    await client.query(`
      INSERT INTO subscriptions (user_id, plan_id, status, current_period_end)
      SELECT u.id, p.id, 'active', NOW() + INTERVAL '100 years'
      FROM users u
      JOIN plans p ON lower(p.name) = 'free'
      LEFT JOIN subscriptions s
        ON s.user_id = u.id
       AND s.status IN ('active', 'trial')
      WHERE s.id IS NULL
    `);

    // ─── projects ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
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

    // ─── onboarding email sequence log ──────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_sequence_log (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        step VARCHAR(64) NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, step)
      )
    `);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_email_sequence_user_sent ON email_sequence_log(user_id, sent_at DESC)'
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
    const statusPageCols = [
      'ALTER TABLE status_pages ADD COLUMN IF NOT EXISTS custom_domain VARCHAR(255)',
      'ALTER TABLE status_pages ADD COLUMN IF NOT EXISTS logo_url TEXT',
      "ALTER TABLE status_pages ADD COLUMN IF NOT EXISTS primary_color VARCHAR(7) NOT NULL DEFAULT '#4299e1'",
      'ALTER TABLE status_pages ADD COLUMN IF NOT EXISTS hide_powered_by BOOLEAN NOT NULL DEFAULT false'
    ];
    for (const sql of statusPageCols) await client.query(sql);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_status_pages_custom_domain ON status_pages(lower(custom_domain)) WHERE custom_domain IS NOT NULL'
    );

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

    // ─── Sprint 7 additions ───────────────────────────────────────────────────

    // projects: tenant ownership + lookup performance
    await client.query(
      'ALTER TABLE projects ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id) ON DELETE CASCADE'
    );
    await client.query(`
      UPDATE projects p
      SET user_id = src.user_id
      FROM (
        SELECT project_id, MIN(user_id) AS user_id
        FROM monitored_urls
        WHERE project_id IS NOT NULL AND user_id IS NOT NULL
        GROUP BY project_id
      ) src
      WHERE p.id = src.project_id AND p.user_id IS NULL
    `);
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_projects_user_created ON projects(user_id, created_at DESC)'
    );

    // monitored_urls: maintenance cron schedule
    const muSprint7 = [
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS maintenance_cron TEXT',
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS maintenance_duration_minutes INTEGER'
    ];
    for (const sql of muSprint7) await client.query(sql);

    // uptime_monitors: maintenance cron schedule
    const umSprint7 = [
      'ALTER TABLE uptime_monitors ADD COLUMN IF NOT EXISTS maintenance_cron TEXT',
      'ALTER TABLE uptime_monitors ADD COLUMN IF NOT EXISTS maintenance_duration_minutes INTEGER'
    ];
    for (const sql of umSprint7) await client.query(sql);

    // snapshots: js_rendered flag
    await client.query(
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS js_rendered BOOLEAN NOT NULL DEFAULT false'
    );

    // performance indexes (dashboard + latest snapshot/alerts queries)
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_snapshots_url_id_checked_at ON snapshots(url_id, checked_at DESC)'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_alerts_url_id_detected_at ON alerts(url_id, detected_at DESC)'
    );

    // users: notification defaults + display preferences
    const userSprint7 = [
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS default_alert_email VARCHAR(255)',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS default_telegram_token TEXT',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS default_telegram_chat_id TEXT',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS default_webhook_url TEXT',
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_dashboard_view VARCHAR(20) NOT NULL DEFAULT 'list'",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_timezone VARCHAR(64) NOT NULL DEFAULT 'UTC'",
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_rows_per_page INTEGER NOT NULL DEFAULT 25',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_hash VARCHAR(64)',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key_last4 VARCHAR(4)'
    ];
    for (const sql of userSprint7) await client.query(sql);

    // Backfill API key hash metadata for legacy rows
    const { rows: apiUsers } = await client.query(
      `SELECT id, api_key
       FROM users
       WHERE api_key IS NOT NULL
         AND (api_key_hash IS NULL OR api_key_last4 IS NULL)`
    );
    for (const u of apiUsers) {
      const apiKey = String(u.api_key || '');
      const apiHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const apiLast4 = apiKey.slice(-4);
      await client.query(
        'UPDATE users SET api_key_hash = $1, api_key_last4 = $2 WHERE id = $3',
        [apiHash, apiLast4 || null, u.id]
      );
    }

    // monitored_urls: alert cooldown (minutes)
    await client.query(
      'ALTER TABLE monitored_urls ADD COLUMN IF NOT EXISTS alert_cooldown_minutes INTEGER NOT NULL DEFAULT 60'
    );

    // snapshots: richer monitoring signals (backward compatible)
    const snapshotSignalCols = [
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS normalized_body_hash VARCHAR(64)',
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS soft_404 BOOLEAN NOT NULL DEFAULT false',
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS redirect_chain TEXT',
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS canonical_issue TEXT',
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS indexability_conflict BOOLEAN NOT NULL DEFAULT false',
      'ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS robots_blocked BOOLEAN NOT NULL DEFAULT false'
    ];
    for (const sql of snapshotSignalCols) await client.query(sql);

    // ─── alert_rules ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_rules (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        conditions JSONB NOT NULL DEFAULT '[]',
        actions JSONB NOT NULL DEFAULT '[]',
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_alert_rules_user ON alert_rules(user_id) WHERE is_active = true`
    );

    // ─── alert_state (noise suppression / cooldown / transition state) ───────
    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_state (
        id SERIAL PRIMARY KEY,
        url_id INT NOT NULL REFERENCES monitored_urls(id) ON DELETE CASCADE,
        field_key VARCHAR(120) NOT NULL,
        state_hash VARCHAR(64) NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_alert_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cooldown_until TIMESTAMPTZ,
        UNIQUE(url_id, field_key)
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_alert_state_url_field ON alert_state(url_id, field_key)`
    );

    // ─── audit_log (SaaS traceability) ───────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE SET NULL,
        action VARCHAR(120) NOT NULL,
        entity_type VARCHAR(60),
        entity_id VARCHAR(120),
        ip VARCHAR(128),
        user_agent VARCHAR(255),
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ─── scale indexes ────────────────────────────────────────────────────────
    const scaleIndexes = [
      'CREATE INDEX IF NOT EXISTS idx_monitored_urls_user_active_created ON monitored_urls(user_id, is_active, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_monitored_urls_user_project_created ON monitored_urls(user_id, project_id, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_uptime_monitors_user_active_created ON uptime_monitors(user_id, is_active, created_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_snapshots_checked_at ON snapshots(checked_at)',
      'CREATE INDEX IF NOT EXISTS idx_alerts_detected_at ON alerts(detected_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_alerts_url_field_new_detected ON alerts(url_id, field_changed, new_value, detected_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_notification_log_status_sent ON notification_log(status, sent_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log(user_id, created_at DESC)'
    ];
    for (const sql of scaleIndexes) await client.query(sql);

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
