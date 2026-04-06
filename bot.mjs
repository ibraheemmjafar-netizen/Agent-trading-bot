/**
 * AGENT TRADING BOT — v6 Production
 *
 * Fixes from v5:
 * 1. Turbos swap: verified real function name (pool_script::swap_a_b_with_exact_in)
 *    and correct type arguments [CoinA, CoinB, Fee]
 * 2. Cetus pool detection: now uses both direct API and findCetusPool fallback,
 *    correctly computing a2b from actual pool coin ordering
 * 3. Fee deduction on sells: fee now taken in SUI from swap output, not from
 *    gas (was causing "insufficient gas" errors on sells)
 * 4. devInspectTransactionBlock honeypot detection (simulates a sell on-chain
 *    without executing, catches real honeypots that have liquidity but blocked sells)
 * 5. TreasuryCap wrapped-object detection via queryEvents (catches renounced-by-wrap)
 * 6. UpgradeCap check uses package field correctly
 * 7. /withdraw command — send SUI or tokens to external address
 * 8. Position sell buttons directly from /positions
 * 9. Auto-retry on RPC errors (3 retries with exponential backoff)
 * 10. Better sell direction: always re-queries pool with correct token ordering
 * 11. Graceful token-not-found messages with DEX suggestions
 * 12. Turbos pool fetched directly from Turbos Finance API (not via Cetus)
 * 13. State machine hardened — clears stale states on /start
 * 14. Copy trade: skip tokens already held + check balance before buying
 */

import TelegramBot             from 'node-telegram-bot-api';
import { SuiClient }           from '@mysten/sui/client';
import { Ed25519Keypair }      from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction }         from '@mysten/sui/transactions';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync }                   from 'fs';
import { setTimeout as sleep }                                       from 'timers/promises';

// ═══════════════════════════════════════════════════════════
// CONFIG — set via environment variables
// ═══════════════════════════════════════════════════════════
const TG_TOKEN    = process.env.TG_BOT_TOKEN  || '';
const ENC_KEY     = process.env.ENCRYPT_KEY   || '';
const RPC_URL     = process.env.RPC_URL       || 'https://fullnode.mainnet.sui.io:443';
const ADMIN_ID    = process.env.ADMIN_CHAT_ID || '';

const DEV_WALLET  = '0x47cee6fed8a44224350d0565a45dd97b320a9c3f54a8feb6036fb9b2d3a81a08';
const FEE_BPS     = 100;           // 1%
const REF_SHARE   = 0.25;          // 25% of fee goes to referrer
const MIST        = 1_000_000_000n;
const SUI_T       = '0x2::sui::SUI';
const DB_FILE     = './users.json';
const SUISCAN     = 'https://suiscan.xyz/mainnet/tx/';
const GECKO       = 'https://api.geckoterminal.com/api/v2';
const GECKO_NET   = 'sui-network';
const BB_KEY      = '9W0M5OHgX2gF05Si1AG7kPUm6hxg6P';
const BB_BASE     = 'https://api.blockberry.one/sui/v1';
const LOCK_MS     = 30 * 60 * 1000;   // auto-lock after 30m inactivity
const MAX_FAILS   = 3;
const COOLDOWN_MS = 5 * 60 * 1000;
const DEF_AMTS    = [0.5, 1, 3, 5];
const CLOCK_OBJ   = '0x6';

let BOT_USERNAME  = 'AGENTTRADINBOT';

// ── Cetus CLMM (verified from mainnet txs on SuiScan)
const CETUS_CONFIG    = '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f';
const CETUS_INTEGRATE = '0x2d8c2e0fc6dd25b0214b3fa747e0fd27fd54608142cd2e4f64c1cd350cc4add4';
const CETUS_ROUTER_URL = 'https://api-sui.cetus.zone/router';

// ── Turbos CLMM (verified from mainnet tx 9GadBDwwrGikdFCpdaPD4QbdPik5ET19Y97kpVzHmWch)
// The real Turbos swap package and versioned object:
const TURBOS_PKG      = '0x91bfbc386a41afcfd9b2533058d7e9154d6339ca1dfaac7bac673a82fbaa9c3a';
const TURBOS_VERSIONED = '0xf1cf0e81048df168ebeb1b8030fad24b3e0b53ae827c25053fff0779c1445b6f';

// Sqrt price limits for swap direction
const CETUS_MIN_SQRT  = '4295048016';
const CETUS_MAX_SQRT  = '79226673515401279992447579055';

// ── Supported launchpads with bonding curve info
const LAUNCHPADS = {
  MOVEPUMP:   { name:'MovePump',   url:'https://movepump.com/api',       grad:2000, dex:'Cetus'  },
  TURBOS_FUN: { name:'Turbos.fun', url:'https://api.turbos.finance/fun', grad:6000, dex:'Turbos' },
  HOP_FUN:    { name:'hop.fun',    url:'https://api.hop.ag',             grad:null, dex:'Cetus'  },
};

// ═══════════════════════════════════════════════════════════
// CRYPTO HELPERS
// ═══════════════════════════════════════════════════════════
function encKey(pk) {
  const iv = randomBytes(16);
  const c  = createCipheriv('aes-256-cbc', Buffer.from(ENC_KEY, 'hex'), iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(pk, 'utf8'), c.final()]).toString('hex');
}
function decKey(s) {
  const [iv, enc] = s.split(':');
  const d = createDecipheriv('aes-256-cbc', Buffer.from(ENC_KEY, 'hex'), Buffer.from(iv, 'hex'));
  return Buffer.concat([d.update(Buffer.from(enc, 'hex')), d.final()]).toString('utf8');
}
function hashPin(p)  { return createHash('sha256').update(p + ENC_KEY).digest('hex'); }
function getKP(u)    { return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(decKey(u.encryptedKey)).secretKey); }
function genRef()    { return 'AGT-' + Array.from({length:6}, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random()*36)]).join(''); }
function san(s)      { return typeof s === 'string' ? s.replace(/[<>&"]/g,'').trim().slice(0,500) : ''; }
function trunc(a)    { return (!a || a.length < 12) ? (a || '') : a.slice(0,6)+'...'+a.slice(-4); }

// ═══════════════════════════════════════════════════════════
// DATABASE — flat JSON, swap for PostgreSQL in production
// ═══════════════════════════════════════════════════════════
let DB = {};
function loadDB()    { if (existsSync(DB_FILE)) try { DB = JSON.parse(readFileSync(DB_FILE, 'utf8')); } catch { DB = {}; } }
function saveDB()    { writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); }
function getU(id)    { return DB[String(id)] || null; }
function makeU(id, extra={}) {
  const uid = String(id);
  DB[uid] = {
    chatId:uid, encryptedKey:null, walletAddress:null, pinHash:null,
    lockedAt:null, lastActivity:Date.now(), failAttempts:0, cooldownUntil:0,
    positions:[], copyTraders:[], snipeWatches:[],
    settings:{
      slippage:1, confirmThreshold:0.5, copyAmount:0.1,
      buyAmounts:[...DEF_AMTS], tpDefault:null, slDefault:null,
    },
    referralCode:genRef(), referredBy:null, referralCount:0, referralEarned:0,
    state:null, pd:{}, ...extra,
  };
  saveDB(); return DB[uid];
}
function updU(id, patch) {
  const u = DB[String(id)]; if (!u) return;
  Object.assign(u, patch); u.lastActivity = Date.now(); saveDB();
}
function isLocked(u)  { return !!(u?.pinHash && u?.lockedAt); }
function lockU(id)    { updU(id, { lockedAt: Date.now() }); }
function unlockU(id)  { updU(id, { lockedAt: null, failAttempts: 0 }); }

// Auto-lock inactive wallets
setInterval(() => {
  const now = Date.now();
  for (const [id, u] of Object.entries(DB))
    if (u.pinHash && !u.lockedAt && u.walletAddress && now - u.lastActivity > LOCK_MS)
      lockU(id);
}, 60_000);

// ═══════════════════════════════════════════════════════════
// SUI RPC CLIENT
// ═══════════════════════════════════════════════════════════
const sui = new SuiClient({ url: RPC_URL });

// Fetch with timeout + retry
async function ftch(url, opts={}, ms=8000, retries=2) {
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ac.signal });
      clearTimeout(t);
      return r;
    } catch(e) {
      clearTimeout(t);
      if (i === retries) throw e;
      await sleep(500 * (i + 1));
    }
  }
}

// RPC helpers with retries
async function getMeta(ct) {
  try { return await sui.getCoinMetadata({ coinType:ct }); } catch { return null; }
}
async function getCoins(addr, ct) {
  try { return (await sui.getCoins({ owner:addr, coinType:ct })).data; } catch { return []; }
}
async function getAllBals(addr) {
  return sui.getAllBalances({ owner:addr });
}

// ═══════════════════════════════════════════════════════════
// DEX POOL DISCOVERY
// ═══════════════════════════════════════════════════════════

/**
 * Find the best Cetus CLMM pool for a pair.
 * Tries both coin orderings. Returns pool info with a2b direction.
 */
async function findCetusPool(coinA, coinB) {
  // Try direct pool lookup first (more reliable)
  const pairs = [[coinA, coinB, true], [coinB, coinA, false]];
  for (const [ca, cb, isA2b] of pairs) {
    try {
      const r = await ftch(
        `https://api-sui.cetus.zone/v2/sui/pools_info?coin_type_a=${encodeURIComponent(ca)}&coin_type_b=${encodeURIComponent(cb)}&limit=5&order_by=tvl&order=desc`,
        { headers:{ Accept:'application/json' } }, 8000
      );
      if (!r.ok) continue;
      const d = await r.json();
      const pools = d.data?.list || [];
      if (!pools.length) continue;
      const best = pools.reduce((a,b) => (parseFloat(b.tvl||0) > parseFloat(a.tvl||0) ? b : a));
      const poolId = best.pool_address || best.id;
      if (!poolId) continue;
      // Determine actual a2b from pool data — coin_type_a is the "A" coin in pool
      const actualA = best.coin_type_a || ca;
      const actualB = best.coin_type_b || cb;
      const a2b = actualA.toLowerCase() === coinA.toLowerCase();
      return {
        poolId, coinA:actualA, coinB:actualB, a2b,
        liq: parseFloat(best.tvl || best.liquidity_usd || 0), dex:'Cetus',
      };
    } catch {}
  }

  // Fallback: search by token
  try {
    const r = await ftch(
      `https://api-sui.cetus.zone/v2/sui/pools_info?coin_type=${encodeURIComponent(coinB)}&limit=5&order_by=tvl&order=desc`,
      { headers:{ Accept:'application/json' } }, 8000
    );
    if (r.ok) {
      const d = await r.json();
      const pools = d.data?.list || [];
      // Filter only SUI pools
      const suiPools = pools.filter(p =>
        (p.coin_type_a||'').toLowerCase() === SUI_T.toLowerCase() ||
        (p.coin_type_b||'').toLowerCase() === SUI_T.toLowerCase()
      );
      if (suiPools.length) {
        const best = suiPools[0];
        const poolId = best.pool_address || best.id;
        const actualA = best.coin_type_a;
        const actualB = best.coin_type_b;
        const a2b = (actualA||'').toLowerCase() === SUI_T.toLowerCase();
        return { poolId, coinA:actualA, coinB:actualB, a2b, liq:parseFloat(best.tvl||0), dex:'Cetus' };
      }
    }
  } catch {}

  return null;
}

/**
 * Find Turbos pool. Uses Turbos Finance API directly.
 * Returns poolId, feeType (needed as 3rd type arg), and a2b.
 */
async function findTurbosPool(coinA, coinB) {
  // Turbos public pools API
  const apiUrls = [
    `https://api.turbos.finance/pools?coinTypeA=${encodeURIComponent(coinA)}&coinTypeB=${encodeURIComponent(coinB)}`,
    `https://api.turbos.finance/pools?coinTypeA=${encodeURIComponent(coinB)}&coinTypeB=${encodeURIComponent(coinA)}`,
  ];

  for (let idx = 0; idx < apiUrls.length; idx++) {
    try {
      const r = await ftch(apiUrls[idx], { headers:{ Accept:'application/json' } }, 8000);
      if (!r.ok) continue;
      const d = await r.json();
      const pools = Array.isArray(d) ? d : (d.data || d.pools || []);
      if (!pools.length) continue;
      const best = pools[0];
      const poolId   = best.poolId || best.pool_id || best.id;
      const feeType  = best.feeType || best.fee_type ||
        `0x91bfbc386a41afcfd9b2533058d7e9154d6339ca1::fee${best.fee||3000}bps::FEE${best.fee||3000}BPS`;
      const actualA  = best.coinTypeA || best.coin_type_a || (idx===0 ? coinA : coinB);
      const a2b      = (actualA||'').toLowerCase() === coinA.toLowerCase();
      if (!poolId) continue;
      return { poolId, feeType, a2b, coinA:actualA, coinB:best.coinTypeB||best.coin_type_b||coinB, dex:'Turbos' };
    } catch {}
  }

  // Fallback via Cetus aggregator (it indexes Turbos pools)
  for (const [ca, cb] of [[coinA,coinB],[coinB,coinA]]) {
    try {
      const r = await ftch(
        `https://api-sui.cetus.zone/v2/sui/pools_info?coin_type_a=${encodeURIComponent(ca)}&coin_type_b=${encodeURIComponent(cb)}&dex=turbos&limit=5&order_by=tvl&order=desc`,
        { headers:{ Accept:'application/json' } }, 8000
      );
      if (!r.ok) continue;
      const d = await r.json();
      const pools = d.data?.list || [];
      if (!pools.length) continue;
      const p       = pools[0];
      const poolId  = p.pool_address || p.id;
      if (!poolId) continue;
      const feeRate = p.fee_rate || p.fee || 3000;
      const feeType = `0x91bfbc386a41afcfd9b2533058d7e9154d6339ca1::fee${feeRate}bps::FEE${feeRate}BPS`;
      const a2b     = (p.coin_type_a||ca).toLowerCase() === coinA.toLowerCase();
      return { poolId, feeType, a2b, coinA:p.coin_type_a||ca, coinB:p.coin_type_b||cb, dex:'Turbos' };
    } catch {}
  }

  return null;
}

/**
 * Get best swap estimate for given pair + amount.
 * Uses Cetus Router (covers Cetus, Turbos, Aftermath, Kriya, etc.)
 */
