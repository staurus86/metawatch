# MetaWatch

MetaWatch is a self-hosted monitoring platform for SEO/meta fields and uptime.

## Run locally

```bash
npm install
npm run dev
```

Environment variables are documented in `.env.example`.

## Production hardening flags

Key production flags (see `.env.example` for full list):

- `ENABLE_OUTBOUND_SAFETY=true` blocks private/internal outbound targets (SSRF guard).
- `ENABLE_ALERT_STATE_ENGINE=true` enables cooldown/state-based alert suppression.
- `DEFAULT_ALERT_COOLDOWN_MINUTES=60` controls duplicate alert cooldown.
- `SLOW_QUERY_MS=250` logs slow SQL queries.
- `WEBHOOK_SIGNING_SECRET=` adds `X-MetaWatch-Signature` HMAC header to outgoing webhooks.
- `ALERT_RETENTION_DAYS`, `NOTIFICATION_LOG_RETENTION_DAYS`, `WEBHOOK_LOG_RETENTION_DAYS` control data retention.

## Browser Extension

The Chrome extension lives in [`/extension`](./extension) and lets you quickly check if the current domain is monitored in MetaWatch uptime.

### Load unpacked extension (Chrome)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the local `extension` folder from this repository.

### Configure extension

1. Click the extension icon.
2. Click the gear icon to open settings.
3. Fill in:
   - **MetaWatch URL** (your deployed app URL)
   - **API Key**
4. Click **Save Settings**.
5. Optional: click **Test Connection** (checks `/api/health`).

### Where to get API key

Open your MetaWatch profile page:

- `/profile` in your MetaWatch app

Use the generated API key from **Profile & API Key** in extension settings.
