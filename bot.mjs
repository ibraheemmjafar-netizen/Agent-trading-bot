/**
 * AGENT TRADING BOT — bot.mjs v2 (Research-Verified)
 * Uses real SDKs: 7K aggregator, Cetus CLMM SDK, Turbos SDK, Aftermath SDK
 * Handles both graduated DEX tokens AND bonding curve launchpad tokens
 */

import TelegramBot from 'node-telegram-bot-api';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { setTimeout as sleep } from 'timers/promises';
import BN from 'bn.js';

// ─────────────────────────────────────────────
// 1. ENV & CONSTANTS
// ─────────────────────────────────────────────

const TG_BOT_TOKEN  = process.env.TG_BOT_TOKEN  || '';
const ENCRYPT_KEY   = process.env.ENCRYPT_KEY   || '';  // 64-char hex = 32 bytes
const RPC_URL       = process.env.RPC_URL       || 'https://fullnode.mainnet.sui.io:443';
const BACKEND_URL   = process.env.BACKEND_URL   || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';

const DEV_WALLET   = '0x9e0ac3152f035e411164b24c8db59b3f0ee870340ec754ae5f074559baaa15b1';
const FEE_BPS      = 100;           // 1%
const REF_SHARE    = 0.25;          // referrer gets 25% of fee
const MIST_PER_SUI = 1_000_000_000n;
const SUI_TYPE     = '0x2::sui::SUI';
const STORAGE_FILE = './users.json';
const LOCK_TIMEOUT = 30 * 60 * 1000;
const MAX_FAILS    = 3;
const COOLDOWN_MS  = 5 * 60 * 1000;
const SUISCAN_TX   = 'https://suiscan.xyz/mainnet/tx/';

// Launchpad registry — sourced from research
// Each launchpad has bonding curve mechanics; tokens graduate to a DEX
const LAUNCHPAD_REGISTRY = {
  MOVEPUMP: {
    name: 'MovePump',
    apiBase: 'https://movepump.com/api',
    graduationSui: 2000,
    destinationDex: 'Cetus',
    // Token coinType IS the package: 0xPKG::module::SYMBOL
    // Buy fn: {pkg}::{module}::buy(bonding_curve_obj, sui_coin, clock)
    buyFn: 'buy',
    sellFn: 'sell',
  },
  TURBOS_FUN: {
    name: 'Turbos.fun',
    apiBase: 'https://api.turbos.finance/fun',
    graduationSui: 6000,
    destinationDex: 'Turbos',
    buyFn: 'buy',
    sellFn: 'sell',
  },
  HOP_FUN: {
    name: 'hop.fun',
    apiBase: 'https://api.hop.ag',
    graduationSui: null,
    destinationDex: 'Cetus',
    buyFn: 'buy',
    sellFn: 'sell',
  },
  MOONBAGS: {
    name: 'MoonBags',
    apiBase: 'https://api.moonbags.io',
    graduationSui: null,
    destinationDex: 'Cetus',
    buyFn: 'buy',
    sellFn: 'sell',
  },
  BLAST_FUN: {
    name: 'blast.fun',
    apiBase: 'https://api.blast.fun',
    graduationSui: null,
    destinationDex: 'Cetus',
    buyFn: 'buy',
    sellFn: 'sell',
  },
};

// ─────────────────────────────────────────────
// 2. CRYPTO / SECURITY HELPERS
// ─────────────────────────────────────────────

function encryptKey(privateKey) {
  const keyBuf = Buffer.from(ENCRYPT_KEY, 'hex');
  const iv     = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', keyBuf, iv);
  const enc    = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decryptKey(stored) {
  const [ivHex, encHex] = stored.split(':');
  const keyBuf  = Buffer.from(ENCRYPT_KEY, 'hex');
  const iv      = Buffer.from(ivHex, 'hex');
  const enc     = Buffer.from(encHex, 'hex');
  const decipher = createDecipheriv('aes-256-cbc', keyBuf, iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function hashPin(pin) {
  return createHash('sha256').update(pin + ENCRYPT_KEY).digest('hex');
}

function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = 'AGT-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>&"'`]/g, '').trim().slice(0, 300);
}

function truncAddr(addr) {
  if (!addr || addr.length < 12) return addr || '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function suiFloat(mist) {
  return (Number(BigInt(mist)) / Number(MIST_PER_SUI)).toFixed(4);
}

function mistFromSui(sui) {
  return BigInt(Math.floor(parseFloat(sui) * Number(MIST_PER_SUI)));
}

function packageFromCoinType(coinType) {
  // "0xABC::module::SYMBOL" → "0xABC"
  return coinType.split('::')[0];
}

function moduleFromCoinType(coinType) {
  return coinType.split('::')[1] || '';
}

// ─────────────────────────────────────────────
// 3. USER STORAGE
// ─────────────────────────────────────────────

let usersDB = {};

function loadUsers() {
  if (existsSync(STORAGE_FILE)) {
    try { usersDB = JSON.parse(readFileSync(STORAGE_FILE, 'utf8')); }
    catch { usersDB = {}; }
  }
}

function saveUsers() {
  writeFileSync(STORAGE_FILE, JSON.stringify(usersDB, null, 2));
}

function getUser(chatId) {
  return usersDB[String(chatId)] || null;
}

function createUser(chatId, extras = {}) {
  const uid = String(chatId);
  usersDB[uid] = {
    chatId: uid,
    encryptedKey: null,
    walletAddress: null,
    pinHash: null,
    lockedAt: null,
    lastActivity: Date.now(),
    failAttempts: 0,
    cooldownUntil: 0,
    positions: [],
    copyTraders: [],
    snipeWatches: [],
    settings: {
      slippage: 1,
      confirmThreshold: 0.5,
      copyAmount: 0.1,
      tpDefault: null,
      slDefault: null,
    },
    referralCode: generateReferralCode(),
    referredBy: null,
    referralCount: 0,
    referralEarningsTotal: 0,
    state: null,
    pendingData: {},
    ...extras,
  };
  saveUsers();
  return usersDB[uid];
}

function updateUser(chatId, patch) {
  const uid = String(chatId);
  if (!usersDB[uid]) return;
  for (const [k, v] of Object.entries(patch)) {
    if (k.includes('.')) {
      const [parent, child] = k.split('.');
      if (!usersDB[uid][parent]) usersDB[uid][parent] = {};
      usersDB[uid][parent][child] = v;
    } else {
      usersDB[uid][k] = v;
    }
  }
  usersDB[uid].lastActivity = Date.now();
  saveUsers();
}

function isLocked(user) {
  return !!(user?.pinHash && user?.lockedAt);
}

function lockUser(chatId)   { updateUser(chatId, { lockedAt: Date.now() }); }
function unlockUser(chatId) { updateUser(chatId, { lockedAt: null, failAttempts: 0 }); }

function checkInactivity() {
  const now = Date.now();
  for (const [uid, user] of Object.entries(usersDB)) {
    if (user.pinHash && !user.lockedAt && user.walletAddress) {
      if (now - user.lastActivity > LOCK_TIMEOUT) lockUser(uid);
    }
  }
}

async function syncToBackend(user) {
  if (!BACKEND_URL) return;
  try {
    await fetchTimeout(`${BACKEND_URL}/api/bot-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatId: user.chatId,
        walletAddress: user.walletAddress,
        referralCode: user.referralCode,
        referralEarningsTotal: user.referralEarningsTotal,
      }),
    });
  } catch { /* non-critical */ }
}

// ─────────────────────────────────────────────
// 4. SUI CLIENT
// ─────────────────────────────────────────────

const suiClient = new SuiClient({ url: RPC_URL });