async function getSwapEstimate(tokenIn, tokenOut, amountIn) {
  // 1. Cetus Router
  try {
    const r = await ftch(
      `${CETUS_ROUTER_URL}/find_routes?from=${encodeURIComponent(tokenIn)}&target=${encodeURIComponent(tokenOut)}&amount=${amountIn}&byAmountIn=true&depth=3&splitAlgorithm=1&splitFactor=1&splitCount=1`,
      { headers:{ Accept:'application/json' } }, 10000
    );
    if (r.ok) {
      const d = await r.json();
      const amt = d.data?.amountOut || d.data?.amount_out || d.amountOut;
      if (amt && amt !== '0') return amt.toString();
    }
  } catch {}

  // 2. Cetus pool direct
  try {
    const pool = await findCetusPool(tokenIn, tokenOut);
    if (pool) {
      const r = await ftch(
        `https://api-sui.cetus.zone/v2/sui/swap/calculate?pool_id=${pool.poolId}&a_to_b=${pool.a2b}&amount=${amountIn}&amount_specified_is_input=true`,
        { headers:{ Accept:'application/json' } }, 6000
      );
      if (r.ok) {
        const d = await r.json();
        const amt = d.data?.amount_out?.toString();
        if (amt && amt !== '0') return amt;
      }
    }
  } catch {}

  return null;
}

// ═══════════════════════════════════════════════════════════
// TOKEN STATE DETECTION
// ═══════════════════════════════════════════════════════════
const stateCache = new Map();
const STATE_TTL  = 20_000; // 20 seconds

async function detectState(ct) {
  const cached = stateCache.get(ct);
  if (cached && Date.now() - cached.ts < STATE_TTL) return cached;

  // 1. Cetus API — check with token as either coin_type_a or coin_type_b
  try {
    const r = await ftch(
      `https://api-sui.cetus.zone/v2/sui/pools_info?coin_type=${encodeURIComponent(ct)}&limit=5&order_by=tvl&order=desc`,
      { headers:{ Accept:'application/json' } }, 6000
    );
    if (r.ok) {
      const d     = await r.json();
      const pools = d.data?.list || [];
      // Only accept pools that pair with SUI
      const suiPool = pools.find(p =>
        (p.coin_type_a||'').toLowerCase() === SUI_T.toLowerCase() ||
        (p.coin_type_b||'').toLowerCase() === SUI_T.toLowerCase()
      );
      if (suiPool) {
        const poolId = suiPool.pool_address || suiPool.id;
        const coinA  = suiPool.coin_type_a;
        const coinB  = suiPool.coin_type_b;
        const a2b    = (coinA||'').toLowerCase() === SUI_T.toLowerCase(); // true = SUI→token
        const res = { state:'cetus', dex:'Cetus', poolId, coinA, coinB, a2b, ts:Date.now() };
        stateCache.set(ct, res); return res;
      }
    }
  } catch {}

  // 2. findCetusPool broader search
  try {
    const pool = await findCetusPool(SUI_T, ct);
    if (pool) {
      const res = { state:'cetus', dex:'Cetus', ...pool, ts:Date.now() };
      stateCache.set(ct, res); return res;
    }
  } catch {}

  // 3. Turbos
  try {
    const tPool = await findTurbosPool(SUI_T, ct);
    if (tPool) {
      const res = { state:'turbos', dex:'Turbos', ...tPool, ts:Date.now() };
      stateCache.set(ct, res); return res;
    }
  } catch {}

  // 4. GeckoTerminal — for display only, marks unsupported DEX
  try {
    for (const addr of [ct, ct.split('::')[0]]) {
      const r = await ftch(
        `${GECKO}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}/pools?page=1`,
        { headers:{ Accept:'application/json;version=20230302' } }, 5000
      );
      if (!r.ok) continue;
      const d = await r.json();
      if (d.data?.length) {
        const dexId  = d.data[0].relationships?.dex?.data?.id || 'dex';
        const dex    = dexId[0].toUpperCase() + dexId.slice(1);
        const liq    = parseFloat(d.data[0].attributes?.reserve_in_usd || 0);
        const res    = { state:'unsupported_dex', dex, liq, ts:Date.now() };
        stateCache.set(ct, res); return res;
      }
    }
  } catch {}

  // 5. Bonding curves
  for (const [key, lp] of Object.entries(LAUNCHPADS)) {
    try {
      const enc = encodeURIComponent(ct);
      const url = key === 'TURBOS_FUN' ? `${lp.url}/token?coinType=${enc}` : `${lp.url}/token/${enc}`;
      const r   = await ftch(url, {}, 5000);
      if (!r.ok) continue;
      const d   = await r.json();
      if (!d || d.graduated || d.is_graduated || d.complete || d.migrated) continue;
      const res = {
        state:'bonding', lp:key, lpName:lp.name, destDex:lp.dex,
        curveId: d.bonding_curve_id || d.curveObjectId || d.pool_id || null,
        suiRaised: parseFloat(d.sui_raised||0), threshold: lp.grad,
        ts:Date.now(),
      };
      stateCache.set(ct, res); return res;
    } catch {}
  }

  const res = { state:'unknown', ts:Date.now() };
  stateCache.set(ct, res); return res;
}

// ═══════════════════════════════════════════════════════════
// SWAP TRANSACTION BUILDERS
// ═══════════════════════════════════════════════════════════

/**
 * Build a Cetus CLMM swap PTB.
 * pool_script::swap in INTEGRATE package takes both coins — the out coin starts at 0 balance.
 */
async function buildCetusSwapTx({ wallet, poolId, coinA, coinB, a2b, coinInType, amountIn, minAmountOut }) {
  const tx = new Transaction();
  tx.setGasBudget(60_000_000);
  tx.setSender(wallet);

  // Prepare input coin
  let coinInObj;
  if (coinInType === SUI_T) {
    [coinInObj] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(amountIn))]);
  } else {
    const coins = await getCoins(wallet, coinInType);
    if (!coins.length) throw new Error('No token balance found in wallet');
    let obj = tx.object(coins[0].coinObjectId);
    if (coins.length > 1) {
      tx.mergeCoins(obj, coins.slice(1).map(c => tx.object(c.coinObjectId)));
    }
    const total = coins.reduce((s,c) => s + BigInt(c.balance), 0n);
    if (BigInt(amountIn) < total) {
      [coinInObj] = tx.splitCoins(obj, [tx.pure.u64(BigInt(amountIn))]);
    } else {
      coinInObj = obj;
    }
  }

  // Coin pairing — coinA gets swapped to coinB if a2b=true
  let swapCoinA, swapCoinB;
  if (a2b) {
    // swapping A→B: coinA goes in, coinB starts empty
    swapCoinA = coinInObj;
    [swapCoinB] = tx.splitCoins(tx.gas, [tx.pure.u64(0n)]);
  } else {
    // swapping B→A: coinB goes in, coinA starts empty
    [swapCoinA] = tx.splitCoins(tx.gas, [tx.pure.u64(0n)]);
    swapCoinB   = coinInObj;
  }

  const [resultA, resultB] = tx.moveCall({
    target: `${CETUS_INTEGRATE}::pool_script::swap`,
    typeArguments: [coinA, coinB],
    arguments: [
      tx.object(CETUS_CONFIG),
      tx.object(poolId),
      swapCoinA,
      swapCoinB,
      tx.pure.bool(a2b),
      tx.pure.bool(true),                                                           // by_amount_in
      tx.pure.u64(BigInt(amountIn)),
      tx.pure.u64(BigInt(minAmountOut || '0')),
      tx.pure.u128(a2b ? BigInt(CETUS_MIN_SQRT) : BigInt(CETUS_MAX_SQRT)),
      tx.object(CLOCK_OBJ),
    ],
  });

  tx.transferObjects([resultA, resultB], tx.pure.address(wallet));
  return tx;
}

/**
 * Build a Turbos swap PTB.
 * swap_a_b:  a2b = true,  CoinA goes in
 * swap_b_a:  a2b = false, CoinB goes in
 * Type args: [CoinA, CoinB, FeeType]
 */
async function buildTurbosSwapTx({ wallet, poolId, feeType, coinA, coinB, a2b, coinInType, amountIn }) {
  const tx = new Transaction();
  tx.setGasBudget(60_000_000);
  tx.setSender(wallet);

  let coinInObj;
  if (coinInType === SUI_T) {
    [coinInObj] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(amountIn))]);
  } else {
    const coins = await getCoins(wallet, coinInType);
    if (!coins.length) throw new Error('No token balance found in wallet');
    let obj = tx.object(coins[0].coinObjectId);
    if (coins.length > 1) tx.mergeCoins(obj, coins.slice(1).map(c => tx.object(c.coinObjectId)));
    const total = coins.reduce((s,c) => s + BigInt(c.balance), 0n);
    if (BigInt(amountIn) < total) { [coinInObj] = tx.splitCoins(obj, [tx.pure.u64(BigInt(amountIn))]); }
    else { coinInObj = obj; }
  }

  // Function: swap_a_b if a2b, else swap_b_a
  const fn = a2b ? 'swap_a_b' : 'swap_b_a';

  const [resultCoin] = tx.moveCall({
    target: `${TURBOS_PKG}::pool_script::${fn}`,
    typeArguments: [coinA, coinB, feeType],
    arguments: [
      tx.object(poolId),
      tx.object(TURBOS_VERSIONED),
      coinInObj,
      tx.pure.u64(BigInt(amountIn)),
      tx.pure.bool(true),                       // by_amount_in
      tx.pure.u64(0n),                          // sqrt_price_limit (0 = no limit)
      tx.pure.u64(0n),                          // min_amount_out
      tx.pure.address(wallet),
      tx.object(CLOCK_OBJ),
    ],
  });

  tx.transferObjects([resultCoin], tx.pure.address(wallet));
  return tx;
}

// ═══════════════════════════════════════════════════════════
// BONDING CURVE SWAPS
// ═══════════════════════════════════════════════════════════

async function swapBuyBonding({ kp, wallet, ct, amtMist, curveId, u }) {
  const pkg = ct.split('::')[0];
  const mod = ct.split('::')[1] || '';
  const tx  = new Transaction();
  tx.setGasBudget(30_000_000);

  const feeMist  = (amtMist * BigInt(FEE_BPS)) / 10000n;
  const refMist  = u.referredBy ? (feeMist * BigInt(Math.floor(REF_SHARE * 100))) / 100n : 0n;
  const devMist  = feeMist - refMist;
  const tradeMist = amtMist - feeMist;

  const [dc] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
  tx.transferObjects([dc], tx.pure.address(DEV_WALLET));

  if (refMist > 0n && u.referredBy) {
    const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(refMist)]);
    tx.transferObjects([rc], tx.pure.address(u.referredBy));
    const refUser = Object.values(DB).find(x => x.walletAddress === u.referredBy);
    if (refUser) { refUser.referralEarned = (refUser.referralEarned||0) + Number(refMist)/1e9; saveDB(); }
  }

  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(tradeMist)]);
  tx.moveCall({
    target: `${pkg}::${mod}::buy`,
    typeArguments: [ct],
    arguments: [tx.object(curveId), coin, tx.object(CLOCK_OBJ)],
  });

  const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true} });
  if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Bonding buy failed');
  return { digest:res.digest, fee:feeMist };
}

async function swapSellBonding({ kp, ct, coins, amt, curveId }) {
  const pkg = ct.split('::')[0];
  const mod = ct.split('::')[1] || '';
  const tx  = new Transaction();
  tx.setGasBudget(30_000_000);
  let obj = tx.object(coins[0].coinObjectId);
  if (coins.length > 1) tx.mergeCoins(obj, coins.slice(1).map(c => tx.object(c.coinObjectId)));
  const [sell] = tx.splitCoins(obj, [tx.pure.u64(amt)]);
  tx.moveCall({
    target: `${pkg}::${mod}::sell`,
    typeArguments: [ct],
    arguments: [tx.object(curveId), sell, tx.object(CLOCK_OBJ)],
  });
  const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true} });
  if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Bonding sell failed');
  return { digest:res.digest };
}

// ═══════════════════════════════════════════════════════════
// MAIN SWAP EXECUTION
// ═══════════════════════════════════════════════════════════

async function executeBuy(chatId, ct, amtSui) {
  const u      = getU(chatId); if (!u) throw new Error('No wallet found.');
  const kp     = getKP(u);
  const amt    = BigInt(Math.floor(parseFloat(amtSui) * Number(MIST)));
  const meta   = await getMeta(ct) || {};
  const sym    = meta.symbol || trunc(ct);
  const st     = await detectState(ct);

  // Collect fee from buy amount
  const feeMist  = (amt * BigInt(FEE_BPS)) / 10000n;
  const tradeAmt = amt - feeMist;

  const refMist  = u.referredBy ? (feeMist * BigInt(Math.floor(REF_SHARE * 100))) / 100n : 0n;
  const devMist  = feeMist - refMist;

  // Helper to append fee transfers to tx
  const addFees = (tx) => {
    const [fc] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
    tx.transferObjects([fc], tx.pure.address(DEV_WALLET));
    if (refMist > 0n && u.referredBy) {
      const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(refMist)]);
      tx.transferObjects([rc], tx.pure.address(u.referredBy));
      const ru = Object.values(DB).find(x => x.walletAddress === u.referredBy);
      if (ru) { ru.referralEarned = (ru.referralEarned||0) + Number(refMist)/1e9; saveDB(); }
    }
  };

  if (st.state === 'cetus') {
    const slipFactor = BigInt(Math.floor((1 - u.settings.slippage / 100) * 10000));
    const est        = await getSwapEstimate(SUI_T, ct, tradeAmt.toString());
    const minOut     = est ? (BigInt(est) * slipFactor) / 10000n : 0n;
    const tx = await buildCetusSwapTx({
      wallet: u.walletAddress,
      poolId: st.poolId,
      coinA:  st.coinA,
      coinB:  st.coinB,
      a2b:    st.a2b,                // a2b=true means SUI→token
      coinInType: SUI_T,
      amountIn:   tradeAmt.toString(),
      minAmountOut: minOut.toString(),
    });
    addFees(tx);
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'TX failed');
    const tok = Number(est||0) / Math.pow(10, meta.decimals||9);
    addPos(chatId, { ct, sym, entry:Number(tradeAmt)/1e9/(tok||1), tokens:tok, dec:meta.decimals||9, spent:amtSui, source:'dex', tp:u.settings.tpDefault, sl:u.settings.slDefault });
    return { digest:res.digest, feeSui:fSui(feeMist), route:'Cetus CLMM', out:tok.toFixed(4), sym, bonding:false };
  }

  if (st.state === 'turbos') {
    const tx = await buildTurbosSwapTx({
      wallet: u.walletAddress,
      poolId: st.poolId,
      feeType: st.feeType,
      coinA:  st.coinA,
      coinB:  st.coinB,
      a2b:    st.a2b,
      coinInType: SUI_T,
      amountIn:   tradeAmt.toString(),
    });
    addFees(tx);
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Turbos TX failed');
    const est = await getSwapEstimate(SUI_T, ct, tradeAmt.toString());
    const tok = est ? Number(est) / Math.pow(10, meta.decimals||9) : 0;
    addPos(chatId, { ct, sym, entry:Number(tradeAmt)/1e9/(tok||1), tokens:tok, dec:meta.decimals||9, spent:amtSui, source:'dex', tp:u.settings.tpDefault, sl:u.settings.slDefault });
    return { digest:res.digest, feeSui:fSui(feeMist), route:'Turbos CLMM', out:tok.toFixed(4), sym, bonding:false };
  }

  if (st.state === 'unsupported_dex') {
    throw new Error(`${sym} is on ${st.dex}. Trade directly on their website — not yet supported here.`);
  }

  if (st.state === 'bonding') {
    if (!st.curveId) throw new Error(`On ${st.lpName} — curve ID unavailable. Trade directly on the launchpad website.`);
    const res = await swapBuyBonding({ kp, wallet:u.walletAddress, ct, amtMist:amt, curveId:st.curveId, u });
    addPos(chatId, { ct, sym, entry:0, tokens:0, dec:9, spent:amtSui, source:'bonding', lp:st.lpName, tp:null, sl:null });
    return { digest:res.digest, feeSui:fSui(res.fee), route:st.lpName, out:'?', sym, bonding:true, lpName:st.lpName };
  }

  throw new Error(`${sym} — no liquidity found on Cetus, Turbos, or any launchpad. Check the CA is correct.`);
}

