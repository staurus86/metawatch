const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const {
  getUserPlanData,
  getUserUsage,
  listPlans,
  limitLabel,
  usagePercent
} = require('../plans');

router.get('/', requireAuth, async (req, res) => {
  try {
    const { plan, subscription } = req.userPlan
      ? { plan: req.userPlan, subscription: req.userSubscription || null }
      : await getUserPlanData(req.user.id);

    const usage = await getUserUsage(req.user.id);
    const plans = await listPlans();

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

    res.render('billing', {
      title: 'Billing & Plan',
      plan,
      subscription,
      usageRows,
      plans,
      limitLabel,
      trialEndsAt: subscription?.status === 'trial' ? subscription.trial_ends_at : null,
      requestedUpgrade: req.query.upgrade || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Error', error: err.message });
  }
});

module.exports = router;
