const { Prisma } = require('@prisma/client');

const VALID_STATUSES = new Set(['UPCOMING', 'ACTIVE', 'ENDED', 'SOLD_OUT']);

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeMoney(value) {
  return Number(value);
}

function serializeTier(tier) {
  return {
    id: tier.id,
    minAmount: tier.minAmount,
    maxAmount: tier.maxAmount,
    pricePerToken: normalizeMoney(tier.pricePerToken)
  };
}

function serializeVesting(vesting) {
  if (!vesting) {
    return null;
  }

  return {
    cliffDays: vesting.cliffDays,
    vestingDays: vesting.vestingDays,
    tgePercent: vesting.tgePercent
  };
}

function computeLaunchStatus(launch, totalPurchased, now = new Date()) {
  if (totalPurchased >= launch.totalSupply) {
    return 'SOLD_OUT';
  }

  if (now < new Date(launch.startsAt)) {
    return 'UPCOMING';
  }

  if (now > new Date(launch.endsAt)) {
    return 'ENDED';
  }

  return 'ACTIVE';
}

function serializeLaunch(launch, totalPurchased = 0, now = new Date()) {
  return {
    id: launch.id,
    creatorId: launch.creatorId,
    name: launch.name,
    symbol: launch.symbol,
    totalSupply: launch.totalSupply,
    pricePerToken: normalizeMoney(launch.pricePerToken),
    startsAt: new Date(launch.startsAt).toISOString(),
    endsAt: new Date(launch.endsAt).toISOString(),
    maxPerWallet: launch.maxPerWallet,
    description: launch.description,
    tiers: (launch.tiers || []).map(serializeTier),
    vesting: serializeVesting(launch.vesting),
    createdAt: new Date(launch.createdAt).toISOString(),
    updatedAt: new Date(launch.updatedAt).toISOString(),
    totalPurchased,
    status: computeLaunchStatus(launch, totalPurchased, now)
  };
}

function serializePurchase(purchase) {
  return {
    id: purchase.id,
    launchId: purchase.launchId,
    userId: purchase.userId,
    walletAddress: purchase.walletAddress,
    amount: purchase.amount,
    totalCost: normalizeMoney(purchase.totalCost),
    txSignature: purchase.txSignature,
    referralCode: purchase.referralCode ? purchase.referralCode.code : null,
    createdAt: new Date(purchase.createdAt).toISOString(),
    updatedAt: new Date(purchase.updatedAt).toISOString()
  };
}