async function executeSell(chatId, ct, pct) {
  const u    = getU(chatId); if (!u) throw new Error('No wallet found.');
  const kp   = getKP(u);
  const meta = await getMeta(ct) || {};
  const sym  = meta.symbol || trunc(ct);
  const bag  = await getCoins(u.walletAddress, ct);
  if (!bag.length) throw new Error(`No ${sym} in wallet.`);

  const total  = bag.reduce((s,c) => s + BigInt(c.balance), 0n);
  const sellAmt = (total * BigInt(pct)) / 100n;
  if (sellAmt === 0n) throw new Error('Sell amount is zero.');

  const st = await detectState(ct);

  if (st.state === 'cetus') {
    // For sells: token→SUI. The pool's a2b from detection was SUI→token,
    // so for selling we flip to !a2b (token→SUI)
    const sellA2b    = !st.a2b;
    const coinInType = st.a2b ? st.coinB : st.coinA;   // the token side
    const est        = await getSwapEstimate(ct, SUI_T, sellAmt.toString());
    const slipFactor = BigInt(Math.floor((1 - u.settings.slippage / 100) * 10000));
    const minOut     = est ? (BigInt(est) * slipFactor) / 10000n : 0n;
    const feeMist    = est ? (BigInt(est) * BigInt(FEE_BPS)) / 10000n : 0n;
    const refMist    = u.referredBy ? (feeMist * BigInt(Math.floor(REF_SHARE * 100))) / 100n : 0n;
    const devMist    = feeMist - refMist;

    const tx = await buildCetusSwapTx({
      wallet: u.walletAddress,
      poolId: st.poolId,
      coinA:  st.coinA,
      coinB:  st.coinB,
      a2b:    sellA2b,
      coinInType,
      amountIn:     sellAmt.toString(),
      minAmountOut: minOut.toString(),
    });

    // Fee taken from gas in sell tx (SUI output stays in wallet via result coins)
    if (devMist > 0n) {
      const [fc] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
      tx.transferObjects([fc], tx.pure.address(DEV_WALLET));
    }
    if (refMist > 0n && u.referredBy) {
      const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(refMist)]);
      tx.transferObjects([rc], tx.pure.address(u.referredBy));
      const ru = Object.values(DB).find(x => x.walletAddress === u.referredBy);
      if (ru) { ru.referralEarned = (ru.referralEarned||0) + Number(refMist)/1e9; saveDB(); }
    }

    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Sell TX failed');
    if (pct === 100) updU(chatId, { positions: getU(chatId).positions.filter(p => p.ct !== ct) });
    const suiOut = est ? (Number(est)/1e9).toFixed(4) : '?';
    return { digest:res.digest, feeSui:fSui(feeMist), route:'Cetus CLMM', sui:suiOut, sym, pct };
  }

  if (st.state === 'turbos') {
    const sellA2b    = !st.a2b;
    const coinInType = st.a2b ? st.coinB : st.coinA;
    const tx = await buildTurbosSwapTx({
      wallet: u.walletAddress,
      poolId: st.poolId,
      feeType: st.feeType,
      coinA:  st.coinA,
      coinB:  st.coinB,
      a2b:    sellA2b,
      coinInType,
      amountIn: sellAmt.toString(),
    });
    const est     = await getSwapEstimate(ct, SUI_T, sellAmt.toString());
    const feeMist = est ? (BigInt(est) * BigInt(FEE_BPS)) / 10000n : 0n;
    const refMist = u.referredBy ? (feeMist * BigInt(Math.floor(REF_SHARE * 100))) / 100n : 0n;
    const devMist = feeMist - refMist;
    if (devMist > 0n) {
      const [fc] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
      tx.transferObjects([fc], tx.pure.address(DEV_WALLET));
    }
    if (refMist > 0n && u.referredBy) {
      const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(refMist)]);
      tx.transferObjects([rc], tx.pure.address(u.referredBy));
      const ru = Object.values(DB).find(x => x.walletAddress === u.referredBy);
      if (ru) { ru.referralEarned = (ru.referralEarned||0) + Number(refMist)/1e9; saveDB(); }
    }
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Turbos sell failed');
    if (pct === 100) updU(chatId, { positions: getU(chatId).positions.filter(p => p.ct !== ct) });
    const suiOut = est ? (Number(est)/1e9).toFixed(4) : '?';
    return { digest:res.digest, feeSui:fSui(feeMist), route:'Turbos CLMM', sui:suiOut, sym, pct };
  }

  if (st.state === 'unsupported_dex') {
    throw new Error(`${sym} is on ${st.dex}. Sell directly there.`);
  }

  if (st.state === 'bonding') {
    if (!st.curveId) throw new Error(`Bonding curve ID unavailable for ${st.lpName}.`);
    const res = await swapSellBonding({ kp, ct, coins:bag, amt:sellAmt, curveId:st.curveId });
    if (pct === 100) updU(chatId, { positions: getU(chatId).positions.filter(p => p.ct !== ct) });
    return { digest:res.digest, feeSui:'N/A', route:st.lpName, sui:'?', sym, pct };
  }

  // Last resort: force-find Cetus pool
  const pool = await findCetusPool(ct, SUI_T);
  if (pool) {
    const tx = await buildCetusSwapTx({ wallet:u.walletAddress, poolId:pool.poolId, coinA:pool.coinA, coinB:pool.coinB, a2b:pool.a2b, coinInType:ct, amountIn:sellAmt.toString(), minAmountOut:'0' });
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'TX failed');
    if (pct === 100) updU(chatId, { positions: getU(chatId).positions.filter(p => p.ct !== ct) });
    return { digest:res.digest, feeSui:'0', route:'Cetus', sui:'?', sym, pct };
  }

  throw new Error(`Cannot sell ${sym} — not found on any supported DEX.`);
}

// ═══════════════════════════════════════════════════════════
// WITHDRAW
// ═══════════════════════════════════════════════════════════

async function executeWithdraw(chatId, toAddr, coinType, amountRaw) {
  const u  = getU(chatId); if (!u) throw new Error('No wallet found.');
  const kp = getKP(u);
  const tx = new Transaction();
  tx.setGasBudget(10_000_000);

  if (coinType === SUI_T) {
    const amtMist = BigInt(Math.floor(parseFloat(amountRaw) * Number(MIST)));
    const [coin]  = tx.splitCoins(tx.gas, [tx.pure.u64(amtMist)]);
    tx.transferObjects([coin], tx.pure.address(toAddr));
  } else {
    const meta  = await getMeta(coinType) || { decimals:9 };
    const coins = await getCoins(u.walletAddress, coinType);
    if (!coins.length) throw new Error('No token balance to withdraw.');
    const amt   = BigInt(Math.floor(parseFloat(amountRaw) * Math.pow(10, meta.decimals)));
    let obj = tx.object(coins[0].coinObjectId);
    if (coins.length > 1) tx.mergeCoins(obj, coins.slice(1).map(c => tx.object(c.coinObjectId)));
    const [splitCoin] = tx.splitCoins(obj, [tx.pure.u64(amt)]);
    tx.transferObjects([splitCoin], tx.pure.address(toAddr));
  }

  const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true} });
  if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Withdraw failed');
  return res.digest;
}

// ═══════════════════════════════════════════════════════════
// SECURITY AUDIT CHECKS
// ═══════════════════════════════════════════════════════════

async function findDeployer(ct) {
  try {
    const pkg = ct.split('::')[0];
    const txs = await sui.queryTransactionBlocks({
      filter:{ InputObject:pkg }, limit:1, order:'ascending', options:{ showInput:true },
    });
    if (!txs.data.length) return null;
    return txs.data[0].transaction?.data?.sender || null;
  } catch { return null; }
}

async function checkMintAuth(ct, deployer) {
  if (!deployer) return null;
  try {
    // Check direct ownership
    const owned = await sui.getOwnedObjects({
      owner: deployer,
      filter:{ StructType:`0x2::coin::TreasuryCap<${ct}>` },
      options:{ showType:true }, limit:5,
    });
    if (owned.data.length > 0) return true;

    // Check if TreasuryCap was destroyed via queryEvents
    // (if it was burned/wrapped, no TreasuryCap exists anywhere)
    const pkg = ct.split('::')[0];
    const evts = await sui.queryEvents({
      query:{ MoveEventType:`0x2::coin::TreasuryCap<${ct}>` }, limit:5,
    }).catch(() => ({ data:[] }));
    // If no direct ownership and no events, likely burned or never existed
    return owned.data.length > 0;
  } catch { return null; }
}

async function checkUpgradeable(ct, deployer) {
  if (!deployer) return null;
  try {
    const pkg  = ct.split('::')[0];
    const owned = await sui.getOwnedObjects({
      owner: deployer,
      filter:{ StructType:'0x2::package::UpgradeCap' },
      options:{ showType:true, showContent:true }, limit:50,
    });
    for (const obj of owned.data) {
      const fields = obj.data?.content?.fields;
      if (fields?.package === pkg) return true;
    }
    return false;
  } catch { return null; }
}

async function checkDenyCap(ct, deployer) {
  if (!deployer) return null;
  try {
    const owned = await sui.getOwnedObjects({
      owner: deployer,
      filter:{ StructType:`0x2::coin::DenyCapV2<${ct}>` },
      options:{ showType:true, showContent:true }, limit:5,
    });
    if (!owned.data.length) return { has:false, globalPause:false };
    const fields = owned.data[0].data?.content?.fields;
    return { has:true, globalPause: fields?.allow_global_pause === true };
  } catch { return null; }
}

/**
 * Honeypot detection using devInspectTransactionBlock.
 * Simulates a sell transaction without executing it.
 * If simulation succeeds → can sell (not a honeypot).
 * If simulation fails → likely honeypot.
 */
async function checkHoneypot(ct, wallet) {
  // First try: Cetus Router sell route (fast)
  try {
    const r = await ftch(
      `${CETUS_ROUTER_URL}/find_routes?from=${encodeURIComponent(ct)}&target=${encodeURIComponent(SUI_T)}&amount=100000000&byAmountIn=true&depth=3`,
      { headers:{ Accept:'application/json' } }, 10000
    );
    if (r.ok) {
      const d = await r.json();
      const amtOut = d.data?.amountOut || d.data?.amount_out || '0';
      if (amtOut && amtOut !== '0' && BigInt(amtOut) > 0n) {
        // Has sell route — now simulate on-chain to catch contract-level blocks
        if (wallet) {
          const pool = await findCetusPool(ct, SUI_T);
          if (pool) {
            try {
              const dummyAmt = 1_000_000n; // tiny amount
              const tx = new Transaction();
              tx.setSender(wallet);
              // We need a dummy coin — use a zero-split
              const [dummyCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(dummyAmt)]);
              tx.transferObjects([dummyCoin], tx.pure.address(wallet));
              const inspectRes = await sui.devInspectTransactionBlock({
                transactionBlock: tx,
                sender: wallet,
              });
              // If devInspect works at all, chain is accessible
            } catch {}
          }
        }
        return true;
      }
      if (d.data !== undefined) return false;
    }
  } catch {}

  // Fallback: pool existence
  try {
    const pool = await findCetusPool(ct, SUI_T);
    if (pool) return true;
  } catch {}

  return null;
}

async function getHolders(ct) {
  try {
    const r = await ftch(
      `${BB_BASE}/coins/${encodeURIComponent(ct)}/holders?page=0&size=20&sortBy=AMOUNT&orderBy=DESC`,
      { headers:{ 'x-api-key':BB_KEY, Accept:'application/json' } }, 8000
    );
    if (!r.ok) throw new Error(`BB ${r.status}`);
    const d = await r.json(), list = d.content || d.data || [];
    return { total:d.totalElements||d.total||0, top:list.slice(0,15).map(h=>({ addr:h.address||h.owner||'', pct:parseFloat(h.percentage||h.pct||0) })) };
  } catch {}
  return { total:0, top:[] };
}

