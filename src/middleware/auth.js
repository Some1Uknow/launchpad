const { prisma } = require('../lib/prisma');
const { verifyToken } = require('../lib/auth');

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = header.slice('Bearer '.length).trim();

  try {
    const payload = verifyToken(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub }
    });

    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = { authMiddleware };