async function fetchTimeout(url, opts = {}, ms = 8000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function getCoinMeta(coinType) {
  try { return await suiClient.getCoinMetadata({ coinType }); }
  catch { return null; }
}

async function getOwnedCoins(address, coinType) {
  const r = await suiClient.getCoins({ owner: address, coinType });
  return r.data;
}

async function getAllBalances(address) {
  return suiClient.getAllBalances({ owner: address });
}

function getKeypair(user) {
  const pk = decryptKey(user.encryptedKey);
  const decoded = decodeSuiPrivateKey(pk);
  return Ed25519Keypair.fromSecretKey(decoded.secretKey);
}

// ─────────────────────────────────────────────
// 5. SDK SINGLETONS (lazy-loaded)
// ─────────────────────────────────────────────

// ── 7K Aggregator
// Covers: Cetus, Turbos, Aftermath, Kriya, FlowX, DeepBook, BlueMove, Suiswap
// Docs: github.com/7k-ag/7k-sdk-ts
let _7k = null;
async function sdk7k() {
  if (_7k) return _7k;
  const mod = await import('@7kprotocol/sdk-ts');
  mod.setSuiClient(suiClient);
  _7k = { getQuote: mod.getQuote, buildTx: mod.buildTx };
  return _7k;
}

// ── Cetus CLMM SDK
// Used for: pool discovery, pool data, direct Cetus swaps when needed
// Docs: cetus-1.gitbook.io/cetus-developer-docs
let _cetusSDK = null;
async function sdkCetus(walletAddress) {
  const { initCetusSDK, adjustForSlippage, Percentage, d } = await import('@cetusprotocol/cetus-sui-clmm-sdk');
  if (!_cetusSDK) {
    _cetusSDK = { sdk: initCetusSDK({ network: 'mainnet', fullNodeUrl: RPC_URL }), adjustForSlippage, Percentage, d };
  }
  if (walletAddress) _cetusSDK.sdk.senderAddress = walletAddress;
  return _cetusSDK;
}

// ── Turbos CLMM SDK
// Used for: Turbos pool queries and direct Turbos swaps
// Docs: github.com/turbos-finance/turbos-clmm-sdk
let _turbosSDK = null;
async function sdkTurbos() {
  if (_turbosSDK) return _turbosSDK;
  const { TurbosSdk, Network } = await import('turbos-clmm-sdk');
  _turbosSDK = new TurbosSdk(Network.mainnet, suiClient);
  return _turbosSDK;
}

// ── Aftermath SDK
// Used for: Aftermath pool queries
// Docs: docs.aftermath.finance
let _afSDK = null;
async function sdkAftermath() {
  if (_afSDK) return _afSDK;
  const { Aftermath } = await import('aftermath-ts-sdk');
  const af = new Aftermath('MAINNET');
  await af.init();
  _afSDK = af;
  return _afSDK;
}

// ─────────────────────────────────────────────
// 6. FEE & REFERRAL
// ─────────────────────────────────────────────

function calcFee(amountMist, user) {
  const feeMist      = (amountMist * BigInt(FEE_BPS)) / 10000n;
  let referrerMist   = 0n;
  let devMist        = feeMist;
  if (user.referredBy) {
    referrerMist = (feeMist * BigInt(Math.floor(REF_SHARE * 100))) / 100n;
    devMist      = feeMist - referrerMist;
  }
  return { feeMist, referrerMist, devMist };
}

function findReferrer(user) {
  if (!user.referredBy) return null;
  return Object.values(usersDB).find(u => u.walletAddress === user.referredBy) || null;
}

// Add fee coin splits to an existing Transaction object.
// Call this BEFORE adding the main swap/buy instruction when possible.
function addFeeCoinsToTx(tx, amountMist, user) {
  const { feeMist, referrerMist, devMist } = calcFee(amountMist, user);

  const [devCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
  tx.transferObjects([devCoin], tx.pure.address(DEV_WALLET));

  if (referrerMist > 0n && user.referredBy) {
    const [refCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(referrerMist)]);
    tx.transferObjects([refCoin], tx.pure.address(user.referredBy));
    // Track referral earnings
    const ref = findReferrer(user);
    if (ref) {
      ref.referralEarningsTotal = (ref.referralEarningsTotal || 0) + Number(referrerMist) / 1e9;
      saveUsers();
    }
  }

  return { feeMist, tradeMist: amountMist - feeMist };
}

// ─────────────────────────────────────────────
// 7. TOKEN STATE DETECTION
// ─────────────────────────────────────────────
// Every meme token on Sui is in one of:
//   'graduated'     — live on DEX (Cetus/Turbos/etc.), use 7K aggregator
//   'bonding_curve' — still on launchpad contract, use launchpad buy/sell fns
//   'unknown'       — not found anywhere, report to user

const stateCache = new Map(); // coinType → { state, data, ts }
const STATE_TTL  = 20_000;   // 20s cache

async function detectTokenState(coinType) {
  const cached = stateCache.get(coinType);
  if (cached && Date.now() - cached.ts < STATE_TTL) return cached;

  // 1. Try 7K quote — if it returns any route, token is tradable on a DEX
  try {
    const k = await sdk7k();
    const q = await k.getQuote({
      tokenIn: SUI_TYPE,
      tokenOut: coinType,
      amountIn: '1000000000', // 1 SUI probe
    });
    if (q && q.outAmount && BigInt(q.outAmount) > 0n) {
      const result = {
        state: 'graduated',
        quote: q,
        dex: q.routes?.[0]?.poolType || 'aggregator',
        ts: Date.now(),
      };
      stateCache.set(coinType, result);
      return result;
    }
  } catch {}

  // 2. Check each launchpad API for bonding curve data
  for (const [key, lp] of Object.entries(LAUNCHPAD_REGISTRY)) {
    try {
      let data = null;
      const encoded = encodeURIComponent(coinType);

      if (key === 'MOVEPUMP') {
        const r = await fetchTimeout(`${lp.apiBase}/token/${encoded}`, {}, 5000);
        if (r.ok) data = await r.json();
      } else if (key === 'TURBOS_FUN') {
        const r = await fetchTimeout(`${lp.apiBase}/token?coinType=${encoded}`, {}, 5000);
        if (r.ok) data = await r.json();
      } else if (key === 'HOP_FUN') {
        const r = await fetchTimeout(`${lp.apiBase}/tokens/${encoded}`, {}, 5000);
        if (r.ok) data = await r.json();
      } else if (key === 'MOONBAGS') {
        const r = await fetchTimeout(`${lp.apiBase}/token/${encoded}`, {}, 5000);
        if (r.ok) data = await r.json();
      } else if (key === 'BLAST_FUN') {
        const r = await fetchTimeout(`${lp.apiBase}/token/${encoded}`, {}, 5000);
        if (r.ok) data = await r.json();
      }

      if (!data) continue;

      const graduated = !!(data.graduated || data.is_graduated || data.complete || data.migrated);
      if (graduated) continue; // graduated but 7K didn't find it yet — race condition, treat as graduated

      // Found active bonding curve
      const result = {
        state: 'bonding_curve',
        launchpad: key,
        launchpadName: lp.name,
        destinationDex: lp.destinationDex,
        bondingCurveId: data.bonding_curve_id || data.curveObjectId || data.pool_id || data.bondingCurveId || null,
        packageId: data.package_id || data.packageId || packageFromCoinType(coinType),
        suiRaised: parseFloat(data.sui_raised || data.suiRaised || 0),
        threshold: lp.graduationSui,
        currentPrice: parseFloat(data.price || data.current_price || 0),
        progress: parseFloat(data.progress || data.graduation_progress || 0),
        buyFn: lp.buyFn,
        sellFn: lp.sellFn,
        ts: Date.now(),
      };
      stateCache.set(coinType, result);
      return result;
    } catch { /* launchpad API down, skip */ }
  }

  // 3. Try Cetus pool list as final check
  try {
    const { sdk } = await sdkCetus();
    const pools = await sdk.Pool.getPools([], undefined, 20);
    const match = pools.find(p => p.coinTypeA === coinType || p.coinTypeB === coinType);
    if (match) {
      const result = { state: 'graduated', dex: 'Cetus', pool: match, ts: Date.now() };
      stateCache.set(coinType, result);
      return result;
    }
  } catch {}

  const result = { state: 'unknown', ts: Date.now() };
  stateCache.set(coinType, result);
  return result;
}

// ─────────────────────────────────────────────
// 8. SWAP VIA 7K AGGREGATOR (graduated tokens)
// Uses @7kprotocol/sdk-ts — real SDK, covers all Sui DEXes
// Fee: split from gas before swap in same PTB
// ─────────────────────────────────────────────

async function swapVia7K({ keypair, walletAddress, tokenIn, tokenOut, amountIn, slippagePct, user }) {
  const k = await sdk7k();

  // Calculate fee
  const { feeMist, tradeMist } = addFeeCoinsToTxPrep(amountIn, user);

  // Get best route for the TRADE amount (after fee deducted)
  const quoteResponse = await k.getQuote({
    tokenIn,
    tokenOut,
    amountIn: tradeMist.toString(),
  });

  if (!quoteResponse || !quoteResponse.outAmount || BigInt(quoteResponse.outAmount) === 0n) {
    throw new Error('No liquidity found across any DEX for this token.');
  }

  // Build the swap PTB
  const buildResult = await k.buildTx({
    quoteResponse,
    accountAddress: walletAddress,
    slippage: slippagePct / 100, // 7K takes decimal fraction e.g. 0.01 = 1%
    commission: {
      partner: DEV_WALLET,
      commissionBps: 0, // We handle fees manually in the same tx below
    },
  });

  const tx = buildResult.tx;

  // Inject fee transfers into the SAME transaction
  // These must go BEFORE the swap inputs are consumed
  const { feeMist: fm, referrerMist, devMist } = calcFee(amountIn, user);

  const [devCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
  tx.transferObjects([devCoin], tx.pure.address(DEV_WALLET));

  if (referrerMist > 0n && user.referredBy) {
    const [refCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(referrerMist)]);
    tx.transferObjects([refCoin], tx.pure.address(user.referredBy));
    const ref = findReferrer(user);
    if (ref) {
      ref.referralEarningsTotal = (ref.referralEarningsTotal || 0) + Number(referrerMist) / 1e9;
      saveUsers();
    }
  }

  // Transfer output coin to user wallet
  if (buildResult.coinOut) {
    tx.transferObjects([buildResult.coinOut], tx.pure.address(walletAddress));
  }

  tx.setGasBudget(50_000_000);

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });

  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Transaction failed: ${result.effects?.status?.error || 'unknown'}`);
  }

  return {
    digest: result.digest,
    estimatedOut: quoteResponse.outAmount,
    feeMist: fm,
    route: quoteResponse.routes?.[0]?.poolType || 'aggregator',
  };
}

// Helper: calculate fee split amounts without modifying tx yet
function addFeeCoinsToTxPrep(amountMist, user) {
  const { feeMist } = calcFee(amountMist, user);
  return { feeMist, tradeMist: amountMist - feeMist };
}

// ─────────────────────────────────────────────
// 9. CETUS DIRECT SWAP (fallback for Cetus-only pools)
// Uses @cetusprotocol/cetus-sui-clmm-sdk correctly:
//   preswap → adjustForSlippage → createSwapTransactionPayload
// ─────────────────────────────────────────────

async function swapViaCetus({ keypair, walletAddress, poolId, a2b, amountMist, slippagePct, user }) {
  const { sdk, adjustForSlippage, Percentage, d } = await sdkCetus(walletAddress);

  const pool = await sdk.Pool.getPool(poolId);
  const [metaA, metaB] = await Promise.all([
    getCoinMeta(pool.coinTypeA),
    getCoinMeta(pool.coinTypeB),
  ]);

  const amount   = new BN(amountMist.toString());
  const slippage = Percentage.fromDecimal(d(slippagePct));

  // Step 1: preswap — calculates estimated output
  const preswap = await sdk.Swap.preswap({
    pool,
    current_sqrt_price: pool.current_sqrt_price,
    coinTypeA: pool.coinTypeA,
    coinTypeB: pool.coinTypeB,
    decimalsA: metaA?.decimals || 9,
    decimalsB: metaB?.decimals || 9,
    a2b,
    by_amount_in: true,
    amount,
  });

  // Step 2: calculate slippage-adjusted limit
  const toAmount    = preswap.estimatedAmountOut;
  const amountLimit = adjustForSlippage(toAmount, slippage, false);

  // Step 3: build swap transaction
  const swapTx = await sdk.Swap.createSwapTransactionPayload({
    pool_id: pool.poolAddress,
    coinTypeA: pool.coinTypeA,
    coinTypeB: pool.coinTypeB,
    a2b,
    by_amount_in: true,
    amount: preswap.amount.toString(),
    amount_limit: amountLimit.toString(),
  });

  // Inject fee
  const { feeMist, devMist, referrerMist } = calcFee(amountMist, user);
  const [devCoin] = swapTx.splitCoins(swapTx.gas, [swapTx.pure.u64(devMist)]);
  swapTx.transferObjects([devCoin], swapTx.pure.address(DEV_WALLET));
  if (referrerMist > 0n && user.referredBy) {
    const [refCoin] = swapTx.splitCoins(swapTx.gas, [swapTx.pure.u64(referrerMist)]);
    swapTx.transferObjects([refCoin], swapTx.pure.address(user.referredBy));
  }

  swapTx.setGasBudget(50_000_000);

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: swapTx,
    options: { showEffects: true },
  });

  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Cetus swap failed: ${result.effects?.status?.error}`);
  }

  return { digest: result.digest, estimatedOut: preswap.estimatedAmountOut, feeMist };
}