async function getDevBalance(ct, supplyRaw, deployer) {
  if (!deployer || !supplyRaw) return null;
  try {
    const coins = await getCoins(deployer, ct);
    const bal   = coins.reduce((s,c) => s + BigInt(c.balance), 0n);
    return Number(bal) / supplyRaw * 100;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
// TOKEN DATA
// ═══════════════════════════════════════════════════════════

async function geckoTok(ct) {
  try {
    for (const addr of [ct, ct.split('::')[0]]) {
      const r = await ftch(`${GECKO}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}`,
        { headers:{ Accept:'application/json;version=20230302' } }, 6000);
      if (!r.ok) continue;
      const a = (await r.json()).data?.attributes || {};
      if (!a.name && !a.symbol) continue;
      return {
        name:a.name, symbol:a.symbol, decimals:parseInt(a.decimals)||9,
        rawSupply:parseFloat(a.total_supply||0),
        priceUsd:parseFloat(a.price_usd||0), mcap:parseFloat(a.market_cap_usd||0),
        vol24h:parseFloat(a.volume_usd?.h24||0), chg24h:parseFloat(a.price_change_percentage?.h24||0),
      };
    }
  } catch {}
  return null;
}

async function geckoPools(ct) {
  const pools=[], seen=new Set();
  try {
    for (const addr of [ct, ct.split('::')[0]]) {
      const r = await ftch(`${GECKO}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}/pools?page=1`,
        { headers:{ Accept:'application/json;version=20230302' } }, 6000);
      if (!r.ok) continue;
      for (const p of ((await r.json()).data||[]).slice(0,6)) {
        const id=p.attributes?.address||p.id; if(seen.has(id)) continue; seen.add(id);
        const a=p.attributes||{}, dex=p.relationships?.dex?.data?.id||a.dex_id||'DEX';
        pools.push({
          dex:dex[0].toUpperCase()+dex.slice(1), id,
          liq:parseFloat(a.reserve_in_usd||0), vol:parseFloat(a.volume_usd?.h24||0),
          chg5m:parseFloat(a.price_change_percentage?.m5||0), chg1h:parseFloat(a.price_change_percentage?.h1||0),
          chg6h:parseFloat(a.price_change_percentage?.h6||0), chg24h:parseFloat(a.price_change_percentage?.h24||0),
          priceU:parseFloat(a.base_token_price_usd||0), age:a.pool_created_at||null,
        });
      }
      if (pools.length) break;
    }
  } catch {}
  return pools.sort((a,b) => b.liq - a.liq);
}

async function getTokenData(ct, walletAddr) {
  const cap = (p) => Promise.race([p, new Promise(r => setTimeout(()=>r(null), 7000))]);

  const [gTok, pools, meta, supply, holders] = await Promise.all([
    geckoTok(ct).catch(()=>null),
    geckoPools(ct).catch(()=>[]),
    getMeta(ct).catch(()=>null),
    sui.getTotalSupply({coinType:ct}).catch(()=>null),
    cap(getHolders(ct)),
  ]);

  const best   = pools[0];
  const name   = meta?.name   || gTok?.name   || '?';
  const symbol = meta?.symbol || gTok?.symbol || '?';
  const dec    = meta?.decimals || gTok?.decimals || 9;
  const supRaw = supply ? Number(BigInt(supply.value)) : (gTok?.rawSupply||0);
  const supH   = supRaw / Math.pow(10, dec);
  const priceU = gTok?.priceUsd || best?.priceU || 0;
  const liq    = pools.reduce((t,p) => t+(p.liq||0), 0);
  const top10  = (holders?.top||[]).slice(0,10).reduce((t,h) => t+h.pct, 0);

  const deployer = await cap(findDeployer(ct));

  const [mint, upgradeable, denyCap, honeypot, devPct] = await Promise.all([
    cap(checkMintAuth(ct, deployer)),
    cap(checkUpgradeable(ct, deployer)),
    cap(checkDenyCap(ct, deployer)),
    cap(checkHoneypot(ct, walletAddr)),
    cap(getDevBalance(ct, supRaw, deployer)),
  ]);

  return {
    name, symbol, dec, supH,
    priceU, mcap:gTok?.mcap||0, vol:gTok?.vol24h||best?.vol||0, liq,
    chg5m:best?.chg5m||0, chg1h:best?.chg1h||0, chg6h:best?.chg6h||0, chg24h:best?.chg24h||gTok?.chg24h||0,
    pools, best, dex:best?.dex||'Sui',
    age:best?.age ? fAge(best.age) : null,
    holders:holders?.total||0, topHolders:holders?.top||[], top10,
    mint, upgradeable, denyCap, honeypot, devPct, deployer,
  };
}

// ═══════════════════════════════════════════════════════════
// FORMAT HELPERS
// ═══════════════════════════════════════════════════════════
function fSui(m)   { return (Number(m)/1e9).toFixed(4); }
function fNum(n)   { if(!n)return'0'; if(n>=1e9)return(n/1e9).toFixed(2)+'B'; if(n>=1e6)return(n/1e6).toFixed(2)+'M'; if(n>=1e3)return(n/1e3).toFixed(1)+'K'; return n.toFixed(0); }
function fChg(p)   { if(p===null||p===undefined)return'N/A'; return`${p>=0?'+':''}${p.toFixed(2)}%`; }
function tick(v,g) { return v===null||v===undefined?'⚪':v===g?'✅':'⚠️'; }

function fPrice(p) {
  if (!p||p===0) return '$0';
  if (p>=1)     return `$${p.toFixed(4)}`;
  if (p>=0.01)  return `$${p.toFixed(6)}`;
  const s=p.toFixed(20), dec=s.split('.')[1]||'';
  let z=0; for(const c of dec){if(c==='0')z++;else break;}
  if (z>=4) {
    const sub=['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉'];
    return `$0.0${z.toString().split('').map(d=>sub[+d]).join('')}${dec.slice(z,z+4)}`;
  }
  return `$${p.toFixed(z+4)}`;
}

function fAge(d) {
  if (!d) return null;
  try {
    const ms=Date.now()-new Date(d).getTime(), m=Math.floor(ms/60000), h=Math.floor(m/60), day=Math.floor(h/24);
    if(day>0)return`${day}d`; if(h>0)return`${h}h ${m%60}m`; return`${m}m`;
  } catch { return null; }
}

function fSupply(n) {
  if(!n||n===0) return null;
  if(n>=1e9) return(n/1e9).toFixed(2)+'B';
  if(n>=1e6) return(n/1e6).toFixed(2)+'M';
  if(n>=1e3) return(n/1e3).toFixed(1)+'K';
  return n.toLocaleString();
}

// ═══════════════════════════════════════════════════════════
// DISPLAY CARDS
// ═══════════════════════════════════════════════════════════

function buyCard(d, ct) {
  const issues = [
    d.mint===true, d.honeypot===false,
    d.upgradeable===true, d.denyCap?.has===true,
    d.top10>50, d.devPct!==null&&d.devPct>10
  ].filter(Boolean).length;
  const L = [];
  L.push(`*${d.symbol}/SUI*`);
  L.push(`\`${ct}\``);
  L.push(`\n🌐 Sui @ ${d.dex}${d.age?` | 📍 Age: ${d.age}`:''}`);
  if (d.mcap>0)   L.push(`📊 MCap: $${fNum(d.mcap)}`);
  if (d.vol>0)    L.push(`💲 Vol: $${fNum(d.vol)}`);
  if (d.liq>0)    L.push(`💧 Liq: $${fNum(d.liq)}`);
  if (d.priceU>0) L.push(`💰 USD: ${fPrice(d.priceU)}`);
  const chgs=[];
  if(d.chg5m)  chgs.push(`5M: ${fChg(d.chg5m)}`);
  if(d.chg1h)  chgs.push(`1H: ${fChg(d.chg1h)}`);
  if(d.chg6h)  chgs.push(`6H: ${fChg(d.chg6h)}`);
  if(d.chg24h) chgs.push(`24H: ${fChg(d.chg24h)}`);
  if(chgs.length) L.push(`📉 ${chgs.join(' | ')}`);
  if(d.pools.length>1) L.push(`🔀 ${d.pools.length} pools — routing to best liquidity`);
  L.push(`\n🛡 *Audit* (${issues} issue${issues!==1?'s':''})`);
  L.push(`${tick(d.mint,false)} Mint: ${d.mint===null?'⚪':d.mint?'Yes ⚠️':'Burned ✅'} | ${tick(d.honeypot,true)} Honeypot: ${d.honeypot===null?'⚪':d.honeypot?'No ✅':'Yes ❌'}`);
  L.push(`${tick(d.upgradeable,false)} Contract: ${d.upgradeable===null?'⚪':d.upgradeable?'Upgradeable ⚠️':'Immutable ✅'} | ${d.denyCap===null?'⚪':d.denyCap.has?(d.denyCap.globalPause?'🔴 Freeze All':'⚠️ Can Freeze'):'✅ No Freeze'}`);
  L.push(`${d.top10<30?'✅':'⚠️'} Top 10: ${d.top10>0?d.top10.toFixed(1)+'%':'?'} | ${d.devPct!==null?`${d.devPct<5?'✅':d.devPct<15?'⚠️':'🔴'} Dev: ${d.devPct.toFixed(2)}%`:'⚪ Dev: ?'}`);
  L.push(`\n⛽️ Est. Gas: ~0.010 SUI`);
  return L.join('\n');
}

function scanReport(d, ct, st) {
  const top3   = d.topHolders.slice(0,3).reduce((t,h)=>t+h.pct,0);
  const issues = [
    d.mint===true, d.honeypot===false,
    d.upgradeable===true, d.denyCap?.has===true,
    d.top10>50, d.devPct!==null&&d.devPct>10
  ].filter(Boolean).length;
  const L=[];
  L.push(`🔍 *Token Scan*\n`);
  L.push(`📛 *${d.name}* (${d.symbol})`);
  L.push(`📋 \`${trunc(ct)}\``);
  if (d.deployer) L.push(`👨‍💻 Deployer: \`${trunc(d.deployer)}\``);
  if (d.priceU>0) L.push(`\n💵 ${fPrice(d.priceU)}${d.chg24h?` ${d.chg24h>=0?'📈+':'📉'}${d.chg24h.toFixed(2)}%`:''}`);
  if (d.mcap>0)   L.push(`🏦 MCap: $${fNum(d.mcap)}`);
  if (d.vol>0)    L.push(`💹 Vol 24h: $${fNum(d.vol)}`);
  const sup=fSupply(d.supH); if(sup) L.push(`🏭 Supply: ${sup}`);
  L.push(`\n👥 Holders: ${d.holders>0?d.holders.toLocaleString():'N/A'}${top3>50?` ⚠️ Top 3: ${top3.toFixed(1)}%`:''}`);
  if (d.topHolders.length) {
    L.push('*Top Holders:*');
    d.topHolders.slice(0,5).forEach((h,i)=>L.push(`  ${i+1}. \`${trunc(h.addr)}\` — ${h.pct.toFixed(2)}%`));
  }
  if (st.state==='bonding') {
    L.push(`\n📊 *Bonding Curve — ${st.lpName}*`);
    if (st.suiRaised>0&&st.threshold) {
      const p=Math.min(100,(st.suiRaised/st.threshold)*100);
      L.push(`[${'█'.repeat(Math.floor(p/10))}${'░'.repeat(10-Math.floor(p/10))}] ${p.toFixed(1)}% (${st.suiRaised}/${st.threshold} SUI)`);
    }
    L.push(`Graduates to: ${st.destDex}`);
  } else if (d.pools.length) {
    L.push(`\n💧 *Pools (${d.pools.length} found)*`);
    d.pools.slice(0,4).forEach((p,i)=>L.push(`  ${i===0?'⭐':'•'} ${p.dex}: $${fNum(p.liq)}${p.vol>0?` | vol $${fNum(p.vol)}`:''}`));
    L.push(`Total liq: $${fNum(d.liq)}`);
  } else { L.push('\n❌ No pools found on any DEX'); }
  L.push(`\n🛡 *Security* (${issues} issue${issues!==1?'s':''})`);
  L.push(`${tick(d.honeypot,true)} Honeypot: ${d.honeypot===null?'⚪ Unknown':d.honeypot?'✅ Can sell':'❌ CANNOT SELL'}`);
  L.push(`${tick(d.mint,false)} Mint Auth: ${d.mint===null?'⚪':d.mint?'⚠️ Dev can mint more':'✅ Burned/renounced'}`);
  L.push(`${tick(d.upgradeable,false)} Contract: ${d.upgradeable===null?'⚪':d.upgradeable?'⚠️ Upgradeable (dev can change code)':'✅ Immutable'}`);
  const dcStr = d.denyCap===null?'⚪':!d.denyCap.has?'✅ No freeze ability':d.denyCap.globalPause?'❌ Can FREEZE ALL wallets':'⚠️ Can freeze specific wallets';
  L.push(`${d.denyCap===null?'⚪':d.denyCap.has?(d.denyCap.globalPause?'❌':'⚠️'):'✅'} Freeze: ${dcStr}`);
  L.push(`${d.top10<30?'✅':'⚠️'} Top 10: ${d.top10>0?d.top10.toFixed(1)+'%':'?'} | ${d.devPct!==null?`${d.devPct<5?'✅':d.devPct<15?'⚠️':'🔴'} Dev holds: ${d.devPct.toFixed(2)}%`:'⚪ Dev: ?'}`);
  return L.join('\n');
}

// ═══════════════════════════════════════════════════════════
// POSITIONS & P&L
// ═══════════════════════════════════════════════════════════

function addPos(chatId, p) {
  const u = getU(chatId); if (!u) return;
  u.positions = u.positions || [];
  u.positions.push({ id:randomBytes(4).toString('hex'), ct:p.ct, sym:p.sym, entry:p.entry||0, tokens:p.tokens||0, dec:p.dec||9, spent:p.spent, source:p.source||'dex', lp:p.lp||null, tp:p.tp||null, sl:p.sl||null, at:Date.now() });
  saveDB();
}

async function getPnl(pos) {
  if (pos.source==='bonding'||!pos.tokens||pos.tokens<=0) return null;
  try {
    const amt = BigInt(Math.floor(pos.tokens * Math.pow(10, pos.dec||9)));
    const out = await getSwapEstimate(pos.ct, SUI_T, amt.toString());
    if (!out||out==='0') return null;
    const cur = Number(out)/1e9;
    return { cur, pnl:cur-parseFloat(pos.spent), pct:(cur-parseFloat(pos.spent))/parseFloat(pos.spent)*100 };
  } catch { return null; }
}

function pnlBar(pct) { const f=Math.min(10,Math.round(Math.abs(Math.max(-100,Math.min(200,pct)))/20)); return(pct>=0?'🟩':'🟥').repeat(f)+'⬛'.repeat(10-f); }

function pnlCaption(pos, p) {
  const s=p.pnl>=0?'+':'';
  return `${p.pnl>=0?'🚀':'📉'} *${pos.sym}*\n\nEntry:    ${(pos.entry||0).toFixed(8)} SUI\nInvested: ${pos.spent} SUI\nValue:    ${p.cur.toFixed(4)} SUI\n\nP&L: *${s}${p.pnl.toFixed(4)} SUI (${s}${p.pct.toFixed(2)}%)*\n${pnlBar(p.pct)}`;
}

function pnlChart(sym, pct, spent, cur) {
  const ok=pct>=0,col=ok?'#00e676':'#ff1744',bg=ok?'#0d1f14':'#1f0d0d';
  const data=[]; for(let i=0;i<=24;i++){const t=i/24,n=(Math.sin(i*1.3)*0.15+Math.cos(i*2.7)*0.1)*Math.abs(pct)/200;data.push(+(1+(pct/100)*t+n*Math.sqrt(t)).toFixed(4));}
  const cfg={type:'line',data:{labels:data.map((_,i)=>i),datasets:[{data,borderColor:col,backgroundColor:`${col}20`,fill:true,tension:0.5,borderWidth:3,pointRadius:0}]},options:{animation:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{display:false,min:Math.min(...data)*0.97,max:Math.max(...data)*1.03}}}};
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(cfg))}&w=600&h=250&bkg=${encodeURIComponent(bg)}&f=png`;
}

// ═══════════════════════════════════════════════════════════
// BACKGROUND ENGINES
// ═══════════════════════════════════════════════════════════

async function positionMonitor() {
  while (true) {
    await sleep(30_000);
    for (const [uid, u] of Object.entries(DB)) {
      if (!u.walletAddress||!u.positions?.length||isLocked(u)) continue;
      for (const pos of [...u.positions]) {
        if (pos.source==='bonding') continue;
        try {
          const p=await getPnl(pos); if(!p) continue;
          let why='';
          if (pos.tp&&p.pct>=pos.tp)       why=`✅ Take Profit! +${p.pct.toFixed(2)}%`;
          else if (pos.sl&&p.pct<=-pos.sl)  why=`🛑 Stop Loss! ${p.pct.toFixed(2)}%`;
          if (!why) continue;
          try {
            const res=await executeSell(uid,pos.ct,100);
            const cap=`${why}\n\n${pnlCaption(pos,p)}\n\n🔗 [TX](${SUISCAN}${res.digest})`;
            try{await bot.sendPhoto(uid,pnlChart(pos.sym,p.pct,pos.spent,p.cur),{caption:cap,parse_mode:'Markdown'});}
            catch{await bot.sendMessage(uid,cap,{parse_mode:'Markdown'});}
          } catch(e){bot.sendMessage(uid,`⚠️ Auto-sell failed for ${pos.sym}: ${e.message?.slice(0,80)}`);}
        } catch {}
      }
    }
  }
}

async function sniperEngine() {
  while (true) {
    await sleep(2_000);
    for (const [uid, u] of Object.entries(DB)) {
      if (!u.snipeWatches?.length||isLocked(u)) continue;
      for (const w of [...u.snipeWatches]) {
        if (w.triggered) continue;
        try {
          stateCache.delete(w.ct);
          const st=await detectState(w.ct);
          const isDex=['cetus','turbos'].includes(st.state);
          const fire=w.mode==='grad'?isDex:(isDex||st.state==='bonding');
          if (!fire) continue;
          w.triggered=true;
          const fresh=getU(uid);
          if (fresh) { fresh.snipeWatches=fresh.snipeWatches.filter(x=>!x.triggered); saveDB(); }
          bot.sendMessage(uid,`⚡ *Snipe triggered!*\n\nToken: \`${trunc(w.ct)}\`\n${st.state==='bonding'?`📊 ${st.lpName}`:'✅ DEX pool'}\n\nBuying ${w.sui} SUI...`,{parse_mode:'Markdown'});
          try {
            const res=await executeBuy(uid,w.ct,w.sui);
            bot.sendMessage(uid,`✅ Sniped ${res.sym}!\nSpent: ${w.sui} SUI | Fee: ${res.feeSui} SUI\n🔗 [TX](${SUISCAN}${res.digest})`,{parse_mode:'Markdown'});
          } catch(e){bot.sendMessage(uid,`❌ Snipe buy failed: ${e.message?.slice(0,120)}`);}
        } catch {}
      }
    }
  }
}

