require('dotenv').config();
const express = require('express');
const ejsLayouts = require('express-ejs-layouts');
const cookieParser = require('cookie-parser');
const path = require('path');
const migrate = require('./migrate');
const { startScheduler } = require('./scheduler');
const { loadUserMiddleware } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(ejsLayouts);
app.set('layout', 'layout');

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Load current user into req.user + res.locals.user for all routes
app.use(loadUserMiddleware);

// Routes — auth (no auth required)
app.use('/', require('./routes/auth'));

// Routes — protected
app.use('/', require('./routes/dashboard'));
app.use('/urls', require('./routes/urls'));
app.use('/export', require('./routes/export'));
app.use('/admin', require('./routes/admin'));
app.use('/profile', require('./routes/profile'));
app.use('/api', require('./routes/api'));

// 404
app.use((req, res) => {
  res.status(404).render('error', { title: 'Not Found', error: 'Page not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('error', { title: 'Error', error: err.message });
});

async function start() {
  try {
    await migrate();
    await startScheduler();
    app.listen(PORT, () => {
      console.log(`✓ MetaWatch v2 running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

start();
