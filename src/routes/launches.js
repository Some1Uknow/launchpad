const express = require('express');
const { Prisma } = require('@prisma/client');

const { prisma } = require('../lib/prisma');
const { authMiddleware } = require('../middleware/auth');
const {
  parseInteger,
  parsePositiveInt,
  serializeLaunch,
  serializePurchase,
  validateLaunchPayload,
  buildLaunchCreateInput,
  buildLaunchUpdateInput,
  getStatusFilter,
  calculateTieredCost,
  computeLaunchStatus,
  computeVestingState
} = require('../lib/launches');

const router = express.Router();
const handleAsync = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function baseLaunchInclude() {
  return {
    tiers: {
      orderBy: { minAmount: 'asc' }
    },
    vesting: true
  };
}

async function getPurchasedTotalsByLaunchIds(client, launchIds) {
  if (!launchIds.length) {
    return new Map();
  }

  const aggregates = await client.purchase.groupBy({
    by: ['launchId'],
    where: { launchId: { in: launchIds } },
    _sum: { amount: true }
  });

  return new Map(
    aggregates.map((entry) => [entry.launchId, entry._sum.amount || 0])
  );
}

async function findLaunchOr404(res, id) {
  const launch = await prisma.launch.findUnique({
    where: { id },
    include: baseLaunchInclude()
  });

  if (!launch) {
    res.status(404).json({ error: 'Launch not found' });
    return null;
  }

  return launch;
}

async function withSerializableTransaction(fn, attempts = 3) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => fn(tx),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      lastError = error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < attempts - 1) {
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}

router.post('/', authMiddleware, handleAsync(async (req, res) => {
  const validationError = validateLaunchPayload(req.body || {});
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const launch = await prisma.launch.create({
    data: buildLaunchCreateInput(req.body, req.user.id),
    include: baseLaunchInclude()
  });

  console.info(JSON.stringify({ event: 'launch_created', launchId: launch.id, creatorId: req.user.id }));

  return res.status(201).json(serializeLaunch(launch, 0));
}));

router.get('/', handleAsync(async (req, res) => {
  const page = parsePositiveInt(req.query.page) || 1;
  const limit = parsePositiveInt(req.query.limit) || 10;
  const statusFilter = getStatusFilter(req.query.status);

  if (req.query.status && !statusFilter) {
    return res.status(400).json({ error: 'Invalid status filter' });
  }

  const launches = await prisma.launch.findMany({
    include: baseLaunchInclude(),
    orderBy: { createdAt: 'desc' }
  });

  const totalsByLaunchId = await getPurchasedTotalsByLaunchIds(prisma, launches.map((launch) => launch.id));
  const now = new Date();
  const serialized = launches.map((launch) => serializeLaunch(launch, totalsByLaunchId.get(launch.id) || 0, now));
  const filtered = statusFilter ? serialized.filter((launch) => launch.status === statusFilter) : serialized;
  const offset = (page - 1) * limit;

  return res.status(200).json({
    launches: filtered.slice(offset, offset + limit),
    total: filtered.length,
    page,
    limit
  });
}));

router.get('/:id', handleAsync(async (req, res) => {
  const launch = await findLaunchOr404(res, req.params.id);
  if (!launch) {
    return undefined;
  }

  const aggregate = await prisma.purchase.aggregate({
    where: { launchId: launch.id },
    _sum: { amount: true }
  });

  return res.status(200).json(serializeLaunch(launch, aggregate._sum.amount || 0));
}));

