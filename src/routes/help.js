const express = require('express');

const router = express.Router();

router.get('/help', (req, res) => {
  res.render('help', {
    layout: false,
    title: 'Help Center'
  });
});

module.exports = router;
