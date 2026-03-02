# MetaWatch Plan Feature Matrix

Source of truth:

- limits: `plans` table + `src/plans.js`
- reports gating: `src/report-access.js`
- headless gating: `src/routes/urls.js`
- white-label status pages: `src/routes/status-pages.js`

## Core Limits

| Plan | URLs | Uptime monitors | Projects | Min check interval |
|---|---:|---:|---:|---:|
| Free | 10 | 2 | 1 | 60 min |
| Starter | 50 | 10 | 5 | 15 min |
| Pro | 200 | 50 | unlimited | 5 min |
| Agency | unlimited | unlimited | unlimited | 1 min |

## Report Entitlements

| Feature | Free | Starter | Pro | Agency |
|---|---|---|---|---|
| Dashboard PDF | yes | yes | yes | yes |
| Dashboard XLSX | no | yes | yes | yes |
| URL PDF | yes | yes | yes | yes |
| URL XLSX | no | yes | yes | yes |
| Uptime Portfolio PDF | yes | yes | yes | yes |
| Uptime Portfolio XLSX | no | yes | yes | yes |
| Uptime Monitor PDF | yes | yes | yes | yes |
| Uptime Monitor XLSX | no | yes | yes | yes |
| Project PDF | no | yes | yes | yes |
| Project XLSX | no | yes | yes | yes |
| Alerts CSV | yes | yes | yes | yes |
| Scheduled PDF digest | no | yes | yes | yes |

## Report Date Range Limits

| Plan | Max range |
|---|---|
| Free | 30 days |
| Starter | 90 days |
| Pro | 365 days |
| Agency | unlimited |

## Feature Gating Highlights

| Feature | Availability |
|---|---|
| Headless JS rendering (`render_mode=headless`) | Pro / Agency |
| White-label status page branding | Agency |
| Custom status page domain | Agency |
| Hide "Powered by MetaWatch" | Agency |
| Browser push critical alerts (opt-in) | All plans (requires VAPID config) |