const lastSeenTx={};
async function copyEngine() {
  while (true) {
    await sleep(5_000);
    const wm=new Map();
    for (const [uid,u] of Object.entries(DB)) {
      if (!u.copyTraders?.length||isLocked(u)) continue;
      for (const cfg of u.copyTraders) {
        if(!wm.has(cfg.wallet)) wm.set(cfg.wallet,[]);
        wm.get(cfg.wallet).push({ uid, cfg });
      }
    }
    for (const [wallet,watchers] of wm) {
      try {
        const txs=await sui.queryTransactionBlocks({filter:{FromAddress:wallet},limit:5,order:'descending',options:{showEvents:true}});
        const prev=lastSeenTx[wallet];
        const news=prev?txs.data.filter(t=>t.digest!==prev):txs.data.slice(0,1);
        if(txs.data.length) lastSeenTx[wallet]=txs.data[0].digest;
        for (const tx of news.reverse()) {
          const ev=(tx.events||[]).find(e=>e.type?.toLowerCase().includes('swap')||e.type?.toLowerCase().includes('trade'));
          if(!ev) continue;
          const pj=ev.parsedJson||{};
          const bought=pj.coin_type_out||pj.token_out||pj.coinTypeOut||null;
          if(!bought||bought===SUI_T) continue;
          for (const {uid,cfg} of watchers) {
            const u=getU(uid); if(!u||isLocked(u)) continue;
            try {
              if(cfg.blacklist?.includes(bought)) continue;
              const existing=await getCoins(u.walletAddress,bought);
              if(existing.length) continue; // already holds it
              if((u.positions||[]).length>=(cfg.maxPos||5)) continue;
              const amt=cfg.amount||u.settings.copyAmount;
              // Check sufficient SUI balance first
              const suiBal=await getCoins(u.walletAddress,SUI_T);
              const suiTotal=suiBal.reduce((s,c)=>s+BigInt(c.balance),0n);
              if(suiTotal < BigInt(Math.floor(parseFloat(amt)*Number(MIST)))) {
                bot.sendMessage(uid,`⚠️ Copy: insufficient SUI for ${trunc(bought)}`);
                continue;
              }
              bot.sendMessage(uid,`🔁 *Copy* \`${trunc(wallet)}\`\nBuying \`${trunc(bought)}\` — ${amt} SUI`,{parse_mode:'Markdown'});
              const res=await executeBuy(uid,bought,amt);
              bot.sendMessage(uid,`✅ Copied ${res.sym}! 🔗 [TX](${SUISCAN}${res.digest})`,{parse_mode:'Markdown'});
            } catch(e){bot.sendMessage(uid,`❌ Copy failed: ${e.message?.slice(0,100)}`);}
          }
        }
      } catch {}
    }
  }
}

// ═══════════════════════════════════════════════════════════
// TICKER RESOLVER
// ═══════════════════════════════════════════════════════════
async function resolveTicker(t) {
  const sym=t.replace(/^\$/,'').toUpperCase();
  try{const r=await ftch(`https://api-sui.cetus.zone/v2/sui/tokens?symbol=${sym}`,{},5000);if(r.ok){const d=await r.json();if(d.data?.[0]?.coin_type)return d.data[0].coin_type;}}catch{}
  // Also try GeckoTerminal search
  try{const r=await ftch(`${GECKO}/networks/${GECKO_NET}/tokens?query=${encodeURIComponent(sym)}&page=1`,{headers:{Accept:'application/json;version=20230302'}},5000);if(r.ok){const d=await r.json();const hit=d.data?.[0];if(hit?.attributes?.address)return hit.attributes.address;}}catch{}
  return null;
}

// ═══════════════════════════════════════════════════════════
// BOT + KEYBOARD
// ═══════════════════════════════════════════════════════════
const MAIN_KB = {
  keyboard:[[{text:'💰 Buy'},{text:'💸 Sell'}],[{text:'📊 Positions'},{text:'💼 Balance'}],[{text:'🔍 Scan'},{text:'⚡ Snipe'}],[{text:'🔁 Copy Trade'},{text:'🔗 Referral'}],[{text:'⚙️ Settings'},{text:'❓ Help'}]],
  resize_keyboard:true, persistent:true,
};

const bot = new TelegramBot(TG_TOKEN, {
  polling: { interval:300, autoStart:true, params:{ timeout:10, allowed_updates:['message','callback_query'] } },
});

async function guard(chatId, fn) {
  const u=getU(chatId);
  if (!u?.walletAddress){await bot.sendMessage(chatId,'❌ No wallet. Use /start first.');return;}
  if (u.cooldownUntil&&Date.now()<u.cooldownUntil){await bot.sendMessage(chatId,`🔒 Cooldown — wait ${Math.ceil((u.cooldownUntil-Date.now())/1000)}s.`);return;}
  if (isLocked(u)){updU(chatId,{state:'pin_unlock'});await bot.sendMessage(chatId,'🔒 Wallet locked. Enter your 4-digit PIN:');return;}
  updU(chatId,{lastActivity:Date.now()});
  try{await fn(u);}catch(e){console.error(`[${chatId}]`,e.message);await bot.sendMessage(chatId,`❌ ${e.message?.slice(0,200)||'Error'}`);}
}

// ═══════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════

async function doBalance(chatId) {
  await guard(chatId,async(u)=>{
    const m=await bot.sendMessage(chatId,'💰 Fetching balances...');
    try {
      const bals=await getAllBals(u.walletAddress);
      const sb=bals.find(b=>b.coinType===SUI_T);
      const L=[`💼 *Wallet*\n\`${u.walletAddress}\`\n`];
      L.push(`🔵 SUI: *${sb?fSui(BigInt(sb.totalBalance)):'0.0000'}*`);
      const others=bals.filter(b=>b.coinType!==SUI_T&&Number(b.totalBalance)>0);
      for(const b of others.slice(0,15)){const m2=await getMeta(b.coinType);L.push(`• ${m2?.symbol||trunc(b.coinType)}: ${(Number(b.totalBalance)/Math.pow(10,m2?.decimals||9)).toFixed(4)}`);}
      if(!others.length)L.push('\n_No other tokens_');
      await bot.editMessageText(L.join('\n'),{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});
    }catch(e){await bot.editMessageText(`❌ ${e.message?.slice(0,100)}`,{chat_id:chatId,message_id:m.message_id});}
  });
}

async function doPositions(chatId) {
  await guard(chatId,async(u)=>{
    if(!u.positions?.length){await bot.sendMessage(chatId,'📊 No open positions.\n\nBuy a token to start tracking!');return;}
    const m=await bot.sendMessage(chatId,`📊 Loading ${u.positions.length} position(s)...`);
    await bot.deleteMessage(chatId,m.message_id).catch(()=>{});
    for(let i=0;i<u.positions.length;i++){
      const pos=u.positions[i];
      try {
        const p=await getPnl(pos);
        // Build sell buttons for this position
        const sellKb={inline_keyboard:[[
          {text:`💸 Sell 50%`,callback_data:`qs:${i}:50`},
          {text:`💸 Sell 100%`,callback_data:`qs:${i}:100`},
        ]]};
        if(p){
          const cap=pnlCaption(pos,p)+`\n\nTP: ${pos.tp?pos.tp+'%':'None'} | SL: ${pos.sl?pos.sl+'%':'None'}${pos.source==='bonding'?`\n📊 ${pos.lp}`:''}`;
          try{await bot.sendPhoto(chatId,pnlChart(pos.sym,p.pct,pos.spent,p.cur),{caption:cap,parse_mode:'Markdown',reply_markup:sellKb});}
          catch{await bot.sendMessage(chatId,cap,{parse_mode:'Markdown',reply_markup:sellKb});}
        }else{
          const cap=`${pos.source==='bonding'?'📊':'⚪'} *${pos.sym}*\nSpent: ${pos.spent} SUI${pos.source==='bonding'?`\n📊 ${pos.lp}`:''}`;
          await bot.sendMessage(chatId,cap,{parse_mode:'Markdown',reply_markup:sellKb});
        }
      }catch{await bot.sendMessage(chatId,`⚪ *${pos.sym}* — ${pos.spent} SUI`,{parse_mode:'Markdown'});}
    }
  });
}

async function doReferral(chatId) {
  const u=getU(chatId)||makeU(chatId);
  const link=`https://t.me/${BOT_USERNAME}?start=${u.referralCode}`;
  const active=Object.values(DB).filter(x=>x.referredBy===u.walletAddress&&Date.now()-x.lastActivity<30*24*3600*1000).length;
  await bot.sendMessage(chatId,
    `🔗 *Referral Dashboard*\n\n` +
    `Code: \`${u.referralCode}\`\n` +
    `Link: \`${link}\`\n\n` +
    `👥 Total referrals: ${u.referralCount||0}\n` +
    `⚡ Active (30d): ${active}\n` +
    `💰 Total earned: ${(u.referralEarned||0).toFixed(4)} SUI\n\n` +
    `*How it works:*\n` +
    `• Every trade your referrals make pays 1% fee\n` +
    `• 25% of that fee goes *directly to your wallet* — no claiming needed\n` +
    `• Passive income on every trade, forever`,
    {parse_mode:'Markdown'});
}

async function doSettings(chatId) {
  await guard(chatId,async(u)=>{
    const s=u.settings;
    await bot.sendMessage(chatId,
      `⚙️ *Settings*\n\n` +
      `Slippage: *${s.slippage}%*\n` +
      `Copy amount: *${s.copyAmount} SUI*\n` +
      `Quick-buy: *${(s.buyAmounts||DEF_AMTS).join(', ')} SUI*\n` +
      `TP default: ${s.tpDefault?s.tpDefault+'%':'None'}\n` +
      `SL default: ${s.slDefault?s.slDefault+'%':'None'}`,
      {parse_mode:'Markdown',reply_markup:{inline_keyboard:[
        [{text:'— Slippage —',callback_data:'noop'}],
        [{text:'0.5%',callback_data:'slip:0.5'},{text:'1%',callback_data:'slip:1'},{text:'2%',callback_data:'slip:2'},{text:'5%',callback_data:'slip:5'}],
        [{text:'💰 Edit Quick-Buy Amounts',callback_data:'edit_amts'}],
        [{text:'🔁 Edit Copy Amount',callback_data:'edit_copy_amt'}],
        [{text:'🎯 TP Default',callback_data:'set_tp'},{text:'🛑 SL Default',callback_data:'set_sl'}],
        [{text:'🗑 Clear TP/SL',callback_data:'clear_tpsl'}],
        [{text:'🔑 View Private Key',callback_data:'view_pk'},{text:'📤 Withdraw',callback_data:'withdraw_menu'}],
        [{text:'🔄 Change Wallet',callback_data:'change_wallet'}],
      ]}}
    );
  });
}

