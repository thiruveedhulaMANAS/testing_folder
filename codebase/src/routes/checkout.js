const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');
const { checkout } = require('../services/checkout');

const router = express.Router();

router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const order = await checkout(req.user.id);
    res.status(201).json(order);
  })
);

module.exports = router;
