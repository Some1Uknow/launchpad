const express = require('express');
const bcrypt = require('bcryptjs');
const { Prisma } = require('@prisma/client');

const { prisma } = require('../lib/prisma');
const { signToken, serializeUser } = require('../lib/auth');

const router = express.Router();
const handleAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post('/register', handleAsync(async (req, res) => {
  const { email, password, name } = req.body || {};

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password, and name are required' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const normalizedName = String(name).trim();

  if (!normalizedEmail || !normalizedName) {
    return res.status(400).json({ error: 'email, password, and name are required' });
  }

  const passwordHash = await bcrypt.hash(String(password), 10);

  try {
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        name: normalizedName
      }
    });

    return res.status(201).json({
      token: signToken(user),
      user: serializeUser(user)
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({ error: 'Email already registered' });
    }

    throw error;
  }
}));

router.post('/login', handleAsync(async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const user = await prisma.user.findUnique({
    where: { email: String(email).trim().toLowerCase() }
  });

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const isValid = await bcrypt.compare(String(password), user.passwordHash);
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  return res.status(200).json({
    token: signToken(user),
    user: serializeUser(user)
  });
}));

module.exports = router;