// ─────────────────────────────────────────────
// 10. TURBOS DIRECT SWAP (fallback for Turbos-only pools)
// Uses turbos-clmm-sdk correctly:
//   computeSwapResultV2 → trade.swap
// ─────────────────────────────────────────────

async function swapViaTurbos({ keypair, walletAddress, poolId, coinTypeA, coinTypeB, a2b, amountStr, slippagePct, user }) {
  const tSdk = await sdkTurbos();

  // Step 1: compute swap result
  const [swapResult] = await tSdk.trade.computeSwapResultV2({
    pools: [{ pool: poolId, a2b, amountSpecified: amountStr }],
    address: walletAddress,
  });

  if (!swapResult) throw new Error('Turbos: no swap result returned');

  const nextTickIndex = tSdk.math.bitsToNumber(swapResult.tick_current_index.bits, 64);

  // Step 2: build swap tx
  const tx = await tSdk.trade.swap({
    routes: [{ pool: swapResult.pool, a2b: swapResult.a_to_b, nextTickIndex }],
    coinTypeA,
    coinTypeB,
    address: walletAddress,
    amountA: swapResult.amount_a,
    amountB: swapResult.amount_b,
    amountSpecifiedIsInput: swapResult.is_exact_in,
    slippage: String(slippagePct),
    deadline: 60000,
  });

  // Inject fee
  const amountMist = BigInt(amountStr);
  const { feeMist, devMist, referrerMist } = calcFee(amountMist, user);
  const [devCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
  tx.transferObjects([devCoin], tx.pure.address(DEV_WALLET));
  if (referrerMist > 0n && user.referredBy) {
    const [refCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(referrerMist)]);
    tx.transferObjects([refCoin], tx.pure.address(user.referredBy));
  }

  tx.setGasBudget(50_000_000);

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });

  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Turbos swap failed: ${result.effects?.status?.error}`);
  }

  return {
    digest: result.digest,
    estimatedOut: a2b ? swapResult.amount_b : swapResult.amount_a,
    feeMist,
  };
}

// ─────────────────────────────────────────────
// 11. BONDING CURVE BUY / SELL
// Calls launchpad Move contract directly.
// Package is embedded in the coinType: 0xPKG::module::SYMBOL
// Function signature (reverse-engineered from on-chain patterns):
//   buy<CoinType>(bonding_curve: &mut BondingCurve, payment: Coin<SUI>, clock: &Clock, ctx: &mut TxContext)
//   sell<CoinType>(bonding_curve: &mut BondingCurve, token: Coin<CoinType>, clock: &Clock, ctx: &mut TxContext)
// ─────────────────────────────────────────────

async function bondingCurveBuy({ keypair, walletAddress, coinType, suiAmountMist, bondingCurveId, buyFn, user }) {
  const pkgId  = packageFromCoinType(coinType);
  const modName = moduleFromCoinType(coinType);

  const tx = new Transaction();
  tx.setGasBudget(30_000_000);

  // Fee split first
  const { feeMist, devMist, referrerMist } = calcFee(suiAmountMist, user);
  const tradeMist = suiAmountMist - feeMist;

  const [devCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
  tx.transferObjects([devCoin], tx.pure.address(DEV_WALLET));

  if (referrerMist > 0n && user.referredBy) {
    const [refCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(referrerMist)]);
    tx.transferObjects([refCoin], tx.pure.address(user.referredBy));
    const ref = findReferrer(user);
    if (ref) {
      ref.referralEarningsTotal = (ref.referralEarningsTotal || 0) + Number(referrerMist) / 1e9;
      saveUsers();
    }
  }

  // Split trade amount from gas
  const [tradeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(tradeMist)]);

  // Call launchpad buy function
  // Note: exact argument order may vary per launchpad — this follows MovePump/hop.fun pattern
  tx.moveCall({
    target: `${pkgId}::${modName}::${buyFn}`,
    typeArguments: [coinType],
    arguments: [
      tx.object(bondingCurveId), // bonding curve shared object
      tradeCoin,                  // SUI payment
      tx.object('0x6'),           // Clock (always 0x6 on Sui)
    ],
  });

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });

  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Bonding curve buy failed: ${result.effects?.status?.error}`);
  }

  return { digest: result.digest, feeMist };
}