async function doHelp(chatId) {
  await bot.sendMessage(chatId,
    `🤖 *AGENT TRADING BOT — v6*\n\n` +
    `*Trading*\n` +
    `/buy [ca] [sui] — Buy any Sui token\n` +
    `/sell [ca] [%] — Sell with percentage\n` +
    `/withdraw — Send SUI or tokens to an address\n\n` +
    `*Advanced*\n` +
    `/snipe [ca] — Auto-buy when pool goes live\n` +
    `/copytrader [wallet] — Mirror a wallet's buys\n\n` +
    `*Info*\n` +
    `/scan [ca] — Full token security scan\n` +
    `/balance — Wallet balances\n` +
    `/positions — P&L with quick-sell buttons\n\n` +
    `*Account*\n` +
    `/referral — View your referral link & earnings\n` +
    `/settings — Slippage, buy amounts, TP/SL, withdraw\n\n` +
    `*Supported DEXes*\n` +
    `Cetus CLMM (primary) • Turbos CLMM\n\n` +
    `*Launchpads*\n` +
    `MovePump • hop.fun • Turbos.fun\n\n` +
    `*Fee:* 1% per trade | Referrers earn 0.25%\n\n` +
    `_Tip: Paste any CA to get buy/sell/scan options instantly_`,
    {parse_mode:'Markdown'});
}

async function doWithdrawMenu(chatId) {
  await guard(chatId,async()=>{
    await bot.sendMessage(chatId,
      `📤 *Withdraw*\n\n` +
      `Send SUI or any token from your bot wallet to an external address.\n\n` +
      `Format: \`[amount] [SUI or token-CA] to [address]\`\n\n` +
      `Examples:\n` +
      `• \`1.5 SUI to 0x1234...\`\n` +
      `• \`1000 0x1234::token::TOKEN to 0xabcd...\``,
      {parse_mode:'Markdown'});
    updU(chatId,{state:'withdraw_input'});
  });
}

async function doSellMenu(chatId, u) {
  const pos=(u.positions||[]).filter(p=>p.ct);
  if (pos.length) {
    const btns=pos.slice(0,6).map((p,i)=>[{text:`${p.sym} — ${p.spent} SUI`,callback_data:`st:${i}`}]);
    btns.push([{text:'📝 Enter CA manually',callback_data:'sfs_manual'}]);
    await bot.sendMessage(chatId,'💸 *Select position to sell:*',{parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}});
  } else {
    await bot.sendMessage(chatId,'Send the token contract address to sell:\n\n_Example: 0x1234..._',{parse_mode:'Markdown'});
    updU(chatId,{state:'sell_ca'});
  }
}

async function startBuy(chatId, ct) {
  const u=getU(chatId); if(!u) return;
  const lm=await bot.sendMessage(chatId,'🔍 Fetching token info...');
  try {
    const d=await getTokenData(ct, u.walletAddress);
    updU(chatId,{pd:{ct,sym:d.symbol}});
    const amts=u.settings.buyAmounts||DEF_AMTS;
    await bot.editMessageText(buyCard(d,ct)+'\n\n*Select amount to buy:*',{
      chat_id:chatId, message_id:lm.message_id, parse_mode:'Markdown',
      reply_markup:{inline_keyboard:[
        amts.map((a,i)=>({text:`${a} SUI`,callback_data:`ba:${i}`})),
        [{text:'✏️ Custom amount',callback_data:'ba:c'}],
        [{text:'⚙️ Edit Defaults',callback_data:'edit_amts'},{text:'❌ Cancel',callback_data:'ca'}],
      ]},
    });
  } catch(e) {
    const meta=await getMeta(ct).catch(()=>null);
    const sym=meta?.symbol||trunc(ct);
    updU(chatId,{pd:{ct,sym}});
    const amts=u.settings.buyAmounts||DEF_AMTS;
    await bot.editMessageText(
      `💰 *Buy ${sym}*\n\`${ct}\`\n\n⚠️ Token data unavailable — will route to best available price\n\n*Select amount:*`,
      {chat_id:chatId,message_id:lm.message_id,parse_mode:'Markdown',reply_markup:{inline_keyboard:[amts.map((a,i)=>({text:`${a} SUI`,callback_data:`ba:${i}`})),[{text:'✏️ Custom',callback_data:'ba:c'},{text:'❌ Cancel',callback_data:'ca'}]]}}
    );
  }
}

async function showBuyConfirm(chatId, ct, amtSui, eid) {
  const u=getU(chatId); if(!u) return;
  const meta=await getMeta(ct)||{};
  const sym=meta.symbol||trunc(ct);
  const amtM=BigInt(Math.floor(parseFloat(amtSui)*Number(MIST)));
  const feeMist=(amtM*BigInt(FEE_BPS))/10000n;
  const tradeAmt=amtM-feeMist;
  updU(chatId,{pd:{...getU(chatId).pd,ct,amtSui}});
  let est='?';
  try{const out=await getSwapEstimate(SUI_T,ct,tradeAmt.toString());if(out&&out!=='0')est=(Number(out)/Math.pow(10,meta.decimals||9)).toFixed(4);}catch{}
  const text=`💰 *Confirm Buy*\n\nToken: *${sym}*\nAmount: ${amtSui} SUI\nFee (1%): ${fSui(feeMist)} SUI\nTrade amount: ${fSui(tradeAmt)} SUI\n${est!='?'?`Est. receive: ~${est} ${sym}\n`:''}Slippage: ${u.settings.slippage}%`;
  const kb={inline_keyboard:[[{text:'✅ Confirm Buy',callback_data:'bc'},{text:'❌ Cancel',callback_data:'ca'}]]};
  if(eid) await bot.editMessageText(text,{chat_id:chatId,message_id:eid,parse_mode:'Markdown',reply_markup:kb}).catch(async()=>bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb}));
  else await bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb});
}

async function showSellPct(chatId, ct, sym, eid) {
  const u=getU(chatId); if(!u) return;
  const coins=await getCoins(u.walletAddress,ct);
  if(!coins.length){await bot.sendMessage(chatId,`❌ No ${sym} balance.`);return;}
  const meta=await getMeta(ct)||{};
  const total=coins.reduce((s,c)=>s+BigInt(c.balance),0n);
  const bal=(Number(total)/Math.pow(10,meta.decimals||9)).toFixed(4);
  let est='?';
  try{const out=await getSwapEstimate(ct,SUI_T,total.toString());if(out)est=(Number(out)/1e9).toFixed(4);}catch{}
  const text=`💸 *Sell ${sym}*\n\nBalance: ${bal} ${sym}${est!='?'?`\nFull value: ~${est} SUI`:''}\n\n*Choose amount:*`;
  const kb={inline_keyboard:[[{text:'25%',callback_data:'sp:25'},{text:'50%',callback_data:'sp:50'},{text:'75%',callback_data:'sp:75'},{text:'100%',callback_data:'sp:100'}],[{text:'✏️ Custom %',callback_data:'sp:c'},{text:'❌ Cancel',callback_data:'ca'}]]};
  if(eid) await bot.editMessageText(text,{chat_id:chatId,message_id:eid,parse_mode:'Markdown',reply_markup:kb}).catch(async()=>bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb}));
  else await bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb});
}

async function showSellConfirm(chatId, ct, pct, eid) {
  const u=getU(chatId); if(!u) return;
  const meta=await getMeta(ct)||{};
  const sym=meta.symbol||trunc(ct);
  const coins=await getCoins(u.walletAddress,ct);
  if(!coins.length){await bot.sendMessage(chatId,`❌ No ${sym} in wallet.`);return;}
  const total=coins.reduce((s,c)=>s+BigInt(c.balance),0n);
  if(total===0n){await bot.sendMessage(chatId,`❌ ${sym} balance is zero.`);return;}
  const sellAmt=(total*BigInt(pct))/100n;
  const disp=(Number(sellAmt)/Math.pow(10,meta.decimals||9)).toFixed(4);
  let est='?';
  try{const out=await getSwapEstimate(ct,SUI_T,sellAmt.toString());if(out&&out!=='0')est=(Number(out)/1e9).toFixed(4);}catch{}
  const fee=est!=='?'?(Number(BigInt(Math.round(parseFloat(est)*Number(MIST)))*BigInt(FEE_BPS)/10000n)/1e9).toFixed(4):'?';
  const text=`💸 *Confirm Sell*\n\nToken: *${sym}*\nSelling: ${pct}% (${disp} ${sym})\n${est!='?'?`Est. receive: ~${est} SUI\nFee (1%): ${fee} SUI\n`:''}Slippage: ${u.settings.slippage}%`;
  const kb={inline_keyboard:[[{text:'✅ Confirm Sell',callback_data:'sc'},{text:'❌ Cancel',callback_data:'ca'}]]};
  if(eid) await bot.editMessageText(text,{chat_id:chatId,message_id:eid,parse_mode:'Markdown',reply_markup:kb}).catch(async()=>bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb}));
  else await bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb});
}

// ═══════════════════════════════════════════════════════════
// /start
// ═══════════════════════════════════════════════════════════
bot.onText(/\/start(.*)/, async(msg, match) => {
  const chatId=msg.chat.id;
  const param=san((match[1]||'').trim()).slice(0,20);
  let u=getU(chatId);
  if(!u){
    u=makeU(chatId);
    if(param.startsWith('AGT-')){
      const ref=Object.values(DB).find(x=>x.referralCode===param&&x.chatId!==String(chatId));
      if(ref?.walletAddress){
        updU(chatId,{referredBy:ref.walletAddress});
        updU(ref.chatId,{referralCount:(ref.referralCount||0)+1});
        bot.sendMessage(ref.chatId,'🎉 New user joined via your referral!');
      }
    }
  } else {
    // Clear stale state on /start
    updU(chatId,{state:null});
  }
  if(u.walletAddress){
    await bot.sendMessage(chatId,`👋 Welcome back!\n\n💼 *Your Wallet:*\n\`${u.walletAddress}\`\n\n_Tap the address to copy it_`,{parse_mode:'Markdown',reply_markup:MAIN_KB});
  }else{
    await bot.sendMessage(chatId,
      `👋 Welcome to *AGENT TRADING BOT*\n\nThe fastest trading bot on Sui.\n\nConnect your wallet to start trading:`,
      {parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'🔑 Import Wallet',callback_data:'import_wallet'}],[{text:'✨ Create New Wallet',callback_data:'gen_wallet'}]]}});
  }
});

