const assert = require('assert/strict');
const http = require('http');
const { prisma } = require('../src/lib/prisma');
const app = require('../src/app');

const BASE_URL = 'http://127.0.0.1:3000';

function isoOffset(daysOffset) {
  return new Date(Date.now() + daysOffset * 24 * 60 * 60 * 1000).toISOString();
}

async function resetDatabase() {
  await prisma.purchase.deleteMany();
  await prisma.referralCode.deleteMany();
  await prisma.whitelistEntry.deleteMany();
  await prisma.launchVesting.deleteMany();
  await prisma.launchTier.deleteMany();
  await prisma.launch.deleteMany();
  await prisma.user.deleteMany();
}

async function startServer() {
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(3000, '127.0.0.1', resolve);
  });

  return server;
}

async function stopServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  return {
    status: response.status,
    body: payload
  };
}

function expectStatus(response, status, context) {
  assert.equal(response.status, status, `${context}: expected ${status}, received ${response.status} with body ${JSON.stringify(response.body)}`);
}

async function run() {
  let server;

  try {
    await prisma.$connect();
    await resetDatabase();
    server = await startServer();

    const health = await request('/api/health');
    expectStatus(health, 200, 'health check');
    assert.deepEqual(health.body, { status: 'ok' });

    const registerMissing = await request('/api/auth/register', {
      method: 'POST',
      body: { email: 'missing@example.com' }
    });
    expectStatus(registerMissing, 400, 'register missing fields');

    const creatorRegister = await request('/api/auth/register', {
      method: 'POST',
      body: {
        email: 'creator@example.com',
        password: 'secret123',
        name: 'Creator'
      }
    });
    expectStatus(creatorRegister, 201, 'register creator');
    const creatorToken = creatorRegister.body.token;
    const creatorId = creatorRegister.body.user.id;

    const buyerRegister = await request('/api/auth/register', {
      method: 'POST',
      body: {
        email: 'buyer@example.com',
        password: 'secret123',
        name: 'Buyer'
      }
    });
    expectStatus(buyerRegister, 201, 'register buyer');
    const buyerToken = buyerRegister.body.token;
    const buyerId = buyerRegister.body.user.id;

    const outsiderRegister = await request('/api/auth/register', {
      method: 'POST',
      body: {
        email: 'outsider@example.com',
        password: 'secret123',
        name: 'Outsider'
      }
    });
    expectStatus(outsiderRegister, 201, 'register outsider');
    const outsiderToken = outsiderRegister.body.token;
    const outsiderId = outsiderRegister.body.user.id;

    const registerDuplicate = await request('/api/auth/register', {
      method: 'POST',
      body: {
        email: 'creator@example.com',
        password: 'secret123',
        name: 'Creator Again'
      }
    });
    expectStatus(registerDuplicate, 409, 'register duplicate email');

    const loginSuccess = await request('/api/auth/login', {
      method: 'POST',
      body: {
        email: 'creator@example.com',
        password: 'secret123'
      }
    });
    expectStatus(loginSuccess, 200, 'login success');
    assert.equal(loginSuccess.body.user.id, creatorId);

    const loginBadPassword = await request('/api/auth/login', {
      method: 'POST',
      body: {
        email: 'creator@example.com',
        password: 'wrong'
      }
    });
    expectStatus(loginBadPassword, 401, 'login invalid password');

    const loginMissingUser = await request('/api/auth/login', {
      method: 'POST',
      body: {
        email: 'nobody@example.com',
        password: 'secret123'
      }
    });
    expectStatus(loginMissingUser, 401, 'login unknown user');

    const launchUnauthorized = await request('/api/launches', {
      method: 'POST',
      body: {
        name: 'Unauthorized',
        symbol: 'BAD',
        totalSupply: 100,
        pricePerToken: 1,
        startsAt: isoOffset(-1),
        endsAt: isoOffset(1),
        maxPerWallet: 10,
        description: 'Unauthorized'
      }
    });
    expectStatus(launchUnauthorized, 401, 'create launch without token');

    const launchMissingFields = await request('/api/launches', {
      method: 'POST',
      token: creatorToken,
      body: {
        name: 'Missing'
      }
    });
    expectStatus(launchMissingFields, 400, 'create launch missing fields');

    const upcomingLaunch = await request('/api/launches', {
      method: 'POST',
      token: creatorToken,
      body: {
        name: 'Upcoming Launch',
        symbol: 'UP',
        totalSupply: 100,
        pricePerToken: 2,
        startsAt: isoOffset(1),
        endsAt: isoOffset(2),
        maxPerWallet: 20,
        description: 'Upcoming'
      }
    });
    expectStatus(upcomingLaunch, 201, 'create upcoming launch');
    assert.equal(upcomingLaunch.body.status, 'UPCOMING');
    const upcomingLaunchId = upcomingLaunch.body.id;

    const activeLaunch = await request('/api/launches', {
      method: 'POST',
      token: creatorToken,
      body: {
        name: 'Active Launch',
        symbol: 'ACT',
        totalSupply: 200,
        pricePerToken: 2,
        startsAt: isoOffset(-1),
        endsAt: isoOffset(2),
        maxPerWallet: 100,
        description: 'Active without whitelist'
      }
    });
    expectStatus(activeLaunch, 201, 'create active launch');
    assert.equal(activeLaunch.body.status, 'ACTIVE');
    const activeLaunchId = activeLaunch.body.id;

    const endedLaunch = await request('/api/launches', {
      method: 'POST',
      token: creatorToken,
      body: {
        name: 'Ended Launch',
        symbol: 'END',
        totalSupply: 80,
        pricePerToken: 3,
        startsAt: isoOffset(-5),
        endsAt: isoOffset(-2),
        maxPerWallet: 40,
        description: 'Ended launch'
      }
    });
    expectStatus(endedLaunch, 201, 'create ended launch');
    assert.equal(endedLaunch.body.status, 'ENDED');
    const endedLaunchId = endedLaunch.body.id;

    const tierLaunch = await request('/api/launches', {
      method: 'POST',
      token: creatorToken,
      body: {
        name: 'Tier Launch',
        symbol: 'TIER',
        totalSupply: 100,
        pricePerToken: 5,
        startsAt: isoOffset(-1),
        endsAt: isoOffset(2),
        maxPerWallet: 100,
        description: 'Tiered pricing launch',
        tiers: [
          { minAmount: 0, maxAmount: 10, pricePerToken: 1.5 },
          { minAmount: 10, maxAmount: 20, pricePerToken: 2 }
        ]
      }
    });
    expectStatus(tierLaunch, 201, 'create tier launch');
    const tierLaunchId = tierLaunch.body.id;

    const whitelistLaunch = await request('/api/launches', {
      method: 'POST',
      token: creatorToken,
      body: {
        name: 'Whitelist Launch',
        symbol: 'WHT',
        totalSupply: 50,
        pricePerToken: 1,
        startsAt: isoOffset(-1),
        endsAt: isoOffset(2),
        maxPerWallet: 50,
        description: 'Whitelist gated launch'
      }
    });
    expectStatus(whitelistLaunch, 201, 'create whitelist launch');
    const whitelistLaunchId = whitelistLaunch.body.id;

    const soldOutLaunch = await request('/api/launches', {
      method: 'POST',
      token: creatorToken,
      body: {
        name: 'Sold Out Launch',
        symbol: 'SOLD',
        totalSupply: 10,
        pricePerToken: 4,
        startsAt: isoOffset(-1),
        endsAt: isoOffset(2),
        maxPerWallet: 20,
        description: 'Will sell out'
      }
    });
    expectStatus(soldOutLaunch, 201, 'create sold out launch');
    const soldOutLaunchId = soldOutLaunch.body.id;

    const supplyLaunch = await request('/api/launches', {
      method: 'POST',
      token: creatorToken,
      body: {
        name: 'Supply Launch',
        symbol: 'SUP',
        totalSupply: 10,
        pricePerToken: 2,
        startsAt: isoOffset(-1),
        endsAt: isoOffset(2),
        maxPerWallet: 100,
        description: 'Supply checks'
      }
    });
    expectStatus(supplyLaunch, 201, 'create supply launch');
    const supplyLaunchId = supplyLaunch.body.id;

    const vestingLaunch = await request('/api/launches', {
      method: 'POST',
      token: creatorToken,
      body: {
        name: 'Vesting Launch',
        symbol: 'VEST',
        totalSupply: 100,
        pricePerToken: 3,
        startsAt: isoOffset(-1),
        endsAt: isoOffset(1),
        maxPerWallet: 100,
        description: 'Launch with vesting',
        vesting: {
          cliffDays: 2,
          vestingDays: 8,
          tgePercent: 25
        }
      }
    });
    expectStatus(vestingLaunch, 201, 'create vesting launch');
    const vestingLaunchId = vestingLaunch.body.id;

    const launchesList = await request('/api/launches?page=1&limit=20');
    expectStatus(launchesList, 200, 'list launches');
    assert.equal(launchesList.body.total, 8);

    const activeFiltered = await request('/api/launches?page=1&limit=20&status=ACTIVE');
    expectStatus(activeFiltered, 200, 'list active launches');
    assert.equal(activeFiltered.body.total, 6);
    assert.ok(activeFiltered.body.launches.every((launch) => launch.status === 'ACTIVE'));

    const invalidStatusFilter = await request('/api/launches?status=BAD');
    expectStatus(invalidStatusFilter, 400, 'invalid status filter');

    const getLaunch = await request(`/api/launches/${activeLaunchId}`);
    expectStatus(getLaunch, 200, 'get launch by id');
    assert.equal(getLaunch.body.id, activeLaunchId);
    assert.equal(getLaunch.body.status, 'ACTIVE');

    const getLaunchMissing = await request('/api/launches/does-not-exist');
    expectStatus(getLaunchMissing, 404, 'get missing launch');

    const updateUnauthorized = await request(`/api/launches/${activeLaunchId}`, {
      method: 'PUT',
      body: {
        description: 'no token'
      }
    });
    expectStatus(updateUnauthorized, 401, 'update launch without token');

    const updateForbidden = await request(`/api/launches/${activeLaunchId}`, {
      method: 'PUT',
      token: outsiderToken,
      body: {
        description: 'forbidden'
      }
    });
    expectStatus(updateForbidden, 403, 'update launch as non creator');

    const updateMissingLaunch = await request('/api/launches/not-real', {
      method: 'PUT',
      token: creatorToken,
      body: {
        description: 'missing'
      }
    });
    expectStatus(updateMissingLaunch, 404, 'update missing launch');

    const updateLaunch = await request(`/api/launches/${activeLaunchId}`, {
      method: 'PUT',
      token: creatorToken,
      body: {
        description: 'Updated description',
        maxPerWallet: 100
      }
    });
    expectStatus(updateLaunch, 200, 'update launch');
    assert.equal(updateLaunch.body.description, 'Updated description');

    const whitelistAdd = await request(`/api/launches/${whitelistLaunchId}/whitelist`, {
      method: 'POST',
      token: creatorToken,
      body: {
        addresses: ['BUYER_WALLET', 'BUYER_WALLET', 'SECOND_WALLET']
      }
    });
    expectStatus(whitelistAdd, 200, 'add whitelist addresses');
    assert.equal(whitelistAdd.body.added, 2);
    assert.equal(whitelistAdd.body.total, 2);

    const whitelistGetForbidden = await request(`/api/launches/${whitelistLaunchId}/whitelist`, {
      token: outsiderToken
    });
    expectStatus(whitelistGetForbidden, 403, 'get whitelist as non creator');

    const whitelistGet = await request(`/api/launches/${whitelistLaunchId}/whitelist`, {
      token: creatorToken
    });
    expectStatus(whitelistGet, 200, 'get whitelist as creator');
    assert.equal(whitelistGet.body.total, 2);

    const whitelistPurchaseRejected = await request(`/api/launches/${whitelistLaunchId}/purchase`, {
      method: 'POST',
      token: buyerToken,
      body: {
        walletAddress: 'NOT_ALLOWED',
        amount: 5,
        txSignature: 'tx-whitelist-reject'
      }
    });
    expectStatus(whitelistPurchaseRejected, 400, 'reject purchase for non whitelisted wallet');

    const whitelistPurchaseAllowed = await request(`/api/launches/${whitelistLaunchId}/purchase`, {
      method: 'POST',
      token: buyerToken,
      body: {
        walletAddress: 'BUYER_WALLET',
        amount: 5,
        txSignature: 'tx-whitelist-allow'
      }
    });
    expectStatus(whitelistPurchaseAllowed, 201, 'allow whitelisted purchase');
    assert.equal(whitelistPurchaseAllowed.body.totalCost, 5);

    const whitelistDelete = await request(`/api/launches/${whitelistLaunchId}/whitelist/SECOND_WALLET`, {
      method: 'DELETE',
      token: creatorToken
    });
    expectStatus(whitelistDelete, 200, 'delete whitelist address');
    assert.equal(whitelistDelete.body.removed, true);

    const whitelistDeleteMissing = await request(`/api/launches/${whitelistLaunchId}/whitelist/SECOND_WALLET`, {
      method: 'DELETE',
      token: creatorToken
    });
    expectStatus(whitelistDeleteMissing, 404, 'delete missing whitelist address');

    const referralCreate = await request(`/api/launches/${tierLaunchId}/referrals`, {
      method: 'POST',
      token: creatorToken,
      body: {
        code: 'ALPHA',
        discountPercent: 10,
        maxUses: 1
      }
    });
    expectStatus(referralCreate, 201, 'create referral');

    const referralDuplicate = await request(`/api/launches/${tierLaunchId}/referrals`, {
      method: 'POST',
      token: creatorToken,
      body: {
        code: 'ALPHA',
        discountPercent: 10,
        maxUses: 1
      }
    });
    expectStatus(referralDuplicate, 409, 'duplicate referral');

    const referralListInitial = await request(`/api/launches/${tierLaunchId}/referrals`, {
      token: creatorToken
    });
    expectStatus(referralListInitial, 200, 'list referrals');
    assert.equal(referralListInitial.body.referrals[0].usedCount, 0);

    const purchaseUnauthorized = await request(`/api/launches/${activeLaunchId}/purchase`, {
      method: 'POST',
      body: {
        walletAddress: 'ANY',
        amount: 1,
        txSignature: 'tx-no-auth'
      }
    });
    expectStatus(purchaseUnauthorized, 401, 'purchase without token');

    const purchaseMissingLaunch = await request('/api/launches/not-real/purchase', {
      method: 'POST',
      token: buyerToken,
      body: {
        walletAddress: 'ANY',
        amount: 1,
        txSignature: 'tx-missing-launch'
      }
    });
    expectStatus(purchaseMissingLaunch, 404, 'purchase missing launch');

    const purchaseUpcoming = await request(`/api/launches/${upcomingLaunchId}/purchase`, {
      method: 'POST',
      token: buyerToken,
      body: {
        walletAddress: 'UPCOMING_WALLET',
        amount: 1,
        txSignature: 'tx-upcoming'
      }
    });
    expectStatus(purchaseUpcoming, 400, 'reject upcoming purchase');

    const purchaseEnded = await request(`/api/launches/${endedLaunchId}/purchase`, {
      method: 'POST',
      token: buyerToken,
      body: {
        walletAddress: 'ENDED_WALLET',
        amount: 1,
        txSignature: 'tx-ended'
      }
    });
    expectStatus(purchaseEnded, 400, 'reject ended purchase');

    const tierPurchaseInvalidReferral = await request(`/api/launches/${tierLaunchId}/purchase`, {
      method: 'POST',
      token: buyerToken,
      body: {
        walletAddress: 'TIER_WALLET_A',
        amount: 2,
        txSignature: 'tx-invalid-referral',
        referralCode: 'NOPE'
      }
    });
    expectStatus(tierPurchaseInvalidReferral, 400, 'reject invalid referral');

    const tierPurchase = await request(`/api/launches/${tierLaunchId}/purchase`, {
      method: 'POST',
      token: buyerToken,
      body: {
        walletAddress: 'TIER_WALLET_A',
        amount: 15,
        txSignature: 'tx-tier-1',
        referralCode: 'ALPHA'
      }
    });
    expectStatus(tierPurchase, 201, 'tier purchase with referral');
    assert.equal(tierPurchase.body.userId, buyerId);
    assert.equal(tierPurchase.body.totalCost, 22.5);

    const tierPurchaseExhaustedReferral = await request(`/api/launches/${tierLaunchId}/purchase`, {
      method: 'POST',
      token: outsiderToken,
      body: {
        walletAddress: 'TIER_WALLET_B',
        amount: 1,
        txSignature: 'tx-tier-exhausted',
        referralCode: 'ALPHA'
      }
    });
    expectStatus(tierPurchaseExhaustedReferral, 400, 'reject exhausted referral');

    const tierDuplicateTx = await request(`/api/launches/${tierLaunchId}/purchase`, {
      method: 'POST',
      token: outsiderToken,
      body: {
        walletAddress: 'TIER_WALLET_B',
        amount: 1,
        txSignature: 'tx-tier-1'
      }
    });
    expectStatus(tierDuplicateTx, 400, 'reject duplicate tx signature');

    const referralListUsed = await request(`/api/launches/${tierLaunchId}/referrals`, {
      token: creatorToken
    });
    expectStatus(referralListUsed, 200, 'list referrals after usage');
    assert.equal(referralListUsed.body.referrals[0].usedCount, 1);

    const activeBuyerPurchase = await request(`/api/launches/${activeLaunchId}/purchase`, {
      method: 'POST',
      token: buyerToken,
      body: {
        walletAddress: 'ACTIVE_WALLET_1',
        amount: 60,
        txSignature: 'tx-active-buyer'
      }
    });
    expectStatus(activeBuyerPurchase, 201, 'active launch buyer purchase');
    assert.equal(activeBuyerPurchase.body.totalCost, 120);

    const activeSybilRejected = await request(`/api/launches/${activeLaunchId}/purchase`, {
      method: 'POST',
      token: buyerToken,
      body: {
        walletAddress: 'ACTIVE_WALLET_2',
        amount: 50,
        txSignature: 'tx-active-sybil'
      }
    });
    expectStatus(activeSybilRejected, 400, 'reject sybil max per wallet enforcement');

    const activeOutsiderPurchase = await request(`/api/launches/${activeLaunchId}/purchase`, {
      method: 'POST',
      token: outsiderToken,
      body: {
        walletAddress: 'ACTIVE_WALLET_3',
        amount: 20,
        txSignature: 'tx-active-outsider'
      }
    });
    expectStatus(activeOutsiderPurchase, 201, 'outsider purchase on active launch');
    assert.equal(activeOutsiderPurchase.body.userId, outsiderId);

    const supplyFirstPurchase = await request(`/api/launches/${supplyLaunchId}/purchase`, {
      method: 'POST',
      token: buyerToken,
      body: {
        walletAddress: 'SUPPLY_WALLET_1',
        amount: 8,
        txSignature: 'tx-supply-1'
      }
    });
    expectStatus(supplyFirstPurchase, 201, 'supply first purchase');

    const supplyExceedPurchase = await request(`/api/launches/${supplyLaunchId}/purchase`, {
      method: 'POST',
      token: outsiderToken,
      body: {
        walletAddress: 'SUPPLY_WALLET_2',
        amount: 3,
        txSignature: 'tx-supply-exceed'
      }
    });
    expectStatus(supplyExceedPurchase, 400, 'reject purchase exceeding total supply');

    const soldOutFirstPurchase = await request(`/api/launches/${soldOutLaunchId}/purchase`, {
      method: 'POST',
      token: buyerToken,
      body: {
        walletAddress: 'SOLD_WALLET_1',
        amount: 10,
        txSignature: 'tx-soldout-1'
      }
    });
    expectStatus(soldOutFirstPurchase, 201, 'sell out launch');

    const soldOutStatus = await request(`/api/launches/${soldOutLaunchId}`);
    expectStatus(soldOutStatus, 200, 'get sold out launch');
    assert.equal(soldOutStatus.body.status, 'SOLD_OUT');

    const soldOutPurchaseRejected = await request(`/api/launches/${soldOutLaunchId}/purchase`, {
      method: 'POST',
      token: outsiderToken,
      body: {
        walletAddress: 'SOLD_WALLET_2',
        amount: 1,
        txSignature: 'tx-soldout-2'
      }
    });
    expectStatus(soldOutPurchaseRejected, 400, 'reject purchase on sold out launch');

    const purchasesUnauthorized = await request(`/api/launches/${activeLaunchId}/purchases`);
    expectStatus(purchasesUnauthorized, 401, 'get purchases without auth');

    const purchasesCreator = await request(`/api/launches/${activeLaunchId}/purchases`, {
      token: creatorToken
    });
    expectStatus(purchasesCreator, 200, 'creator sees all purchases');
    assert.equal(purchasesCreator.body.total, 2);
    assert.ok(purchasesCreator.body.purchases.every((purchase) => purchase.userId));

    const purchasesBuyer = await request(`/api/launches/${activeLaunchId}/purchases`, {
      token: buyerToken
    });
    expectStatus(purchasesBuyer, 200, 'buyer sees own purchases only');
    assert.equal(purchasesBuyer.body.total, 1);
    assert.equal(purchasesBuyer.body.purchases[0].userId, buyerId);

    const vestingPublic = await request(`/api/launches/${activeLaunchId}/vesting?walletAddress=ACTIVE_WALLET_1`);
    expectStatus(vestingPublic, 200, 'vesting is public');
    assert.equal(vestingPublic.body.totalPurchased, 60);
    assert.equal(vestingPublic.body.claimableAmount, 60);

    const vestingMissingWallet = await request(`/api/launches/${activeLaunchId}/vesting`);
    expectStatus(vestingMissingWallet, 400, 'vesting requires wallet address');

    const vestingMissingLaunch = await request('/api/launches/not-real/vesting?walletAddress=ANY');
    expectStatus(vestingMissingLaunch, 404, 'vesting missing launch');

    const vestingImmediate = await request(`/api/launches/${activeLaunchId}/vesting?walletAddress=ACTIVE_WALLET_1`);
    expectStatus(vestingImmediate, 200, 'vesting without config');
    assert.equal(vestingImmediate.body.totalPurchased, 60);
    assert.equal(vestingImmediate.body.claimableAmount, 60);

    const vestingPurchase = await request(`/api/launches/${vestingLaunchId}/purchase`, {
      method: 'POST',
      token: buyerToken,
      body: {
        walletAddress: 'VEST_WALLET',
        amount: 40,
        txSignature: 'tx-vesting-1'
      }
    });
    expectStatus(vestingPurchase, 201, 'purchase vesting launch');

    const vestingLaunchUpdated = await request(`/api/launches/${vestingLaunchId}`, {
      method: 'PUT',
      token: creatorToken,
      body: {
        startsAt: isoOffset(-7),
        endsAt: isoOffset(-6)
      }
    });
    expectStatus(vestingLaunchUpdated, 200, 'update vesting launch into ended state');
    assert.equal(vestingLaunchUpdated.body.status, 'ENDED');

    const vestingState = await request(`/api/launches/${vestingLaunchId}/vesting?walletAddress=VEST_WALLET`);
    expectStatus(vestingState, 200, 'vesting calculation with config');
    assert.equal(vestingState.body.totalPurchased, 40);
    assert.equal(vestingState.body.tgeAmount, 10);
    assert.equal(vestingState.body.vestedAmount, 25);
    assert.equal(vestingState.body.lockedAmount, 15);
    assert.equal(vestingState.body.claimableAmount, 25);

    const soldOutFiltered = await request('/api/launches?page=1&limit=20&status=SOLD_OUT');
    expectStatus(soldOutFiltered, 200, 'list sold out launches');
    assert.equal(soldOutFiltered.body.total, 1);
    assert.equal(soldOutFiltered.body.launches[0].id, soldOutLaunchId);

    console.log('All integration checks passed.');
  } finally {
    if (server) {
      await stopServer(server);
    }

    await prisma.$disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