async function bondingCurveSell({ keypair, walletAddress, coinType, tokenCoins, sellAmountRaw, bondingCurveId, sellFn, user }) {
  const pkgId   = packageFromCoinType(coinType);
  const modName = moduleFromCoinType(coinType);

  const tx = new Transaction();
  tx.setGasBudget(30_000_000);

  // Merge token coins if multiple
  let tokenObj;
  if (tokenCoins.length === 1) {
    tokenObj = tx.object(tokenCoins[0].coinObjectId);
  } else {
    tokenObj = tx.object(tokenCoins[0].coinObjectId);
    tx.mergeCoins(tokenObj, tokenCoins.slice(1).map(c => tx.object(c.coinObjectId)));
  }

  // Split exact sell amount
  const [sellCoin] = tx.splitCoins(tokenObj, [tx.pure.u64(sellAmountRaw)]);

  // Call launchpad sell — returns SUI
  // The returned SUI coin is handled by the contract (transferred back or returned)
  tx.moveCall({
    target: `${pkgId}::${modName}::${sellFn}`,
    typeArguments: [coinType],
    arguments: [
      tx.object(bondingCurveId),
      sellCoin,
      tx.object('0x6'),
    ],
  });

  // Fee on sell: approximate based on current curve price
  // SUI returned goes to user wallet automatically via Move contract transfer
  // We take our fee separately in a follow-up instruction is not possible without knowing exact amount
  // Best practice: take fee from remaining token balance or accept fee is taken from SUI received
  // For now we split a small SUI amount from gas as fee proxy (imperfect but atomic)
  const estSuiOut = BigInt(0); // unknown at tx build time on bonding curve
  // Fee will be approximated as 1% of trade SUI value — skip for bonding curve sells
  // since the exact SUI return is unknown until execution

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });

  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Bonding curve sell failed: ${result.effects?.status?.error}`);
  }

  return { digest: result.digest };
}

// ─────────────────────────────────────────────
// 12. UNIFIED BUY / SELL (routes to correct engine)
// ─────────────────────────────────────────────

async function executeBuy(chatId, coinType, amountSui) {
  const user       = getUser(chatId);
  if (!user) throw new Error('User not found');
  const keypair    = getKeypair(user);
  const amountMist = mistFromSui(amountSui);
  const state      = await detectTokenState(coinType);
  const meta       = await getCoinMeta(coinType) || {};
  const symbol     = meta.symbol || truncAddr(coinType);

  if (state.state === 'graduated' || state.state === 'unknown') {
    // Use 7K aggregator for best price across all DEXes
    const res = await swapVia7K({
      keypair,
      walletAddress: user.walletAddress,
      tokenIn: SUI_TYPE,
      tokenOut: coinType,
      amountIn: amountMist,
      slippagePct: user.settings.slippage,
      user,
    });

    const estTokens = Number(res.estimatedOut) / Math.pow(10, meta.decimals || 9);
    const entryPrice = Number(amountMist - res.feeMist) / 1e9 / (estTokens || 1);

    addPosition(chatId, {
      coinType, symbol,
      entryPriceSui: entryPrice,
      amountTokens: estTokens,
      spentSui: amountSui,
      source: 'dex',
      tp: user.settings.tpDefault || null,
      sl: user.settings.slDefault || null,
    });

    return {
      digest: res.digest,
      feeSui: suiFloat(res.feeMist),
      route: res.route,
      estOut: estTokens.toFixed(4),
      symbol,
      state: 'graduated',
    };
  }

  if (state.state === 'bonding_curve') {
    if (!state.bondingCurveId) {
      throw new Error(
        `Token found on ${state.launchpadName} but bonding curve object ID not available. ` +
        `Visit ${state.launchpadName} directly to trade.`
      );
    }

    const res = await bondingCurveBuy({
      keypair,
      walletAddress: user.walletAddress,
      coinType,
      suiAmountMist: amountMist,
      bondingCurveId: state.bondingCurveId,
      buyFn: state.buyFn || 'buy',
      user,
    });

    addPosition(chatId, {
      coinType, symbol,
      entryPriceSui: state.currentPrice || 0,
      amountTokens: 0, // unknown until tx parses events
      spentSui: amountSui,
      source: 'bonding_curve',
      launchpad: state.launchpadName,
      tp: null, sl: null,
    });

    return {
      digest: res.digest,
      feeSui: suiFloat(res.feeMist),
      route: state.launchpadName,
      estOut: '?',
      symbol,
      state: 'bonding_curve',
      launchpadName: state.launchpadName,
      progress: state.progress,
      destinationDex: state.destinationDex,
    };
  }

  throw new Error('Token not found on any DEX or launchpad. It may have no liquidity yet.');
}

async function executeSell(chatId, coinType, pct) {
  const user    = getUser(chatId);
  if (!user) throw new Error('User not found');
  const keypair = getKeypair(user);
  const meta    = await getCoinMeta(coinType) || {};
  const symbol  = meta.symbol || truncAddr(coinType);

  const coins = await getOwnedCoins(user.walletAddress, coinType);
  if (!coins.length) throw new Error('No balance of this token in your wallet.');

  const totalBal   = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
  const sellAmount = (totalBal * BigInt(Math.floor(pct))) / 100n;
  if (sellAmount === 0n) throw new Error('Sell amount is zero.');

  const state = await detectTokenState(coinType);

  if (state.state === 'graduated' || state.state === 'unknown') {
    // Sell via 7K — token for SUI
    const res = await swapVia7K({
      keypair,
      walletAddress: user.walletAddress,
      tokenIn: coinType,
      tokenOut: SUI_TYPE,
      amountIn: sellAmount,
      slippagePct: user.settings.slippage,
      user,
    });

    if (pct === 100) {
      updateUser(chatId, { positions: user.positions.filter(p => p.coinType !== coinType) });
    }

    const suiOut = Number(res.estimatedOut) / 1e9;
    const { feeMist } = calcFee(BigInt(res.estimatedOut), user);

    return {
      digest: res.digest,
      feeSui: suiFloat(feeMist),
      route: res.route,
      estSui: suiOut.toFixed(4),
      symbol,
      pct,
    };
  }

  if (state.state === 'bonding_curve') {
    if (!state.bondingCurveId) {
      throw new Error(`Bonding curve object ID not available for ${state.launchpadName}.`);
    }

    const res = await bondingCurveSell({
      keypair,
      walletAddress: user.walletAddress,
      coinType,
      tokenCoins: coins,
      sellAmountRaw: sellAmount,
      bondingCurveId: state.bondingCurveId,
      sellFn: state.sellFn || 'sell',
      user,
    });

    if (pct === 100) {
      updateUser(chatId, { positions: user.positions.filter(p => p.coinType !== coinType) });
    }

    return {
      digest: res.digest,
      feeSui: 'N/A',
      route: state.launchpadName,
      estSui: '?',
      symbol,
      pct,
    };
  }

  throw new Error('Cannot sell — token not found on any DEX or launchpad.');
}

// ─────────────────────────────────────────────
// 13. POOL DISCOVERY (for display in /scan)
// Uses real SDK calls, not fabricated APIs
// ─────────────────────────────────────────────

async function getPoolsForToken(coinType) {
  const pools = [];

  // Cetus pools via SDK
  try {
    const { sdk } = await sdkCetus();
    // getPools returns paginated list — filter client-side for token
    const cetusRes = await sdk.Pool.getPools([], undefined, 50);
    for (const p of cetusRes) {
      if (p.coinTypeA !== coinType && p.coinTypeB !== coinType) continue;
      const suiIdx = p.coinTypeA === SUI_TYPE ? 'A' : (p.coinTypeB === SUI_TYPE ? 'B' : null);
      const suiLiq = suiIdx === 'A'
        ? Number(p.coinAmountA || 0) / 1e9
        : suiIdx === 'B'
          ? Number(p.coinAmountB || 0) / 1e9
          : 0;
      pools.push({ dex: 'Cetus', poolId: p.poolAddress, coinTypeA: p.coinTypeA, coinTypeB: p.coinTypeB, liquidity: suiLiq, fee: Number(p.fee_rate || 0) / 1e6 });
    }
  } catch {}

  // Turbos pools via SDK
  try {
    const tSdk = await sdkTurbos();
    // Turbos SDK may have pool search — check by querying known methods
    if (tSdk.pool && typeof tSdk.pool.getPools === 'function') {
      const tp = await tSdk.pool.getPools();
      for (const p of (tp || [])) {
        if (p.coin_a !== coinType && p.coin_b !== coinType) continue;
        const suiLiq = p.coin_a === SUI_TYPE
          ? Number(p.liquidity_a || 0) / 1e9
          : Number(p.liquidity_b || 0) / 1e9;
        pools.push({ dex: 'Turbos', poolId: p.id, coinTypeA: p.coin_a, coinTypeB: p.coin_b, liquidity: suiLiq, fee: 0.003 });
      }
    }
  } catch {}

  // 7K quote as proxy for "is there any DEX liquidity?"
  if (!pools.length) {
    try {
      const k = await sdk7k();
      const q = await k.getQuote({ tokenIn: SUI_TYPE, tokenOut: coinType, amountIn: '1000000000' });
      if (q && BigInt(q.outAmount || 0) > 0n) {
        pools.push({ dex: q.routes?.[0]?.poolType || 'Aggregator', poolId: 'aggregator', coinTypeA: SUI_TYPE, coinTypeB: coinType, liquidity: -1, fee: 0 });
      }
    } catch {}
  }

  return pools.sort((a, b) => b.liquidity - a.liquidity);
}

// ─────────────────────────────────────────────
// 14. TOKEN SCANNER
// ─────────────────────────────────────────────

async function scanToken(coinType) {
  const scan = {
    coinType, name: '?', symbol: '?', decimals: 9, totalSupply: 0,
    holders: 0, topHolders: [],
    pools: [], totalLiquiditySui: 0,
    honeypotPass: null,
    riskScore: 'UNKNOWN',
    bondingCurveState: null,
  };

  // Metadata
  try {
    const m = await getCoinMeta(coinType);
    if (m) { scan.name = m.name; scan.symbol = m.symbol; scan.decimals = m.decimals; }
  } catch {}

  // Supply
  try {
    const s = await suiClient.getTotalSupply({ coinType });
    scan.totalSupply = Number(s.value) / Math.pow(10, scan.decimals);
  } catch {}

  // State detection
  const state = await detectTokenState(coinType);
  if (state.state === 'bonding_curve') {
    scan.bondingCurveState = {
      launchpad: state.launchpadName,
      suiRaised: state.suiRaised,
      threshold: state.threshold,
      progress: state.progress,
      destinationDex: state.destinationDex,
    };
  }

  // Pools
  try {
    scan.pools = await getPoolsForToken(coinType);
    scan.totalLiquiditySui = scan.pools.filter(p => p.liquidity > 0).reduce((s, p) => s + p.liquidity, 0);
  } catch {}

  // Holders via SuiScan API
  try {
    const r = await fetchTimeout(`https://suiscan.xyz/api/sui/mainnet/coin/${encodeURIComponent(coinType)}/holders?limit=20`, {}, 8000);
    if (r.ok) {
      const d = await r.json();
      scan.holders    = d.total || 0;
      scan.topHolders = (d.data || []).slice(0, 10).map(h => ({ address: h.address, pct: parseFloat(h.percentage || 0) }));
    }
  } catch {}

  // Honeypot test — try to get sell quote via 7K
  try {
    const k = await sdk7k();
    const q = await k.getQuote({ tokenIn: coinType, tokenOut: SUI_TYPE, amountIn: '1000000' });
    scan.honeypotPass = !!(q && BigInt(q.outAmount || 0) > 0n);
  } catch { scan.honeypotPass = null; }

  // Risk scoring
  const top3pct = scan.topHolders.slice(0, 3).reduce((s, h) => s + h.pct, 0);
  const noLiq   = scan.totalLiquiditySui < 0.5 && !scan.bondingCurveState;
  const lowLiq  = scan.totalLiquiditySui < 5;
  const conc    = top3pct > 50;

  if (scan.honeypotPass === false || noLiq)  scan.riskScore = 'LIKELY RUG';
  else if (conc && lowLiq)                   scan.riskScore = 'HIGH RISK';
  else if (conc || lowLiq)                   scan.riskScore = 'CAUTION';
  else                                        scan.riskScore = 'SAFE';

  return scan;
}

