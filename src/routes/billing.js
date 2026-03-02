const express = require('express');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../auth');
const {
  getUserPlanData,
  getUserUsage,
  listPlans,
  limitLabel,
  usagePercent,
  clearPlanCache
} = require('../plans');
const { sendEmail } = require('../mailer');

const PLAN_PRICE_ENV = {
  starter: 'STRIPE_PRICE_ID_STARTER',
  pro: 'STRIPE_PRICE_ID_PRO',
  agency: 'STRIPE_PRICE_ID_AGENCY'
};

const CANONICAL_PLAN_NAME = {
  starter: 'Starter',
  pro: 'Pro',
  agency: 'Agency'
};

let stripeLoadAttempted = false;
let stripeClient = null;

function getStripeClient() {
  if (stripeLoadAttempted) return stripeClient;
  stripeLoadAttempted = true;

  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secretKey) return null;

  try {
    const Stripe = require('stripe');
    stripeClient = new Stripe(secretKey);
  } catch (err) {
    console.error('[Billing] Stripe SDK not available:', err.message);
    stripeClient = null;
  }

  return stripeClient;
}

function normalizePlanKey(name) {
  return String(name || '').trim().toLowerCase();
}

function getPriceIdForPlan(planName) {
  const key = normalizePlanKey(planName);
  const envVar = PLAN_PRICE_ENV[key];
  if (!envVar) return null;
  const value = String(process.env[envVar] || '').trim();
  return value || null;
}

function normalizeSubscriptionStatus(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'active') return 'active';
  if (key === 'trialing') return 'trial';
  if (key === 'canceled') return 'cancelled';
  if (key === 'past_due' || key === 'incomplete' || key === 'incomplete_expired' || key === 'unpaid') {
    return 'expired';
  }
  return 'active';
}

function parsePositiveInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function getBaseUrl(req) {
  const configured = String(process.env.BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  const host = req.get('host') || 'localhost:3000';
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}

async function getPlanByName(planName) {
  const key = normalizePlanKey(planName);
  if (!key) return null;
  const { rows: [plan] } = await pool.query(
    'SELECT * FROM plans WHERE lower(name) = $1 LIMIT 1',
    [key]
  );
  return plan || null;
}

async function getPlanIdByName(planName) {
  const row = await getPlanByName(planName);
  return row?.id || null;
}

async function getFreePlan() {
  const { rows: [plan] } = await pool.query(
    "SELECT * FROM plans WHERE lower(name) = 'free' LIMIT 1"
  );
  return plan || null;
}

async function resolvePlanIdFromPriceId(priceId) {
  const target = String(priceId || '').trim();
  if (!target) return null;

  for (const [key, envName] of Object.entries(PLAN_PRICE_ENV)) {
    const envValue = String(process.env[envName] || '').trim();
    if (!envValue || envValue !== target) continue;
    const planName = CANONICAL_PLAN_NAME[key];
    return getPlanIdByName(planName);
  }
  return null;
}

async function getLastStripeCustomerIdForUser(userId) {
  const { rows: [row] } = await pool.query(
    `SELECT stripe_customer_id
     FROM subscriptions
     WHERE user_id = $1
       AND stripe_customer_id IS NOT NULL
       AND stripe_customer_id != ''
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [userId]
  );
  return row?.stripe_customer_id || null;
}

async function findUserByEmail(email) {
  const safeEmail = String(email || '').trim().toLowerCase();
  if (!safeEmail) return null;
  const { rows: [row] } = await pool.query(
    'SELECT id, email FROM users WHERE lower(email) = $1 LIMIT 1',
    [safeEmail]
  );
  return row || null;
}

async function findUserIdByStripeCustomer(stripeCustomerId) {
  const id = String(stripeCustomerId || '').trim();
  if (!id) return null;
  const { rows: [row] } = await pool.query(
    `SELECT user_id
     FROM subscriptions
     WHERE stripe_customer_id = $1
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [id]
  );
  return row?.user_id || null;
}

async function findUserIdByStripeSubscription(stripeSubscriptionId) {
  const id = String(stripeSubscriptionId || '').trim();
  if (!id) return null;
  const { rows: [row] } = await pool.query(
    `SELECT user_id
     FROM subscriptions
     WHERE stripe_subscription_id = $1
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [id]
  );
  return row?.user_id || null;
}

async function resolveUserId({ metadataUserId, stripeCustomerId, stripeSubscriptionId, customerEmail }) {
  const fromMetadata = parsePositiveInt(metadataUserId);
  if (fromMetadata) return fromMetadata;

  const fromSubscription = await findUserIdByStripeSubscription(stripeSubscriptionId);
  if (fromSubscription) return fromSubscription;

  const fromCustomer = await findUserIdByStripeCustomer(stripeCustomerId);
  if (fromCustomer) return fromCustomer;

  const userByEmail = await findUserByEmail(customerEmail);
  return userByEmail?.id || null;
}

async function setPrimarySubscription({
  userId,
  planId,
  status,
  trialEndsAt,
  currentPeriodEnd,
  stripeCustomerId,
  stripeSubscriptionId
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const normalizedStatus = ['active', 'trial', 'expired', 'cancelled'].includes(status)
      ? status
      : 'active';
    const safeCustomer = stripeCustomerId ? String(stripeCustomerId) : null;
    const safeSub = stripeSubscriptionId ? String(stripeSubscriptionId) : null;

    let existingId = null;
    if (safeSub) {
      const { rows: [existing] } = await client.query(
        'SELECT id FROM subscriptions WHERE stripe_subscription_id = $1 LIMIT 1',
        [safeSub]
      );
      existingId = existing?.id || null;
    }

    let targetId = existingId;
    if (existingId) {
      const { rows: [updated] } = await client.query(
        `UPDATE subscriptions
         SET user_id = $1,
             plan_id = $2,
             status = $3,
             trial_ends_at = $4,
             current_period_end = $5,
             stripe_customer_id = $6,
             stripe_subscription_id = $7,
             updated_at = NOW()
         WHERE id = $8
         RETURNING id`,
        [userId, planId, normalizedStatus, trialEndsAt || null, currentPeriodEnd || null, safeCustomer, safeSub, existingId]
      );
      targetId = updated?.id || existingId;
    } else {
      const { rows: [inserted] } = await client.query(
        `INSERT INTO subscriptions
           (user_id, plan_id, status, trial_ends_at, current_period_end, stripe_customer_id, stripe_subscription_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
         RETURNING id`,
        [userId, planId, normalizedStatus, trialEndsAt || null, currentPeriodEnd || null, safeCustomer, safeSub]
      );
      targetId = inserted?.id || null;
    }

    if (targetId) {
      await client.query(
        `UPDATE subscriptions
         SET status = 'cancelled',
             updated_at = NOW()
         WHERE user_id = $1
           AND status IN ('active', 'trial')
           AND id <> $2`,
        [userId, targetId]
      );
    }

    await client.query('COMMIT');
    clearPlanCache(userId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function downgradeUserToFree(userId, stripeCustomerId = null) {
  if (!userId) return;
  const freePlan = await getFreePlan();
  if (!freePlan) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE subscriptions
       SET status = 'cancelled',
           updated_at = NOW()
       WHERE user_id = $1
         AND status IN ('active', 'trial')`,
      [userId]
    );

    await client.query(
      `INSERT INTO subscriptions
         (user_id, plan_id, status, current_period_end, stripe_customer_id, created_at, updated_at)
       VALUES ($1, $2, 'active', NOW() + INTERVAL '100 years', $3, NOW(), NOW())`,
      [userId, freePlan.id, stripeCustomerId ? String(stripeCustomerId) : null]
    );

    await client.query('COMMIT');
    clearPlanCache(userId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function expireUserSubscriptions(userId, { stripeCustomerId = null, stripeSubscriptionId = null } = {}) {
  if (!userId) return;

  const clauses = ['user_id = $1', "status IN ('active', 'trial')"];
  const params = [userId];

  if (stripeSubscriptionId) {
    params.push(String(stripeSubscriptionId));
    clauses.push(`stripe_subscription_id = $${params.length}`);
  } else if (stripeCustomerId) {
    params.push(String(stripeCustomerId));
    clauses.push(`stripe_customer_id = $${params.length}`);
  }

  await pool.query(
    `UPDATE subscriptions
     SET status = 'expired',
         updated_at = NOW()
     WHERE ${clauses.join(' AND ')}`,
    params
  );
  clearPlanCache(userId);
}

async function handleCheckoutSessionCompleted(stripe, session) {
  if (!session || session.mode !== 'subscription') return;

  const userId = await resolveUserId({
    metadataUserId: session.metadata?.user_id,
    stripeCustomerId: session.customer,
    stripeSubscriptionId: session.subscription,
    customerEmail: session.customer_email
  });
  if (!userId) {
    console.warn('[Billing] checkout.session.completed: user not found');
    return;
  }

  let planId = parsePositiveInt(session.metadata?.plan_id);
  if (!planId && session.metadata?.plan_name) {
    planId = await getPlanIdByName(session.metadata.plan_name);
  }

  let status = 'active';
  let currentPeriodEnd = null;
  let trialEndsAt = null;
  const stripeSubscriptionId = session.subscription ? String(session.subscription) : null;
  const stripeCustomerId = session.customer ? String(session.customer) : null;

  if (stripeSubscriptionId && stripe?.subscriptions?.retrieve) {
    const stripeSub = await stripe.subscriptions.retrieve(stripeSubscriptionId).catch(() => null);
    if (stripeSub) {
      status = normalizeSubscriptionStatus(stripeSub.status);
      if (stripeSub.current_period_end) {
        currentPeriodEnd = new Date(stripeSub.current_period_end * 1000);
      }
      if (stripeSub.trial_end) {
        trialEndsAt = new Date(stripeSub.trial_end * 1000);
      }
      if (!planId) {
        const priceId = stripeSub.items?.data?.[0]?.price?.id || null;
        planId = await resolvePlanIdFromPriceId(priceId);
      }
    }
  }

  if (!planId) {
    console.warn('[Billing] checkout.session.completed: plan not resolved');
    return;
  }

  await setPrimarySubscription({
    userId,
    planId,
    status,
    trialEndsAt,
    currentPeriodEnd,
    stripeCustomerId,
    stripeSubscriptionId
  });
}

async function handleCustomerSubscriptionUpdated(subscription) {
  if (!subscription) return;
  const stripeSubscriptionId = subscription.id ? String(subscription.id) : null;
  const stripeCustomerId = subscription.customer ? String(subscription.customer) : null;

  const userId = await resolveUserId({
    metadataUserId: subscription.metadata?.user_id,
    stripeCustomerId,
    stripeSubscriptionId,
    customerEmail: null
  });
  if (!userId) {
    console.warn('[Billing] customer.subscription.updated: user not found');
    return;
  }

  const priceId = subscription.items?.data?.[0]?.price?.id || null;
  const planId = await resolvePlanIdFromPriceId(priceId);
  if (!planId) {
    console.warn('[Billing] customer.subscription.updated: plan not resolved');
    return;
  }

  const status = normalizeSubscriptionStatus(subscription.status);
  const currentPeriodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000)
    : null;
  const trialEndsAt = subscription.trial_end
    ? new Date(subscription.trial_end * 1000)
    : null;

  await setPrimarySubscription({
    userId,
    planId,
    status,
    trialEndsAt,
    currentPeriodEnd,
    stripeCustomerId,
    stripeSubscriptionId
  });
}

async function handleCustomerSubscriptionDeleted(subscription) {
  if (!subscription) return;
  const stripeSubscriptionId = subscription.id ? String(subscription.id) : null;
  const stripeCustomerId = subscription.customer ? String(subscription.customer) : null;

  const userId = await resolveUserId({
    metadataUserId: subscription.metadata?.user_id,
    stripeCustomerId,
    stripeSubscriptionId,
    customerEmail: null
  });
  if (!userId) {
    console.warn('[Billing] customer.subscription.deleted: user not found');
    return;
  }

  await downgradeUserToFree(userId, stripeCustomerId);
}

async function handleInvoicePaymentFailed(invoice) {
  if (!invoice) return;
  const stripeCustomerId = invoice.customer ? String(invoice.customer) : null;
  const stripeSubscriptionId = invoice.subscription ? String(invoice.subscription) : null;
  const customerEmail = invoice.customer_email ? String(invoice.customer_email).trim() : '';

  const userId = await resolveUserId({
    metadataUserId: null,
    stripeCustomerId,
    stripeSubscriptionId,
    customerEmail
  });

  if (userId) {
    await expireUserSubscriptions(userId, { stripeCustomerId, stripeSubscriptionId });
  }

  let recipient = customerEmail;
  if (!recipient && userId) {
    const { rows: [user] } = await pool.query('SELECT email FROM users WHERE id = $1 LIMIT 1', [userId]);
    recipient = user?.email || '';
  }

  if (!recipient) return;

  const billingUrl = `${String(process.env.BASE_URL || '').replace(/\/+$/, '') || 'https://example.com'}/billing`;
  await sendEmail({
    to: recipient,
    subject: 'Payment failed - update your card',
    html: `
      <p>Your recent MetaWatch subscription payment failed.</p>
      <p>Please update your card to keep paid plan limits active.</p>
      <p><a href="${billingUrl}">Open billing</a></p>
    `,
    text: `Payment failed. Update your card in billing: ${billingUrl}`
  });
}

function billingMessageFromCode(code) {
  const key = String(code || '').trim().toLowerCase();
  const map = {
    missing_plan: 'Select a paid plan first.',
    invalid_plan: 'Selected plan is invalid.',
    free_plan_no_checkout: 'Free plan does not require checkout.',
    stripe_unavailable: 'Stripe is not configured yet.',
    price_missing: 'Stripe price ID is missing for this plan.',
    checkout_failed: 'Could not start checkout session.'
  };
  return map[key] || null;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const { plan, subscription } = req.userPlan
      ? { plan: req.userPlan, subscription: req.userSubscription || null }
      : await getUserPlanData(req.user.id);

    const usage = await getUserUsage(req.user.id);
    const plans = await listPlans();
    const stripe = getStripeClient();

    const usageRows = [
      {
        label: 'Meta URLs',
        used: usage.urls,
        limit: plan.max_urls,
        percent: usagePercent(usage.urls, plan.max_urls)
      },
      {
        label: 'Uptime monitors',
        used: usage.uptimeMonitors,
        limit: plan.max_uptime_monitors,
        percent: usagePercent(usage.uptimeMonitors, plan.max_uptime_monitors)
      },
      {
        label: 'Projects',
        used: usage.projects,
        limit: plan.max_projects,
        percent: usagePercent(usage.projects, plan.max_projects)
      }
    ];

    const checkoutEnabledByPlan = {};
    for (const p of plans) {
      checkoutEnabledByPlan[p.name] = !!(stripe && Number(p.price_usd || 0) > 0 && getPriceIdForPlan(p.name));
    }

    const billingError = billingMessageFromCode(req.query.error);
    const billingMessage = req.query.msg ? String(req.query.msg) : null;

    res.render('billing', {
      title: 'Billing & Plan',
      plan,
      subscription,
      usageRows,
      plans,
      limitLabel,
      trialEndsAt: subscription?.status === 'trial' ? subscription.trial_ends_at : null,
      requestedUpgrade: req.query.upgrade || null,
      stripeEnabled: !!stripe,
      checkoutEnabledByPlan,
      billingError,
      billingMessage
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

router.post('/checkout', requireAuth, async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) {
    return res.redirect('/billing?error=stripe_unavailable');
  }

  try {
    const requestedPlan = String(req.body.plan || req.body.plan_name || req.query.plan || '').trim();
    if (!requestedPlan) {
      return res.redirect('/billing?error=missing_plan');
    }

    const plan = await getPlanByName(requestedPlan);
    if (!plan) return res.redirect('/billing?error=invalid_plan');
    if (Number(plan.price_usd || 0) <= 0) {
      return res.redirect('/billing?error=free_plan_no_checkout');
    }

    const priceId = getPriceIdForPlan(plan.name);
    if (!priceId) return res.redirect('/billing?error=price_missing');

    let customerId = req.userSubscription?.stripe_customer_id || null;
    if (!customerId) {
      customerId = await getLastStripeCustomerIdForUser(req.user.id);
    }

    if (!customerId) {
      const createdCustomer = await stripe.customers.create({
        email: req.user.email,
        metadata: { user_id: String(req.user.id) }
      });
      customerId = createdCustomer.id;
    }

    const baseUrl = getBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/billing/cancel?plan=${encodeURIComponent(plan.name)}`,
      metadata: {
        user_id: String(req.user.id),
        plan_id: String(plan.id),
        plan_name: plan.name
      }
    });

    if (!session?.url) {
      return res.redirect('/billing?error=checkout_failed');
    }
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('[Billing] Checkout failed:', err.message);
    return res.redirect('/billing?error=checkout_failed');
  }
});

router.get('/success', requireAuth, async (req, res) => {
  const stripe = getStripeClient();
  const sessionId = String(req.query.session_id || '').trim();
  let sessionInfo = null;

  if (stripe && sessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const ownerId = parsePositiveInt(session?.metadata?.user_id);
      if (!ownerId || ownerId === req.user.id) {
        sessionInfo = {
          id: session.id,
          status: session.status || null,
          paymentStatus: session.payment_status || null,
          planName: session.metadata?.plan_name || null
        };
      }
    } catch (err) {
      console.warn('[Billing] success session lookup failed:', err.message);
    }
  }

  res.render('billing-success', {
    title: 'Payment Successful',
    sessionInfo
  });
});

router.get('/cancel', requireAuth, async (req, res) => {
  res.render('billing-cancel', {
    title: 'Checkout Cancelled',
    cancelledPlan: req.query.plan ? String(req.query.plan) : null
  });
});

router.post('/webhook', async (req, res) => {
  const stripe = getStripeClient();
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

  let event = null;
  const signature = req.headers['stripe-signature'];
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();

  try {
    if (webhookSecret && signature && req.rawBody) {
      event = stripe.webhooks.constructEvent(req.rawBody, signature, webhookSecret);
    } else if (req.body && req.body.type) {
      event = req.body;
      if (webhookSecret) {
        console.warn('[Billing] Webhook signature not verified (missing raw body/signature)');
      }
    } else {
      throw new Error('Invalid webhook payload');
    }
  } catch (err) {
    console.error('[Billing] Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutSessionCompleted(stripe, event.data?.object);
    } else if (event.type === 'customer.subscription.updated') {
      await handleCustomerSubscriptionUpdated(event.data?.object);
    } else if (event.type === 'customer.subscription.deleted') {
      await handleCustomerSubscriptionDeleted(event.data?.object);
    } else if (event.type === 'invoice.payment_failed') {
      await handleInvoicePaymentFailed(event.data?.object);
    }
  } catch (err) {
    console.error('[Billing] Webhook processing error:', err.message);
    return res.status(500).json({ received: false, error: 'processing_error' });
  }

  return res.json({ received: true });
});

module.exports = router;