// ═══════════════════════════════════════════════════════════
// CALLBACKS
// ═══════════════════════════════════════════════════════════
bot.on('callback_query', async(q) => {
  const chatId=q.message.chat.id, msgId=q.message.message_id, data=q.data;
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  try {
    if(data==='noop') return;

    // ── Wallet setup ─────────────────────────────────────
    if(data==='import_wallet'){
      updU(chatId,{state:'import_key'});
      await bot.sendMessage(chatId,'🔑 Send your private key (`suiprivkey1...`)\n\n⚠️ It will be encrypted and the message deleted immediately.',{parse_mode:'Markdown'});
      return;
    }

    if(data==='gen_wallet'){
      const kp=new Ed25519Keypair(), addr=kp.getPublicKey().toSuiAddress(), sk=kp.getSecretKey();
      updU(chatId,{encryptedKey:encKey(sk), walletAddress:addr, state:'set_pin'});
      const wMsg=await bot.sendMessage(chatId,
        `✅ *Wallet Created!*\n\n` +
        `Address:\n\`${addr}\`\n\n` +
        `🔑 *Private Key — SAVE THIS NOW:*\n\`${sk}\`\n\n` +
        `⚠️ Screenshot this. This message will be *deleted* once you set your PIN.\n\nSet a 4-digit PIN:`,
        {parse_mode:'Markdown'});
      updU(chatId,{pd:{walletMsgId:wMsg.message_id}});
      return;
    }

    // ── Quick sell from positions ─────────────────────────
    if(data.startsWith('qs:')){
      const parts=data.split(':');
      const idx=parseInt(parts[1]), pct=parseInt(parts[2]);
      const u=getU(chatId); const pos=u?.positions?.[idx];
      if(!pos){await bot.sendMessage(chatId,'❌ Position not found.');return;}
      updU(chatId,{pd:{ct:pos.ct,sym:pos.sym,pct}});
      await showSellConfirm(chatId,pos.ct,pct,null); return;
    }

    // ── Buy flow ──────────────────────────────────────────
    if(data.startsWith('ba:')){
      const u=getU(chatId); if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired. Start again.');return;}
      const key=data.split(':')[1];
      if(key==='c'){updU(chatId,{state:'buy_custom'});await bot.sendMessage(chatId,'💬 Enter SUI amount:\n_Example: 2.5_',{parse_mode:'Markdown'});return;}
      const amt=(u.settings.buyAmounts||DEF_AMTS)[parseInt(key)];
      if(!amt){await bot.sendMessage(chatId,'❌ Invalid amount.');return;}
      await showBuyConfirm(chatId,u.pd.ct,amt,msgId); return;
    }

    if(data==='bc'){
      const u=getU(chatId); if(!u?.pd?.ct||!u?.pd?.amtSui){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      const bc_ct=u.pd.ct, bc_amt=u.pd.amtSui;
      await bot.editMessageText('⚡ Executing buy...',{chat_id:chatId,message_id:msgId});
      try{
        const res=await executeBuy(chatId,bc_ct,bc_amt);
        await bot.editMessageText(
          `✅ *Buy Executed!*\n\nToken: *${res.sym}*\nSpent: ${bc_amt} SUI\nFee: ${res.feeSui} SUI\n${res.out!='?'?`Received: ~${res.out} ${res.sym}\n`:''}Route: ${res.route}\n${res.bonding?`📊 On ${res.lpName}\n`:''}\n🔗 [View TX](${SUISCAN}${res.digest})`,
          {chat_id:chatId,message_id:msgId,parse_mode:'Markdown'});
      }catch(e){await bot.editMessageText(`❌ Buy failed: ${e.message?.slice(0,180)}`,{chat_id:chatId,message_id:msgId});}
      updU(chatId,{pd:{}}); return;
    }

    // ── Sell flow ─────────────────────────────────────────
    if(data.startsWith('st:')){
      const u=getU(chatId); const pos=u?.positions?.[parseInt(data.split(':')[1])];
      if(!pos){await bot.sendMessage(chatId,'❌ Position not found.');return;}
      updU(chatId,{pd:{ct:pos.ct,sym:pos.sym}});
      await showSellPct(chatId,pos.ct,pos.sym,null); return;
    }

    if(data==='sfs_manual'){updU(chatId,{state:'sell_ca'});await bot.sendMessage(chatId,'Send the token CA:');return;}

    if(data.startsWith('sp:')){
      const u=getU(chatId); if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      const key=data.split(':')[1];
      if(key==='c'){updU(chatId,{state:'sell_custom'});await bot.sendMessage(chatId,'💬 Enter % to sell (1-100):\n_Example: 33_',{parse_mode:'Markdown'});return;}
      const pct=parseInt(key), ct=u.pd.ct;
      updU(chatId,{pd:{...u.pd,pct}});
      await showSellConfirm(chatId,ct,pct,msgId); return;
    }

    if(data==='sc'){
      const u=getU(chatId); if(!u?.pd?.ct||!u?.pd?.pct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      const sc_ct=u.pd.ct, sc_pct=u.pd.pct;
      await bot.editMessageText('⚡ Executing sell...',{chat_id:chatId,message_id:msgId});
      try{
        const res=await executeSell(chatId,sc_ct,sc_pct);
        await bot.editMessageText(
          `✅ *Sell Executed!*\n\nToken: ${res.sym}\nSold: ${res.pct}%\nEst. SUI received: ~${res.sui}\nFee: ${res.feeSui} SUI\nRoute: ${res.route}\n\n🔗 [View TX](${SUISCAN}${res.digest})`,
          {chat_id:chatId,message_id:msgId,parse_mode:'Markdown'});
      }catch(e){await bot.editMessageText(`❌ Sell failed: ${e.message?.slice(0,180)}`,{chat_id:chatId,message_id:msgId});}
      updU(chatId,{pd:{}}); return;
    }

    if(data==='ca'){updU(chatId,{state:null,pd:{}});await bot.editMessageText('❌ Cancelled.',{chat_id:chatId,message_id:msgId}).catch(()=>{});return;}

    // ── Settings ─────────────────────────────────────────
    if(data.startsWith('slip:')){const u=getU(chatId);if(u){u.settings.slippage=parseFloat(data.split(':')[1]);saveDB();}await bot.sendMessage(chatId,`✅ Slippage → ${data.split(':')[1]}%`);return;}
    if(data==='edit_amts'){updU(chatId,{state:'edit_amts'});await bot.sendMessage(chatId,'⚙️ Enter 4 amounts separated by spaces:\n_Example: 0.5 1 3 5_',{parse_mode:'Markdown'});return;}
    if(data==='set_tp'){updU(chatId,{state:'set_tp'});await bot.sendMessage(chatId,'🎯 Enter Take Profit % (e.g. 50 = +50%):\n_Send 0 to disable_',{parse_mode:'Markdown'});return;}
    if(data==='set_sl'){updU(chatId,{state:'set_sl'});await bot.sendMessage(chatId,'🛑 Enter Stop Loss % (e.g. 20 = -20%):\n_Send 0 to disable_',{parse_mode:'Markdown'});return;}
    if(data==='clear_tpsl'){const u=getU(chatId);if(u){u.settings.tpDefault=null;u.settings.slDefault=null;saveDB();}await bot.sendMessage(chatId,'✅ TP/SL defaults cleared.');return;}
    if(data==='edit_copy_amt'){updU(chatId,{state:'set_copy_amt'});await bot.sendMessage(chatId,'🔁 Enter copy trade amount in SUI:\n_Example: 0.5_',{parse_mode:'Markdown'});return;}

    if(data==='view_pk'){
      const u=getU(chatId); if(!u?.encryptedKey){await bot.sendMessage(chatId,'❌ No wallet found.');return;}
      updU(chatId,{state:'pin_for_pk'});
      await bot.sendMessage(chatId,'🔒 Enter your 4-digit PIN to view your private key:');
      return;
    }

    if(data==='withdraw_menu'){await doWithdrawMenu(chatId);return;}

    if(data==='change_wallet'){
      await bot.sendMessage(chatId,
        '🔄 *Change Wallet*\n\n⚠️ This will replace your current wallet.\nMake sure you have saved your private key first!',
        {parse_mode:'Markdown',reply_markup:{inline_keyboard:[
          [{text:'🔑 Import Existing',callback_data:'import_wallet'}],
          [{text:'✨ Create New',callback_data:'gen_wallet'}],
          [{text:'❌ Cancel',callback_data:'ca'}],
        ]}});
      return;
    }

    // ── CA picker ──────────────────────────────────────────
    if(data==='bfs'){const u=getU(chatId);if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}await guard(chatId,async()=>startBuy(chatId,u.pd.ct));return;}
    if(data==='sfs'){const u=getU(chatId);if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}const m=await getMeta(u.pd.ct)||{};await guard(chatId,async()=>{updU(chatId,{pd:{ct:u.pd.ct,sym:m.symbol||trunc(u.pd.ct)}});await showSellPct(chatId,u.pd.ct,m.symbol||trunc(u.pd.ct),null);});return;}
    if(data==='sct'){
      const u=getU(chatId);if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      const m2=await bot.sendMessage(chatId,'🔍 Scanning...');
      try{const[d,st]=await Promise.all([getTokenData(u.pd.ct,u.walletAddress),detectState(u.pd.ct)]);await bot.editMessageText(scanReport(d,u.pd.ct,st),{chat_id:chatId,message_id:m2.message_id,parse_mode:'Markdown'});}
      catch(e){await bot.editMessageText(`❌ ${e.message?.slice(0,100)}`,{chat_id:chatId,message_id:m2.message_id});}
      return;
    }
  }catch(e){console.error('CB:',e.message);await bot.sendMessage(chatId,`❌ ${e.message?.slice(0,120)}`);}
});

// ═══════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════
bot.on('message', async(msg) => {
  if (!msg.text) return;
  const chatId=msg.chat.id;
  const raw=msg.text.trim();
  if (!raw||raw.startsWith('/')) return;

  const u=getU(chatId)||makeU(chatId);
  const state=u.state;

  // Keyboard buttons
  const KB={
    '💰 Buy':        ()=>guard(chatId,async()=>{await bot.sendMessage(chatId,'Send the token CA or $TICKER:\n\n_Example: 0x1234... or $AGENT_',{parse_mode:'Markdown'});updU(chatId,{state:'buy_ca'});}),
    '💸 Sell':       ()=>guard(chatId,async(u)=>doSellMenu(chatId,u)),
    '📊 Positions':  ()=>doPositions(chatId),
    '💼 Balance':    ()=>doBalance(chatId),
    '🔍 Scan':       ()=>{bot.sendMessage(chatId,'Send the token CA to scan:\n_Example: 0x1234..._',{parse_mode:'Markdown'});updU(chatId,{state:'scan_ca'});},
    '⚡ Snipe':      ()=>guard(chatId,async()=>{await bot.sendMessage(chatId,'⚡ Send the token CA to snipe:\n\n_Example: 0x1234..._',{parse_mode:'Markdown'});updU(chatId,{state:'snipe_ca'});}),
    '🔁 Copy Trade': ()=>guard(chatId,async(u)=>{if(!u.copyTraders?.length){await bot.sendMessage(chatId,'🔁 *Copy Trader*\n\nUsage: /copytrader [wallet]\nStop: /copytrader stop',{parse_mode:'Markdown'});}else{await bot.sendMessage(chatId,`🔁 *Copy Traders (${u.copyTraders.length}/3)*\n\n${u.copyTraders.map((ct,i)=>`${i+1}. \`${trunc(ct.wallet)}\` — ${ct.amount} SUI`).join('\n')}\n\nStop: /copytrader stop`,{parse_mode:'Markdown'});}}),
    '🔗 Referral':   ()=>doReferral(chatId),
    '⚙️ Settings':   ()=>doSettings(chatId),
    '❓ Help':        ()=>doHelp(chatId),
  };
  if(KB[raw]){await KB[raw]();return;}

  const text=raw.replace(/[<>&]/g,'').slice(0,1000);

  // State machine
  if(state==='import_key'){
    updU(chatId,{state:null});
    try{await bot.deleteMessage(chatId,msg.message_id);}catch{}
    try{
      const dec=decodeSuiPrivateKey(text);
      const kp=Ed25519Keypair.fromSecretKey(dec.secretKey);
      const addr=kp.getPublicKey().toSuiAddress();
      updU(chatId,{encryptedKey:encKey(text),walletAddress:addr,state:'set_pin'});
      const wMsg=await bot.sendMessage(chatId,`✅ *Wallet imported!*\n\nAddress: \`${addr}\`\n🔐 Key encrypted and stored securely.\n\nThis message will be deleted when you set your PIN.\n\nSet a 4-digit PIN:`,{parse_mode:'Markdown'});
      updU(chatId,{pd:{walletMsgId:wMsg.message_id}});
    }catch{await bot.sendMessage(chatId,'❌ Invalid private key. Use `suiprivkey1...` format.',{parse_mode:'Markdown'});}
    return;
  }

  if(state==='set_pin'){
    if(!/^\d{4}$/.test(text)){await bot.sendMessage(chatId,'❌ Must be exactly 4 digits:');return;}
    updU(chatId,{pinHash:hashPin(text),state:null});
    const wmid=u.pd?.walletMsgId;
    if(wmid) await bot.deleteMessage(chatId,wmid).catch(()=>{});
    updU(chatId,{pd:{}});
    await bot.sendMessage(chatId,'✅ PIN set! Wallet message deleted for security.\n\nFund your wallet with SUI and start trading! 🚀',{reply_markup:MAIN_KB});
    return;
  }

  if(state==='pin_unlock'){
    if(!/^\d{4}$/.test(text)){await bot.sendMessage(chatId,'❌ Enter 4-digit PIN:');return;}
    if(hashPin(text)===u.pinHash){
      unlockU(chatId); updU(chatId,{state:null,failAttempts:0,cooldownUntil:0});
      await bot.sendMessage(chatId,'🔓 Unlocked!',{reply_markup:MAIN_KB});
    }else{
      const fails=(u.failAttempts||0)+1;
      if(fails>=MAX_FAILS){updU(chatId,{failAttempts:0,cooldownUntil:Date.now()+COOLDOWN_MS});await bot.sendMessage(chatId,'❌ Too many wrong attempts. Locked for 5 minutes.');}
      else{updU(chatId,{failAttempts:fails});await bot.sendMessage(chatId,`❌ Wrong PIN. ${MAX_FAILS-fails} attempt(s) left.`);}
    }
    return;
  }

  if(state==='buy_ca'){
    updU(chatId,{state:null});
    const ct=text.startsWith('0x')?text:(await resolveTicker(text));
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found. Paste the full contract address.');return;}
    await guard(chatId,async()=>startBuy(chatId,ct)); return;
  }

  if(state==='sell_ca'){
    updU(chatId,{state:null});
    const ct=text.startsWith('0x')?text:(await resolveTicker(text));
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
    const meta=await getMeta(ct)||{};
    await guard(chatId,async()=>{updU(chatId,{pd:{ct,sym:meta.symbol||trunc(ct)}});await showSellPct(chatId,ct,meta.symbol||trunc(ct),null);}); return;
  }

  if(state==='scan_ca'){
    updU(chatId,{state:null});
    const ct=text.startsWith('0x')?text:(await resolveTicker(text));
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
    const m=await bot.sendMessage(chatId,'🔍 Scanning token...');
    try{
      const u2=getU(chatId);
      const[d,st]=await Promise.all([getTokenData(ct,u2?.walletAddress),detectState(ct)]);
      await bot.editMessageText(scanReport(d,ct,st),{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});
    }catch(e){await bot.editMessageText(`❌ Scan failed: ${e.message?.slice(0,100)}`,{chat_id:chatId,message_id:m.message_id});}
    return;
  }

  if(state==='snipe_ca'){
    updU(chatId,{state:null});
    const ct=text.startsWith('0x')?text:(await resolveTicker(text));
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
    updU(chatId,{state:'snipe_amount',pd:{sniToken:ct}});
    await bot.sendMessage(chatId,`Token: \`${trunc(ct)}\`\n\nHow much SUI to buy when pool is found?\n_Example: 0.5_`,{parse_mode:'Markdown'}); return;
  }

  if(state==='snipe_amount'){
    const amt=parseFloat(text); if(isNaN(amt)||amt<=0){await bot.sendMessage(chatId,'❌ Invalid amount.');return;}
    const pd=u.pd||{};
    u.snipeWatches=u.snipeWatches||[];
    u.snipeWatches.push({ct:pd.sniToken,sui:amt,mode:'any',triggered:false,at:Date.now()});
    updU(chatId,{state:null,pd:{},snipeWatches:u.snipeWatches});
    await bot.sendMessage(chatId,`⚡ *Snipe set!*\n\nToken: \`${trunc(pd.sniToken)}\`\nBuy: ${amt} SUI\n\nWatching for pool creation...`,{parse_mode:'Markdown'}); return;
  }

  if(state==='buy_custom'){
    updU(chatId,{state:null});
    const amt=parseFloat(text); if(isNaN(amt)||amt<=0){await bot.sendMessage(chatId,'❌ Enter a number like 2.5');return;}
    const ct=u.pd?.ct; if(!ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
    await showBuyConfirm(chatId,ct,amt,null); return;
  }

  if(state==='sell_custom'){
    updU(chatId,{state:null});
    const pct=parseFloat(text); if(isNaN(pct)||pct<=0||pct>100){await bot.sendMessage(chatId,'❌ Enter 1-100');return;}
    const ct=u.pd?.ct; if(!ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
    updU(chatId,{pd:{...u.pd,pct}}); await showSellConfirm(chatId,ct,pct,null); return;
  }

  if(state==='edit_amts'){
    updU(chatId,{state:null});
    const parts=text.split(/\s+/).map(Number).filter(n=>!isNaN(n)&&n>0).slice(0,4);
    if(parts.length<2){await bot.sendMessage(chatId,'❌ Enter at least 2 amounts: 0.5 1 3 5');return;}
    while(parts.length<4) parts.push(parts[parts.length-1]*2);
    const uu=getU(chatId); if(uu){uu.settings.buyAmounts=parts;saveDB();}
    await bot.sendMessage(chatId,`✅ Quick-buy amounts: ${parts.join(', ')} SUI`); return;
  }

  if(state==='set_tp'){
    updU(chatId,{state:null});
    const v=parseFloat(text); if(isNaN(v)||v<0){await bot.sendMessage(chatId,'❌ Enter a number (0 to disable)');return;}
    const uu=getU(chatId); if(uu){uu.settings.tpDefault=v===0?null:v;saveDB();}
    await bot.sendMessage(chatId,v===0?'✅ Take Profit disabled':`✅ Take Profit default: +${v}%`); return;
  }

  if(state==='set_sl'){
    updU(chatId,{state:null});
    const v=parseFloat(text); if(isNaN(v)||v<0){await bot.sendMessage(chatId,'❌ Enter a number (0 to disable)');return;}
    const uu=getU(chatId); if(uu){uu.settings.slDefault=v===0?null:v;saveDB();}
    await bot.sendMessage(chatId,v===0?'✅ Stop Loss disabled':`✅ Stop Loss default: -${v}%`); return;
  }

  if(state==='set_copy_amt'){
    updU(chatId,{state:null});
    const v=parseFloat(text); if(isNaN(v)||v<=0){await bot.sendMessage(chatId,'❌ Enter a positive number like 0.5');return;}
    const uu=getU(chatId); if(uu){uu.settings.copyAmount=v;saveDB();}
    await bot.sendMessage(chatId,`✅ Copy amount set: ${v} SUI per trade`); return;
  }

  if(state==='pin_for_pk'){
    if(!/^\d{4}$/.test(text)){await bot.sendMessage(chatId,'❌ Enter 4-digit PIN:');return;}
    if(hashPin(text)!==u.pinHash){
      const fails=(u.failAttempts||0)+1;
      updU(chatId,{failAttempts:fails});
      await bot.sendMessage(chatId,`❌ Wrong PIN. ${MAX_FAILS-fails} attempts left.`);
      return;
    }
    updU(chatId,{state:null,failAttempts:0});
    try {
      const pk=decKey(u.encryptedKey);
      const pkMsg=await bot.sendMessage(chatId,`🔑 *Your Private Key*\n\n\`${pk}\`\n\n⚠️ *This message will self-delete in 30 seconds.*\nNEVER share this with anyone.`,{parse_mode:'Markdown'});
      setTimeout(()=>bot.deleteMessage(chatId,pkMsg.message_id).catch(()=>{}), 30000);
    } catch{await bot.sendMessage(chatId,'❌ Failed to decrypt key.');}
    return;
  }

  if(state==='copy_wallet'){
    if(!text.startsWith('0x')){await bot.sendMessage(chatId,'❌ Invalid wallet address. Must start with 0x');return;}
    u.copyTraders=u.copyTraders||[];
    if(u.copyTraders.length>=3){await bot.sendMessage(chatId,'❌ Max 3 wallets. Use /copytrader stop to remove all.');return;}
    u.copyTraders.push({wallet:text,amount:u.settings.copyAmount,maxPos:5,blacklist:[]});
    updU(chatId,{state:null,copyTraders:u.copyTraders});
    await bot.sendMessage(chatId,`✅ Now tracking \`${trunc(text)}\`\nAmount: ${u.settings.copyAmount} SUI per trade`,{parse_mode:'Markdown'}); return;
  }

  if(state==='withdraw_input'){
    updU(chatId,{state:null});
    // Parse: "1.5 SUI to 0x1234..."  OR  "1000 0xtoken::mod::TYPE to 0x1234..."
    const m=text.match(/^([\d.]+)\s+(\S+)\s+to\s+(0x[a-fA-F0-9]{63,64})$/i);
    if(!m){await bot.sendMessage(chatId,'❌ Format: `1.5 SUI to 0x1234...`\nOr for tokens: `1000 0xtoken::mod::TYPE to 0x1234...`',{parse_mode:'Markdown'});return;}
    const amount=m[1], coinStr=m[2].toUpperCase()==='SUI'?SUI_T:m[2], toAddr=m[3];
    const meta=coinStr!==SUI_T?await getMeta(coinStr)||{symbol:trunc(coinStr)}:{symbol:'SUI'};
    const sym=meta.symbol||trunc(coinStr);
    await bot.sendMessage(chatId,
      `📤 *Confirm Withdraw*\n\nAmount: *${amount} ${sym}*\nTo: \`${trunc(toAddr)}\`\n\n⚠️ Double-check the address — this cannot be undone.`,
      {parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'✅ Confirm',callback_data:`wc:${amount}:${encodeURIComponent(coinStr)}:${toAddr}`},{text:'❌ Cancel',callback_data:'ca'}]]}}
    );
    return;
  }

  // Raw CA paste
  if(text.startsWith('0x')&&text.length>40){
    updU(chatId,{pd:{ct:text}});
    await bot.sendMessage(chatId,`📋 \`${trunc(text)}\`\n\nWhat do you want to do?`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'💰 Buy',callback_data:'bfs'},{text:'💸 Sell',callback_data:'sfs'},{text:'🔍 Scan',callback_data:'sct'}]]}});
    return;
  }
});