function formatScanReport(scan) {
  const icons = { 'SAFE': '🟢', 'CAUTION': '🟡', 'HIGH RISK': '🔴', 'LIKELY RUG': '💀', 'UNKNOWN': '⚪' };
  const top3  = scan.topHolders.slice(0, 3).reduce((s, h) => s + h.pct, 0);
  const lines = [`🔍 *Token Scan: ${scan.symbol}*\n`];

  lines.push(`📛 Name: ${scan.name}  🔖 ${scan.symbol}`);
  lines.push(`💰 Supply: ${scan.totalSupply.toLocaleString()}`);
  lines.push(`👥 Holders: ${scan.holders.toLocaleString()}${top3 > 50 ? ` ⚠️ Top 3 own ${top3.toFixed(1)}%` : ''}`);

  if (scan.topHolders.length) {
    lines.push('\n*Top Holders:*');
    scan.topHolders.slice(0, 5).forEach((h, i) =>
      lines.push(`  ${i + 1}. \`${truncAddr(h.address)}\` — ${h.pct.toFixed(2)}%`)
    );
  }

  if (scan.bondingCurveState) {
    const bc = scan.bondingCurveState;
    lines.push(`\n📊 *On Bonding Curve — ${bc.launchpad}*`);
    if (bc.suiRaised > 0 && bc.threshold) {
      const pct = ((bc.suiRaised / bc.threshold) * 100).toFixed(1);
      lines.push(`Progress: ${bc.suiRaised} / ${bc.threshold} SUI (${pct}%)`);
    }
    lines.push(`Will graduate to: ${bc.destinationDex}`);
    lines.push(`⚠️ Not yet on any DEX`);
  } else {
    lines.push('\n*Liquidity:*');
    if (scan.pools.length) {
      scan.pools.slice(0, 4).forEach(p =>
        lines.push(`  • ${p.dex}: ${p.liquidity > 0 ? p.liquidity.toFixed(2) + ' SUI' : 'Available (aggregated)'}`)
      );
      lines.push(`Total: ${scan.totalLiquiditySui.toFixed(2)} SUI`);
    } else {
      lines.push('  ❌ No pools found');
    }
  }

  lines.push(`\n🍯 Honeypot check: ${scan.honeypotPass === true ? '✅ Can sell' : scan.honeypotPass === false ? '❌ CANNOT SELL' : '⚪ Unknown'}`);
  lines.push(`\n${icons[scan.riskScore] || '⚪'} *Risk Score: ${scan.riskScore}*`);

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// 15. POSITIONS
// ─────────────────────────────────────────────

function addPosition(chatId, pos) {
  const user = getUser(chatId);
  if (!user) return;
  user.positions.push({
    id: randomBytes(4).toString('hex'),
    coinType: pos.coinType,
    symbol: pos.symbol,
    entryPriceSui: pos.entryPriceSui || 0,
    amountTokens: pos.amountTokens || 0,
    spentSui: pos.spentSui,
    tp: pos.tp || null,
    sl: pos.sl || null,
    source: pos.source || 'dex',
    launchpad: pos.launchpad || null,
    openedAt: Date.now(),
  });
  saveUsers();
}

async function getPositionPnl(pos) {
  if (pos.source === 'bonding_curve' || pos.amountTokens <= 0) return null;
  try {
    const k = await sdk7k();
    const tokenAmt = BigInt(Math.floor(pos.amountTokens * 1e9));
    const q = await k.getQuote({ tokenIn: pos.coinType, tokenOut: SUI_TYPE, amountIn: tokenAmt.toString() });
    if (!q || !q.outAmount) return null;
    const currentSui = Number(q.outAmount) / 1e9;
    const pnl        = currentSui - pos.spentSui;
    const pnlPct     = (pnl / pos.spentSui) * 100;
    return { currentSui, pnl, pnlPct };
  } catch { return null; }
}

// ─────────────────────────────────────────────
// 16. POSITION MONITOR (TP/SL)
// ─────────────────────────────────────────────

async function positionMonitor() {
  while (true) {
    await sleep(30_000);
    for (const [uid, user] of Object.entries(usersDB)) {
      if (!user.walletAddress || !user.positions?.length || isLocked(user)) continue;
      for (const pos of [...user.positions]) {
        if (pos.source === 'bonding_curve') continue;
        try {
          const pnl = await getPositionPnl(pos);
          if (!pnl) continue;
          let reason = '';
          if (pos.tp && pnl.pnlPct >= pos.tp)        reason = `✅ Take Profit +${pnl.pnlPct.toFixed(2)}%`;
          else if (pos.sl && pnl.pnlPct <= -pos.sl)  reason = `🛑 Stop Loss ${pnl.pnlPct.toFixed(2)}%`;
          if (!reason) continue;
          try {
            const res = await executeSell(uid, pos.coinType, 100);
            bot.sendMessage(uid, `${reason}\n\nToken: ${pos.symbol}\nP&L: ${pnl.pnl > 0 ? '+' : ''}${pnl.pnl.toFixed(4)} SUI\n\n🔗 [TX](${SUISCAN_TX}${res.digest})`, { parse_mode: 'Markdown' });
          } catch (e) {
            bot.sendMessage(uid, `⚠️ Auto-sell failed for ${pos.symbol}: ${e.message?.slice(0, 80)}`);
          }
        } catch {}
      }
    }
  }
}

// ─────────────────────────────────────────────
// 17. SNIPER ENGINE
// Watches for:
//   - New DEX pools (7K starts returning a route)
//   - New bonding curve tokens on launchpads
//   - Graduation events (bonding curve → DEX)
// ─────────────────────────────────────────────

async function sniperEngine() {
  while (true) {
    await sleep(2_000);
    for (const [uid, user] of Object.entries(usersDB)) {
      if (!user.snipeWatches?.length || isLocked(user)) continue;
      for (const watch of [...user.snipeWatches]) {
        if (watch.triggered) continue;
        try {
          // Clear state cache so we get fresh detection
          stateCache.delete(watch.coinType);
          const state = await detectTokenState(watch.coinType);

          let fire = false;
          if (watch.mode === 'graduation') {
            fire = state.state === 'graduated';
          } else {
            // 'any': fire on bonding curve launch OR DEX pool
            fire = state.state === 'graduated' || state.state === 'bonding_curve';
          }

          if (!fire) continue;

          watch.triggered = true;
          saveUsers();

          const stateLabel = state.state === 'bonding_curve'
            ? `📊 Bonding curve (${state.launchpadName})`
            : `✅ DEX pool found (${state.dex || 'aggregator'})`;

          bot.sendMessage(uid,
            `⚡ *Snipe triggered!*\n\nToken: \`${truncAddr(watch.coinType)}\`\n${stateLabel}\n\nBuying ${watch.buyAmount} SUI...`,
            { parse_mode: 'Markdown' }
          );

          try {
            const res = await executeBuy(uid, watch.coinType, watch.buyAmount);
            bot.sendMessage(uid,
              `⚡ *Sniped!*\n\nToken: ${res.symbol}\nSpent: ${watch.buyAmount} SUI\nFee: ${res.feeSui} SUI\nRoute: ${res.route}\n${res.state === 'bonding_curve' ? `📊 On ${res.launchpadName}\n` : ''}\n🔗 [View TX](${SUISCAN_TX}${res.digest})`,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {
            bot.sendMessage(uid, `❌ Snipe buy failed: ${e.message?.slice(0, 120)}`);
          }
        } catch {}
      }
    }
  }
}

// ─────────────────────────────────────────────
// 18. COPY TRADER ENGINE
// Polls tracked wallets every 5s for new swap events
// ─────────────────────────────────────────────

const copyLastSeen = {};

async function copyTraderEngine() {
  while (true) {
    await sleep(5_000);

    // Build map: wallet → list of watchers
    const watchMap = new Map();
    for (const [uid, user] of Object.entries(usersDB)) {
      if (!user.copyTraders?.length || isLocked(user)) continue;
      for (const ct of user.copyTraders) {
        if (!watchMap.has(ct.wallet)) watchMap.set(ct.wallet, []);
        watchMap.get(ct.wallet).push({ user, config: ct, uid });
      }
    }

    for (const [wallet, watchers] of watchMap) {
      try {
        const txs = await suiClient.queryTransactionBlocks({
          filter: { FromAddress: wallet },
          limit: 5,
          order: 'descending',
          options: { showEffects: true, showEvents: true },
        });

        const lastSeen = copyLastSeen[wallet];
        const newTxs   = lastSeen
          ? txs.data.filter(t => t.digest !== lastSeen)
          : txs.data.slice(0, 1);
        if (txs.data.length > 0) copyLastSeen[wallet] = txs.data[0].digest;

        for (const tx of newTxs.reverse()) {
          // Detect swap events — look for swap/trade event types
          const events = tx.events || [];
          const swapEv = events.find(e =>
            e.type?.toLowerCase().includes('swap') ||
            e.type?.toLowerCase().includes('trade') ||
            e.type?.toLowerCase().includes('addliquidity') === false
          );
          if (!swapEv) continue;

          const pj = swapEv.parsedJson || {};
          // Extract output coin type from event
          const boughtCoin = pj.coin_type_out || pj.token_out || pj.coin_b_type || pj.coinTypeOut || null;
          if (!boughtCoin || boughtCoin === SUI_TYPE) continue;

          for (const { user, config, uid } of watchers) {
            try {
              if (config.blacklist?.includes(boughtCoin)) continue;
              const holding = await getOwnedCoins(user.walletAddress, boughtCoin);
              if (holding.length > 0) continue;
              if ((user.positions || []).length >= (config.maxPositions || 5)) continue;

              const copyAmt = config.amount || user.settings.copyAmount;
              const amtMist = mistFromSui(copyAmt);
              const { feeMist } = calcFee(amtMist, user);

              bot.sendMessage(uid,
                `🔁 *Copy Trade Triggered*\n\nWallet: \`${truncAddr(wallet)}\`\nBuying: \`${truncAddr(boughtCoin)}\`\nAmount: ${copyAmt} SUI (fee: ${suiFloat(feeMist)} SUI)`,
                { parse_mode: 'Markdown' }
              );

              const res = await executeBuy(uid, boughtCoin, copyAmt);
              bot.sendMessage(uid,
                `✅ *Copy trade executed!*\n\nToken: ${res.symbol}\nFee: ${res.feeSui} SUI\nRoute: ${res.route}\n\n🔗 [TX](${SUISCAN_TX}${res.digest})`,
                { parse_mode: 'Markdown' }
              );
            } catch (e) {
              bot.sendMessage(uid, `❌ Copy trade failed: ${e.message?.slice(0, 100)}`);
            }
          }
        }
      } catch {}
    }
  }
}

// ─────────────────────────────────────────────
// 19. SYMBOL RESOLVER
// ─────────────────────────────────────────────

async function resolveSymbol(ticker) {
  const sym = ticker.replace(/^\$/, '').toUpperCase();
  try {
    const r = await fetchTimeout(`https://api-sui.cetus.zone/v2/sui/tokens?symbol=${sym}`, {}, 5000);
    if (r.ok) {
      const d = await r.json();
      const t = d.data?.[0];
      if (t?.coin_type) return t.coin_type;
    }
  } catch {}
  return null;
}

// ─────────────────────────────────────────────
// 20. TELEGRAM BOT
// ─────────────────────────────────────────────

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });

async function requireUnlocked(chatId, fn) {
  const user = getUser(chatId);
  if (!user?.walletAddress) {
    await bot.sendMessage(chatId, '❌ No wallet set up. Use /start to begin.');
    return;
  }
  if (user.cooldownUntil && Date.now() < user.cooldownUntil) {
    const s = Math.ceil((user.cooldownUntil - Date.now()) / 1000);
    await bot.sendMessage(chatId, `🔒 Cooldown active — try again in ${s}s.`);
    return;
  }
  if (isLocked(user)) {
    updateUser(chatId, { state: 'awaiting_unlock_pin' });
    await bot.sendMessage(chatId, '🔒 Bot locked. Enter your 4-digit PIN to unlock:');
    return;
  }
  updateUser(chatId, { lastActivity: Date.now() });
  try { await fn(user); }
  catch (e) {
    console.error(`Handler [${chatId}]:`, e.message);
    await bot.sendMessage(chatId, `❌ ${e.message?.slice(0, 180) || 'Unknown error'}`);
  }
}

// ── /start
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const param  = sanitize((match[1] || '').trim());
  let user = getUser(chatId);

  if (!user) {
    user = createUser(chatId);
    if (param.startsWith('AGT-')) {
      const referrer = Object.values(usersDB).find(u =>
        u.referralCode === param && u.chatId !== String(chatId)
      );
      if (referrer?.walletAddress) {
        updateUser(chatId, { referredBy: referrer.walletAddress });
        updateUser(referrer.chatId, { referralCount: (referrer.referralCount || 0) + 1 });
        bot.sendMessage(referrer.chatId, `🎉 Someone joined via your referral! You earn 25% of their fees forever.`);
      }
    }
  }

  if (user.walletAddress) {
    await bot.sendMessage(chatId,
      `🤖 *AGENT TRADING BOT*\n\nWelcome back!\nWallet: \`${truncAddr(user.walletAddress)}\`\n\nType /help for all commands.`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await bot.sendMessage(chatId,
      `🤖 *Welcome to AGENT TRADING BOT*\n\n` +
      `Trade any Sui token across all DEXes and launchpads.\n\n` +
      `✅ Cetus, Turbos, Aftermath, Kriya, FlowX & more via 7K aggregator\n` +
      `✅ MovePump, hop.fun, moonbags, Turbos.fun bonding curves\n` +
      `✅ Auto-detects if token is on bonding curve or DEX\n\n` +
      `🔐 AES-256 encrypted keys • PIN lock • Auto-lock after 30min\n\n` +
      `Get started:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔑 Import Wallet', callback_data: 'import_wallet' }],
            [{ text: '✨ Generate New Wallet', callback_data: 'gen_wallet' }],
          ],
        },
      }
    );
  }
});

// ── Callbacks
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;
  await bot.answerCallbackQuery(query.id);

  try {
    if (data === 'import_wallet') {
      updateUser(chatId, { state: 'awaiting_private_key' });
      await bot.sendMessage(chatId,
        `🔑 Send your private key (starts with \`suiprivkey1...\`).\n\n⚠️ Message deleted immediately after processing.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (data === 'gen_wallet') {
      const kp   = new Ed25519Keypair();
      const addr = kp.getPublicKey().toSuiAddress();
      const enc  = encryptKey(kp.getSecretKey());
      updateUser(chatId, { encryptedKey: enc, walletAddress: addr, state: 'awaiting_pin_set' });
      await bot.sendMessage(chatId,
        `✅ *Wallet Generated!*\n\nAddress: \`${addr}\`\n\n⚠️ Fund with SUI before trading.\n\nSet a 4-digit PIN:`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (data.startsWith('confirm_buy:')) {
      const parts    = data.split(':');
      const uid      = parts[1];
      const coinType = parts[2];
      const amt      = parseFloat(parts[3]);
      if (String(chatId) !== uid) return;
      await doConfirmedBuy(chatId, coinType, amt);
      return;
    }

    if (data.startsWith('confirm_sell:')) {
      const parts    = data.split(':');
      const uid      = parts[1];
      const coinType = parts[2];
      const pct      = parseFloat(parts[3]);
      if (String(chatId) !== uid) return;
      await doConfirmedSell(chatId, coinType, pct);
      return;
    }

    if (data === 'cancel') {
      updateUser(chatId, { state: null });
      await bot.sendMessage(chatId, '❌ Cancelled.');
      return;
    }

    if (data.startsWith('slip:')) {
      const val = parseFloat(data.split(':')[1]);
      const u = getUser(chatId);
      if (u) { u.settings.slippage = val; saveUsers(); }
      await bot.sendMessage(chatId, `✅ Slippage set to ${val}%`);
      return;
    }

    if (data.startsWith('confirm_thresh:')) {
      const val = parseFloat(data.split(':')[1]);
      const u = getUser(chatId);
      if (u) { u.settings.confirmThreshold = val; saveUsers(); }
      await bot.sendMessage(chatId, `✅ Confirmation threshold set to ${val} SUI`);
      return;
    }
  } catch (e) {
    await bot.sendMessage(chatId, `❌ ${e.message?.slice(0, 120)}`);
  }
});

// ── Message handler (state machine)
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const text   = sanitize(msg.text);
  const user   = getUser(chatId) || createUser(chatId);
  const state  = user.state;

  // Private key import
  if (state === 'awaiting_private_key') {
    updateUser(chatId, { state: null });
    try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
    try {
      const decoded = decodeSuiPrivateKey(text);
      const kp      = Ed25519Keypair.fromSecretKey(decoded.secretKey);
      const addr    = kp.getPublicKey().toSuiAddress();
      updateUser(chatId, {
        encryptedKey: encryptKey(text),
        walletAddress: addr,
        state: 'awaiting_pin_set',
      });
      await bot.sendMessage(chatId,
        `✅ Wallet imported!\n\nAddress: \`${addr}\`\n🔐 Key encrypted.\n\nSet a 4-digit PIN:`,
        { parse_mode: 'Markdown' }
      );
    } catch {
      await bot.sendMessage(chatId, '❌ Invalid key. Start over with /start.');
    }
    return;
  }

  // PIN set
  if (state === 'awaiting_pin_set') {
    if (!/^\d{4}$/.test(text)) { await bot.sendMessage(chatId, '❌ Must be exactly 4 digits:'); return; }
    updateUser(chatId, { pinHash: hashPin(text), state: null });
    await bot.sendMessage(chatId, `✅ PIN set! Bot auto-locks after 30min inactivity.\n\nUse /help for all commands.`);
    syncToBackend(getUser(chatId));
    return;
  }

  // PIN unlock
  if (state === 'awaiting_unlock_pin') {
    if (!/^\d{4}$/.test(text)) { await bot.sendMessage(chatId, '❌ Enter 4-digit PIN:'); return; }
    if (hashPin(text) === user.pinHash) {
      unlockUser(chatId);
      updateUser(chatId, { state: null, failAttempts: 0, cooldownUntil: 0 });
      await bot.sendMessage(chatId, '🔓 Unlocked! Use /help for all commands.');
    } else {
      const fails = (user.failAttempts || 0) + 1;
      if (fails >= MAX_FAILS) {
        updateUser(chatId, { failAttempts: 0, cooldownUntil: Date.now() + COOLDOWN_MS });
        await bot.sendMessage(chatId, '❌ Too many failed attempts. Locked for 5 minutes.');
      } else {
        updateUser(chatId, { failAttempts: fails });
        await bot.sendMessage(chatId, `❌ Wrong PIN. ${MAX_FAILS - fails} attempts remaining.`);
      }
    }
    return;
  }

  // Snipe amount
  if (state === 'awaiting_snipe_amount') {
    const amt = parseFloat(text);
    if (isNaN(amt) || amt <= 0) { await bot.sendMessage(chatId, '❌ Invalid amount.'); return; }
    const pd = user.pendingData || {};
    user.snipeWatches = user.snipeWatches || [];
    user.snipeWatches.push({
      coinType: pd.snipeToken,
      buyAmount: amt,
      minLiquidity: 1,
      mode: pd.snipeMode || 'any',
      triggered: false,
      addedAt: Date.now(),
    });
    updateUser(chatId, { state: null, pendingData: {}, snipeWatches: user.snipeWatches });
    await bot.sendMessage(chatId,
      `⚡ *Snipe set!*\n\nToken: \`${truncAddr(pd.snipeToken)}\`\nBuy: ${amt} SUI\nMode: ${pd.snipeMode === 'graduation' ? 'Wait for DEX graduation' : 'Any pool or bonding curve'}\n\nWatching...`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Copy trader wallet entry
  if (state === 'awaiting_copytrader_wallet') {
    if (!text.startsWith('0x')) { await bot.sendMessage(chatId, '❌ Invalid wallet address.'); return; }
    user.copyTraders = user.copyTraders || [];
    if (user.copyTraders.length >= 3) {
      await bot.sendMessage(chatId, '❌ Max 3 copy traders. Use /copytrader stop to clear.');
      updateUser(chatId, { state: null });
      return;
    }
    user.copyTraders.push({ wallet: text, amount: user.settings.copyAmount, maxPositions: 5, blacklist: [] });
    updateUser(chatId, { state: null, copyTraders: user.copyTraders });
    await bot.sendMessage(chatId, `✅ Now tracking \`${truncAddr(text)}\`\nAmount: ${user.settings.copyAmount} SUI/trade`, { parse_mode: 'Markdown' });
    return;
  }
});

// ─────────────────────────────────────────────
// COMMAND HANDLERS
// ─────────────────────────────────────────────

// /buy
bot.onText(/\/buy(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const args   = sanitize(match[1] || '');

  await requireUnlocked(chatId, async (user) => {
    if (!args) {
      await bot.sendMessage(chatId,
        `*Buy a Token*\n\nUsage: /buy [address or $TICKER] [SUI amount]\n\nExamples:\n• /buy 0x1234...5678 0.5\n• /buy $AGENT 1\n\n✅ Works on ALL DEXes + bonding curve launchpads\n✅ Auto-detects if token is pre or post graduation`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const parts     = args.split(/\s+/);
    let tokenInput  = parts[0];
    const amountSui = parseFloat(parts[1] || '0.5');

    if (isNaN(amountSui) || amountSui <= 0) {
      await bot.sendMessage(chatId, '❌ Invalid amount. Example: /buy $TOKEN 0.5'); return;
    }

    const loadMsg = await bot.sendMessage(chatId, '🔍 Detecting token and getting best price...');

    let coinType = tokenInput;
    if (!tokenInput.startsWith('0x')) {
      coinType = await resolveSymbol(tokenInput);
      if (!coinType) {
        await bot.editMessageText('❌ Token not found. Use full contract address.', { chat_id: chatId, message_id: loadMsg.message_id });
        return;
      }
    }

    const [state, meta] = await Promise.all([
      detectTokenState(coinType),
      getCoinMeta(coinType),
    ]);
    const symbol = meta?.symbol || truncAddr(coinType);

    const amountMist = mistFromSui(amountSui);
    const { feeMist } = calcFee(amountMist, user);

    let stateInfo = '';
    let quoteInfo = '';

    if (state.state === 'graduated') {
      stateInfo = `✅ Listed on DEX — best price via aggregator`;
      if (state.quote) {
        const estOut = Number(state.quote.outAmount) / Math.pow(10, meta?.decimals || 9);
        quoteInfo = `Est. receive: ~${estOut.toFixed(4)} ${symbol}`;
      }
    } else if (state.state === 'bonding_curve') {
      stateInfo = `📊 On bonding curve — ${state.launchpadName}`;
      if (state.suiRaised > 0 && state.threshold) {
        const pct = ((state.suiRaised / state.threshold) * 100).toFixed(1);
        stateInfo += `\nProgress: ${state.suiRaised}/${state.threshold} SUI (${pct}%)`;
        stateInfo += `\nGraduates to: ${state.destinationDex}`;
      }
      quoteInfo = `Buys direct from launchpad contract`;
    } else {
      stateInfo = `⚠️ Token state unknown — will try all DEXes`;
      quoteInfo = `May fail if no liquidity exists`;
    }

    const quoteText =
      `💰 *Buy Quote*\n\n` +
      `Token: *${symbol}*\n` +
      `Contract: \`${truncAddr(coinType)}\`\n\n` +
      `${stateInfo}\n\n` +
      `Trade: ${amountSui} SUI\n` +
      `Fee (1%): ${suiFloat(feeMist)} SUI\n` +
      (quoteInfo ? `${quoteInfo}\n` : '') +
      `Slippage: ${user.settings.slippage}%`;

    if (amountSui >= user.settings.confirmThreshold) {
      await bot.editMessageText(quoteText, {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Confirm Buy', callback_data: `confirm_buy:${chatId}:${coinType}:${amountSui}` },
            { text: '❌ Cancel',      callback_data: 'cancel' },
          ]],
        },
      });
    } else {
      await bot.editMessageText(quoteText + '\n\n_Amount below threshold — executing..._', {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown',
      });
      await doConfirmedBuy(chatId, coinType, amountSui, loadMsg.message_id);
    }
  });
});

async function doConfirmedBuy(chatId, coinType, amountSui, existingMsgId) {
  const execMsg = existingMsgId
    ? { message_id: existingMsgId }
    : await bot.sendMessage(chatId, '⚡ Executing buy...');

  try {
    const res = await executeBuy(chatId, coinType, amountSui);
    const text =
      `✅ *Buy Executed!*\n\n` +
      `Token: *${res.symbol}*\n` +
      `Spent: ${amountSui} SUI\n` +
      `Fee: ${res.feeSui} SUI\n` +
      (res.estOut !== '?' ? `Received: ~${res.estOut} ${res.symbol}\n` : '') +
      `Route: ${res.route}\n` +
      (res.state === 'bonding_curve'
        ? `📊 Bought on ${res.launchpadName} bonding curve\n` +
          (res.progress ? `Progress: ${(res.progress * 100).toFixed(1)}% to graduation\n` : '')
        : '') +
      `\n🔗 [View TX](${SUISCAN_TX}${res.digest})`;
    await bot.editMessageText(text, { chat_id: chatId, message_id: execMsg.message_id, parse_mode: 'Markdown' });
  } catch (e) {
    await bot.editMessageText(`❌ Buy failed: ${e.message?.slice(0, 180)}`, { chat_id: chatId, message_id: execMsg.message_id });
  }
}

// /sell
bot.onText(/\/sell(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const args   = sanitize(match[1] || '');

  await requireUnlocked(chatId, async (user) => {
    if (!args) {
      await bot.sendMessage(chatId,
        `*Sell a Token*\n\nUsage: /sell [address] [% or "all"]\n\nExamples:\n• /sell 0x1234... 50%\n• /sell 0x1234... all`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const parts    = args.split(/\s+/);
    const coinType = parts[0];
    const amtStr   = (parts[1] || 'all').toLowerCase().replace('%', '');
    const pct      = amtStr === 'all' ? 100 : parseFloat(amtStr);

    if (isNaN(pct) || pct <= 0 || pct > 100) {
      await bot.sendMessage(chatId, '❌ Invalid percentage. Example: /sell 0x... 50'); return;
    }

    const loadMsg = await bot.sendMessage(chatId, '🔍 Checking balance and state...');

    const coins = await getOwnedCoins(user.walletAddress, coinType).catch(() => []);
    if (!coins.length) {
      await bot.editMessageText('❌ No balance of this token.', { chat_id: chatId, message_id: loadMsg.message_id });
      return;
    }

    const [state, meta] = await Promise.all([detectTokenState(coinType), getCoinMeta(coinType)]);
    const symbol = meta?.symbol || truncAddr(coinType);

    const totalBal   = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
    const sellAmt    = (totalBal * BigInt(Math.floor(pct))) / 100n;
    const displayAmt = (Number(sellAmt) / Math.pow(10, meta?.decimals || 9)).toFixed(4);

    const stateLabel = state.state === 'bonding_curve'
      ? `📊 On ${state.launchpadName} — sells to bonding curve contract`
      : `✅ DEX — best price via 7K aggregator`;

    const quoteText =
      `💸 *Sell Quote*\n\n` +
      `Token: *${symbol}*\n` +
      `Selling: ${pct}% (${displayAmt} ${symbol})\n` +
      `${stateLabel}\n` +
      `Slippage: ${user.settings.slippage}%`;

    await bot.editMessageText(quoteText, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Confirm Sell', callback_data: `confirm_sell:${chatId}:${coinType}:${pct}` },
          { text: '❌ Cancel',       callback_data: 'cancel' },
        ]],
      },
    });
  });
});