router.put('/:id', authMiddleware, handleAsync(async (req, res) => {
  const launch = await findLaunchOr404(res, req.params.id);
  if (!launch) {
    return undefined;
  }

  if (launch.creatorId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const validationError = validateLaunchPayload(req.body || {}, { partial: true });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const nextStartsAt = req.body?.startsAt !== undefined ? new Date(req.body.startsAt) : new Date(launch.startsAt);
  const nextEndsAt = req.body?.endsAt !== undefined ? new Date(req.body.endsAt) : new Date(launch.endsAt);
  if (nextStartsAt >= nextEndsAt) {
    return res.status(400).json({ error: 'startsAt must be before endsAt' });
  }

  const data = buildLaunchUpdateInput(req.body || {});

  const updatedLaunch = await prisma.$transaction(async (tx) => {
    const savedLaunch = await tx.launch.update({
      where: { id: launch.id },
      data
    });

    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'tiers')) {
      await tx.launchTier.deleteMany({
        where: { launchId: launch.id }
      });

      if (Array.isArray(req.body.tiers) && req.body.tiers.length > 0) {
        await tx.launchTier.createMany({
          data: [...req.body.tiers]
            .sort((a, b) => Number(a.minAmount) - Number(b.minAmount))
            .map((tier) => ({
              launchId: launch.id,
              minAmount: parseInteger(tier.minAmount),
              maxAmount: parseInteger(tier.maxAmount),
              pricePerToken: new Prisma.Decimal(tier.pricePerToken)
            }))
        });
      }
    }

    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'vesting')) {
      if (req.body.vesting === null) {
        await tx.launchVesting.deleteMany({
          where: { launchId: launch.id }
        });
      } else if (req.body.vesting) {
        await tx.launchVesting.upsert({
          where: { launchId: launch.id },
          update: {
            cliffDays: parseInteger(req.body.vesting.cliffDays),
            vestingDays: parseInteger(req.body.vesting.vestingDays),
            tgePercent: parseInteger(req.body.vesting.tgePercent)
          },
          create: {
            launchId: launch.id,
            cliffDays: parseInteger(req.body.vesting.cliffDays),
            vestingDays: parseInteger(req.body.vesting.vestingDays),
            tgePercent: parseInteger(req.body.vesting.tgePercent)
          }
        });
      }
    }

    return tx.launch.findUnique({
      where: { id: savedLaunch.id },
      include: baseLaunchInclude()
    });
  });

  const aggregate = await prisma.purchase.aggregate({
    where: { launchId: launch.id },
    _sum: { amount: true }
  });

  return res.status(200).json(serializeLaunch(updatedLaunch, aggregate._sum.amount || 0));
}));