function validateLaunchPayload(payload, { partial = false } = {}) {
  const requiredFields = [
    'name',
    'symbol',
    'totalSupply',
    'pricePerToken',
    'startsAt',
    'endsAt',
    'maxPerWallet',
    'description'
  ];

  if (!partial) {
    const missingField = requiredFields.find((field) => payload[field] === undefined || payload[field] === null || payload[field] === '');
    if (missingField) {
      return `${missingField} is required`;
    }
  }

  if (payload.name !== undefined && !String(payload.name).trim()) {
    return 'name is required';
  }

  if (payload.symbol !== undefined && !String(payload.symbol).trim()) {
    return 'symbol is required';
  }

  if (payload.description !== undefined && !String(payload.description).trim()) {
    return 'description is required';
  }

  if (payload.totalSupply !== undefined) {
    const totalSupply = Number.parseInt(payload.totalSupply, 10);
    if (!Number.isInteger(totalSupply) || totalSupply <= 0) {
      return 'totalSupply must be a positive integer';
    }
  }

  if (payload.maxPerWallet !== undefined) {
    const maxPerWallet = Number.parseInt(payload.maxPerWallet, 10);
    if (!Number.isInteger(maxPerWallet) || maxPerWallet <= 0) {
      return 'maxPerWallet must be a positive integer';
    }
  }

  if (payload.pricePerToken !== undefined) {
    try {
      const price = new Prisma.Decimal(payload.pricePerToken);
      if (price.lte(0)) {
        return 'pricePerToken must be greater than 0';
      }
    } catch (error) {
      return 'pricePerToken must be a valid number';
    }
  }

  const startsAt = payload.startsAt !== undefined ? new Date(payload.startsAt) : null;
  const endsAt = payload.endsAt !== undefined ? new Date(payload.endsAt) : null;

  if (payload.startsAt !== undefined && Number.isNaN(startsAt.getTime())) {
    return 'startsAt must be a valid date';
  }

  if (payload.endsAt !== undefined && Number.isNaN(endsAt.getTime())) {
    return 'endsAt must be a valid date';
  }

  if (payload.startsAt !== undefined && payload.endsAt !== undefined && startsAt >= endsAt) {
    return 'startsAt must be before endsAt';
  }

  if (payload.tiers !== undefined) {
    if (!Array.isArray(payload.tiers)) {
      return 'tiers must be an array';
    }

    const sortedTiers = [...payload.tiers].sort((a, b) => Number(a.minAmount) - Number(b.minAmount));
    let previousMaxAmount = null;

    for (const tier of sortedTiers) {
      if (tier.minAmount === undefined || tier.maxAmount === undefined || tier.pricePerToken === undefined) {
        return 'each tier requires minAmount, maxAmount, and pricePerToken';
      }

      const minAmount = Number.parseInt(tier.minAmount, 10);
      const maxAmount = Number.parseInt(tier.maxAmount, 10);

      if (!Number.isInteger(minAmount) || !Number.isInteger(maxAmount) || minAmount < 0 || maxAmount <= minAmount) {
        return 'tier minAmount and maxAmount must define a valid positive range';
      }

      try {
        const price = new Prisma.Decimal(tier.pricePerToken);
        if (price.lte(0)) {
          return 'tier pricePerToken must be greater than 0';
        }
      } catch (error) {
        return 'tier pricePerToken must be a valid number';
      }

      if (previousMaxAmount !== null && minAmount < previousMaxAmount) {
        return 'tiers must not overlap';
      }

      previousMaxAmount = maxAmount;
    }
  }

  if (payload.vesting !== undefined && payload.vesting !== null) {
    const cliffDays = Number.parseInt(payload.vesting.cliffDays, 10);
    const vestingDays = Number.parseInt(payload.vesting.vestingDays, 10);
    const tgePercent = Number.parseInt(payload.vesting.tgePercent, 10);

    if (
      Number.isNaN(cliffDays) ||
      Number.isNaN(vestingDays) ||
      Number.isNaN(tgePercent)
    ) {
      return 'vesting requires cliffDays, vestingDays, and tgePercent';
    }

    if (
      !Number.isInteger(cliffDays) ||
      cliffDays < 0 ||
      !Number.isInteger(vestingDays) ||
      vestingDays < 0 ||
      !Number.isInteger(tgePercent) ||
      tgePercent < 0 ||
      tgePercent > 100
    ) {
      return 'vesting values must be valid integers and tgePercent must be between 0 and 100';
    }
  }

  return null;
}

function buildLaunchCreateInput(payload, creatorId) {
  return {
    creatorId,
    name: payload.name.trim(),
    symbol: payload.symbol.trim().toUpperCase(),
    totalSupply: Number.parseInt(payload.totalSupply, 10),
    pricePerToken: new Prisma.Decimal(payload.pricePerToken),
    startsAt: new Date(payload.startsAt),
    endsAt: new Date(payload.endsAt),
    maxPerWallet: Number.parseInt(payload.maxPerWallet, 10),
    description: payload.description.trim(),
    tiers: payload.tiers
      ? {
          create: [...payload.tiers]
            .sort((a, b) => Number(a.minAmount) - Number(b.minAmount))
            .map((tier) => ({
              minAmount: Number.parseInt(tier.minAmount, 10),
              maxAmount: Number.parseInt(tier.maxAmount, 10),
              pricePerToken: new Prisma.Decimal(tier.pricePerToken)
            }))
        }
      : undefined,
    vesting: payload.vesting
      ? {
          create: {
            cliffDays: Number.parseInt(payload.vesting.cliffDays, 10),
            vestingDays: Number.parseInt(payload.vesting.vestingDays, 10),
            tgePercent: Number.parseInt(payload.vesting.tgePercent, 10)
          }
        }
      : undefined
  };
}