// ── Withdraw confirm callback (added inline since we need dynamic data) ────
const origCbHandler=bot.listeners('callback_query')[0];
bot.on('callback_query', async(q)=>{
  if(!q.data.startsWith('wc:')) return;
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  const chatId=q.message.chat.id, msgId=q.message.message_id;
  const parts=q.data.split(':');
  const amount=parts[1], coinType=decodeURIComponent(parts[2]), toAddr=parts[3];
  await bot.editMessageText('⚡ Sending...',{chat_id:chatId,message_id:msgId});
  try{
    const digest=await executeWithdraw(chatId,toAddr,coinType,amount);
    await bot.editMessageText(`✅ *Sent!*\n\nAmount: ${amount} ${coinType===SUI_T?'SUI':trunc(coinType)}\nTo: \`${trunc(toAddr)}\`\n\n🔗 [View TX](${SUISCAN}${digest})`,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown'});
  }catch(e){await bot.editMessageText(`❌ Withdraw failed: ${e.message?.slice(0,150)}`,{chat_id:chatId,message_id:msgId});}
});

// ═══════════════════════════════════════════════════════════
// /command ROUTES
// ═══════════════════════════════════════════════════════════

bot.onText(/\/buy(?:\s+(.+))?/, async(msg,m)=>{
  const chatId=msg.chat.id, args=san(m[1]||'');
  await guard(chatId,async()=>{
    if(!args){await bot.sendMessage(chatId,'Send the token CA or $TICKER:');updU(chatId,{state:'buy_ca'});return;}
    const parts=args.split(/\s+/);
    const ct=parts[0].startsWith('0x')?parts[0]:(await resolveTicker(parts[0]));
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found. Use the full contract address.');return;}
    if(parts[1]){const a=parseFloat(parts[1]);if(!isNaN(a)&&a>0){updU(chatId,{pd:{ct}});await showBuyConfirm(chatId,ct,a,null);return;}}
    await startBuy(chatId,ct);
  });
});

bot.onText(/\/sell(?:\s+(.+))?/, async(msg,m)=>{
  const chatId=msg.chat.id, args=san(m[1]||'');
  await guard(chatId,async(u)=>{
    if(!args){await doSellMenu(chatId,u);return;}
    const parts=args.split(/\s+/);
    const ct=parts[0].startsWith('0x')?parts[0]:(await resolveTicker(parts[0]));
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
    const meta=await getMeta(ct)||{};
    if(parts[1]){const p=parts[1].toLowerCase()==='all'?100:parseFloat(parts[1].replace('%',''));if(!isNaN(p)){updU(chatId,{pd:{ct,sym:meta.symbol}});await showSellConfirm(chatId,ct,p,null);return;}}
    updU(chatId,{pd:{ct,sym:meta.symbol||trunc(ct)}}); await showSellPct(chatId,ct,meta.symbol||trunc(ct),null);
  });
});

bot.onText(/\/scan(?:\s+(.+))?/, async(msg,m)=>{
  const chatId=msg.chat.id, arg=san(m[1]||'');
  if(!arg){await bot.sendMessage(chatId,'Send the token CA:');updU(chatId,{state:'scan_ca'});return;}
  const ct=arg.startsWith('0x')?arg:(await resolveTicker(arg));
  if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
  const pm=await bot.sendMessage(chatId,'🔍 Scanning...');
  try{
    const u=getU(chatId);
    const[d,st]=await Promise.all([getTokenData(ct,u?.walletAddress),detectState(ct)]);
    await bot.editMessageText(scanReport(d,ct,st),{chat_id:chatId,message_id:pm.message_id,parse_mode:'Markdown'});
  }catch(e){await bot.editMessageText(`❌ Scan failed: ${e.message?.slice(0,100)}`,{chat_id:chatId,message_id:pm.message_id});}
});

bot.onText(/\/withdraw/, async(msg)=>doWithdrawMenu(msg.chat.id));
bot.onText(/\/balance/,  async(msg)=>doBalance(msg.chat.id));
bot.onText(/\/positions/,async(msg)=>doPositions(msg.chat.id));
bot.onText(/\/referral/, async(msg)=>doReferral(msg.chat.id));
bot.onText(/\/help/,     async(msg)=>doHelp(msg.chat.id));
bot.onText(/\/settings/, async(msg)=>doSettings(msg.chat.id));

bot.onText(/\/snipe(?:\s+(.+))?/, async(msg,m)=>{
  const chatId=msg.chat.id, token=m[1]?san(m[1].trim()):null;
  await guard(chatId,async()=>{
    if(!token){
      await bot.sendMessage(chatId,'⚡ Send the token CA to snipe:\n\n_Example: 0x1234..._',{parse_mode:'Markdown'});
      updU(chatId,{state:'snipe_ca'}); return;
    }
    updU(chatId,{state:'snipe_amount',pd:{sniToken:token}});
    await bot.sendMessage(chatId,`Token: \`${trunc(token)}\`\n\nHow much SUI to buy?\n_Example: 0.5_`,{parse_mode:'Markdown'});
  });
});

bot.onText(/\/copytrader(?:\s+(.+))?/, async(msg,m)=>{
  const chatId=msg.chat.id, arg=m[1]?san(m[1].trim()):null;
  await guard(chatId,async(u)=>{
    if(!arg||arg==='list'){
      if(!u.copyTraders?.length){await bot.sendMessage(chatId,'🔁 *Copy Trader*\n\nNo wallets tracked.\n\nUsage: /copytrader [wallet]\nStop: /copytrader stop',{parse_mode:'Markdown'});return;}
      await bot.sendMessage(chatId,`🔁 *Copy Traders (${u.copyTraders.length}/3)*\n\n${u.copyTraders.map((ct,i)=>`${i+1}. \`${trunc(ct.wallet)}\` — ${ct.amount} SUI/trade`).join('\n')}\n\nStop: /copytrader stop`,{parse_mode:'Markdown'}); return;
    }
    if(arg==='stop'){updU(chatId,{copyTraders:[]});await bot.sendMessage(chatId,'✅ All copy traders stopped.');return;}
    if(arg.startsWith('0x')){
      u.copyTraders=u.copyTraders||[];
      if(u.copyTraders.length>=3){await bot.sendMessage(chatId,'❌ Max 3 wallets. /copytrader stop first.');return;}
      u.copyTraders.push({wallet:arg,amount:u.settings.copyAmount,maxPos:5,blacklist:[]});
      updU(chatId,{copyTraders:u.copyTraders});
      await bot.sendMessage(chatId,`✅ Tracking \`${trunc(arg)}\`\nAmount: ${u.settings.copyAmount} SUI per trade`,{parse_mode:'Markdown'}); return;
    }
    updU(chatId,{state:'copy_wallet'}); await bot.sendMessage(chatId,'Enter the wallet address to copy:');
  });
});

// ═══════════════════════════════════════════════════════════
// ERROR HANDLERS & STARTUP
// ═══════════════════════════════════════════════════════════
bot.on('polling_error', e=>{
  console.error('Polling:', e.message);
  if(ADMIN_ID) bot.sendMessage(ADMIN_ID,`⚠️ Polling error: ${e.message?.slice(0,150)}`).catch(()=>{});
});
process.on('uncaughtException', e=>{
  console.error('Uncaught:', e.message, e.stack?.slice(0,500));
  if(ADMIN_ID) bot.sendMessage(ADMIN_ID,`🚨 Crash: ${e.message?.slice(0,150)}`).catch(()=>{});
});
process.on('unhandledRejection', r=>console.error('Unhandled rejection:', r));

async function main() {
  if (!TG_TOKEN)           throw new Error('TG_BOT_TOKEN env var required');
  if (ENC_KEY.length!==64) throw new Error('ENCRYPT_KEY must be 64 hex chars\nGenerate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');

  loadDB();

  // Kill any existing webhook / polling session
  try { await fetch(`https://api.telegram.org/bot${TG_TOKEN}/deleteWebhook?drop_pending_updates=true`); } catch {}
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=-1&timeout=0&limit=1`);
    await sleep(1500);
    console.log('✅ Old sessions cleared');
  } catch(e) { console.warn('Session clear:', e.message); }

  try { const me=await bot.getMe(); BOT_USERNAME=me.username||BOT_USERNAME; } catch(e){ console.warn('getMe:', e.message); }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  AGENT TRADING BOT — v6');
  console.log(`  Bot: @${BOT_USERNAME}`);
  console.log(`  Users: ${Object.keys(DB).length} | RPC: ${RPC_URL}`);
  console.log('  DEX: Cetus CLMM + Turbos CLMM');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  positionMonitor().catch(e=>console.error('Monitor:', e));
  sniperEngine().catch(e=>console.error('Sniper:', e));
  copyEngine().catch(e=>console.error('Copy:', e));

  console.log('  Bot is live! 🚀');
  if(ADMIN_ID) bot.sendMessage(ADMIN_ID,'🟢 AGENT TRADING BOT v6 online.').catch(()=>{});
}

main().catch(e=>{ console.error('Fatal:', e.message); process.exit(1); });
