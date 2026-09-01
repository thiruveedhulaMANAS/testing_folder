const express = require('express');
const { requireAuth, requireAdmin } = require('../../middleware/auth');
const usersRoutes = require('./users');
const productsRoutes = require('./products');
const ordersRoutes = require('./orders');
const marketingRoutes = require('./marketing');

const router = express.Router();

// Every /api/admin/* route requires a valid session AND a fresh
// (re-checked-against-the-DB) admin role. See requireAdmin's doc comment
// in src/middleware/auth.js for why the JWT's role claim alone isn't
// trusted here.
router.use(requireAuth, requireAdmin);

router.use('/users', usersRoutes);
router.use('/products', productsRoutes);
router.use('/orders', ordersRoutes);
router.use('/marketing', marketingRoutes);

module.exports = router;
