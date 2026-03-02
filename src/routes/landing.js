const express = require('express');
const router = express.Router();
const { listPlans } = require('../plans');

// GET / — public landing for logged-out users
router.get('/', async (req, res, next) => {
  try {
    if (req.user) {
      const suffix = (req.originalUrl || '/').startsWith('/')
        ? (req.originalUrl || '/').slice(1)
        : (req.originalUrl || '/');
      return res.redirect(`/dashboard${suffix}`);
    }

    const plans = await listPlans().catch(() => []);
    res.render('landing', {
      layout: false,
      title: 'MetaWatch',
      plans
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