function buildLaunchUpdateInput(payload) {
  const data = {};

  if (payload.name !== undefined) {
    data.name = payload.name.trim();
  }

  if (payload.symbol !== undefined) {
    data.symbol = payload.symbol.trim().toUpperCase();
  }

  if (payload.totalSupply !== undefined) {
    data.totalSupply = Number.parseInt(payload.totalSupply, 10);
  }

  if (payload.pricePerToken !== undefined) {
    data.pricePerToken = new Prisma.Decimal(payload.pricePerToken);
  }

  if (payload.startsAt !== undefined) {
    data.startsAt = new Date(payload.startsAt);
  }

  if (payload.endsAt !== undefined) {
    data.endsAt = new Date(payload.endsAt);
  }

  if (payload.maxPerWallet !== undefined) {
    data.maxPerWallet = Number.parseInt(payload.maxPerWallet, 10);
  }

  if (payload.description !== undefined) {
    data.description = payload.description.trim();
  }

  return data;
}

function getStatusFilter(status) {
  if (!status) {
    return null;
  }

  const normalized = String(status).toUpperCase();
  return VALID_STATUSES.has(normalized) ? normalized : null;
}

function calculateTieredCost(amount, basePricePerToken, tiers, amountSoldBeforePurchase = 0) {
  let remaining = amount;
  let soldCursor = amountSoldBeforePurchase;
  let totalCost = new Prisma.Decimal(0);
  const sortedTiers = [...tiers].sort((a, b) => a.minAmount - b.minAmount);

  for (const tier of sortedTiers) {
    if (remaining <= 0) {
      break;
    }

    if (soldCursor >= tier.maxAmount) {
      continue;
    }

    const tierStart = Math.max(soldCursor, tier.minAmount);
    if (tierStart >= tier.maxAmount) {
      continue;
    }

    const capacity = tier.maxAmount - tierStart;
    const fillAmount = Math.min(remaining, capacity);

    if (fillAmount > 0) {
      totalCost = totalCost.plus(new Prisma.Decimal(fillAmount).mul(tier.pricePerToken));
      remaining -= fillAmount;
      soldCursor += fillAmount;
    }
  }

  if (remaining > 0) {
    totalCost = totalCost.plus(new Prisma.Decimal(remaining).mul(basePricePerToken));
  }

  return totalCost;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function computeVestingState(launch, totalPurchased, now = new Date()) {
  if (!launch.vesting) {
    return {
      totalPurchased,
      tgeAmount: totalPurchased,
      cliffEndsAt: null,
      vestedAmount: totalPurchased,
      lockedAmount: 0,
      claimableAmount: totalPurchased
    };
  }

  const tgeDate = new Date(launch.endsAt);
  const cliffEndsAt = addDays(tgeDate, launch.vesting.cliffDays);
  const tgeAmount = Math.floor((totalPurchased * launch.vesting.tgePercent) / 100);
  const remainingAfterTge = Math.max(totalPurchased - tgeAmount, 0);

  let claimableAmount = 0;

  if (now >= tgeDate) {
    claimableAmount = tgeAmount;
  }

  if (now >= cliffEndsAt) {
    if (launch.vesting.vestingDays === 0) {
      claimableAmount = totalPurchased;
    } else {
      const vestingEndsAt = addDays(cliffEndsAt, launch.vesting.vestingDays);
      const elapsedMs = Math.max(0, Math.min(now.getTime(), vestingEndsAt.getTime()) - cliffEndsAt.getTime());
      const vestingDurationMs = Math.max(1, vestingEndsAt.getTime() - cliffEndsAt.getTime());
      const vestedAfterCliff = Math.floor((remainingAfterTge * elapsedMs) / vestingDurationMs);
      claimableAmount = Math.min(totalPurchased, tgeAmount + vestedAfterCliff);
    }
  }

  return {
    totalPurchased,
    tgeAmount,
    cliffEndsAt: cliffEndsAt.toISOString(),
    vestedAmount: claimableAmount,
    lockedAmount: Math.max(totalPurchased - claimableAmount, 0),
    claimableAmount
  };
}

module.exports = {
  VALID_STATUSES,
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
};
