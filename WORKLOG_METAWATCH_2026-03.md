# MetaWatch — Worklog & Improvement Plan

Обновлено: 2026-03-02

## 1) Ключевые изменения, которые были внесены

### Коммит `d17c633` — Hardening reliability/security/performance

#### Scheduler / Reliability
- Добавлен лидер-лок scheduler через PostgreSQL advisory lock (защита от двойного запуска cron в multi-instance).
- Добавлена идемпотентность старта scheduler в процессе.
- Добавлен runtime dedup для URL/uptime checks.
- Добавлен fair startup scheduling (interleave по `user_id`) + jitter по приоритетам.
- Расширены retention-задачи: snapshots, uptime_checks, alerts, notification_log, webhook_delivery_log.
- Добавлен системный статус scheduler для health/admin.

Файлы:
- `src/scheduler.js`
- `src/queue.js`

#### Alert noise reduction / state transitions
- Добавлен `alert_state` движок: cooldown, duplicate suppression, state-based уведомления.
- Добавлены transition-алерты для HTTP-состояний (ошибка -> recovery).
- Добавлена фильтрация по maintenance window и suppression-логика в `notification_log`.

Файлы:
- `src/checker.js`
- `src/migrate.js`

#### Scraper robustness
- Добавлены сигналы: `normalized_body_hash`, `soft_404`, `redirect_chain`, `canonical_issue`, `indexability_conflict`, `robots_blocked`.
- Улучшена нормализация контента перед hash (динамические/шумные блоки).
- Добавлено определение JS-render warning.

Файлы:
- `src/scraper.js`
- `src/checker.js`
- `src/migrate.js`

#### Security
- Введён централизованный outbound safety слой (SSRF guard) для URL/webhook/sitemap/uptime.
- Усилен webhook transport (безопасная валидация target URL).
- API key auth расширена поддержкой hashed keys (`api_key_hash`) без ломки старых ключей.
- Добавлены аудит-логи действий пользователей/админа.
- В админке прекращён вывод сырого API key (маскирование).

Файлы:
- `src/net-safety.js` (новый)
- `src/notifier.js`
- `src/routes/urls.js`
- `src/routes/uptime.js`
- `src/uptime-checker.js`
- `src/auth.js`
- `src/routes/auth.js`
- `src/routes/profile.js`
- `src/routes/admin.js`
- `src/audit.js` (новый)
- `views/admin.ejs`

#### CSP / frontend stability
- Убраны inline scripts из шаблонов, логика вынесена в `public/app.js` и `public/theme-init.js`.
- Усилен CSP: убран `unsafe-inline` из `script-src`, добавлен `script-src-attr 'none'`.
- Закрыты UI-риски по bulk preview (select all/count в общем `app.js`).

Файлы:
- `src/index.js`
- `views/layout.ejs`
- `views/bulk-import.ejs`
- `public/app.js`
- `public/theme-init.js` (новый)

#### Export reliability
- Экспортные date-фильтры переведены на parameterized SQL (без string interpolation).
- Добавлена валидация диапазона дат (`from <= to`).

Файл:
- `src/routes/export.js`

#### Ops / Admin
- Добавлена страница системных метрик для администратора (`/admin/system`).

Файлы:
- `src/routes/admin.js`
- `views/admin-system.ejs` (новый)

---

### Коммит `08acfbc` — Next safe optimization pass

#### Performance
- `/api/stats` переписан на SQL-агрегации вместо перебора больших наборов в Node.
- Сохранён прежний контракт ответа endpoint.

Файл:
- `src/routes/api.js`

#### Deployment safety
- Добавлен флаг `ENABLE_SCHEDULER` для безопасного web/worker split и контролируемого запуска cron.

Файл:
- `src/index.js`

#### API rate limiting
- Вынесены лимиты в ENV:
  - `API_RATE_LIMIT_WINDOW_MS`
  - `API_RATE_LIMIT_MAX`
- Обновлена docs-страница `/api/docs` под динамические лимиты.

Файл:
- `src/routes/api.js`

#### Auth limiter hygiene
- Для login rate limiter добавлена периодическая очистка in-memory карты попыток (ограничение роста памяти).

Файл:
- `src/routes/auth.js`

#### Docs / env
- Обновлены `.env.example` и `README.md` новыми флагами и пояснениями.

Файлы:
- `.env.example`
- `README.md`

---

## 2) Проверки, которые выполнялись
- `node --check` по всем `*.js` в `src`, `public`, `extension`.
- Точечный `require(...)` ключевых модулей/роутов.
- Проверка чистоты рабочей ветки после push.

Ограничение:
- Полный runtime integration test с БД локально не выполнялся в sandbox (нет доступного локального PostgreSQL).

---

## 3) Список новых/критичных ENV флагов
- `ENABLE_SCHEDULER`
- `ENABLE_ALERT_STATE_ENGINE`
- `DEFAULT_ALERT_COOLDOWN_MINUTES`
- `ENABLE_OUTBOUND_SAFETY`
- `ALLOW_PRIVATE_TARGETS`
- `WEBHOOK_SIGNING_SECRET`
- `SLOW_QUERY_MS`
- `API_RATE_LIMIT_WINDOW_MS`
- `API_RATE_LIMIT_MAX`
- `ALERT_RETENTION_DAYS`
- `NOTIFICATION_LOG_RETENTION_DAYS`
- `WEBHOOK_LOG_RETENTION_DAYS`

---

## 4) План дальнейших улучшений (следующие итерации)

### Итерация A (быстрые wins, низкий риск)
1. Keyset pagination для dashboard (замена части `OFFSET`-путей).
2. Добавить индексы под top-heavy queries (после `EXPLAIN ANALYZE`).
3. Небольшой in-memory cache для тяжёлых admin/stats запросов (TTL 30-60s).
4. Стандартизировать health payload (db latency, queue depth, leader lock status).

### Итерация B (точность мониторинга)
1. Расширить нормализацию контента (больше динамических паттернов).
2. Улучшить robots blocking анализ (более точный parser правил allow/disallow).
3. Добавить отдельную классификацию “meaningful change vs cosmetic change”.
4. Расширить soft-404 эвристику + метки confidence.

### Итерация C (масштаб и эксплуатация)
1. Подготовить Redis queue backend (feature-flagged, fallback на in-memory).
2. Добавить slow-query отчёт в admin/system.
3. Добавить аудит системных событий scheduler/retry/retention.
4. Подготовить SLO-панель: check latency, alert delivery rate, retry backlog.

---

## 5) Safe rollout checklist на следующие релизы
- Все изменения только backward-compatible (API и БД).
- Новая логика сначала за feature flags.
- Canary deploy + мониторинг `/api/health` и ошибок уведомлений.
- Проверка критических флоу: auth, dashboard, bulk import, exports, extension, uptime.
- Явный rollback: отключение флагов + откат deploy.

