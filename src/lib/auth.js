require('./load-env');

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

function requireJwtSecret() {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }
}

function signToken(user) {
  requireJwtSecret();

  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function verifyToken(token) {
  requireJwtSecret();
  return jwt.verify(token, JWT_SECRET);
}

function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name
  };
}

module.exports = {
  signToken,
  verifyToken,
  serializeUser
};
