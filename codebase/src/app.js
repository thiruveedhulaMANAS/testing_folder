const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { query } = require('./config/db');
const { errorHandler } = require('./middleware/error');
const { pageImpressionLogger } = require('./middleware/pageImpression');
const { optionalAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const catalogRoutes = require('./routes/catalog');
const cartRoutes = require('./routes/cart');
const orderRoutes = require('./routes/orders');
const checkoutRoutes = require('./routes/checkout');
const trackRoutes = require('./routes/track');
const adminRoutes = require('./routes/admin');

function createApp() {
  const app = express();

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(express.json({ limit: '32kb' }));
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 400,
      standardHeaders: true,
      legacyHeaders: false
    })
  );

  app.get('/api/health', async (_req, res, next) => {
    try {
      await query('SELECT 1');
      res.json({ status: 'ok', database: 'up' });
    } catch (err) {
      next(err);
    }
  });

  // Resolve req.user (when a valid bearer token is present) before the page
  // impression logger runs, so PAGE_VIEW events are attributed to logged-in
  // users even on routes that don't otherwise require auth.
  app.use(optionalAuth);
  app.use(pageImpressionLogger);

  app.use('/api/auth', authRoutes);
  app.use('/api', catalogRoutes);
  app.use('/api/cart', cartRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/checkout', checkoutRoutes);
  app.use('/api/track', trackRoutes);
  app.use('/api/admin', adminRoutes);

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Clean, bookmarkable URLs for the auth pages (served alongside the
  // .html files that express.static already exposes at /login.html and
  // /register.html).
  app.get('/login', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
  });
  app.get('/register', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'register.html'));
  });

  // The admin SPA shell. Note this route itself carries no server-side
  // authorization -- admin.js checks GET /api/auth/me client-side and
  // bounces non-admins to /login. That's a UX convenience only; the real
  // security boundary is requireAdmin on every /api/admin/* route above,
  // which is enforced regardless of how this HTML page was reached.
  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
  });
  app.get('/admin/*', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
  });

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
