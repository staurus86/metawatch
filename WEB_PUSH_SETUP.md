# Web Push Setup

## 1. Generate VAPID keys

Run once locally:

```bash
npx web-push generate-vapid-keys
```

Copy generated keys into environment:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `WEB_PUSH_SUBJECT` (recommended: `mailto:alerts@your-domain.com`)

## 2. Configure Railway

Set variables on the web service:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `WEB_PUSH_SUBJECT`

If async notifications are enabled:

- make sure worker has the same keys too.

## 3. Enable in UI

1. Open `/profile`
2. In `Browser Push Alerts` click `Enable in this browser`
3. Allow notification permission
4. Optionally click `Send test push`

## 4. Runtime behavior

- Meta monitoring: critical changes trigger push.
- Uptime monitoring: DOWN events trigger push.
- Invalid push endpoints (HTTP 404/410) are removed automatically.