router.post('/:id/whitelist', authMiddleware, handleAsync(async (req, res) => {
  const launch = await prisma.launch.findUnique({
    where: { id: req.params.id }
  });

  if (!launch) {
    return res.status(404).json({ error: 'Launch not found' });
  }

  if (launch.creatorId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const addresses = Array.isArray(req.body?.addresses)
    ? [...new Set(req.body.addresses.map((address) => String(address).trim()).filter(Boolean))]
    : null;

  if (!addresses) {
    return res.status(400).json({ error: 'addresses must be an array' });
  }

  if (addresses.length === 0) {
    const total = await prisma.whitelistEntry.count({
      where: { launchId: launch.id }
    });

    return res.status(200).json({
      added: 0,
      total
    });
  }

  const createResult = await prisma.whitelistEntry.createMany({
    data: addresses.map((address) => ({
      launchId: launch.id,
      address
    })),
    skipDuplicates: true
  });

  const total = await prisma.whitelistEntry.count({
    where: { launchId: launch.id }
  });

  return res.status(200).json({
    added: createResult.count,
    total
  });
}));

router.get('/:id/whitelist', authMiddleware, handleAsync(async (req, res) => {
  const launch = await prisma.launch.findUnique({
    where: { id: req.params.id }
  });

  if (!launch) {
    return res.status(404).json({ error: 'Launch not found' });
  }

  if (launch.creatorId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const entries = await prisma.whitelistEntry.findMany({
    where: { launchId: launch.id },
    orderBy: { createdAt: 'asc' }
  });

  return res.status(200).json({
    addresses: entries.map((entry) => entry.address),
    total: entries.length
  });
}));

router.delete('/:id/whitelist/:address', authMiddleware, handleAsync(async (req, res) => {
  const launch = await prisma.launch.findUnique({
    where: { id: req.params.id }
  });

  if (!launch) {
    return res.status(404).json({ error: 'Launch not found' });
  }

  if (launch.creatorId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    await prisma.whitelistEntry.delete({
      where: {
        launchId_address: {
          launchId: launch.id,
          address: req.params.address
        }
      }
    });

    return res.status(200).json({ removed: true });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return res.status(404).json({ error: 'Whitelist address not found' });
    }

    throw error;
  }
}));

router.post('/:id/referrals', authMiddleware, handleAsync(async (req, res) => {
  const launch = await prisma.launch.findUnique({
    where: { id: req.params.id }
  });

  if (!launch) {
    return res.status(404).json({ error: 'Launch not found' });
  }

  if (launch.creatorId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { code } = req.body || {};
  const discountPercent = parseInteger(req.body?.discountPercent);
  const maxUses = parseInteger(req.body?.maxUses);

  if (!String(code || '').trim() || !Number.isInteger(discountPercent) || !Number.isInteger(maxUses) || discountPercent < 0 || discountPercent > 100 || maxUses <= 0) {
    return res.status(400).json({ error: 'code, discountPercent, and maxUses are required' });
  }

  try {
    const referral = await prisma.referralCode.create({
      data: {
        launchId: launch.id,
        code: String(code).trim(),
        discountPercent,
        maxUses
      }
    });

    return res.status(201).json({
      id: referral.id,
      code: referral.code,
      discountPercent: referral.discountPercent,
      maxUses: referral.maxUses,
      usedCount: referral.usedCount
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({ error: 'Referral code already exists for this launch' });
    }

    throw error;
  }
}));

router.get('/:id/referrals', authMiddleware, handleAsync(async (req, res) => {
  const launch = await prisma.launch.findUnique({
    where: { id: req.params.id }
  });

  if (!launch) {
    return res.status(404).json({ error: 'Launch not found' });
  }

  if (launch.creatorId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const referrals = await prisma.referralCode.findMany({
    where: { launchId: launch.id },
    orderBy: { createdAt: 'asc' }
  });

  return res.status(200).json({
    referrals: referrals.map((referral) => ({
      id: referral.id,
      code: referral.code,
      discountPercent: referral.discountPercent,
      maxUses: referral.maxUses,
      usedCount: referral.usedCount
    }))
  });
}));

router.post('/:id/purchase', authMiddleware, handleAsync(async (req, res) => {
  const { walletAddress, amount, txSignature, referralCode } = req.body || {};
  const normalizedWalletAddress = String(walletAddress || '').trim();
  const normalizedTxSignature = String(txSignature || '').trim();
  const normalizedReferralCode = String(referralCode || '').trim();
  const parsedAmount = parseInteger(amount);

  if (!normalizedWalletAddress || !normalizedTxSignature || !Number.isInteger(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'walletAddress, amount, and txSignature are required' });
  }

  try {
    const purchase = await withSerializableTransaction(async (tx) => {
      const launch = await tx.launch.findUnique({
        where: { id: req.params.id },
        include: {
          tiers: {
            orderBy: { minAmount: 'asc' }
          },
          whitelist: true
        }
      });

      if (!launch) {
        return { error: { status: 404, message: 'Launch not found' } };
      }

      const existingTx = await tx.purchase.findUnique({
        where: { txSignature: normalizedTxSignature }
      });

      if (existingTx) {
        return { error: { status: 400, message: 'Duplicate txSignature' } };
      }

      const launchAggregate = await tx.purchase.aggregate({
        where: { launchId: launch.id },
        _sum: { amount: true }
      });
      const soldAmount = launchAggregate._sum.amount || 0;
      const status = computeLaunchStatus(launch, soldAmount);

      if (status !== 'ACTIVE') {
        return { error: { status: 400, message: `Launch is not ACTIVE (${status})` } };
      }

      if (launch.whitelist.length > 0) {
        const isWhitelisted = launch.whitelist.some((entry) => entry.address === normalizedWalletAddress);
        if (!isWhitelisted) {
          return { error: { status: 400, message: 'Wallet address is not whitelisted' } };
        }
      }

      if (soldAmount + parsedAmount > launch.totalSupply) {
        return { error: { status: 400, message: 'Purchase exceeds totalSupply' } };
      }

      const userAggregate = await tx.purchase.aggregate({
        where: {
          launchId: launch.id,
          userId: req.user.id
        },
        _sum: { amount: true }
      });
      const purchasedByUser = userAggregate._sum.amount || 0;

      if (purchasedByUser + parsedAmount > launch.maxPerWallet) {
        return { error: { status: 400, message: 'Purchase exceeds maxPerWallet for this user' } };
      }

      let selectedReferral = null;
      if (normalizedReferralCode) {
        selectedReferral = await tx.referralCode.findUnique({
          where: {
            launchId_code: {
              launchId: launch.id,
              code: normalizedReferralCode
            }
          }
        });

        if (!selectedReferral || selectedReferral.usedCount >= selectedReferral.maxUses) {
          return { error: { status: 400, message: 'Invalid or exhausted referral code' } };
        }
      }

      let totalCost = launch.tiers.length
        ? calculateTieredCost(parsedAmount, launch.pricePerToken, launch.tiers, soldAmount)
        : new Prisma.Decimal(parsedAmount).mul(launch.pricePerToken);

      if (selectedReferral) {
        totalCost = totalCost.mul(new Prisma.Decimal(100 - selectedReferral.discountPercent)).div(100);
        await tx.referralCode.update({
          where: { id: selectedReferral.id },
          data: { usedCount: { increment: 1 } }
        });
      }

      const createdPurchase = await tx.purchase.create({
        data: {
          launchId: launch.id,
          userId: req.user.id,
          walletAddress: normalizedWalletAddress,
          amount: parsedAmount,
          totalCost,
          txSignature: normalizedTxSignature,
          referralCodeId: selectedReferral ? selectedReferral.id : null
        },
        include: {
          referralCode: true
        }
      });

      console.info(JSON.stringify({
        event: 'purchase_created',
        launchId: launch.id,
        purchaseId: createdPurchase.id,
        userId: req.user.id,
        amount: parsedAmount
      }));

      return { purchase: createdPurchase };
    });

    if (purchase.error) {
      return res.status(purchase.error.status).json({ error: purchase.error.message });
    }

    return res.status(201).json(serializePurchase(purchase.purchase));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(400).json({ error: 'Duplicate txSignature' });
    }

    throw error;
  }
}));

router.get('/:id/purchases', authMiddleware, handleAsync(async (req, res) => {
  const launch = await prisma.launch.findUnique({
    where: { id: req.params.id }
  });

  if (!launch) {
    return res.status(404).json({ error: 'Launch not found' });
  }

  const where = launch.creatorId === req.user.id
    ? { launchId: launch.id }
    : { launchId: launch.id, userId: req.user.id };

  const purchases = await prisma.purchase.findMany({
    where,
    include: {
      referralCode: true
    },
    orderBy: { createdAt: 'asc' }
  });

  return res.status(200).json({
    purchases: purchases.map(serializePurchase),
    total: purchases.length
  });
}));

router.get('/:id/vesting', handleAsync(async (req, res) => {
  const walletAddress = String(req.query.walletAddress || '').trim();
  if (!walletAddress) {
    return res.status(400).json({ error: 'walletAddress is required' });
  }

  const launch = await prisma.launch.findUnique({
    where: { id: req.params.id },
    include: { vesting: true }
  });

  if (!launch) {
    return res.status(404).json({ error: 'Launch not found' });
  }

  const aggregate = await prisma.purchase.aggregate({
    where: {
      launchId: launch.id,
      walletAddress
    },
    _sum: {
      amount: true
    }
  });

  return res.status(200).json(
    computeVestingState(launch, aggregate._sum.amount || 0)
  );
}));

module.exports = router;