async function doConfirmedSell(chatId, coinType, pct) {
  const execMsg = await bot.sendMessage(chatId, '⚡ Executing sell...');
  try {
    const res = await executeSell(chatId, coinType, pct);
    await bot.editMessageText(
      `✅ *Sell Executed!*\n\nToken: ${res.symbol}\nSold: ${res.pct}%\nRoute: ${res.route}\nEst. SUI: ${res.estSui}\nFee: ${res.feeSui} SUI\n\n🔗 [View TX](${SUISCAN_TX}${res.digest})`,
      { chat_id: chatId, message_id: execMsg.message_id, parse_mode: 'Markdown' }
    );
  } catch (e) {
    await bot.editMessageText(`❌ Sell failed: ${e.message?.slice(0, 180)}`, { chat_id: chatId, message_id: execMsg.message_id });
  }
}

// /scan
bot.onText(/\/scan(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const ct = sanitize(match[1] || '');
  if (!ct) {
    await bot.sendMessage(chatId, `*Token Scanner*\n\nUsage: /scan [contract address]`, { parse_mode: 'Markdown' });
    return;
  }
  const m = await bot.sendMessage(chatId, '🔍 Scanning token...');
  try {
    const scan = await scanToken(ct);
    await bot.editMessageText(formatScanReport(scan), { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' });
  } catch (e) {
    await bot.editMessageText(`❌ Scan failed: ${e.message?.slice(0, 100)}`, { chat_id: chatId, message_id: m.message_id });
  }
});

// /balance
bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id;
  await requireUnlocked(chatId, async (user) => {
    const m = await bot.sendMessage(chatId, '💰 Fetching balances...');
    try {
      const bals   = await getAllBalances(user.walletAddress);
      const suiBal = bals.find(b => b.coinType === SUI_TYPE);
      const lines  = [`💼 *Wallet Balances*\n\`${truncAddr(user.walletAddress)}\`\n`];
      lines.push(`🔵 SUI: ${suiBal ? suiFloat(suiBal.totalBalance) : '0.0000'}`);
      const others = bals.filter(b => b.coinType !== SUI_TYPE && Number(b.totalBalance) > 0);
      for (const bal of others.slice(0, 15)) {
        const meta = await getCoinMeta(bal.coinType).catch(() => null);
        const sym  = meta?.symbol || truncAddr(bal.coinType);
        const amt  = (Number(bal.totalBalance) / Math.pow(10, meta?.decimals || 9)).toFixed(4);
        lines.push(`• ${sym}: ${amt}`);
      }
      if (!others.length) lines.push('\n_No other tokens._');
      await bot.editMessageText(lines.join('\n'), { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' });
    } catch (e) {
      await bot.editMessageText(`❌ ${e.message?.slice(0, 100)}`, { chat_id: chatId, message_id: m.message_id });
    }
  });
});

// /positions
bot.onText(/\/positions/, async (msg) => {
  const chatId = msg.chat.id;
  await requireUnlocked(chatId, async (user) => {
    if (!user.positions?.length) { await bot.sendMessage(chatId, '📊 No open positions.'); return; }
    const m = await bot.sendMessage(chatId, '📊 Loading positions...');
    const lines = ['📊 *Open Positions*\n'];
    for (const pos of user.positions) {
      const pnl    = await getPositionPnl(pos);
      const pnlStr = pnl ? `${pnl.pnl >= 0 ? '+' : ''}${pnl.pnl.toFixed(4)} SUI (${pnl.pnlPct >= 0 ? '+' : ''}${pnl.pnlPct.toFixed(2)}%)` : 'N/A';
      const em     = pnl ? (pnl.pnl >= 0 ? '🟢' : '🔴') : (pos.source === 'bonding_curve' ? '📊' : '⚪');
      lines.push(
        `${em} *${pos.symbol}*\n` +
        `  Spent: ${pos.spentSui} SUI\n` +
        `  P&L: ${pnlStr}\n` +
        `  TP: ${pos.tp ? pos.tp + '%' : 'None'} | SL: ${pos.sl ? pos.sl + '%' : 'None'}` +
        (pos.source === 'bonding_curve' ? `\n  📊 ${pos.launchpad}` : '')
      );
    }
    await bot.editMessageText(lines.join('\n\n'), { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' });
  });
});

// /snipe
bot.onText(/\/snipe(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  await requireUnlocked(chatId, async (user) => {
    const token = sanitize(match[1] || '');
    if (!token) {
      await bot.sendMessage(chatId,
        `⚡ *Sniper*\n\nUsage: /snipe [token address]\n\nBot buys the instant:\n• A bonding curve is created on any launchpad\n• OR a DEX pool appears\n• OR a launchpad token graduates to DEX\n\nExample:\n/snipe 0x1234...5678`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    const pd = user.pendingData || {};
    pd.snipeToken = token;
    pd.snipeMode  = 'any';
    updateUser(chatId, { state: 'awaiting_snipe_amount', pendingData: pd });
    await bot.sendMessage(chatId,
      `Token: \`${truncAddr(token)}\`\n\nHow much SUI to buy when found? (e.g. 0.5)`,
      { parse_mode: 'Markdown' }
    );
  });
});

// /copytrader
bot.onText(/\/copytrader(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  await requireUnlocked(chatId, async (user) => {
    const arg = sanitize(match[1] || '').toLowerCase();

    if (arg === 'stop') {
      updateUser(chatId, { copyTraders: [] });
      await bot.sendMessage(chatId, '✅ All copy traders stopped.');
      return;
    }

    if (!arg || arg === 'list') {
      if (!user.copyTraders?.length) {
        await bot.sendMessage(chatId,
          `🔁 *Copy Trader*\n\nNo wallets tracked.\n\nUsage: /copytrader [wallet address]\nStop all: /copytrader stop`,
          { parse_mode: 'Markdown' }
        );
      } else {
        const lines = user.copyTraders.map((ct, i) =>
          `${i + 1}. \`${truncAddr(ct.wallet)}\` — ${ct.amount} SUI/trade`
        ).join('\n');
        await bot.sendMessage(chatId,
          `🔁 *Copy Traders (${user.copyTraders.length}/3)*\n\n${lines}\n\nStop all: /copytrader stop`,
          { parse_mode: 'Markdown' }
        );
      }
      return;
    }

    if (arg.startsWith('0x')) {
      user.copyTraders = user.copyTraders || [];
      if (user.copyTraders.length >= 3) {
        await bot.sendMessage(chatId, '❌ Max 3 copy traders. Use /copytrader stop first.'); return;
      }
      user.copyTraders.push({ wallet: arg, amount: user.settings.copyAmount, maxPositions: 5, blacklist: [] });
      updateUser(chatId, { copyTraders: user.copyTraders });
      await bot.sendMessage(chatId,
        `✅ Now tracking: \`${truncAddr(arg)}\`\nAmount: ${user.settings.copyAmount} SUI per trade\n\nStop: /copytrader stop`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    updateUser(chatId, { state: 'awaiting_copytrader_wallet' });
    await bot.sendMessage(chatId, 'Enter the wallet address to copy:');
  });
});

// /settings
bot.onText(/\/settings/, async (msg) => {
  const chatId = msg.chat.id;
  await requireUnlocked(chatId, async (user) => {
    const s = user.settings;
    await bot.sendMessage(chatId,
      `⚙️ *Settings*\n\nSlippage: ${s.slippage}%\nConfirm trades ≥: ${s.confirmThreshold} SUI\nCopy amount: ${s.copyAmount} SUI\nTP default: ${s.tpDefault || 'None'}\nSL default: ${s.slDefault || 'None'}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '0.5% slip', callback_data: 'slip:0.5' },
              { text: '1% slip',   callback_data: 'slip:1'   },
              { text: '2% slip',   callback_data: 'slip:2'   },
              { text: '5% slip',   callback_data: 'slip:5'   },
            ],
            [
              { text: 'Confirm ≥0.1 SUI', callback_data: 'confirm_thresh:0.1' },
              { text: 'Confirm ≥0.5 SUI', callback_data: 'confirm_thresh:0.5' },
              { text: 'Confirm ≥1 SUI',   callback_data: 'confirm_thresh:1'   },
              { text: 'Confirm ≥5 SUI',   callback_data: 'confirm_thresh:5'   },
            ],
          ],
        },
      }
    );
  });
});

// /referral
bot.onText(/\/referral/, async (msg) => {
  const chatId = msg.chat.id;
  const user   = getUser(chatId) || createUser(chatId);
  const link   = `https://t.me/AGENTTRADINBOT?start=${user.referralCode}`;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const active = Object.values(usersDB).filter(u =>
    u.referredBy === user.walletAddress && u.lastActivity > cutoff
  ).length;
  await bot.sendMessage(chatId,
    `🔗 *Referral Dashboard*\n\n` +
    `Code: \`${user.referralCode}\`\n` +
    `Link: \`${link}\`\n\n` +
    `👥 Total referrals: ${user.referralCount || 0}\n` +
    `⚡ Active last 30d: ${active}\n` +
    `💰 Total earned: ${(user.referralEarningsTotal || 0).toFixed(4)} SUI\n\n` +
    `*Share to earn 25% of all your referrals' fees — forever, paid on-chain in every trade.*`,
    { parse_mode: 'Markdown' }
  );
});

// /help
bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `🤖 *AGENT TRADING BOT*\n\n` +
    `*Trading*\n` +
    `/buy [token] [SUI] — Buy on best DEX or bonding curve\n` +
    `/sell [token] [% or all] — Sell via best route\n\n` +
    `*Advanced*\n` +
    `/snipe [token] — Auto-buy on pool creation or launchpad launch\n` +
    `/copytrader [wallet] — Mirror a wallet's buys\n\n` +
    `*Info*\n` +
    `/scan [address] — Full token safety scan\n` +
    `/balance — All wallet balances\n` +
    `/positions — Open positions & P&L\n\n` +
    `*Account*\n` +
    `/referral — Your referral link & earnings\n` +
    `/settings — Slippage, confirm threshold\n\n` +
    `*Supported DEXes (via 7K aggregator)*\n` +
    `Cetus • Turbos • Aftermath • Kriya • FlowX • DeepBook • BlueMove\n\n` +
    `*Supported Launchpads (bonding curves)*\n` +
    `MovePump • hop.fun • moonbags • Turbos.fun • blast.fun\n\n` +
    `*Fees*\n` +
    `• 1% on all trades — collected on-chain in same TX\n` +
    `• Refer friends → earn 25% of their fees forever`,
    { parse_mode: 'Markdown' }
  );
});

// ─────────────────────────────────────────────
// ERROR & STARTUP
// ─────────────────────────────────────────────

bot.on('polling_error', (e) => {
  console.error('Polling error:', e.message);
  if (ADMIN_CHAT_ID) bot.sendMessage(ADMIN_CHAT_ID, `⚠️ Poll error: ${e.message?.slice(0, 150)}`).catch(() => {});
});

process.on('uncaughtException', (e) => {
  console.error('Uncaught exception:', e);
  if (ADMIN_CHAT_ID) bot.sendMessage(ADMIN_CHAT_ID, `🚨 Crash: ${e.message?.slice(0, 150)}`).catch(() => {});
});

process.on('unhandledRejection', (r) => console.error('Unhandled rejection:', r));

async function main() {
  if (!TG_BOT_TOKEN)                          throw new Error('TG_BOT_TOKEN is required');
  if (!ENCRYPT_KEY || ENCRYPT_KEY.length !== 64) throw new Error('ENCRYPT_KEY must be 64 hex chars (32 bytes). Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');

  loadUsers();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  AGENT TRADING BOT v2 — Starting');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Users loaded: ${Object.keys(usersDB).length}`);
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Dev wallet: ${truncAddr(DEV_WALLET)}`);
  console.log(`Fee: ${FEE_BPS / 100}% (referrer share: ${REF_SHARE * 100}%)`);

  // Pre-warm SDKs
  console.log('Initializing SDKs...');
  await sdk7k().then(() => console.log('  ✅ 7K Aggregator SDK')).catch(e => console.warn('  ⚠️ 7K SDK:', e.message));
  await sdkCetus().then(() => console.log('  ✅ Cetus CLMM SDK')).catch(e => console.warn('  ⚠️ Cetus SDK:', e.message));
  await sdkTurbos().then(() => console.log('  ✅ Turbos SDK')).catch(e => console.warn('  ⚠️ Turbos SDK:', e.message));

  // Background loops
  setInterval(checkInactivity, 60_000);
  positionMonitor().catch(e => console.error('Position monitor crashed:', e));
  sniperEngine().catch(e => console.error('Sniper crashed:', e));
  copyTraderEngine().catch(e => console.error('Copy trader crashed:', e));

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Bot is live. Listening for messages...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (ADMIN_CHAT_ID) {
    bot.sendMessage(ADMIN_CHAT_ID, '🟢 AGENT TRADING BOT v2 is online.').catch(() => {});
  }
}

main().catch(e => { console.error('Fatal startup error:', e); process.exit(1); });
