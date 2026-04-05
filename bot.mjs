/**
 * AGENT TRADING BOT — bot.mjs v3
 * Fixed: scan (GeckoTerminal API), button data invalid, buy/sell UX,
 *        PnL images via QuickChart, proper amount/percent selection flows
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
const ENCRYPT_KEY   = process.env.ENCRYPT_KEY   || '';
const RPC_URL       = process.env.RPC_URL       || 'https://fullnode.mainnet.sui.io:443';
const BACKEND_URL   = process.env.BACKEND_URL   || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';

const DEV_WALLET   = '0x9e0ac3152f035e411164b24c8db59b3f0ee870340ec754ae5f074559baaa15b1';
const FEE_BPS      = 100;
const REF_SHARE    = 0.25;
const MIST_PER_SUI = 1_000_000_000n;
const SUI_TYPE     = '0x2::sui::SUI';
const STORAGE_FILE = './users.json';
const LOCK_TIMEOUT = 30 * 60 * 1000;
const MAX_FAILS    = 3;
const COOLDOWN_MS  = 5 * 60 * 1000;
const SUISCAN_TX   = 'https://suiscan.xyz/mainnet/tx/';
const GECKO_BASE   = 'https://api.geckoterminal.com/api/v2';
const GECKO_NET    = 'sui-network';

const LAUNCHPAD_REGISTRY = {
  MOVEPUMP:  { name: 'MovePump',   apiBase: 'https://movepump.com/api',          graduationSui: 2000, destinationDex: 'Cetus',  buyFn: 'buy', sellFn: 'sell' },
  TURBOS_FUN:{ name: 'Turbos.fun', apiBase: 'https://api.turbos.finance/fun',     graduationSui: 6000, destinationDex: 'Turbos', buyFn: 'buy', sellFn: 'sell' },
  HOP_FUN:   { name: 'hop.fun',    apiBase: 'https://api.hop.ag',                 graduationSui: null, destinationDex: 'Cetus',  buyFn: 'buy', sellFn: 'sell' },
  MOONBAGS:  { name: 'MoonBags',   apiBase: 'https://api.moonbags.io',            graduationSui: null, destinationDex: 'Cetus',  buyFn: 'buy', sellFn: 'sell' },
  BLAST_FUN: { name: 'blast.fun',  apiBase: 'https://api.blast.fun',              graduationSui: null, destinationDex: 'Cetus',  buyFn: 'buy', sellFn: 'sell' },
};

// Default buy amounts shown as quick buttons (user can customise)
const DEFAULT_BUY_AMOUNTS = [0.5, 1, 3, 5];

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

// NOTE: decryptKey is handled inline in getKeypair below (correct param order: key then iv)

function hashPin(pin) { return createHash('sha256').update(pin + ENCRYPT_KEY).digest('hex'); }

function generateReferralCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let c = 'AGT-';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>&"'`]/g, '').trim().slice(0, 300);
}

function truncAddr(addr) {
  if (!addr || addr.length < 12) return addr || '';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function suiFloat(mist) { return (Number(BigInt(mist)) / Number(MIST_PER_SUI)).toFixed(4); }
function mistFromSui(sui) { return BigInt(Math.floor(parseFloat(sui) * Number(MIST_PER_SUI))); }
function packageFromCoinType(ct) { return ct.split('::')[0]; }
function moduleFromCoinType(ct)  { return ct.split('::')[1] || ''; }

// ─────────────────────────────────────────────
// 3. USER STORAGE
// ─────────────────────────────────────────────

let usersDB = {};

function loadUsers() {
  if (existsSync(STORAGE_FILE)) {
    try { usersDB = JSON.parse(readFileSync(STORAGE_FILE, 'utf8')); } catch { usersDB = {}; }
  }
}

function saveUsers() { writeFileSync(STORAGE_FILE, JSON.stringify(usersDB, null, 2)); }
function getUser(chatId) { return usersDB[String(chatId)] || null; }

function createUser(chatId, extras = {}) {
  const uid = String(chatId);
  usersDB[uid] = {
    chatId: uid,
    encryptedKey: null, walletAddress: null, pinHash: null, lockedAt: null,
    lastActivity: Date.now(), failAttempts: 0, cooldownUntil: 0,
    positions: [], copyTraders: [], snipeWatches: [],
    settings: {
      slippage: 1, confirmThreshold: 0.5,
      copyAmount: 0.1, tpDefault: null, slDefault: null,
      buyAmounts: [...DEFAULT_BUY_AMOUNTS],
    },
    referralCode: generateReferralCode(),
    referredBy: null, referralCount: 0, referralEarningsTotal: 0,
    state: null, pendingData: {},
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
      const [p, c] = k.split('.');
      if (!usersDB[uid][p]) usersDB[uid][p] = {};
      usersDB[uid][p][c] = v;
    } else { usersDB[uid][k] = v; }
  }
  usersDB[uid].lastActivity = Date.now();
  saveUsers();
}

function isLocked(user) { return !!(user?.pinHash && user?.lockedAt); }
function lockUser(chatId)   { updateUser(chatId, { lockedAt: Date.now() }); }
function unlockUser(chatId) { updateUser(chatId, { lockedAt: null, failAttempts: 0 }); }

function checkInactivity() {
  const now = Date.now();
  for (const [uid, user] of Object.entries(usersDB)) {
    if (user.pinHash && !user.lockedAt && user.walletAddress && now - user.lastActivity > LOCK_TIMEOUT) lockUser(uid);
  }
}

async function syncToBackend(user) {
  if (!BACKEND_URL) return;
  try {
    await fetchTimeout(`${BACKEND_URL}/api/bot-user`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: user.chatId, walletAddress: user.walletAddress, referralCode: user.referralCode }),
    });
  } catch {}
}

// ─────────────────────────────────────────────
// 4. SUI CLIENT
// ─────────────────────────────────────────────

const suiClient = new SuiClient({ url: RPC_URL });

async function fetchTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ctrl.signal }); clearTimeout(t); return r; }
  catch (e) { clearTimeout(t); throw e; }
}

async function getCoinMeta(coinType) {
  try { return await suiClient.getCoinMetadata({ coinType }); } catch { return null; }
}

async function getOwnedCoins(address, coinType) {
  const r = await suiClient.getCoins({ owner: address, coinType }); return r.data;
}

async function getAllBalances(address) { return suiClient.getAllBalances({ owner: address }); }

function getKeypair(user) {
  const stored = user.encryptedKey;
  const parts  = stored.split(':');
  const keyBuf = Buffer.from(ENCRYPT_KEY, 'hex');
  const dec    = createDecipheriv('aes-256-cbc', keyBuf, Buffer.from(parts[0], 'hex'));
  const pk     = Buffer.concat([dec.update(Buffer.from(parts[1], 'hex')), dec.final()]).toString('utf8');
  return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(pk).secretKey);
}

// ─────────────────────────────────────────────
// 5. SDK SINGLETONS
// ─────────────────────────────────────────────

let _7k = null;
async function sdk7k() {
  if (_7k) return _7k;
  const mod = await import('@7kprotocol/sdk-ts');
  // Handle CJS interop — named exports may be on mod or mod.default
  const lib = (mod.default && typeof mod.default === 'object') ? mod.default : mod;
  const setSC  = typeof mod.setSuiClient === 'function' ? mod.setSuiClient
               : typeof lib.setSuiClient === 'function' ? lib.setSuiClient
               : null;
  if (setSC) setSC(suiClient);
  const getQuote = mod.getQuote ?? lib.getQuote;
  const buildTx  = mod.buildTx  ?? lib.buildTx;
  if (!getQuote) throw new Error('7K SDK: getQuote not found — check package version');
  _7k = { getQuote, buildTx };
  return _7k;
}

let _cetusSDK = null;
async function sdkCetus(walletAddress) {
  const { initCetusSDK, adjustForSlippage, Percentage, d } = await import('@cetusprotocol/cetus-sui-clmm-sdk');
  if (!_cetusSDK) _cetusSDK = { sdk: initCetusSDK({ network: 'mainnet', fullNodeUrl: RPC_URL }), adjustForSlippage, Percentage, d };
  if (walletAddress) _cetusSDK.sdk.senderAddress = walletAddress;
  return _cetusSDK;
}

let _turbosSDK = null;
async function sdkTurbos() {
  if (_turbosSDK) return _turbosSDK;
  const { TurbosSdk, Network } = await import('turbos-clmm-sdk');
  _turbosSDK = new TurbosSdk(Network.mainnet, suiClient);
  return _turbosSDK;
}

// ─────────────────────────────────────────────
// 6. FEE & REFERRAL
// ─────────────────────────────────────────────

function calcFee(amountMist, user) {
  const feeMist    = (amountMist * BigInt(FEE_BPS)) / 10000n;
  let referrerMist = 0n, devMist = feeMist;
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

// ─────────────────────────────────────────────
// 7. TOKEN STATE DETECTION
// ─────────────────────────────────────────────

const stateCache = new Map();
const STATE_TTL  = 20_000;

async function detectTokenState(coinType) {
  const cached = stateCache.get(coinType);
  if (cached && Date.now() - cached.ts < STATE_TTL) return cached;

  // 1. Try 7K quote — fastest signal of DEX tradability
  try {
    const k = await sdk7k();
    const q = await k.getQuote({ tokenIn: SUI_TYPE, tokenOut: coinType, amountIn: '1000000000' });
    if (q && q.outAmount && BigInt(q.outAmount) > 0n) {
      const r = { state: 'graduated', quote: q, dex: q.routes?.[0]?.poolType || 'aggregator', ts: Date.now() };
      stateCache.set(coinType, r); return r;
    }
  } catch {}

  // 2. Try Cetus REST API directly for this coin type (catches new/thin tokens 7K ignores)
  try {
    const enc = encodeURIComponent(coinType);
    const r = await fetchTimeout(`https://api-sui.cetus.zone/v2/sui/pools_info?coin_type=${enc}&page_index=1&page_size=5`, {}, 5000);
    if (r.ok) {
      const d = await r.json();
      const pools = d.data?.list || [];
      if (pools.length > 0) {
        const result = { state: 'graduated', dex: 'Cetus', cetusPools: pools, ts: Date.now() };
        stateCache.set(coinType, result); return result;
      }
    }
  } catch {}

  // 3. GeckoTerminal — if any pool found for this token, it's on a DEX
  try {
    for (const addr of [coinType, packageFromCoinType(coinType)]) {
      const r = await fetchTimeout(
        `${GECKO_BASE}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}/pools?page=1`,
        { headers: { Accept: 'application/json;version=20230302' } }, 5000
      );
      if (r.ok) {
        const d = await r.json();
        if ((d.data || []).length > 0) {
          const dex = d.data[0].relationships?.dex?.data?.id || 'DEX';
          const result = { state: 'graduated', dex, geckoPools: d.data, ts: Date.now() };
          stateCache.set(coinType, result); return result;
        }
      }
    }
  } catch {}

  // 4. Check launchpad bonding curves
  for (const [key, lp] of Object.entries(LAUNCHPAD_REGISTRY)) {
    try {
      let data = null;
      const enc = encodeURIComponent(coinType);
      if (key === 'MOVEPUMP')        { const r = await fetchTimeout(`${lp.apiBase}/token/${enc}`, {}, 4000); if (r.ok) data = await r.json(); }
      else if (key === 'TURBOS_FUN') { const r = await fetchTimeout(`${lp.apiBase}/token?coinType=${enc}`, {}, 4000); if (r.ok) data = await r.json(); }
      else                           { const r = await fetchTimeout(`${lp.apiBase}/token/${enc}`, {}, 4000); if (r.ok) data = await r.json(); }
      if (!data) continue;
      if (!!(data.graduated || data.is_graduated || data.complete || data.migrated)) continue;
      const result = {
        state: 'bonding_curve', launchpad: key, launchpadName: lp.name, destinationDex: lp.destinationDex,
        bondingCurveId: data.bonding_curve_id || data.curveObjectId || data.pool_id || data.bondingCurveId || null,
        packageId: data.package_id || packageFromCoinType(coinType),
        suiRaised: parseFloat(data.sui_raised || 0), threshold: lp.graduationSui,
        currentPrice: parseFloat(data.price || 0), progress: parseFloat(data.progress || 0),
        buyFn: lp.buyFn, sellFn: lp.sellFn, ts: Date.now(),
      };
      stateCache.set(coinType, result); return result;
    } catch {}
  }

  // 5. Cetus SDK scan (last resort — slow but catches everything)
  try {
    const { sdk } = await sdkCetus();
    const cetusRes = await sdk.Pool.getPools([], undefined, 30);
    const match = cetusRes.find(p => p.coinTypeA === coinType || p.coinTypeB === coinType);
    if (match) {
      const result = { state: 'graduated', dex: 'Cetus', pool: match, ts: Date.now() };
      stateCache.set(coinType, result); return result;
    }
  } catch {}

  // Unknown — allow buy attempt anyway (7K will report if truly no liquidity)
  const result = { state: 'unknown', ts: Date.now() };
  stateCache.set(coinType, result); return result;
}

// ─────────────────────────────────────────────
// 8. SWAP VIA 7K AGGREGATOR
// ─────────────────────────────────────────────

async function swapVia7K({ keypair, walletAddress, tokenIn, tokenOut, amountIn, slippagePct, user }) {
  const k = await sdk7k();
  const { feeMist } = calcFee(amountIn, user);
  const tradeMist   = amountIn - feeMist;

  const quoteResponse = await k.getQuote({ tokenIn, tokenOut, amountIn: tradeMist.toString() });
  if (!quoteResponse || !quoteResponse.outAmount || BigInt(quoteResponse.outAmount) === 0n)
    throw new Error('No liquidity found across any DEX for this token.');

  const buildResult = await k.buildTx({
    quoteResponse, accountAddress: walletAddress, slippage: slippagePct / 100,
    commission: { partner: DEV_WALLET, commissionBps: 0 },
  });

  const tx = buildResult.tx;
  const { referrerMist, devMist } = calcFee(amountIn, user);
  const [devCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
  tx.transferObjects([devCoin], tx.pure.address(DEV_WALLET));
  if (referrerMist > 0n && user.referredBy) {
    const [refCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(referrerMist)]);
    tx.transferObjects([refCoin], tx.pure.address(user.referredBy));
    const ref = findReferrer(user);
    if (ref) { ref.referralEarningsTotal = (ref.referralEarningsTotal || 0) + Number(referrerMist) / 1e9; saveUsers(); }
  }
  if (buildResult.coinOut) tx.transferObjects([buildResult.coinOut], tx.pure.address(walletAddress));
  tx.setGasBudget(50_000_000);

  const result = await suiClient.signAndExecuteTransaction({ signer: keypair, transaction: tx, options: { showEffects: true, showEvents: true } });
  if (result.effects?.status?.status !== 'success') throw new Error(`TX failed: ${result.effects?.status?.error || 'unknown'}`);

  return { digest: result.digest, estimatedOut: quoteResponse.outAmount, feeMist, route: quoteResponse.routes?.[0]?.poolType || 'aggregator' };
}

// ─────────────────────────────────────────────
// 9. CETUS DIRECT SWAP
// ─────────────────────────────────────────────

async function swapViaCetus({ keypair, walletAddress, poolId, a2b, amountMist, slippagePct, user }) {
  const { sdk, adjustForSlippage, Percentage, d } = await sdkCetus(walletAddress);
  const pool = await sdk.Pool.getPool(poolId);
  const [metaA, metaB] = await Promise.all([getCoinMeta(pool.coinTypeA), getCoinMeta(pool.coinTypeB)]);
  const preswap = await sdk.Swap.preswap({
    pool, current_sqrt_price: pool.current_sqrt_price,
    coinTypeA: pool.coinTypeA, coinTypeB: pool.coinTypeB,
    decimalsA: metaA?.decimals || 9, decimalsB: metaB?.decimals || 9,
    a2b, by_amount_in: true, amount: new BN(amountMist.toString()),
  });
  const amountLimit = adjustForSlippage(preswap.estimatedAmountOut, Percentage.fromDecimal(d(slippagePct)), false);
  const swapTx = await sdk.Swap.createSwapTransactionPayload({
    pool_id: pool.poolAddress, coinTypeA: pool.coinTypeA, coinTypeB: pool.coinTypeB,
    a2b, by_amount_in: true, amount: preswap.amount.toString(), amount_limit: amountLimit.toString(),
  });
  const { feeMist, devMist, referrerMist } = calcFee(amountMist, user);
  const [devCoin] = swapTx.splitCoins(swapTx.gas, [swapTx.pure.u64(devMist)]);
  swapTx.transferObjects([devCoin], swapTx.pure.address(DEV_WALLET));
  if (referrerMist > 0n && user.referredBy) {
    const [rc] = swapTx.splitCoins(swapTx.gas, [swapTx.pure.u64(referrerMist)]);
    swapTx.transferObjects([rc], swapTx.pure.address(user.referredBy));
  }
  swapTx.setGasBudget(50_000_000);
  const result = await suiClient.signAndExecuteTransaction({ signer: keypair, transaction: swapTx, options: { showEffects: true } });
  if (result.effects?.status?.status !== 'success') throw new Error(`Cetus swap failed: ${result.effects?.status?.error}`);
  return { digest: result.digest, estimatedOut: preswap.estimatedAmountOut, feeMist };
}

// ─────────────────────────────────────────────
// 10. TURBOS DIRECT SWAP
// ─────────────────────────────────────────────

async function swapViaTurbos({ keypair, walletAddress, poolId, coinTypeA, coinTypeB, a2b, amountStr, slippagePct, user }) {
  const tSdk = await sdkTurbos();
  const [swapResult] = await tSdk.trade.computeSwapResultV2({ pools: [{ pool: poolId, a2b, amountSpecified: amountStr }], address: walletAddress });
  if (!swapResult) throw new Error('Turbos: no swap result');
  const tx = await tSdk.trade.swap({
    routes: [{ pool: swapResult.pool, a2b: swapResult.a_to_b, nextTickIndex: tSdk.math.bitsToNumber(swapResult.tick_current_index.bits, 64) }],
    coinTypeA, coinTypeB, address: walletAddress,
    amountA: swapResult.amount_a, amountB: swapResult.amount_b,
    amountSpecifiedIsInput: swapResult.is_exact_in, slippage: String(slippagePct), deadline: 60000,
  });
  const amountMist = BigInt(amountStr);
  const { feeMist, devMist, referrerMist } = calcFee(amountMist, user);
  const [devCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
  tx.transferObjects([devCoin], tx.pure.address(DEV_WALLET));
  if (referrerMist > 0n && user.referredBy) {
    const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(referrerMist)]);
    tx.transferObjects([rc], tx.pure.address(user.referredBy));
  }
  tx.setGasBudget(50_000_000);
  const result = await suiClient.signAndExecuteTransaction({ signer: keypair, transaction: tx, options: { showEffects: true } });
  if (result.effects?.status?.status !== 'success') throw new Error(`Turbos swap failed: ${result.effects?.status?.error}`);
  return { digest: result.digest, estimatedOut: a2b ? swapResult.amount_b : swapResult.amount_a, feeMist };
}

// ─────────────────────────────────────────────
// 11. BONDING CURVE BUY / SELL
// ─────────────────────────────────────────────

async function bondingCurveBuy({ keypair, walletAddress, coinType, suiAmountMist, bondingCurveId, buyFn, user }) {
  const pkgId = packageFromCoinType(coinType), modName = moduleFromCoinType(coinType);
  const tx = new Transaction();
  tx.setGasBudget(30_000_000);
  const { feeMist, devMist, referrerMist } = calcFee(suiAmountMist, user);
  const tradeMist = suiAmountMist - feeMist;
  const [devCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
  tx.transferObjects([devCoin], tx.pure.address(DEV_WALLET));
  if (referrerMist > 0n && user.referredBy) {
    const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(referrerMist)]);
    tx.transferObjects([rc], tx.pure.address(user.referredBy));
    const ref = findReferrer(user);
    if (ref) { ref.referralEarningsTotal = (ref.referralEarningsTotal || 0) + Number(referrerMist) / 1e9; saveUsers(); }
  }
  const [tradeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(tradeMist)]);
  tx.moveCall({ target: `${pkgId}::${modName}::${buyFn}`, typeArguments: [coinType], arguments: [tx.object(bondingCurveId), tradeCoin, tx.object('0x6')] });
  const result = await suiClient.signAndExecuteTransaction({ signer: keypair, transaction: tx, options: { showEffects: true, showEvents: true } });
  if (result.effects?.status?.status !== 'success') throw new Error(`Bonding curve buy failed: ${result.effects?.status?.error}`);
  return { digest: result.digest, feeMist };
}

async function bondingCurveSell({ keypair, walletAddress, coinType, tokenCoins, sellAmountRaw, bondingCurveId, sellFn, user }) {
  const pkgId = packageFromCoinType(coinType), modName = moduleFromCoinType(coinType);
  const tx = new Transaction();
  tx.setGasBudget(30_000_000);
  let tokenObj = tx.object(tokenCoins[0].coinObjectId);
  if (tokenCoins.length > 1) tx.mergeCoins(tokenObj, tokenCoins.slice(1).map(c => tx.object(c.coinObjectId)));
  const [sellCoin] = tx.splitCoins(tokenObj, [tx.pure.u64(sellAmountRaw)]);
  tx.moveCall({ target: `${pkgId}::${modName}::${sellFn}`, typeArguments: [coinType], arguments: [tx.object(bondingCurveId), sellCoin, tx.object('0x6')] });
  const result = await suiClient.signAndExecuteTransaction({ signer: keypair, transaction: tx, options: { showEffects: true, showEvents: true } });
  if (result.effects?.status?.status !== 'success') throw new Error(`Bonding curve sell failed: ${result.effects?.status?.error}`);
  return { digest: result.digest };
}

// ─────────────────────────────────────────────
// 12. UNIFIED BUY / SELL
// ─────────────────────────────────────────────

async function executeBuy(chatId, coinType, amountSui) {
  const user = getUser(chatId);
  if (!user) throw new Error('User not found');
  const keypair    = getKeypair(user);
  const amountMist = mistFromSui(amountSui);
  const state      = await detectTokenState(coinType);
  const meta       = await getCoinMeta(coinType) || {};
  const symbol     = meta.symbol || truncAddr(coinType);

  if (state.state === 'graduated' || state.state === 'unknown') {
    const res = await swapVia7K({ keypair, walletAddress: user.walletAddress, tokenIn: SUI_TYPE, tokenOut: coinType, amountIn: amountMist, slippagePct: user.settings.slippage, user });
    const estTokens  = Number(res.estimatedOut) / Math.pow(10, meta.decimals || 9);
    const entryPrice = Number(amountMist - res.feeMist) / 1e9 / (estTokens || 1);
    addPosition(chatId, { coinType, symbol, entryPriceSui: entryPrice, amountTokens: estTokens, decimals: meta.decimals || 9, spentSui: amountSui, source: 'dex', tp: user.settings.tpDefault, sl: user.settings.slDefault });
    return { digest: res.digest, feeSui: suiFloat(res.feeMist), route: res.route, estOut: estTokens.toFixed(4), symbol, state: 'graduated' };
  }

  if (state.state === 'bonding_curve') {
    if (!state.bondingCurveId) throw new Error(`Found on ${state.launchpadName} but curve ID unavailable. Trade directly on the launchpad.`);
    const res = await bondingCurveBuy({ keypair, walletAddress: user.walletAddress, coinType, suiAmountMist: amountMist, bondingCurveId: state.bondingCurveId, buyFn: state.buyFn || 'buy', user });
    addPosition(chatId, { coinType, symbol, entryPriceSui: state.currentPrice || 0, amountTokens: 0, spentSui: amountSui, source: 'bonding_curve', launchpad: state.launchpadName, tp: null, sl: null });
    return { digest: res.digest, feeSui: suiFloat(res.feeMist), route: state.launchpadName, estOut: '?', symbol, state: 'bonding_curve', launchpadName: state.launchpadName };
  }

  throw new Error('Token not found on any DEX or launchpad. It may have no liquidity yet.');
}

async function executeSell(chatId, coinType, pct) {
  const user = getUser(chatId);
  if (!user) throw new Error('User not found');
  const keypair = getKeypair(user);
  const meta    = await getCoinMeta(coinType) || {};
  const symbol  = meta.symbol || truncAddr(coinType);
  const coins   = await getOwnedCoins(user.walletAddress, coinType);
  if (!coins.length) throw new Error('No balance of this token in your wallet.');
  const totalBal   = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
  const sellAmount = (totalBal * BigInt(Math.floor(pct))) / 100n;
  if (sellAmount === 0n) throw new Error('Sell amount is zero.');
  const state = await detectTokenState(coinType);

  if (state.state === 'graduated' || state.state === 'unknown') {
    const res = await swapVia7K({ keypair, walletAddress: user.walletAddress, tokenIn: coinType, tokenOut: SUI_TYPE, amountIn: sellAmount, slippagePct: user.settings.slippage, user });
    if (pct === 100) updateUser(chatId, { positions: user.positions.filter(p => p.coinType !== coinType) });
    const suiOut = Number(res.estimatedOut) / 1e9;
    const { feeMist } = calcFee(BigInt(res.estimatedOut), user);
    return { digest: res.digest, feeSui: suiFloat(feeMist), route: res.route, estSui: suiOut.toFixed(4), symbol, pct };
  }

  if (state.state === 'bonding_curve') {
    if (!state.bondingCurveId) throw new Error(`Bonding curve ID unavailable for ${state.launchpadName}.`);
    const res = await bondingCurveSell({ keypair, walletAddress: user.walletAddress, coinType, tokenCoins: coins, sellAmountRaw: sellAmount, bondingCurveId: state.bondingCurveId, sellFn: state.sellFn || 'sell', user });
    if (pct === 100) updateUser(chatId, { positions: user.positions.filter(p => p.coinType !== coinType) });
    return { digest: res.digest, feeSui: 'N/A', route: state.launchpadName, estSui: '?', symbol, pct };
  }

  throw new Error('Cannot sell — token not found on any DEX or launchpad.');
}

// ─────────────────────────────────────────────
// 13. POOL DISCOVERY — GeckoTerminal (FIXED)
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// PRICE / AGE / SECURITY HELPERS
// ─────────────────────────────────────────────

function formatPrice(price) {
  if (!price || price === 0) return '$0';
  if (price >= 1)    return `$${price.toFixed(4)}`;
  if (price >= 0.01) return `$${price.toFixed(6)}`;
  const str = price.toFixed(20);
  const dec = str.split('.')[1] || '';
  let zeros = 0;
  for (const c of dec) { if (c === '0') zeros++; else break; }
  if (zeros >= 4) {
    const subs = ['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉'];
    const sub = zeros.toString().split('').map(d => subs[+d]).join('');
    return `$0.0${sub}${dec.slice(zeros, zeros + 4)}`;
  }
  return `$${price.toFixed(zeros + 4)}`;
}

function formatAge(dateStr) {
  if (!dateStr) return null;
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    const hrs  = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    if (days > 0) return `${days}d`;
    if (hrs > 0)  return `${hrs}h ${mins % 60}m`;
    return `${mins}m`;
  } catch { return null; }
}

function fmtChg(pct) {
  if (pct === null || pct === undefined) return 'N/A';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

async function checkMintAuth(coinType) {
  try {
    const res = await suiClient.queryObjects({
      query: { MatchType: `0x2::coin::TreasuryCap<${coinType}>` },
      options: { showOwner: true }, limit: 1,
    });
    if (!res.data?.length) return false;
    return !!(res.data[0].data?.owner?.AddressOwner);
  } catch { return null; }
}

async function getDeployerBalance(coinType, totalSupplyRaw) {
  try {
    const pkgAddr = packageFromCoinType(coinType);
    const txs = await suiClient.queryTransactionBlocks({
      filter: { InputObject: pkgAddr }, limit: 1, order: 'ascending',
      options: { showInput: true },
    });
    const deployer = txs.data?.[0]?.transaction?.data?.sender;
    if (!deployer) return null;
    const coins = await suiClient.getCoins({ owner: deployer, coinType });
    const bal = coins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
    return totalSupplyRaw > 0 ? Number(bal) / totalSupplyRaw * 100 : null;
  } catch { return null; }
}

// Full token data for buy card (all parallel)
async function getFullTokenData(coinType) {
  const [geckoTok, poolsRes, metaRes, supplyRes, holdersRes, mintRes] = await Promise.allSettled([
    getTokenInfoFromGecko(coinType),
    getPoolsForToken(coinType),
    getCoinMeta(coinType),
    suiClient.getTotalSupply({ coinType }).catch(() => null),
    getHolders(coinType),
    checkMintAuth(coinType),
  ]);

  const pools    = poolsRes.value   || [];
  const gi       = geckoTok.value;
  const m        = metaRes.value;
  const s        = supplyRes.value;
  const hd       = holdersRes.value || { total: 0, topHolders: [] };
  const mintAuth = mintRes.value;
  const best     = pools[0];

  const name     = m?.name    || gi?.name    || '?';
  const symbol   = m?.symbol  || gi?.symbol  || '?';
  const decimals = m?.decimals || gi?.decimals || 9;

  let supplyRaw = 0, supplyHuman = 0;
  if (s) { supplyRaw = Number(BigInt(s.value)); supplyHuman = supplyRaw / Math.pow(10, decimals); }
  else if (gi?.rawSupply) { supplyRaw = gi.rawSupply; supplyHuman = gi.rawSupply / Math.pow(10, decimals); }

  const priceUsd = gi?.priceUsd     || best?.priceUsd || 0;
  const mcap     = gi?.marketCapUsd || 0;
  const vol24h   = gi?.volume24h    || best?.volume24h || 0;
  const liqUsd   = pools.reduce((t, p) => t + (p.liquidityUsd || 0), 0);
  const chg24h   = gi?.priceChange24h || best?.priceChange24h || 0;
  const chg1h    = best?.priceChange1h || 0;
  const chg6h    = best?.priceChange6h || 0;
  const chg5m    = best?.priceChange5m || 0;
  const top10pct = hd.topHolders.slice(0, 10).reduce((t, h) => t + h.pct, 0);

  // Honeypot check
  let honeypot = null;
  try { const k = await sdk7k(); const q = await k.getQuote({ tokenIn: coinType, tokenOut: SUI_TYPE, amountIn: '1000000' }); honeypot = !!(q && BigInt(q.outAmount || 0) > 0n); } catch {}

  // Dev balance (non-blocking)
  let devPct = null;
  try { if (supplyRaw > 0) devPct = await getDeployerBalance(coinType, supplyRaw); } catch {}

  return {
    name, symbol, decimals, supplyHuman, supplyRaw,
    priceUsd, mcap, vol24h, liqUsd,
    chg5m, chg1h, chg6h, chg24h,
    pools, best, dex: best?.dex || 'Sui',
    poolAge: best?.createdAt ? formatAge(best.createdAt) : null,
    holders: hd.total, topHolders: hd.topHolders, top10pct,
    mintAuth, honeypot, devPct,
  };
}

function formatBuyCard(info, coinType) {
  const L = [];
  const issues = [
    info.mintAuth === true,
    info.honeypot === false,
    info.devPct !== null && info.devPct > 10,
    info.top10pct > 50,
  ].filter(Boolean).length;

  L.push(`*${info.symbol}/SUI*`);
  L.push(`\`${coinType}\``);
  L.push(`\n🌐 Sui @ ${info.dex}${info.poolAge ? ` | 📍Age: ${info.poolAge}` : ''}`);

  if (info.mcap > 0)    L.push(`📊 MCap: $${fmt(info.mcap)}`);
  if (info.vol24h > 0)  L.push(`💲 Vol: $${fmt(info.vol24h)}`);
  if (info.liqUsd > 0)  L.push(`💧 Liq: $${fmt(info.liqUsd)}`);
  if (info.priceUsd > 0) L.push(`💰 USD: ${formatPrice(info.priceUsd)}`);

  const chgs = [];
  if (info.chg5m)  chgs.push(`5M: ${fmtChg(info.chg5m)}`);
  if (info.chg1h)  chgs.push(`1H: ${fmtChg(info.chg1h)}`);
  if (info.chg6h)  chgs.push(`6H: ${fmtChg(info.chg6h)}`);
  if (info.chg24h) chgs.push(`24H: ${fmtChg(info.chg24h)}`);
  if (chgs.length) L.push(`📉 ${chgs.join(' | ')}`);

  if (info.pools.length > 1) L.push(`🔀 ${info.pools.length} pools — 7K routes to best price`);

  L.push(`\n🛡 *Audit* (Issues: ${issues})`);
  const t = (v, good) => v === null ? '⚪' : v === good ? '✅' : '⚠️';
  L.push(`${t(info.mintAuth,false)} Mint Auth: ${info.mintAuth === null ? '?' : info.mintAuth ? 'Yes ⚠️' : 'No'} | ${t(info.honeypot,true)} Honeypot: ${info.honeypot === null ? '?' : info.honeypot ? 'No' : 'Yes ❌'}`);
  L.push(`${info.top10pct < 30 ? '✅' : '⚠️'} Top 10: ${info.top10pct > 0 ? info.top10pct.toFixed(1)+'%' : '?'} | ${info.devPct !== null ? `${info.devPct < 10 ? '✅' : '⚠️'} Dev: ${info.devPct.toFixed(2)}%` : '⚪ Dev: ?'}`);
  L.push(`\n⛽️ Est. Gas: ~0.010 SUI`);

  return L.join('\n');
}

// 22. POOL DETECTION — Multi-DEX
// GeckoTerminal (all DEXes) + Bluefin + Cetus SDK
// ─────────────────────────────────────────────

async function getPoolsForToken(coinType) {
  const pools = [];
  const seen  = new Set();

  // 1. GeckoTerminal — indexes Cetus, Turbos, Aftermath, Bluefin, Kriya, FlowX, all major Sui DEXes
  try {
    const tryAddrs = [coinType, packageFromCoinType(coinType)];
    for (const addr of tryAddrs) {
      const r = await fetchTimeout(
        `${GECKO_BASE}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}/pools?page=1`,
        { headers: { Accept: 'application/json;version=20230302' } }, 8000
      );
      if (!r.ok) continue;
      const d = await r.json();
      for (const p of (d.data || []).slice(0, 6)) {
        const id = p.attributes?.address || p.id;
        if (seen.has(id)) continue;
        seen.add(id);
        const attr = p.attributes || {};
        const dexId = p.relationships?.dex?.data?.id || attr.dex_id || 'DEX';
        pools.push({
          dex: dexId.charAt(0).toUpperCase() + dexId.slice(1),
          poolId: id,
          liquidityUsd:   parseFloat(attr.reserve_in_usd || 0),
          volume24h:      parseFloat(attr.volume_usd?.h24 || 0),
          priceChange5m:  parseFloat(attr.price_change_percentage?.m5  || 0),
          priceChange1h:  parseFloat(attr.price_change_percentage?.h1  || 0),
          priceChange6h:  parseFloat(attr.price_change_percentage?.h6  || 0),
          priceChange24h: parseFloat(attr.price_change_percentage?.h24 || 0),
          priceNative:    parseFloat(attr.base_token_price_native_currency || 0),
          priceUsd:       parseFloat(attr.base_token_price_usd || 0),
          marketCapUsd:   parseFloat(attr.market_cap_usd || attr.fdv_usd || 0),
          createdAt:      attr.pool_created_at || null,
        });
      }
      if (pools.length > 0) break;
    }
  } catch {}

  // 2. Bluefin — CLMM DEX on Sui (not always indexed by Gecko for new tokens)
  try {
    const enc = encodeURIComponent(coinType);
    const r = await fetchTimeout(`https://dapi.api.sui-prod.bluefin.io/pools?coinType=${enc}`, {}, 5000);
    if (r.ok) {
      const d = await r.json();
      for (const p of (d.data || d || []).slice(0, 3)) {
        const id = p.address || p.poolId || p.id || '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        pools.push({
          dex: 'Bluefin',
          poolId: id,
          liquidityUsd: parseFloat(p.liquidityUSD || p.tvl || 0),
          volume24h: parseFloat(p.volume24h || 0),
          priceChange24h: 0,
          priceNative: parseFloat(p.price || 0),
          priceUsd: 0,
        });
      }
    }
  } catch {}

  // 3. Cetus SDK fallback for tokens not indexed by GeckoTerminal
  if (pools.length === 0) {
    try {
      const { sdk } = await sdkCetus();
      const cetusRes = await sdk.Pool.getPools([], undefined, 30);
      for (const p of cetusRes) {
        if (p.coinTypeA !== coinType && p.coinTypeB !== coinType) continue;
        if (seen.has(p.poolAddress)) continue;
        seen.add(p.poolAddress);
        const suiAmt = p.coinTypeA === SUI_TYPE
          ? Number(p.coinAmountA || 0) / 1e9
          : p.coinTypeB === SUI_TYPE
            ? Number(p.coinAmountB || 0) / 1e9
            : 0;
        pools.push({
          dex: 'Cetus',
          poolId: p.poolAddress,
          liquidityUsd: suiAmt * 3, // rough USD estimate
          volume24h: 0,
          priceChange24h: 0,
          priceNative: 0,
          priceUsd: 0,
        });
      }
    } catch {}
  }

  // 4. 7K quote as existence proof
  if (pools.length === 0) {
    try {
      const k = await sdk7k();
      const q = await k.getQuote({ tokenIn: SUI_TYPE, tokenOut: coinType, amountIn: '1000000000' });
      if (q && BigInt(q.outAmount || 0) > 0n) {
        const dex = q.routes?.[0]?.poolType || 'Aggregator';
        pools.push({ dex, poolId: 'agg', liquidityUsd: 0, volume24h: 0, priceChange24h: 0, priceNative: 0, priceUsd: parseFloat(q.outAmount || 0) / 1e9 / 1 });
      }
    } catch {}
  }

  return pools.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

// ─────────────────────────────────────────────
// 23. GECKO TOKEN INFO (price/market data)
// ─────────────────────────────────────────────

async function getTokenInfoFromGecko(coinType) {
  try {
    const tryAddrs = [coinType, packageFromCoinType(coinType)];
    for (const addr of tryAddrs) {
      const r = await fetchTimeout(
        `${GECKO_BASE}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}`,
        { headers: { 'Accept': 'application/json;version=20230302' } }, 8000
      );
      if (!r.ok) continue;
      const data = await r.json();
      const attr = data.data?.attributes || {};
      if (!attr.name && !attr.symbol) continue;
      return {
        name:         attr.name   || null,
        symbol:       attr.symbol || null,
        decimals:     parseInt(attr.decimals) || 9,
        // GeckoTerminal total_supply = raw units (not human-readable) — caller divides by 10^decimals
        rawSupply:    parseFloat(attr.total_supply || 0),
        priceUsd:     parseFloat(attr.price_usd || 0),
        fdvUsd:       parseFloat(attr.fdv_usd || 0),
        marketCapUsd: parseFloat(attr.market_cap_usd || 0),
        volume24h:    parseFloat(attr.volume_usd?.h24 || 0),
        priceChange24h: parseFloat(attr.price_change_percentage?.h24 || 0),
      };
    }
    return null;
  } catch { return null; }
}

// ─────────────────────────────────────────────
// 24. HOLDERS — Sui GraphQL + multiple fallbacks
// ─────────────────────────────────────────────

async function getHolders(coinType) {
  const empty = { total: 0, topHolders: [] };

  // Attempt 1: Sui GraphQL indexer (Mysten Labs — free, no auth)
  // Returns coin objects grouped by owner — gives real on-chain top holders
  try {
    const gql = `
      query($type: String!) {
        coins(type: $type, first: 50) {
          nodes {
            owner { ... on AddressOwner { owner { address } } }
            balance
          }
        }
      }`;
    const r = await fetchTimeout('https://sui-mainnet.mystenlabs.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gql, variables: { type: coinType } }),
    }, 8000);
    if (r.ok) {
      const d = await r.json();
      const nodes = d.data?.coins?.nodes || [];
      if (nodes.length > 0) {
        // Aggregate by owner address
        const byOwner = {};
        let totalRaw = BigInt(0);
        for (const node of nodes) {
          const addr = node.owner?.owner?.address;
          if (!addr) continue;
          const bal = BigInt(node.balance || 0);
          byOwner[addr] = (byOwner[addr] || BigInt(0)) + bal;
          totalRaw += bal;
        }
        const sorted = Object.entries(byOwner).sort((a, b) => (b[1] > a[1] ? 1 : -1));
        const topHolders = sorted.slice(0, 10).map(([address, bal]) => ({
          address,
          pct: totalRaw > 0n ? Number(bal * 10000n / totalRaw) / 100 : 0,
        }));
        // Get total holder count from GeckoTerminal info endpoint
        let total = sorted.length;
        try {
          for (const addr of [coinType, packageFromCoinType(coinType)]) {
            const ri = await fetchTimeout(`${GECKO_BASE}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}/info`, { headers: { 'Accept': 'application/json;version=20230302' } }, 5000);
            if (ri.ok) { const di = await ri.json(); const h = di.data?.attributes?.holders; if (h) { total = parseInt(h) || total; break; } }
          }
        } catch {}
        return { total, topHolders };
      }
    }
  } catch {}

  // Attempt 2: Blockberry API (no key needed for basic tier)
  try {
    const enc = encodeURIComponent(coinType);
    const r = await fetchTimeout(
      `https://api.blockberry.one/sui/v1/coins/${enc}/holders?page=0&size=10&sortBy=AMOUNT&orderBy=DESC`,
      { headers: { 'Accept': 'application/json', 'Origin': 'https://suiscan.xyz' } }, 7000
    );
    if (r.ok) {
      const d = await r.json();
      const list = d.content || d.data || d.holders || [];
      if (list.length > 0) {
        return {
          total: d.totalElements || d.total || list.length,
          topHolders: list.slice(0, 10).map(h => ({
            address: h.address || h.owner || h.holderAddress || '',
            pct: parseFloat(h.percentage || h.pct || h.sharePercent || 0),
          })),
        };
      }
    }
  } catch {}

  // Attempt 3: GeckoTerminal info — holder count only (no top holders breakdown)
  try {
    for (const addr of [coinType, packageFromCoinType(coinType)]) {
      const r = await fetchTimeout(
        `${GECKO_BASE}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}/info`,
        { headers: { 'Accept': 'application/json;version=20230302' } }, 6000
      );
      if (r.ok) {
        const d = await r.json();
        const holders = d.data?.attributes?.holders;
        if (holders && parseInt(holders) > 0) return { total: parseInt(holders), topHolders: [] };
      }
    }
  } catch {}

  return empty;
}

// ─────────────────────────────────────────────
// 25. SCAN TOKEN (parallel fetches for speed)
// ─────────────────────────────────────────────

async function scanToken(coinType) {
  const scan = {
    coinType, name: '?', symbol: '?', decimals: 9, totalSupply: 0,
    priceUsd: 0, priceNative: 0, fdvUsd: 0, marketCapUsd: 0, volume24h: 0, priceChange24h: 0,
    holders: 0, topHolders: [], pools: [], totalLiquidityUsd: 0,
    honeypotPass: null, riskScore: 'UNKNOWN', bondingCurveState: null,
  };

  // Run data fetches in parallel for speed
  const [geckoInfo, coinMeta, supplyRes, stateRes, holderData, poolData] = await Promise.allSettled([
    getTokenInfoFromGecko(coinType),
    getCoinMeta(coinType),
    suiClient.getTotalSupply({ coinType }).catch(() => null),
    detectTokenState(coinType),
    getHolders(coinType),
    getPoolsForToken(coinType),
  ]);

  // Step 1: on-chain metadata is ground truth for name/symbol/decimals
  const m = coinMeta.status === 'fulfilled' ? coinMeta.value : null;
  if (m) {
    scan.name    = m.name    || '?';
    scan.symbol  = m.symbol  || '?';
    scan.decimals = m.decimals || 9;
  }

  // Step 2: on-chain supply is 100% accurate — always use this first
  const s = supplyRes.status === 'fulfilled' ? supplyRes.value : null;
  if (s) {
    scan.totalSupply = Number(BigInt(s.value)) / Math.pow(10, scan.decimals);
  }

  // Step 3: GeckoTerminal fills price/market data (not supply — their total_supply is raw units)
  const gi = geckoInfo.status === 'fulfilled' ? geckoInfo.value : null;
  if (gi) {
    if (scan.name === '?' && gi.name)    scan.name    = gi.name;
    if (scan.symbol === '?' && gi.symbol) scan.symbol  = gi.symbol;
    // GeckoTerminal total_supply is raw units — divide by decimals to get human amount
    if (!scan.totalSupply && gi.rawSupply > 0) {
      scan.totalSupply = gi.rawSupply / Math.pow(10, scan.decimals);
    }
    scan.priceUsd       = gi.priceUsd;
    scan.fdvUsd         = gi.fdvUsd;
    scan.marketCapUsd   = gi.marketCapUsd;
    scan.volume24h      = gi.volume24h;
    scan.priceChange24h = gi.priceChange24h;
  }

  // State (bonding curve?)
  const state = stateRes.status === 'fulfilled' ? stateRes.value : { state: 'unknown' };
  if (state.state === 'bonding_curve') {
    scan.bondingCurveState = { launchpad: state.launchpadName, suiRaised: state.suiRaised, threshold: state.threshold, progress: state.progress, destinationDex: state.destinationDex };
  }

  // Pools
  scan.pools = poolData.status === 'fulfilled' ? poolData.value : [];
  scan.totalLiquidityUsd = scan.pools.reduce((s, p) => s + (p.liquidityUsd || 0), 0);
  if (scan.pools.length && !scan.priceNative) scan.priceNative = scan.pools[0].priceNative || 0;
  if (scan.pools.length && !scan.priceUsd)    scan.priceUsd    = scan.pools[0].priceUsd || 0;

  // Holders
  const hd = holderData.status === 'fulfilled' ? holderData.value : { total: 0, topHolders: [] };
  scan.holders    = hd.total;
  scan.topHolders = hd.topHolders;

  // Honeypot
  try {
    const k = await sdk7k();
    const q = await k.getQuote({ tokenIn: coinType, tokenOut: SUI_TYPE, amountIn: '1000000' });
    scan.honeypotPass = !!(q && BigInt(q.outAmount || 0) > 0n);
  } catch { scan.honeypotPass = null; }

  // Risk
  const top3 = scan.topHolders.slice(0, 3).reduce((s, h) => s + h.pct, 0);
  const noLiq = scan.totalLiquidityUsd < 500 && !scan.bondingCurveState && !scan.pools.length;
  const lowLiq = scan.totalLiquidityUsd < 5000;
  const conc   = top3 > 50;
  if (scan.honeypotPass === false || noLiq) scan.riskScore = 'LIKELY RUG';
  else if (conc && lowLiq)                  scan.riskScore = 'HIGH RISK';
  else if (conc || lowLiq)                  scan.riskScore = 'CAUTION';
  else                                       scan.riskScore = 'SAFE';

  return scan;
}

function formatScanReport(scan) {
  const icons = { SAFE: '🟢', CAUTION: '🟡', 'HIGH RISK': '🔴', 'LIKELY RUG': '💀', UNKNOWN: '⚪' };
  const top3  = scan.topHolders.slice(0, 3).reduce((s, h) => s + h.pct, 0);
  const chg   = scan.priceChange24h;
  const chgStr = chg !== 0 ? ` ${chg >= 0 ? '📈+' : '📉'}${chg.toFixed(2)}%` : '';
  const L = [];

  L.push(`🔍 *Token Scan*\n`);
  L.push(`📛 *${scan.name}* (${scan.symbol})`);
  L.push(`📋 \`${truncAddr(scan.coinType)}\``);

  if (scan.priceUsd > 0) L.push(`\n💵 $${scan.priceUsd < 0.0001 ? scan.priceUsd.toExponential(3) : scan.priceUsd.toFixed(6)}${chgStr}`);
  if (scan.priceNative > 0) L.push(`🔵 ${scan.priceNative.toFixed(8)} SUI`);
  if (scan.marketCapUsd > 0) L.push(`🏦 MCap: $${fmt(scan.marketCapUsd)}`);
  if (scan.fdvUsd > 0)       L.push(`📊 FDV: $${fmt(scan.fdvUsd)}`);
  if (scan.volume24h > 0)    L.push(`💹 Vol 24h: $${fmt(scan.volume24h)}`);

  // Supply — format intelligently (avoid showing 1000000000000 as "1,000,000,000,000")
  if (scan.totalSupply > 0) {
    const supplyFmt = scan.totalSupply >= 1e9
      ? (scan.totalSupply / 1e9).toFixed(2) + 'B'
      : scan.totalSupply >= 1e6
        ? (scan.totalSupply / 1e6).toFixed(2) + 'M'
        : scan.totalSupply >= 1e3
          ? (scan.totalSupply / 1e3).toFixed(1) + 'K'
          : scan.totalSupply.toLocaleString();
    L.push(`🏭 Supply: ${supplyFmt}`);
  }

  // Holders
  L.push(`\n👥 Holders: ${scan.holders > 0 ? scan.holders.toLocaleString() : 'N/A'}${top3 > 50 ? ` ⚠️ Top 3 own ${top3.toFixed(1)}%` : ''}`);
  if (scan.topHolders.length > 0) {
    L.push('*Top Holders:*');
    scan.topHolders.slice(0, 5).forEach((h, i) =>
      L.push(`  ${i+1}. \`${truncAddr(h.address)}\` — ${h.pct.toFixed(2)}%`)
    );
  }

  // Pools — highlight best pool & explain routing
  if (scan.bondingCurveState) {
    const bc = scan.bondingCurveState;
    L.push(`\n📊 *Bonding Curve — ${bc.launchpad}*`);
    if (bc.suiRaised > 0 && bc.threshold) {
      const p = Math.min(100, (bc.suiRaised / bc.threshold) * 100);
      L.push(`[${'█'.repeat(Math.floor(p/10))}${'░'.repeat(10-Math.floor(p/10))}] ${p.toFixed(1)}%  (${bc.suiRaised}/${bc.threshold} SUI)`);
    }
    L.push(`Graduates to: ${bc.destinationDex}`);
    L.push(`⚠️ Not on DEX yet — trades go directly to launchpad contract`);
  } else if (scan.pools.length > 0) {
    const bestPool = scan.pools[0]; // highest liquidity = 7K will route here first
    L.push(`\n💧 *Liquidity Pools (${scan.pools.length} found)*`);
    L.push(`🏆 Best: ${bestPool.dex} — $${fmt(bestPool.liquidityUsd)} liq${bestPool.volume24h > 0 ? ` | $${fmt(bestPool.volume24h)} vol` : ''}`);
    if (scan.pools.length > 1) {
      L.push(`*All pools:*`);
      scan.pools.slice(0, 5).forEach((p, i) =>
        L.push(`  ${i === 0 ? '⭐' : '•'} ${p.dex}: $${fmt(p.liquidityUsd)}${p.volume24h > 0 ? ` vol $${fmt(p.volume24h)}` : ''}`)
      );
    }
    L.push(`Total: $${fmt(scan.totalLiquidityUsd)}`);
    L.push(`\n💡 *Bot trades via 7K aggregator — automatically routes through the highest liquidity pool or splits across multiple pools for best price.*`);
  } else {
    L.push('\n❌ No pools found on any DEX');
  }

  L.push(`\n🍯 Honeypot: ${scan.honeypotPass === true ? '✅ Sellable' : scan.honeypotPass === false ? '❌ HONEYPOT — CANNOT SELL' : '⚪ Unknown'}`);
  L.push(`\n${icons[scan.riskScore] || '⚪'} *Risk: ${scan.riskScore}*`);

  return L.join('\n');
}

function fmt(n) {
  if (!n || n === 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toFixed(0);
}

// ─────────────────────────────────────────────
// POSITIONS — add, PnL calculation
// ─────────────────────────────────────────────

function addPosition(chatId, pos) {
  const user = getUser(chatId);
  if (!user) return;
  user.positions = user.positions || [];
  user.positions.push({
    id: randomBytes(4).toString('hex'),
    coinType: pos.coinType, symbol: pos.symbol,
    entryPriceSui: pos.entryPriceSui || 0,
    amountTokens: pos.amountTokens || 0,
    decimals: pos.decimals || 9,
    spentSui: pos.spentSui,
    tp: pos.tp || null, sl: pos.sl || null,
    source: pos.source || 'dex',
    launchpad: pos.launchpad || null,
    openedAt: Date.now(),
  });
  saveUsers();
}

async function getPositionPnl(pos) {
  if (pos.source === 'bonding_curve' || !pos.amountTokens || pos.amountTokens <= 0) return null;
  try {
    const k   = await sdk7k();
    const dec = pos.decimals || 9;
    const amt = BigInt(Math.floor(pos.amountTokens * Math.pow(10, dec)));
    const q   = await k.getQuote({ tokenIn: pos.coinType, tokenOut: SUI_TYPE, amountIn: amt.toString() });
    if (!q || !q.outAmount) return null;
    const currentSui = Number(q.outAmount) / 1e9;
    const pnl        = currentSui - pos.spentSui;
    return { currentSui, pnl, pnlPct: (pnl / pos.spentSui) * 100 };
  } catch { return null; }
}

// ─────────────────────────────────────────────
// PnL IMAGE — QuickChart.io
// ─────────────────────────────────────────────

function buildPnlChartUrl(symbol, pnlPct, spentSui, currentSui) {
  const isProfit = pnlPct >= 0;
  const color    = isProfit ? '#00e676' : '#ff1744';
  const bgColor  = isProfit ? '#0d1f14' : '#1f0d0d';
  const pts = 24; const data = [];
  for (let i = 0; i <= pts; i++) {
    const t = i / pts;
    const noise = (Math.sin(i * 1.3) * 0.15 + Math.cos(i * 2.7) * 0.1) * Math.abs(pnlPct) / 200;
    data.push(+(1 + (pnlPct / 100) * t + noise * Math.sqrt(t)).toFixed(4));
  }
  const config = {
    type: 'line',
    data: { labels: data.map((_, i) => i), datasets: [{ data, borderColor: color, backgroundColor: `${color}20`, fill: true, tension: 0.5, borderWidth: 3, pointRadius: 0 }] },
    options: { animation: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false, min: Math.min(...data) * 0.97, max: Math.max(...data) * 1.03 } } },
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=600&h=250&bkg=${encodeURIComponent(bgColor)}&f=png`;
}

function buildPnlBar(pct) {
  const f = Math.min(10, Math.round(Math.abs(Math.max(-100, Math.min(200, pct))) / 20));
  return (pct >= 0 ? '🟩' : '🟥').repeat(f) + '⬛'.repeat(10 - f);
}

function buildPnlCaption(pos, pnl) {
  const sign = pnl.pnl >= 0 ? '+' : '';
  return (
    `${pnl.pnl >= 0 ? '🚀' : '📉'} *${pos.symbol}*\n\n` +
    `Entry:    ${(pos.entryPriceSui || 0).toFixed(8)} SUI\n` +
    `Invested: ${pos.spentSui} SUI\n` +
    `Value:    ${pnl.currentSui.toFixed(4)} SUI\n\n` +
    `P&L: *${sign}${pnl.pnl.toFixed(4)} SUI  (${sign}${pnl.pnlPct.toFixed(2)}%)*\n` +
    buildPnlBar(pnl.pnlPct)
  );
}

// ─────────────────────────────────────────────
// AUTO TP/SL MONITOR
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
          if (pos.tp && pnl.pnlPct >= pos.tp)      reason = `✅ Take Profit! +${pnl.pnlPct.toFixed(2)}%`;
          else if (pos.sl && pnl.pnlPct <= -pos.sl) reason = `🛑 Stop Loss! ${pnl.pnlPct.toFixed(2)}%`;
          if (!reason) continue;
          try {
            const res     = await executeSell(uid, pos.coinType, 100);
            const caption = `${reason}\n\n${buildPnlCaption(pos, pnl)}\n\n🔗 [View TX](${SUISCAN_TX}${res.digest})`;
            try { await bot.sendPhoto(uid, buildPnlChartUrl(pos.symbol, pnl.pnlPct, pos.spentSui, pnl.currentSui), { caption, parse_mode: 'Markdown' }); }
            catch { await bot.sendMessage(uid, caption, { parse_mode: 'Markdown' }); }
          } catch (e) { bot.sendMessage(uid, `⚠️ Auto-sell failed for ${pos.symbol}: ${e.message?.slice(0, 80)}`); }
        } catch {}
      }
    }
  }
}

// ─────────────────────────────────────────────
// SNIPER ENGINE
// ─────────────────────────────────────────────

async function sniperEngine() {
  while (true) {
    await sleep(2_000);
    for (const [uid, user] of Object.entries(usersDB)) {
      if (!user.snipeWatches?.length || isLocked(user)) continue;
      for (const watch of [...user.snipeWatches]) {
        if (watch.triggered) continue;
        try {
          stateCache.delete(watch.coinType);
          const state = await detectTokenState(watch.coinType);
          const fire  = watch.mode === 'graduation'
            ? state.state === 'graduated'
            : (state.state === 'graduated' || state.state === 'bonding_curve');
          if (!fire) continue;
          watch.triggered = true; saveUsers();
          const lbl = state.state === 'bonding_curve' ? `📊 ${state.launchpadName}` : `✅ DEX pool detected`;
          bot.sendMessage(uid, `⚡ *Snipe triggered!*\n\nToken: \`${truncAddr(watch.coinType)}\`\n${lbl}\n\nBuying ${watch.buyAmount} SUI...`, { parse_mode: 'Markdown' });
          try {
            const res = await executeBuy(uid, watch.coinType, watch.buyAmount);
            bot.sendMessage(uid, `⚡ *Sniped!*\n\nToken: ${res.symbol}\nSpent: ${watch.buyAmount} SUI\nFee: ${res.feeSui} SUI\n\n🔗 [View TX](${SUISCAN_TX}${res.digest})`, { parse_mode: 'Markdown' });
          } catch (e) { bot.sendMessage(uid, `❌ Snipe failed: ${e.message?.slice(0, 120)}`); }
        } catch {}
      }
    }
  }
}

// ─────────────────────────────────────────────
// COPY TRADER ENGINE
// ─────────────────────────────────────────────

const copyLastSeen = {};

async function copyTraderEngine() {
  while (true) {
    await sleep(5_000);
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
          filter: { FromAddress: wallet }, limit: 5, order: 'descending',
          options: { showEffects: true, showEvents: true },
        });
        const lastSeen = copyLastSeen[wallet];
        const newTxs   = lastSeen ? txs.data.filter(t => t.digest !== lastSeen) : txs.data.slice(0, 1);
        if (txs.data.length > 0) copyLastSeen[wallet] = txs.data[0].digest;
        for (const tx of newTxs.reverse()) {
          const swapEv = (tx.events || []).find(e =>
            e.type?.toLowerCase().includes('swap') || e.type?.toLowerCase().includes('trade')
          );
          if (!swapEv) continue;
          const pj = swapEv.parsedJson || {};
          const boughtCoin = pj.coin_type_out || pj.token_out || pj.coin_b_type || pj.coinTypeOut || null;
          if (!boughtCoin || boughtCoin === SUI_TYPE) continue;
          for (const { user, config, uid } of watchers) {
            try {
              if (config.blacklist?.includes(boughtCoin)) continue;
              const holding = await getOwnedCoins(user.walletAddress, boughtCoin);
              if (holding.length > 0) continue;
              if ((user.positions || []).length >= (config.maxPositions || 5)) continue;
              const copyAmt = config.amount || user.settings.copyAmount;
              bot.sendMessage(uid, `🔁 *Copy Trade*\n\nWallet: \`${truncAddr(wallet)}\`\nBuying: \`${truncAddr(boughtCoin)}\`\nAmount: ${copyAmt} SUI`, { parse_mode: 'Markdown' });
              const res = await executeBuy(uid, boughtCoin, copyAmt);
              bot.sendMessage(uid, `✅ *Copied!*\n\nToken: ${res.symbol}\nFee: ${res.feeSui} SUI\n\n🔗 [TX](${SUISCAN_TX}${res.digest})`, { parse_mode: 'Markdown' });
            } catch (e) { bot.sendMessage(uid, `❌ Copy failed: ${e.message?.slice(0, 100)}`); }
          }
        }
      } catch {}
    }
  }
}

// ─────────────────────────────────────────────
// SYMBOL RESOLVER ($TICKER → coinType)
// ─────────────────────────────────────────────

async function resolveSymbol(ticker) {
  const sym = ticker.replace(/^\$/, '').toUpperCase();
  try {
    const r = await fetchTimeout(`https://api-sui.cetus.zone/v2/sui/tokens?symbol=${sym}`, {}, 5000);
    if (r.ok) { const d = await r.json(); if (d.data?.[0]?.coin_type) return d.data[0].coin_type; }
  } catch {}
  return null;
}

// ─────────────────────────────────────────────
// 25. TELEGRAM BOT
// ─────────────────────────────────────────────

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });

async function requireUnlocked(chatId, fn) {
  const user = getUser(chatId);
  if (!user?.walletAddress) { await bot.sendMessage(chatId, '❌ No wallet. Use /start first.'); return; }
  if (user.cooldownUntil && Date.now() < user.cooldownUntil) {
    await bot.sendMessage(chatId, `🔒 Cooldown — wait ${Math.ceil((user.cooldownUntil - Date.now()) / 1000)}s.`); return;
  }
  if (isLocked(user)) {
    updateUser(chatId, { state: 'awaiting_unlock_pin' });
    await bot.sendMessage(chatId, '🔒 Bot locked. Enter your 4-digit PIN:'); return;
  }
  updateUser(chatId, { lastActivity: Date.now() });
  try { await fn(user); }
  catch (e) { console.error(`[${chatId}]`, e.message); await bot.sendMessage(chatId, `❌ ${e.message?.slice(0, 180) || 'Error'}`); }
}

// ─────────────────────────────────────────────
// STANDALONE COMMAND HANDLERS
// Called by BOTH keyboard buttons AND /commands
// This replaces the broken bot.emit approach entirely
// ─────────────────────────────────────────────

async function cmdBalance(chatId) {
  await requireUnlocked(chatId, async (user) => {
    const m = await bot.sendMessage(chatId, '💰 Fetching balances...');
    try {
      const bals   = await getAllBalances(user.walletAddress);
      const suiBal = bals.find(b => b.coinType === SUI_TYPE);
      const L = [`💼 *Wallet Balances*\n\`${truncAddr(user.walletAddress)}\`\n`];
      L.push(`🔵 SUI: ${suiBal ? suiFloat(suiBal.totalBalance) : '0.0000'}`);
      const others = bals.filter(b => b.coinType !== SUI_TYPE && Number(b.totalBalance) > 0);
      for (const bal of others.slice(0, 15)) {
        const meta = await getCoinMeta(bal.coinType).catch(() => null);
        const sym  = meta?.symbol || truncAddr(bal.coinType);
        const amt  = (Number(bal.totalBalance) / Math.pow(10, meta?.decimals || 9)).toFixed(4);
        L.push(`• ${sym}: ${amt}`);
      }
      if (!others.length) L.push('\n_No other tokens_');
      await bot.editMessageText(L.join('\n'), { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' });
    } catch (e) {
      await bot.editMessageText(`❌ ${e.message?.slice(0, 100)}`, { chat_id: chatId, message_id: m.message_id });
    }
  });
}

async function cmdPositions(chatId) {
  await requireUnlocked(chatId, async (user) => {
    if (!user.positions?.length) { await bot.sendMessage(chatId, '📊 No open positions yet.\n\nBuy a token to start tracking!'); return; }
    const m = await bot.sendMessage(chatId, `📊 Loading ${user.positions.length} position(s)...`);
    await bot.deleteMessage(chatId, m.message_id).catch(() => {});

    for (const pos of user.positions) {
      try {
        const pnl = await getPositionPnl(pos);
        if (pnl) {
          const imgUrl  = buildPnlChartUrl(pos.symbol, pnl.pnlPct, pos.spentSui, pnl.currentSui);
          const caption = buildPnlCaption(pos, pnl) +
            `\n\nTP: ${pos.tp ? pos.tp + '%' : 'None'} | SL: ${pos.sl ? pos.sl + '%' : 'None'}` +
            (pos.source === 'bonding_curve' ? `\n📊 ${pos.launchpad}` : '');
          try {
            await bot.sendPhoto(chatId, imgUrl, { caption, parse_mode: 'Markdown' });
          } catch {
            await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
          }
        } else {
          const em = pos.source === 'bonding_curve' ? '📊' : '⚪';
          await bot.sendMessage(chatId,
            `${em} *${pos.symbol}*\nSpent: ${pos.spentSui} SUI\n` +
            (pos.source === 'bonding_curve' ? `📊 On ${pos.launchpad}\n` : '') +
            `TP: ${pos.tp || 'None'} | SL: ${pos.sl || 'None'}`,
            { parse_mode: 'Markdown' }
          );
        }
      } catch {
        await bot.sendMessage(chatId, `⚪ *${pos.symbol}* — ${pos.spentSui} SUI`, { parse_mode: 'Markdown' });
      }
    }
  });
}

async function cmdSnipe(chatId, tokenArg) {
  await requireUnlocked(chatId, async (user) => {
    if (!tokenArg) {
      await bot.sendMessage(chatId,
        `⚡ *Sniper*\n\nUsage: /snipe [token address]\n\nThe bot buys instantly when:\n` +
        `• A bonding curve is created on any launchpad\n` +
        `• A DEX pool appears for the token\n` +
        `• A launchpad token graduates to DEX\n\n` +
        `Example: /snipe 0x1234...5678`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
    const token = tokenArg.trim();
    const pd = user.pendingData || {};
    pd.snipeToken = token; pd.snipeMode = 'any';
    updateUser(chatId, { state: 'awaiting_snipe_amount', pendingData: pd });
    await bot.sendMessage(chatId,
      `⚡ Token: \`${truncAddr(token)}\`\n\nHow much SUI to buy when pool is found?\n\n_Example: 0.5_`,
      { parse_mode: 'Markdown' }
    );
  });
}

async function cmdCopytrader(chatId, arg) {
  await requireUnlocked(chatId, async (user) => {
    const a = (arg || '').trim().toLowerCase();
    if (a === 'stop') {
      updateUser(chatId, { copyTraders: [] });
      await bot.sendMessage(chatId, '✅ All copy traders stopped.'); return;
    }
    if (!a || a === 'list') {
      if (!user.copyTraders?.length) {
        await bot.sendMessage(chatId,
          `🔁 *Copy Trader*\n\nNo wallets tracked.\n\nUsage: /copytrader [wallet address]\nStop all: /copytrader stop`,
          { parse_mode: 'Markdown' }
        ); return;
      }
      const L = user.copyTraders.map((ct, i) => `${i + 1}. \`${truncAddr(ct.wallet)}\` — ${ct.amount} SUI/trade`).join('\n');
      await bot.sendMessage(chatId, `🔁 *Copy Traders (${user.copyTraders.length}/3)*\n\n${L}\n\nStop: /copytrader stop`, { parse_mode: 'Markdown' });
      return;
    }
    if (a.startsWith('0x')) {
      user.copyTraders = user.copyTraders || [];
      if (user.copyTraders.length >= 3) { await bot.sendMessage(chatId, '❌ Max 3 copy traders. Use /copytrader stop first.'); return; }
      user.copyTraders.push({ wallet: a, amount: user.settings.copyAmount, maxPositions: 5, blacklist: [] });
      updateUser(chatId, { copyTraders: user.copyTraders });
      await bot.sendMessage(chatId, `✅ Tracking \`${truncAddr(a)}\`\nCopy amount: ${user.settings.copyAmount} SUI/trade\n\nStop: /copytrader stop`, { parse_mode: 'Markdown' });
      return;
    }
    updateUser(chatId, { state: 'awaiting_copytrader_wallet' });
    await bot.sendMessage(chatId, 'Enter the wallet address to copy:');
  });
}

async function cmdReferral(chatId) {
  const user   = getUser(chatId) || createUser(chatId);
  const link   = `https://t.me/AGENTTRADINBOT?start=${user.referralCode}`;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const active = Object.values(usersDB).filter(u => u.referredBy === user.walletAddress && u.lastActivity > cutoff).length;
  await bot.sendMessage(chatId,
    `🔗 *Your Referral Dashboard*\n\n` +
    `Code: \`${user.referralCode}\`\nLink: \`${link}\`\n\n` +
    `👥 Total referrals: ${user.referralCount || 0}\n` +
    `⚡ Active last 30d: ${active}\n` +
    `💰 Total earned: ${(user.referralEarningsTotal || 0).toFixed(4)} SUI\n\n` +
    `*Share your link to earn 25% of every fee your referrals pay — forever, paid on-chain automatically.*`,
    { parse_mode: 'Markdown' }
  );
}

async function cmdSettings(chatId) {
  await requireUnlocked(chatId, async (user) => {
    const s       = user.settings;
    const amounts = (s.buyAmounts || DEFAULT_BUY_AMOUNTS).join(', ');
    await bot.sendMessage(chatId,
      `⚙️ *Settings*\n\n` +
      `Slippage: *${s.slippage}%*\n` +
      `Confirm ≥: *${s.confirmThreshold} SUI*\n` +
      `Copy amount: *${s.copyAmount} SUI*\n` +
      `Quick-buy amounts: *${amounts} SUI*\n` +
      `TP default: ${s.tpDefault || 'None'}\n` +
      `SL default: ${s.slDefault || 'None'}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '— Slippage —', callback_data: 'noop' }],
            [{ text: '0.5%', callback_data: 'slip:0.5' }, { text: '1%', callback_data: 'slip:1' }, { text: '2%', callback_data: 'slip:2' }, { text: '5%', callback_data: 'slip:5' }],
            [{ text: '— Confirm Threshold —', callback_data: 'noop' }],
            [{ text: '0.1 SUI', callback_data: 'ct:0.1' }, { text: '0.5 SUI', callback_data: 'ct:0.5' }, { text: '1 SUI', callback_data: 'ct:1' }, { text: '5 SUI', callback_data: 'ct:5' }],
            [{ text: '💰 Edit Quick-Buy Amounts', callback_data: 'edit_buy_amounts' }],
          ],
        },
      }
    );
  });
}

async function cmdHelp(chatId) {
  await bot.sendMessage(chatId,
    `🤖 *AGENT TRADING BOT*\n\n` +
    `*Trading*\n` +
    `/buy [ca] [sui] — Buy any token\n` +
    `/sell [ca] [%] — Sell with percentage\n\n` +
    `*Advanced*\n` +
    `/snipe [ca] — Snipe on pool creation\n` +
    `/copytrader [wallet] — Mirror wallet buys\n\n` +
    `*Info*\n` +
    `/scan [ca] — Full token safety scan\n` +
    `/balance — Wallet balances\n` +
    `/positions — Open positions + P&L charts\n\n` +
    `*Account*\n` +
    `/referral — Your referral link & earnings\n` +
    `/settings — Slippage, buy amounts, TP/SL\n\n` +
    `*DEXes (all via 7K aggregator)*\n` +
    `Cetus • Turbos • Aftermath • Bluefin • Kriya • FlowX • DeepBook\n\n` +
    `*Launchpads (bonding curves)*\n` +
    `MovePump • hop.fun • MoonBags • Turbos.fun • blast.fun\n\n` +
    `*Fee:* 1% per trade — referrers earn 25% of fees forever`,
    { parse_mode: 'Markdown' }
  );
}

// ─────────────────────────────────────────────
// SELL FLOW HELPERS
// ─────────────────────────────────────────────

async function handleSellButton(chatId, user) {
  const positions = (user.positions || []).filter(p => p.coinType);
  if (positions.length > 0) {
    const posButtons = positions.slice(0, 6).map((p, i) => ([{
      text: `${p.symbol} — ${p.spentSui} SUI`,
      callback_data: `st:${i}`,
    }]));
    posButtons.push([{ text: '📝 Enter CA manually', callback_data: 'sfs_manual' }]);
    await bot.sendMessage(chatId, `💸 *Select position to sell:*`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: posButtons },
    });
  } else {
    await bot.sendMessage(chatId, `Send the token contract address to sell:\n\n_Example: 0x1234...5678_`, { parse_mode: 'Markdown' });
    updateUser(chatId, { state: 'awaiting_sell_ca' });
  }
}

// ─────────────────────────────────────────────
// PRICE FORMATTER — subscript zero notation
// e.g. 0.000003568 → $0.0₅3568
// ─────────────────────────────────────────────

function formatSmallPrice(price) {
  if (!price || price === 0) return '$0';
  if (price >= 1) return '$' + price.toLocaleString('en', { maximumFractionDigits: 4 });
  if (price >= 0.01) return '$' + price.toFixed(4);
  // Count leading zeros after "0."
  const str = price.toFixed(20);
  const afterDot = str.split('.')[1] || '';
  let zeros = 0;
  for (const ch of afterDot) { if (ch === '0') zeros++; else break; }
  if (zeros <= 2) return '$' + price.toFixed(zeros + 4);
  // Use subscript digits for zero count
  const SUBS = ['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉'];
  const subNum = zeros.toString().split('').map(d => SUBS[+d]).join('');
  const sig = afterDot.slice(zeros, zeros + 4);
  return `$0.0${subNum}${sig}`;
}

function pctArrow(p) {
  if (!p || p === 0) return '0%';
  return (p > 0 ? '▲' : '▼') + Math.abs(p).toFixed(2) + '%';
}

function poolAge(createdAt) {
  if (!createdAt) return 'Unknown';
  const ms = Date.now() - new Date(createdAt).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 60)  return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ─────────────────────────────────────────────
// FULL TOKEN DATA — everything needed for rich panel
// ─────────────────────────────────────────────


// ─────────────────────────────────────────────
// RICH BUY PANEL — RaidenX-style display
// ─────────────────────────────────────────────

async function startBuyFlow(chatId, coinType) {
  const user = getUser(chatId);
  if (!user) return;

  const loadMsg = await bot.sendMessage(chatId, `🔍 Fetching token info...`);

  try {
    const info    = await getFullTokenData(coinType);
    const amounts = user.settings.buyAmounts || DEFAULT_BUY_AMOUNTS;
    updateUser(chatId, { pendingData: { coinType, symbol: info.symbol } });

    const card     = formatBuyCard(info, coinType);
    const fullText = card + `\n\n*Select amount to buy:*`;

    await bot.editMessageText(fullText, {
      chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          amounts.map((a, i) => ({ text: `${a} SUI`, callback_data: `ba:${i}` })),
          [{ text: '✏️ Custom Amount', callback_data: 'ba:c' }],
          [{ text: '⚙️ Edit Defaults', callback_data: 'edit_buy_amounts' }, { text: '❌ Cancel', callback_data: 'ca' }],
        ],
      },
    });
  } catch (e) {
    const meta   = await getCoinMeta(coinType).catch(() => null);
    const symbol = meta?.symbol || truncAddr(coinType);
    updateUser(chatId, { pendingData: { coinType, symbol } });
    const amounts = user.settings.buyAmounts || DEFAULT_BUY_AMOUNTS;
    await bot.editMessageText(
      `💰 *Buy ${symbol}*\n\`${truncAddr(coinType)}\`\n\n⚠️ Token data unavailable\n💡 7K aggregator routes to best price automatically\n\n*Select amount:*`,
      {
        chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [amounts.map((a, i) => ({ text: `${a} SUI`, callback_data: `ba:${i}` })), [{ text: '✏️ Custom', callback_data: 'ba:c' }, { text: '❌ Cancel', callback_data: 'ca' }]] },
      }
    );
  }
}

async function startSellFlow(chatId, coinType, symbol) {
  updateUser(chatId, { pendingData: { coinType, symbol } });
  await showSellPercentButtons(chatId, coinType, symbol, null);
}

async function showBuyConfirm(chatId, coinType, amountSui, editMsgId) {
  const user   = getUser(chatId);
  if (!user) return;
  const meta   = await getCoinMeta(coinType) || {};
  const symbol = meta.symbol || truncAddr(coinType);
  const amountMist = mistFromSui(amountSui);
  const { feeMist } = calcFee(amountMist, user);
  updateUser(chatId, { pendingData: { ...user.pendingData, amountSui } });

  let estOut = '?';
  try {
    const k = await sdk7k();
    const q = await k.getQuote({ tokenIn: SUI_TYPE, tokenOut: coinType, amountIn: (amountMist - feeMist).toString() });
    if (q?.outAmount) estOut = (Number(q.outAmount) / Math.pow(10, meta.decimals || 9)).toFixed(4);
  } catch {}

  const text =
    `💰 *Confirm Buy*\n\nToken: *${symbol}*\n` +
    `Amount: ${amountSui} SUI\nFee (1%): ${suiFloat(feeMist)} SUI\n` +
    `You trade: ${suiFloat(amountMist - feeMist)} SUI\n` +
    (estOut !== '?' ? `Est. receive: ~${estOut} ${symbol}\n` : '') +
    `Slippage: ${user.settings.slippage}%`;

  const kb = { inline_keyboard: [[{ text: '✅ Confirm Buy', callback_data: 'bc' }, { text: '❌ Cancel', callback_data: 'ca' }]] };

  if (editMsgId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: kb })
      .catch(async () => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb }));
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
  }
}

async function showSellPercentButtons(chatId, coinType, symbol, editMsgId) {
  const user = getUser(chatId);
  if (!user) return;
  const coins = await getOwnedCoins(user.walletAddress, coinType).catch(() => []);
  if (!coins.length) { await bot.sendMessage(chatId, `❌ No ${symbol} balance in your wallet.`); return; }
  const meta     = await getCoinMeta(coinType) || {};
  const totalBal = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
  const dispBal  = (Number(totalBal) / Math.pow(10, meta.decimals || 9)).toFixed(4);

  const text = `💸 *Sell ${symbol}*\n\nBalance: ${dispBal} ${symbol}\n\n*Choose amount to sell:*`;
  const kb   = {
    inline_keyboard: [
      [{ text: '25%', callback_data: 'sp:25' }, { text: '50%', callback_data: 'sp:50' }, { text: '75%', callback_data: 'sp:75' }, { text: '100%', callback_data: 'sp:100' }],
      [{ text: '✏️ Custom %', callback_data: 'sp:c' }, { text: '❌ Cancel', callback_data: 'ca' }],
    ],
  };

  if (editMsgId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: kb })
      .catch(async () => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb }));
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
  }
}

async function showSellConfirm(chatId, coinType, pct, editMsgId) {
  const user   = getUser(chatId);
  if (!user) return;
  const meta   = await getCoinMeta(coinType) || {};
  const symbol = meta.symbol || truncAddr(coinType);
  const coins  = await getOwnedCoins(user.walletAddress, coinType).catch(() => []);
  const total  = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
  const sellAm = (total * BigInt(pct)) / 100n;
  const dispAm = (Number(sellAm) / Math.pow(10, meta.decimals || 9)).toFixed(4);

  let estSui = '?';
  try {
    const k = await sdk7k();
    const q = await k.getQuote({ tokenIn: coinType, tokenOut: SUI_TYPE, amountIn: sellAm.toString() });
    if (q?.outAmount) estSui = (Number(q.outAmount) / 1e9).toFixed(4);
  } catch {}

  const text =
    `💸 *Confirm Sell*\n\nToken: *${symbol}*\n` +
    `Selling: ${pct}% (${dispAm} ${symbol})\n` +
    (estSui !== '?' ? `Est. receive: ~${estSui} SUI\n` : '') +
    `Slippage: ${user.settings.slippage}%`;
  const kb = { inline_keyboard: [[{ text: '✅ Confirm Sell', callback_data: 'sc' }, { text: '❌ Cancel', callback_data: 'ca' }]] };

  if (editMsgId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: kb })
      .catch(async () => bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb }));
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
  }
}

// ─────────────────────────────────────────────
// /start
// ─────────────────────────────────────────────

bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const param  = sanitize((match[1] || '').trim());
  let user = getUser(chatId);

  if (!user) {
    user = createUser(chatId);
    if (param.startsWith('AGT-')) {
      const referrer = Object.values(usersDB).find(u => u.referralCode === param && u.chatId !== String(chatId));
      if (referrer?.walletAddress) {
        updateUser(chatId, { referredBy: referrer.walletAddress });
        updateUser(referrer.chatId, { referralCount: (referrer.referralCount || 0) + 1 });
        bot.sendMessage(referrer.chatId, `🎉 New user joined via your referral! You earn 25% of their fees forever.`);
      }
    }
  }

  if (user.walletAddress) {
    await bot.sendMessage(chatId,
      `👋 Welcome back!\n\nWallet: \`${truncAddr(user.walletAddress)}\``,
      { parse_mode: 'Markdown', reply_markup: MAIN_KB }
    );
  } else {
    await bot.sendMessage(chatId,
      `👋 Welcome to *AGENT TRADING BOT*\n\nThe fastest trading bot on Sui.\n\nConnect your wallet:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔑 Import Existing Wallet', callback_data: 'import_wallet' }],
            [{ text: '✨ Create New Wallet',       callback_data: 'gen_wallet'    }],
          ],
        },
      }
    );
  }
});

// ─────────────────────────────────────────────
// CALLBACK HANDLER — all short codes, NO coinType in data
// ─────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  try {
    if (data === 'noop') return;

    // ── Wallet setup
    if (data === 'import_wallet') {
      updateUser(chatId, { state: 'awaiting_private_key' });
      await bot.sendMessage(chatId,
        `🔑 *Import Wallet*\n\nSend your private key (starts with \`suiprivkey1...\`).\n\n⚠️ Your message is deleted immediately after import. Never share keys with anyone.`,
        { parse_mode: 'Markdown' }
      ); return;
    }

    if (data === 'gen_wallet') {
      const kp   = new Ed25519Keypair();
      const addr = kp.getPublicKey().toSuiAddress();
      const sk   = kp.getSecretKey(); // suiprivkey1... format
      updateUser(chatId, { encryptedKey: encryptKey(sk), walletAddress: addr, state: 'awaiting_pin_set' });

      // Show address and private key — user must save the key
      await bot.sendMessage(chatId,
        `✅ *New Wallet Created!*\n\n` +
        `Address: \`${addr}\`\n\n` +
        `🔑 *Private Key (save this NOW):*\n\`${sk}\`\n\n` +
        `⚠️ *CRITICAL: Write this key down somewhere safe. If you lose it you lose access to your funds.*\n\n` +
        `Now set a 4-digit PIN to protect your bot:`,
        { parse_mode: 'Markdown' }
      ); return;
    }

    // ── BUY FLOW: amount selection (ba:INDEX or ba:c for custom)
    if (data.startsWith('ba:')) {
      const user = getUser(chatId);
      if (!user?.pendingData?.coinType) { await bot.sendMessage(chatId, '❌ Session expired. Start again.'); return; }
      const key = data.split(':')[1];
      if (key === 'c') {
        updateUser(chatId, { state: 'awaiting_buy_custom_amount' });
        await bot.sendMessage(chatId, `💬 Enter SUI amount:\n\n_Example: 2.5_`, { parse_mode: 'Markdown' });
        return;
      }
      const amounts = user.settings.buyAmounts || DEFAULT_BUY_AMOUNTS;
      const amt     = amounts[parseInt(key)];
      if (!amt) { await bot.sendMessage(chatId, '❌ Invalid amount.'); return; }
      await showBuyConfirm(chatId, user.pendingData.coinType, amt, msgId);
      return;
    }

    // ── BUY FLOW: confirm
    if (data === 'bc') {
      const user = getUser(chatId);
      if (!user?.pendingData?.coinType || !user?.pendingData?.amountSui) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
      await bot.editMessageText('⚡ Executing buy...', { chat_id: chatId, message_id: msgId });
      try {
        const res  = await executeBuy(chatId, user.pendingData.coinType, user.pendingData.amountSui);
        await bot.editMessageText(
          `✅ *Buy Executed!*\n\nToken: *${res.symbol}*\nSpent: ${user.pendingData.amountSui} SUI\nFee: ${res.feeSui} SUI\n` +
          (res.estOut !== '?' ? `Received: ~${res.estOut} ${res.symbol}\n` : '') +
          `Route: ${res.route}\n` +
          (res.state === 'bonding_curve' ? `📊 On ${res.launchpadName}\n` : '') +
          `\n🔗 [View TX](${SUISCAN_TX}${res.digest})`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        );
      } catch (e) {
        await bot.editMessageText(`❌ Buy failed: ${e.message?.slice(0, 180)}`, { chat_id: chatId, message_id: msgId });
      }
      updateUser(chatId, { pendingData: {} }); return;
    }

    // ── SELL FLOW: select from positions list
    if (data.startsWith('st:')) {
      const user = getUser(chatId);
      const idx  = parseInt(data.split(':')[1]);
      const pos  = user?.positions?.[idx];
      if (!pos) { await bot.sendMessage(chatId, '❌ Position not found.'); return; }
      updateUser(chatId, { pendingData: { coinType: pos.coinType, symbol: pos.symbol } });
      await showSellPercentButtons(chatId, pos.coinType, pos.symbol, null);
      return;
    }

    // Manual CA sell (from positions list "Enter CA manually")
    if (data === 'sfs_manual') {
      updateUser(chatId, { state: 'awaiting_sell_ca' });
      await bot.sendMessage(chatId, `Send the token contract address to sell:`); return;
    }

    // ── SELL FLOW: percent selection
    if (data.startsWith('sp:')) {
      const user = getUser(chatId);
      if (!user?.pendingData?.coinType) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
      const key = data.split(':')[1];
      if (key === 'c') {
        updateUser(chatId, { state: 'awaiting_sell_custom_pct' });
        await bot.sendMessage(chatId, `💬 Enter percentage to sell (1-100):\n\n_Example: 33_`, { parse_mode: 'Markdown' });
        return;
      }
      const pct = parseInt(key);
      updateUser(chatId, { pendingData: { ...user.pendingData, sellPct: pct } });
      await showSellConfirm(chatId, user.pendingData.coinType, pct, msgId);
      return;
    }

    // ── SELL FLOW: confirm
    if (data === 'sc') {
      const user = getUser(chatId);
      if (!user?.pendingData?.coinType || !user?.pendingData?.sellPct) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
      await bot.editMessageText('⚡ Executing sell...', { chat_id: chatId, message_id: msgId });
      try {
        const res = await executeSell(chatId, user.pendingData.coinType, user.pendingData.sellPct);
        await bot.editMessageText(
          `✅ *Sell Executed!*\n\nToken: ${res.symbol}\nSold: ${res.pct}%\nEst. SUI: ${res.estSui}\nFee: ${res.feeSui} SUI\nRoute: ${res.route}\n\n🔗 [View TX](${SUISCAN_TX}${res.digest})`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        );
      } catch (e) {
        await bot.editMessageText(`❌ Sell failed: ${e.message?.slice(0, 180)}`, { chat_id: chatId, message_id: msgId });
      }
      updateUser(chatId, { pendingData: {} }); return;
    }

    if (data === 'ca') { updateUser(chatId, { state: null, pendingData: {} }); await bot.editMessageText('❌ Cancelled.', { chat_id: chatId, message_id: msgId }).catch(() => {}); return; }

    // ── Settings
    if (data.startsWith('slip:')) { const u = getUser(chatId); if (u) { u.settings.slippage = parseFloat(data.split(':')[1]); saveUsers(); } await bot.sendMessage(chatId, `✅ Slippage → ${data.split(':')[1]}%`); return; }
    if (data.startsWith('ct:'))   { const u = getUser(chatId); if (u) { u.settings.confirmThreshold = parseFloat(data.split(':')[1]); saveUsers(); } await bot.sendMessage(chatId, `✅ Confirm threshold → ${data.split(':')[1]} SUI`); return; }
    if (data === 'edit_buy_amounts') { updateUser(chatId, { state: 'awaiting_buy_amounts_edit' }); await bot.sendMessage(chatId, `⚙️ Enter 4 amounts separated by spaces:\n\n_Example: 0.5 1 3 5_`, { parse_mode: 'Markdown' }); return; }

    // ── CA paste picker callbacks
    if (data === 'bfs') { const u = getUser(chatId); if (!u?.pendingData?.coinType) { await bot.sendMessage(chatId, '❌ Session expired.'); return; } await requireUnlocked(chatId, async () => startBuyFlow(chatId, u.pendingData.coinType)); return; }
    if (data === 'sfs') { const u = getUser(chatId); if (!u?.pendingData?.coinType) { await bot.sendMessage(chatId, '❌ Session expired.'); return; } const meta = await getCoinMeta(u.pendingData.coinType) || {}; await requireUnlocked(chatId, async () => startSellFlow(chatId, u.pendingData.coinType, meta.symbol || truncAddr(u.pendingData.coinType))); return; }
    if (data === 'sct') { const u = getUser(chatId); if (!u?.pendingData?.coinType) { await bot.sendMessage(chatId, '❌ Session expired.'); return; } const m = await bot.sendMessage(chatId, '🔍 Scanning...'); try { await bot.editMessageText(formatScanReport(await scanToken(u.pendingData.coinType)), { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' }); } catch (e) { await bot.editMessageText(`❌ ${e.message?.slice(0,100)}`, { chat_id: chatId, message_id: m.message_id }); } return; }

  } catch (e) {
    console.error('Callback error:', e.message);
    await bot.sendMessage(chatId, `❌ ${e.message?.slice(0, 120)}`);
  }
});

// ─────────────────────────────────────────────
// MESSAGE HANDLER — state machine + keyboard routing
// NOTE: keyboard buttons call standalone functions DIRECTLY
//       (no bot.emit — that was the root cause of buttons not working)
// ─────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const text   = sanitize(msg.text);
  if (!text || text.startsWith('/')) return;  // commands handled by onText below

  const user  = getUser(chatId) || createUser(chatId);
  const state = user.state;

  // ── Keyboard button routing — DIRECT function calls, no bot.emit
  const KB_ROUTES = {
    '💰 Buy':        async () => { await requireUnlocked(chatId, async () => { await bot.sendMessage(chatId, `Send the token CA or $TICKER:\n\n_Example: 0x1234... or $AGENT_`, { parse_mode: 'Markdown' }); updateUser(chatId, { state: 'awaiting_buy_ca' }); }); },
    '💸 Sell':       async () => { await requireUnlocked(chatId, async (u) => handleSellButton(chatId, u)); },
    '📊 Positions':  async () => { await cmdPositions(chatId); },
    '💼 Balance':    async () => { await cmdBalance(chatId); },
    '🔍 Scan':       async () => { await bot.sendMessage(chatId, `Send the token contract address to scan:\n\n_Example: 0x1234..._`, { parse_mode: 'Markdown' }); updateUser(chatId, { state: 'awaiting_scan_ca' }); },
    '⚡ Snipe':      async () => { await cmdSnipe(chatId, null); },
    '🔁 Copy Trade': async () => { await cmdCopytrader(chatId, null); },
    '🔗 Referral':   async () => { await cmdReferral(chatId); },
    '⚙️ Settings':   async () => { await cmdSettings(chatId); },
    '❓ Help':        async () => { await cmdHelp(chatId); },
  };

  if (KB_ROUTES[text]) { await KB_ROUTES[text](); return; }

  // ── State machine (free-text inputs)
  if (state === 'awaiting_private_key') {
    updateUser(chatId, { state: null });
    try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
    try {
      const decoded = decodeSuiPrivateKey(text);
      const kp      = Ed25519Keypair.fromSecretKey(decoded.secretKey);
      const addr    = kp.getPublicKey().toSuiAddress();
      updateUser(chatId, { encryptedKey: encryptKey(text), walletAddress: addr, state: 'awaiting_pin_set' });
      await bot.sendMessage(chatId, `✅ Wallet imported!\n\nAddress: \`${addr}\`\n🔐 Key encrypted.\n\nSet a 4-digit PIN:`, { parse_mode: 'Markdown' });
    } catch { await bot.sendMessage(chatId, '❌ Invalid key. Try again with /start.'); }
    return;
  }

  if (state === 'awaiting_pin_set') {
    if (!/^\d{4}$/.test(text)) { await bot.sendMessage(chatId, '❌ Must be exactly 4 digits:'); return; }
    updateUser(chatId, { pinHash: hashPin(text), state: null });
    await bot.sendMessage(chatId, `✅ All set! Bot auto-locks after 30min.\n\nFund your wallet with SUI and you're ready to trade!`, { reply_markup: MAIN_KB });
    syncToBackend(getUser(chatId)); return;
  }

  if (state === 'awaiting_unlock_pin') {
    if (!/^\d{4}$/.test(text)) { await bot.sendMessage(chatId, '❌ Enter 4-digit PIN:'); return; }
    if (hashPin(text) === user.pinHash) {
      unlockUser(chatId); updateUser(chatId, { state: null, failAttempts: 0, cooldownUntil: 0 });
      await bot.sendMessage(chatId, '🔓 Unlocked!', { reply_markup: MAIN_KB });
    } else {
      const fails = (user.failAttempts || 0) + 1;
      if (fails >= MAX_FAILS) { updateUser(chatId, { failAttempts: 0, cooldownUntil: Date.now() + COOLDOWN_MS }); await bot.sendMessage(chatId, '❌ Too many attempts. Locked 5 minutes.'); }
      else { updateUser(chatId, { failAttempts: fails }); await bot.sendMessage(chatId, `❌ Wrong PIN. ${MAX_FAILS - fails} attempts left.`); }
    }
    return;
  }

  if (state === 'awaiting_buy_ca') {
    updateUser(chatId, { state: null });
    const coinType = text.startsWith('0x') ? text : (await resolveSymbol(text));
    if (!coinType) { await bot.sendMessage(chatId, '❌ Token not found. Use the full contract address.'); return; }
    await requireUnlocked(chatId, async () => startBuyFlow(chatId, coinType)); return;
  }

  if (state === 'awaiting_sell_ca') {
    updateUser(chatId, { state: null });
    const coinType = text.startsWith('0x') ? text : (await resolveSymbol(text));
    if (!coinType) { await bot.sendMessage(chatId, '❌ Token not found.'); return; }
    const meta = await getCoinMeta(coinType) || {};
    await requireUnlocked(chatId, async () => startSellFlow(chatId, coinType, meta.symbol || truncAddr(coinType))); return;
  }

  if (state === 'awaiting_scan_ca') {
    updateUser(chatId, { state: null });
    const coinType = text.startsWith('0x') ? text : (await resolveSymbol(text));
    if (!coinType) { await bot.sendMessage(chatId, '❌ Token not found.'); return; }
    const m = await bot.sendMessage(chatId, '🔍 Scanning token...');
    try { await bot.editMessageText(formatScanReport(await scanToken(coinType)), { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' }); }
    catch (e) { await bot.editMessageText(`❌ Scan failed: ${e.message?.slice(0, 100)}`, { chat_id: chatId, message_id: m.message_id }); }
    return;
  }

  if (state === 'awaiting_buy_custom_amount') {
    updateUser(chatId, { state: null });
    const amt = parseFloat(text);
    if (isNaN(amt) || amt <= 0) { await bot.sendMessage(chatId, '❌ Invalid amount. Enter a number like 2.5'); return; }
    const ct = user.pendingData?.coinType;
    if (!ct) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
    await showBuyConfirm(chatId, ct, amt, null); return;
  }

  if (state === 'awaiting_sell_custom_pct') {
    updateUser(chatId, { state: null });
    const pct = parseFloat(text);
    if (isNaN(pct) || pct <= 0 || pct > 100) { await bot.sendMessage(chatId, '❌ Enter a number 1-100'); return; }
    const ct = user.pendingData?.coinType;
    if (!ct) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
    updateUser(chatId, { pendingData: { ...user.pendingData, sellPct: pct } });
    await showSellConfirm(chatId, ct, pct, null); return;
  }

  if (state === 'awaiting_buy_amounts_edit') {
    updateUser(chatId, { state: null });
    const parts = text.split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0).slice(0, 4);
    if (parts.length < 2) { await bot.sendMessage(chatId, '❌ Enter at least 2 amounts, e.g.: 0.5 1 3 5'); return; }
    while (parts.length < 4) parts.push(parts[parts.length - 1] * 2);
    const u = getUser(chatId);
    if (u) { u.settings.buyAmounts = parts; saveUsers(); }
    await bot.sendMessage(chatId, `✅ Quick-buy amounts updated: ${parts.join(', ')} SUI`); return;
  }

  if (state === 'awaiting_snipe_amount') {
    const amt = parseFloat(text);
    if (isNaN(amt) || amt <= 0) { await bot.sendMessage(chatId, '❌ Invalid amount.'); return; }
    const pd = user.pendingData || {};
    user.snipeWatches = user.snipeWatches || [];
    user.snipeWatches.push({ coinType: pd.snipeToken, buyAmount: amt, minLiquidity: 1, mode: pd.snipeMode || 'any', triggered: false, addedAt: Date.now() });
    updateUser(chatId, { state: null, pendingData: {}, snipeWatches: user.snipeWatches });
    await bot.sendMessage(chatId, `⚡ *Snipe set!*\n\nToken: \`${truncAddr(pd.snipeToken)}\`\nBuy: ${amt} SUI\n\nWatching for pool...`, { parse_mode: 'Markdown' }); return;
  }

  if (state === 'awaiting_copytrader_wallet') {
    if (!text.startsWith('0x')) { await bot.sendMessage(chatId, '❌ Invalid wallet address.'); return; }
    user.copyTraders = user.copyTraders || [];
    if (user.copyTraders.length >= 3) { await bot.sendMessage(chatId, '❌ Max 3. Use /copytrader stop first.'); return; }
    user.copyTraders.push({ wallet: text, amount: user.settings.copyAmount, maxPositions: 5, blacklist: [] });
    updateUser(chatId, { state: null, copyTraders: user.copyTraders });
    await bot.sendMessage(chatId, `✅ Tracking \`${truncAddr(text)}\``, { parse_mode: 'Markdown' }); return;
  }

  // Raw CA paste
  if (text.startsWith('0x') && text.length > 40) {
    updateUser(chatId, { pendingData: { coinType: text } });
    await bot.sendMessage(chatId, `📋 Detected:\n\`${truncAddr(text)}\`\n\nWhat do you want to do?`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '💰 Buy', callback_data: 'bfs' }, { text: '💸 Sell', callback_data: 'sfs' }, { text: '🔍 Scan', callback_data: 'sct' }]] },
    }); return;
  }
});

// ─────────────────────────────────────────────
// bot.onText COMMAND HANDLERS — call standalone fns
// ─────────────────────────────────────────────

bot.onText(/\/buy(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const args   = sanitize(match[1] || '');
  await requireUnlocked(chatId, async (user) => {
    if (!args) { await bot.sendMessage(chatId, `Send the token CA or $TICKER:`); updateUser(chatId, { state: 'awaiting_buy_ca' }); return; }
    const parts  = args.split(/\s+/);
    let ct       = parts[0].startsWith('0x') ? parts[0] : (await resolveSymbol(parts[0]));
    if (!ct) { await bot.sendMessage(chatId, '❌ Token not found.'); return; }
    if (parts[1]) {
      const amt = parseFloat(parts[1]);
      if (!isNaN(amt) && amt > 0) { updateUser(chatId, { pendingData: { coinType: ct } }); await showBuyConfirm(chatId, ct, amt, null); return; }
    }
    await startBuyFlow(chatId, ct);
  });
});

bot.onText(/\/sell(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const args   = sanitize(match[1] || '');
  await requireUnlocked(chatId, async (user) => {
    if (!args) { await handleSellButton(chatId, user); return; }
    const parts = args.split(/\s+/);
    const ct    = parts[0].startsWith('0x') ? parts[0] : (await resolveSymbol(parts[0]));
    if (!ct) { await bot.sendMessage(chatId, '❌ Token not found.'); return; }
    const meta = await getCoinMeta(ct) || {};
    if (parts[1]) {
      const pctStr = parts[1].toLowerCase().replace('%', '');
      const pct    = pctStr === 'all' ? 100 : parseFloat(pctStr);
      if (!isNaN(pct)) { updateUser(chatId, { pendingData: { coinType: ct, symbol: meta.symbol } }); await showSellConfirm(chatId, ct, pct, null); return; }
    }
    await startSellFlow(chatId, ct, meta.symbol || truncAddr(ct));
  });
});

bot.onText(/\/scan(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const arg    = sanitize(match[1] || '');
  if (!arg) { await bot.sendMessage(chatId, `Send the token CA:`); updateUser(chatId, { state: 'awaiting_scan_ca' }); return; }
  const ct = arg.startsWith('0x') ? arg : (await resolveSymbol(arg));
  if (!ct) { await bot.sendMessage(chatId, '❌ Token not found.'); return; }
  const m = await bot.sendMessage(chatId, '🔍 Scanning...');
  try { await bot.editMessageText(formatScanReport(await scanToken(ct)), { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' }); }
  catch (e) { await bot.editMessageText(`❌ Scan failed: ${e.message?.slice(0, 100)}`, { chat_id: chatId, message_id: m.message_id }); }
});

bot.onText(/\/balance/, async (msg) => { await cmdBalance(msg.chat.id); });
bot.onText(/\/positions/, async (msg) => { await cmdPositions(msg.chat.id); });
bot.onText(/\/referral/, async (msg) => { await cmdReferral(msg.chat.id); });
bot.onText(/\/help/, async (msg) => { await cmdHelp(msg.chat.id); });
bot.onText(/\/settings/, async (msg) => { await cmdSettings(msg.chat.id); });
bot.onText(/\/snipe(?:\s+(.+))?/, async (msg, match) => { await cmdSnipe(msg.chat.id, match[1] ? sanitize(match[1]) : null); });
bot.onText(/\/copytrader(?:\s+(.+))?/, async (msg, match) => { await cmdCopytrader(msg.chat.id, match[1] ? sanitize(match[1]) : null); });

// ─────────────────────────────────────────────
// ERROR & STARTUP
// ─────────────────────────────────────────────

bot.on('polling_error', (e) => {
  console.error('Polling error:', e.message);
  if (ADMIN_CHAT_ID) bot.sendMessage(ADMIN_CHAT_ID, `⚠️ Poll error: ${e.message?.slice(0, 150)}`).catch(() => {});
});
process.on('uncaughtException', (e) => {
  console.error('Uncaught:', e);
  if (ADMIN_CHAT_ID) bot.sendMessage(ADMIN_CHAT_ID, `🚨 Crash: ${e.message?.slice(0, 150)}`).catch(() => {});
});
process.on('unhandledRejection', r => console.error('Unhandled:', r));

async function main() {
  if (!TG_BOT_TOKEN)                             throw new Error('TG_BOT_TOKEN required');
  if (!ENCRYPT_KEY || ENCRYPT_KEY.length !== 64) throw new Error('ENCRYPT_KEY must be 64 hex chars');

  loadUsers();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  AGENT TRADING BOT v4 — Starting');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Users: ${Object.keys(usersDB).length} | RPC: ${RPC_URL}`);

  await sdk7k().then(() => console.log('✅ 7K Aggregator')).catch(e => console.warn('⚠️ 7K:', e.message));
  await sdkCetus().then(() => console.log('✅ Cetus SDK')).catch(e => console.warn('⚠️ Cetus:', e.message));
  await sdkTurbos().then(() => console.log('✅ Turbos SDK')).catch(e => console.warn('⚠️ Turbos:', e.message));

  setInterval(checkInactivity, 60_000);
  positionMonitor().catch(e => console.error('Position monitor crashed:', e));
  sniperEngine().catch(e => console.error('Sniper crashed:', e));
  copyTraderEngine().catch(e => console.error('Copy trader crashed:', e));

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Bot is live! All engines running.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (ADMIN_CHAT_ID) bot.sendMessage(ADMIN_CHAT_ID, '🟢 AGENT TRADING BOT v4 online.').catch(() => {});
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
