# Reports Reference

## Reports Center

- URL: `/reports`
- Purpose: one-page launcher for all exports with plan-aware enable/disable UI.

## Export Endpoints

### Portfolio

- `GET /export/report.pdf`
- `GET /export/report.xlsx`
- `GET /export/uptime-report.pdf`
- `GET /export/uptime-report.xlsx`
- `GET /export/alerts.csv`

### Per URL

- `GET /export/url/:id.pdf`
- `GET /export/url/:id.xlsx`

### Per Uptime Monitor

- `GET /export/uptime/:id.pdf`
- `GET /export/uptime/:id.xlsx`

### Per Project (meta monitoring)

- `GET /export/project/:id.pdf`
- `GET /export/project/:id.xlsx`

## Routing Helpers

Reports center short routes validate ownership then redirect:

- `/reports/url-pdf`, `/reports/url-xlsx`
- `/reports/uptime-pdf`, `/reports/uptime-xlsx`
- `/reports/project-pdf`, `/reports/project-xlsx`

## Date Range Controls

Common query params:

- `from=YYYY-MM-DD`
- `to=YYYY-MM-DD`

Access control:

- enforced by `src/report-access.js`
- returns HTTP `402` on plan/range violation.

## Scheduled PDF in Digests

- settings page: `/profile` -> Email Digest
- storage: `digest_settings.pdf_report_enabled`, `digest_settings.pdf_report_frequency`
- scheduler attaches PDF when allowed by plan and configured frequency.

