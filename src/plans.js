const pool = require('./db');

const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;
const planCache = new Map();

const FREE_FALLBACK = {
  id: null,
  name: 'Free',
  max_urls: 10,
  max_uptime_monitors: 2,
  max_projects: 1,
  check_interval_min: 60,
  price_usd: 0
};

function parseLimit(value) {
  if (value === null || value === undefined) return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function normalizePlanRow(row) {
  if (!row) return { ...FREE_FALLBACK };
  return {
    id: row.id ?? null,
    name: row.name || 'Free',
    max_urls: parseLimit(row.max_urls),
    max_uptime_monitors: parseLimit(row.max_uptime_monitors),
    max_projects: parseLimit(row.max_projects),
    check_interval_min: parseInt(row.check_interval_min || FREE_FALLBACK.check_interval_min, 10),
    price_usd: parseInt(row.price_usd || 0, 10)
  };
}

function isUnlimited(limit) {
  return limit == null || Number(limit) < 0;
}

function isLimitReached(currentCount, limit) {
  if (isUnlimited(limit)) return false;
  return Number(currentCount || 0) >= Number(limit);
}

function limitLabel(limit) {
  return isUnlimited(limit) ? 'unlimited' : String(limit);
}

function usagePercent(currentCount, limit) {
  if (isUnlimited(limit)) return null;
  if (Number(limit) <= 0) return 100;
  return Math.min(100, Math.round((Number(currentCount || 0) / Number(limit)) * 100));
}

async function listPlans() {
  const { rows } = await pool.query(
    'SELECT * FROM plans ORDER BY price_usd ASC, id ASC'
  );
  return rows.map(normalizePlanRow);
}

async function getFreePlan() {
  const { rows: [row] } = await pool.query(
    "SELECT * FROM plans WHERE lower(name) = 'free' LIMIT 1"
  );
  return normalizePlanRow(row || FREE_FALLBACK);
}

async function getUserPlanData(userId, { forceRefresh = false } = {}) {
  if (!userId) {
    return { plan: { ...FREE_FALLBACK }, subscription: null };
  }

  const cached = planCache.get(userId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const { rows: [subRow] } = await pool.query(
    `SELECT
       s.id AS subscription_id,
       s.user_id,
       s.plan_id,
       s.status,
       s.trial_ends_at,
       s.current_period_end,
       s.stripe_customer_id,
       s.stripe_subscription_id,
       p.*
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = $1
       AND s.status IN ('active', 'trial')
     ORDER BY
       CASE WHEN s.status = 'active' THEN 0 ELSE 1 END,
       COALESCE(s.current_period_end, s.trial_ends_at, s.created_at) DESC
     LIMIT 1`,
    [userId]
  );

  const plan = subRow ? normalizePlanRow(subRow) : await getFreePlan();
  const subscription = subRow
    ? {
        id: subRow.subscription_id,
        user_id: subRow.user_id,
        plan_id: subRow.plan_id,
        status: subRow.status,
        trial_ends_at: subRow.trial_ends_at,
        current_period_end: subRow.current_period_end,
        stripe_customer_id: subRow.stripe_customer_id,
        stripe_subscription_id: subRow.stripe_subscription_id
      }
    : null;

  const value = { plan, subscription };
  planCache.set(userId, { value, expiresAt: Date.now() + PLAN_CACHE_TTL_MS });
  return value;
}

function clearPlanCache(userId) {
  if (userId) planCache.delete(userId);
}

async function getUserUsage(userId) {
  const { rows: [row] } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM monitored_urls WHERE user_id = $1) AS urls_count,
       (SELECT COUNT(*)::int FROM uptime_monitors WHERE user_id = $1) AS monitors_count,
       (SELECT COUNT(*)::int FROM projects WHERE user_id = $1) AS projects_count`,
    [userId]
  );
  return {
    urls: row?.urls_count || 0,
    uptimeMonitors: row?.monitors_count || 0,
    projects: row?.projects_count || 0
  };
}

function minIntervalForPlan(plan) {
  const n = parseInt(plan?.check_interval_min || FREE_FALLBACK.check_interval_min, 10);
  return Number.isFinite(n) && n > 0 ? n : FREE_FALLBACK.check_interval_min;
}

function isIntervalAllowed(plan, intervalMinutes) {
  return Number(intervalMinutes || 0) >= minIntervalForPlan(plan);
}

async function loadUserPlanMiddleware(req, res, next) {
  res.locals.userPlan = null;
  res.locals.userSubscription = null;

  if (!req.user?.id) return next();

  try {
    const { plan, subscription } = await getUserPlanData(req.user.id);
    req.userPlan = plan;
    req.userSubscription = subscription;
    res.locals.userPlan = plan;
    res.locals.userSubscription = subscription;
  } catch (err) {
    console.error('[Plans] Failed to resolve user plan:', err.message);
    req.userPlan = { ...FREE_FALLBACK };
    req.userSubscription = null;
    res.locals.userPlan = req.userPlan;
    res.locals.userSubscription = null;
  }

  next();
}

module.exports = {
  getUserPlanData,
  getUserUsage,
  listPlans,
  isUnlimited,
  isLimitReached,
  isIntervalAllowed,
  minIntervalForPlan,
  limitLabel,
  usagePercent,
  clearPlanCache,
  loadUserPlanMiddleware
};
