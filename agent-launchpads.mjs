// ════════════════════════════════════════════════════════════════
// AGENT-LAUNCHPADS module — adds three launchpad integrations:
//
//   1. AGENT Launchpad (MemeLand v6.5b)        — discovery only (Cetus)
//   2. Odyssey  (theodyssey.fun)                — moonbags bonding curve
//   3. Moonbags (moonbags.io / api2.moonbags.io) — RaidenX bonding curve
//
// v7.3 — adds Moonbags (moonbags.io) integration. AGENT + Odyssey code
// is byte-identical to v7.2; only NEW code was added below the
// "MOONBAGS.IO" banner. None of the existing exports were changed,
// renamed, or behaviorally modified.
//
// Moonbags integration was reverse-engineered from on-chain inspection
// (verified May 2026, against the live, upgraded package):
//   • Package (current upgraded ID, used for calls):
//     0x1f2fd9f03575a5dd8a0482ea9a32522fa5f4ec8073a14a5362efd3833d415a7e
//   • Original package (type origin, kept for reference):
//     0x8f70ad5db84e1a99b542f86ccfb1a932ca7ba010a2fa12a1504d839ff4c111c6
//   • Reference BUY tx:  EFmxW5XkWAWXgAzhCTtTWK3Ueh73TQqQXGhxoyt3uG8B
//   • Reference SELL tx: AcMh1snDXZPU9WjWgFmxSqGDGD5URmqAENtq7eWv9p9T
//   • Buy fn (current):  moonbags::buy_exact_in<T>(
//                            Configuration mut,
//                            Coin<SUI>,
//                            amount_in:       u64,
//                            min_amount_out:  u64,
//                            BurnManager mut,
//                            Pools mut,                  // cetus factory
//                            GlobalConfig mut,           // cetus config
//                            &CoinMetadata<SUI>,
//                            &Clock,
//                            &mut TxContext,
//                        )
//   • Sell fn:           moonbags::sell<T>(
//                            Configuration mut,
//                            Coin<T>,
//                            min_sui_out: u64,
//                            &Clock,
//                            &mut TxContext,
//                        )
// ════════════════════════════════════════════════════════════════

import { Transaction } from '@mysten/sui/transactions';
import { setTimeout as sleep } from 'timers/promises';

// ─── public endpoints (override via env) ───────────────────────────
export const AGENT_BACKEND_URL =
  process.env.AGENT_LAUNCHPAD_URL ||
  'https://backend-production-d4c4b.up.railway.app';

export const ODYSSEY_API_URL =
  process.env.ODYSSEY_API_URL ||
  'https://www.theodyssey.fun';

export const MOONBAGS_API_URL =
  process.env.MOONBAGS_API_URL ||
  'https://api2.moonbags.io';

const CLOCK_OBJ = '0x6';
const SUI_T = '0x2::sui::SUI';

// ─── helpers ────────────────────────────────────────────────────────
async function jget(url, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ════════════════════════════════════════════════════════════════
// 1. AGENT LAUNCHPAD — discovery only (Cetus swap reused from bot)
// ════════════════════════════════════════════════════════════════

export async function fetchAgentLaunchpadTokens(limit = 20) {
  const j = await jget(`${AGENT_BACKEND_URL}/memeland/tokens`);
  const arr = Array.isArray(j?.tokens) ? j.tokens : [];
  return arr.slice(0, limit).map(t => ({
    coinType: t.coinType,
    name: t.name || t.symbol || 'Unknown',
    symbol: t.symbol || '',
    image: t.image || null,
    poolId: t.poolId || null,
    creator: t.creator || null,
    holders: typeof t.holders === 'number' ? t.holders : null,
    marketCap: t.marketCap ?? null,
    priceUsd: t.priceUsd ?? null,
    priceSui: t.priceSui ?? null,
    marketCapUsd: t.marketCapUsd ?? null,
    onChainId: t.onChainId ?? t.tokenId ?? null,
    isAgent: true,
    source: 'AGENT',
  }));
}

export async function fetchAgentTokenByCoinType(coinType) {
  try {
    const j = await jget(`${AGENT_BACKEND_URL}/memeland/tokens`);
    const arr = Array.isArray(j?.tokens) ? j.tokens : [];
    const norm = (coinType || '').toLowerCase();
    const t = arr.find(x => (x.coinType || '').toLowerCase() === norm);
    if (!t) return null;
    return {
      coinType:   t.coinType,
      symbol:     t.symbol     || '',
      poolId:     t.poolId     || null,
      priceSui:   t.priceSui   ?? null,
      priceUsd:   t.priceUsd   ?? null,
      marketCap:  t.marketCap  ?? null,
    };
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// 2. ODYSSEY — moonbags bonding curve (theodyssey.fun)
// ════════════════════════════════════════════════════════════════
// [unchanged from v7.2 — keeping the full original code below verbatim]

export async function fetchOdysseyTokens({ limit = 20, includeCompleted = false } = {}) {
  const arr = await jget(`${ODYSSEY_API_URL}/api/tokens`);
  if (!Array.isArray(arr)) return [];
  let list = arr;
  if (!includeCompleted) list = list.filter(t => !t.isCompleted);
  return list.slice(0, limit).map(t => ({
    coinType: t.coinType,
    name: t.name || t.symbol || 'Unknown',
    symbol: t.symbol || '',
    image: t.imageUrl || null,
    poolId: t.poolId || t.id || null,
    creator: t.creator || null,
    moonbagsPackageId: t.moonbagsPackageId,
    pairType: t.pairType || 'SUI',
    pairToken: t.pairToken || 'SUI',
    progress: t.progress ?? 0,
    threshold: t.threshold ?? null,
    raised: t.realSuiRaised ?? t.realSuiSui ?? 0,
    marketCap: t.marketCap ?? null,
    priceUsd: t.currentPrice ?? null,
    isCompleted: !!t.isCompleted,
    isOdyssey: true,
    source: 'Odyssey',
  }));
}

const _odyConfigCache = new Map();
const ODY_CFG_TTL_MS = 30 * 60 * 1000;

export async function getOdysseyConfigs(suiClient, packageId) {
  if (!packageId) throw new Error('getOdysseyConfigs: packageId is required');
  const cached = _odyConfigCache.get(packageId);
  if (cached && Date.now() - cached.discoveredAt < ODY_CFG_TTL_MS) return cached;
  const evRes = await suiClient.queryEvents({
    query: { MoveModule: { package: packageId, module: 'moonbags' } },
    limit: 10,
    order: 'descending',
  });
  let bestResult = null;
  for (const ev of evRes?.data || []) {
    const digest = ev.id?.txDigest;
    if (!digest) continue;
    try {
      const tx = await suiClient.getTransactionBlock({ digest, options: { showInput: true } });
      const inputs = tx?.transaction?.data?.transaction?.inputs || [];
      const calls  = tx?.transaction?.data?.transaction?.transactions || [];
      for (const t of calls) {
        const c = t.MoveCall;
        if (!c || c.module !== 'moonbags') continue;
        if (c.function !== 'buy_exact_in_with_lock' && c.function !== 'sell') continue;
        const args = c.arguments || [];
        const inpIdx0 = args[0]?.Input;
        const inpIdx1 = c.function === 'buy_exact_in_with_lock' ? args[1]?.Input : null;
        if (typeof inpIdx0 !== 'number') continue;
        const cfg = inputs[inpIdx0];
        if (!cfg?.objectId) continue;
        let tokenLockId = null;
        if (typeof inpIdx1 === 'number') {
          const tl = inputs[inpIdx1];
          if (tl?.objectId) tokenLockId = tl.objectId;
        }
        const out = { configId: cfg.objectId, tokenLockConfigId: tokenLockId, discoveredAt: Date.now() };
        if (tokenLockId) { _odyConfigCache.set(packageId, out); return out; }
        if (!bestResult) bestResult = out;
      }
    } catch { /* try next */ }
  }
  if (bestResult) { _odyConfigCache.set(packageId, bestResult); return bestResult; }
  throw new Error(
    `Could not discover Odyssey Configuration objects for package ${packageId}. ` +
    `No recent moonbags buy/sell transactions found on-chain for this package.`
  );
}

const _odyTokenIndex = { at: 0, byCoin: new Map() };
const ODY_INDEX_TTL_MS = 2 * 60 * 1000;

export async function isOdysseyToken(coinType) {
  if (!coinType) return null;
  if (Date.now() - _odyTokenIndex.at > ODY_INDEX_TTL_MS) {
    try {
      const arr = await jget(`${ODYSSEY_API_URL}/api/tokens`);
      _odyTokenIndex.at = Date.now();
      _odyTokenIndex.byCoin.clear();
      for (const t of (arr || [])) {
        if (t.coinType) _odyTokenIndex.byCoin.set(t.coinType, t);
      }
    } catch { /* keep stale */ }
  }
  const t = _odyTokenIndex.byCoin.get(coinType);
  if (!t) return null;
  return {
    coinType: t.coinType,
    moonbagsPackageId: t.moonbagsPackageId,
    pairType: t.pairType || 'SUI',
    isCompleted: !!t.isCompleted,
    symbol: t.symbol || '',
    progress: t.progress ?? 0,
  };
}

export async function buildOdysseyBuyTx({
  suiClient, walletAddress, packageId, coinType,
  amountInMist, minOutRaw = 0n, feeBufferBps = 300n,
}) {
  if (!packageId) throw new Error(`No moonbagsPackageId for this Odyssey token — cannot buy`);
  const cfg = await getOdysseyConfigs(suiClient, packageId);
  if (!cfg.tokenLockConfigId) {
    throw new Error(
      'Could not discover Odyssey TokenLock Configuration (no buy transactions found for this package). ' +
      'Try again in a moment after any buy tx is mined for this token.'
    );
  }
  const amountIn  = BigInt(amountInMist);
  const feeBuf    = (amountIn * BigInt(feeBufferBps) + 9999n) / 10000n;
  const coinTotal = amountIn + feeBuf;
  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  tx.setSender(walletAddress);
  const [suiCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(coinTotal)]);
  tx.moveCall({
    target: `${packageId}::moonbags::buy_exact_in_with_lock`,
    typeArguments: [coinType],
    arguments: [
      tx.object(cfg.configId),
      tx.object(cfg.tokenLockConfigId),
      suiCoin,
      tx.pure.u64(amountIn),
      tx.pure.u64(BigInt(minOutRaw)),
      tx.object(CLOCK_OBJ),
    ],
  });
  return tx;
}

export async function buildOdysseySellTx({
  suiClient, walletAddress, packageId, coinType,
  tokenCoinIdsToMerge, amountToSellRaw, minSuiOutMist = 0n,
}) {
  if (!packageId) throw new Error(`No moonbagsPackageId for this Odyssey token — cannot sell`);
  if (!Array.isArray(tokenCoinIdsToMerge) || !tokenCoinIdsToMerge.length) {
    throw new Error('No token coin objects provided to sell');
  }
  const cfg = await getOdysseyConfigs(suiClient, packageId);
  if (!cfg.configId) throw new Error('Could not discover Odyssey Configuration object for this package');
  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  tx.setSender(walletAddress);
  const primary = tx.object(tokenCoinIdsToMerge[0]);
  if (tokenCoinIdsToMerge.length > 1) {
    tx.mergeCoins(primary, tokenCoinIdsToMerge.slice(1).map(id => tx.object(id)));
  }
  const [coinToSell] = tx.splitCoins(primary, [tx.pure.u64(BigInt(amountToSellRaw))]);
  tx.moveCall({
    target: `${packageId}::moonbags::sell`,
    typeArguments: [coinType],
    arguments: [
      tx.object(cfg.configId),
      coinToSell,
      tx.pure.u64(BigInt(minSuiOutMist)),
      tx.object(CLOCK_OBJ),
    ],
  });
  return tx;
}

export async function executeOdysseyBuy({ suiClient, signAndExecute, walletAddress, packageId, coinType, amountInMist, minOutRaw = 0n }) {
  const tx = await buildOdysseyBuyTx({ suiClient, walletAddress, packageId, coinType, amountInMist, minOutRaw });
  return await signAndExecute(tx);
}
export async function executeOdysseySell({ suiClient, signAndExecute, walletAddress, packageId, coinType, tokenCoinIdsToMerge, amountToSellRaw, minSuiOutMist = 0n }) {
  const tx = await buildOdysseySellTx({ suiClient, walletAddress, packageId, coinType, tokenCoinIdsToMerge, amountToSellRaw, minSuiOutMist });
  return await signAndExecute(tx);
}

// ════════════════════════════════════════════════════════════════
// 3. MOONBAGS.IO — bonding curve via package 0x8f70ad5d…  (NEW v7.3)
// ════════════════════════════════════════════════════════════════
// All identifiers below are SHARED, GLOBAL constants — they don't vary per
// token (unlike Odyssey, which has one package per token batch).
// Verified live on Sui mainnet via on-chain tx inspection, Apr 2026.

// Current upgraded package ID — call moonbags functions on THIS id.
// (The original publish was 0x8f70ad5db84e…; the contract has since been
// upgraded. Type origins still point at the original package, which is
// fine — Sui resolves type identity across upgrades.)
export const MOONBAGS_PKG          = '0x1f2fd9f03575a5dd8a0482ea9a32522fa5f4ec8073a14a5362efd3833d415a7e';
export const MOONBAGS_PKG_ORIGIN   = '0x8f70ad5db84e1a99b542f86ccfb1a932ca7ba010a2fa12a1504d839ff4c111c6';
export const MOONBAGS_CONFIG       = '0x74aecf86067c6913960ba4925333aefd2b1f929cafca7e21fd55a8f244b70499';
// NB: object types verified live via sui_getObject —
//     BurnManager  = 0x12d73de9…::lp_burn::BurnManager
//     Pools        = 0x1eabed72…::factory::Pools
//     GlobalConfig = 0x1eabed72…::config::GlobalConfig
export const MOONBAGS_BURN_MGR     = '0x1d94aa32518d0cb00f9de6ed60d450c9a2090761f326752ffad06b2e9404f845';
export const CETUS_FACTORY_POOLS   = '0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0';
export const CETUS_GLOBAL_CONFIG   = '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f';
export const SUI_COIN_METADATA     = '0x9258181f5ceac8dbffb7030890243caed69a9599d2886d957a9cb7656af3bdb3';

// Moonbags charges a 1% trade fee on the bonding curve (verified from real
// TradedEvent: fee=29700000 on sui_amount=2970000000 → 1.0%).
const MOONBAGS_FEE_BPS = 100n; // 1.00%

/**
 * GET /api/v1/coin → list of Moonbags bonding-curve tokens (page 1).
 * Returns tokens shaped like the Odyssey list so the bot's launchpad UI
 * can render them with `_fmtToken` unchanged.
 *
 * `bondingCurve` from the API is 0–100 (% toward graduation).
 * `mcap` is in USD. Tokens whose bonding curve has completed are filtered
 * by default — those trade as plain Cetus pools afterwards and are
 * already supported by the bot's standard /buy flow.
 */
export async function fetchMoonbagsTokens({ limit = 20, includeCompleted = false } = {}) {
  // NB: sortBy=mcap returns mostly graduated tokens (the biggest caps are
  // already listed on Cetus). To surface live bonding-curve tokens we sort
  // by createdAt (newest), filter out graduated ones, then re-sort the
  // active set by bonding-curve progress (closer to grad = more action).
  const j = await jget(`${MOONBAGS_API_URL}/api/v1/coin?page=1&limit=100&sortBy=createdAt`);
  const arr = Array.isArray(j?.docs) ? j.docs : [];
  let list = arr;
  if (!includeCompleted) list = list.filter(t => !t.listedPoolId); // listedPoolId set ⇢ graduated to Cetus
  list.sort((a, b) => (Number(b.bondingCurve) || 0) - (Number(a.bondingCurve) || 0));
  return list.slice(0, limit).map(t => ({
    coinType: t.tokenAddress,
    name: t.name || t.symbol || 'Unknown',
    symbol: t.symbol || '',
    image: t.image || t.logo || null,
    poolId: t.poolAddress || null,           // moonbags Pool<T> object
    creator: t.creator || null,
    pairType: 'SUI',
    progress: typeof t.bondingCurve === 'number' ? t.bondingCurve : null,
    threshold: t.threshold ?? null,
    virtualSuiReserves:   t.virtualSuiReserves   ?? null,
    virtualTokenReserves: t.virtualTokenReserves ?? null,
    realSuiReserves:      t.realSuiReserves      ?? null,
    realTokenReserves:    t.realTokenReserves    ?? null,
    marketCap: t.mcap ?? null,
    priceUsd:  t.priceUsd ?? null,
    isCompleted: !!t.listedPoolId,
    isMoonbags: true,
    source: 'Moonbags',
  }));
}

/**
 * Fetch a single Moonbags token by tokenAddress (the SUI coin type string).
 * Used by `isMoonbagsToken` and the buy estimator.
 */
export async function fetchMoonbagsCoin(coinType) {
  if (!coinType) return null;
  try {
    // The API accepts the full coinType as the {identifier} path param.
    const t = await jget(`${MOONBAGS_API_URL}/api/v1/coin/${encodeURIComponent(coinType)}`);
    if (!t || !t.tokenAddress) return null;
    return {
      coinType: t.tokenAddress,
      symbol: t.symbol || '',
      poolId: t.poolAddress || null,
      progress: typeof t.bondingCurve === 'number' ? t.bondingCurve : null,
      virtualSuiReserves:   BigInt(t.virtualSuiReserves   ?? 0),
      virtualTokenReserves: BigInt(t.virtualTokenReserves ?? 0),
      realSuiReserves:      BigInt(t.realSuiReserves      ?? 0),
      realTokenReserves:    BigInt(t.realTokenReserves    ?? 0),
      threshold: t.threshold ?? null,
      isCompleted: !!t.listedPoolId,
      marketCap: t.mcap ?? null,
    };
  } catch {
    return null;
  }
}

// In-process index for fast "is this CA a Moonbags token?" probes.
const _mbIndex = { at: 0, byCoin: new Map() };
const MB_INDEX_TTL_MS = 2 * 60 * 1000;

export async function isMoonbagsToken(coinType) {
  if (!coinType) return null;
  // Fast path: cached list
  if (Date.now() - _mbIndex.at > MB_INDEX_TTL_MS) {
    try {
      // Index newest tokens (these are the ones still on bonding curve).
      // Top-mcap is dominated by graduated tokens — useless for "is this
      // a moonbags bonding-curve token?".
      const j = await jget(`${MOONBAGS_API_URL}/api/v1/coin?page=1&limit=100&sortBy=createdAt`);
      _mbIndex.at = Date.now();
      _mbIndex.byCoin.clear();
      for (const t of (j?.docs || [])) {
        if (t.tokenAddress) _mbIndex.byCoin.set(t.tokenAddress, t);
      }
    } catch { /* keep stale */ }
  }
  let t = _mbIndex.byCoin.get(coinType);
  // Fallback: per-coin lookup (covers tokens that fell off the top-100 page)
  if (!t) {
    const detail = await fetchMoonbagsCoin(coinType);
    if (!detail) return null;
    t = {
      tokenAddress: detail.coinType,
      symbol: detail.symbol,
      poolAddress: detail.poolId,
      bondingCurve: detail.progress,
      virtualSuiReserves:   String(detail.virtualSuiReserves),
      virtualTokenReserves: String(detail.virtualTokenReserves),
      listedPoolId: detail.isCompleted ? 'graduated' : null,
    };
  }
  return {
    coinType: t.tokenAddress,
    symbol: t.symbol || '',
    poolId: t.poolAddress || null,
    progress: typeof t.bondingCurve === 'number' ? t.bondingCurve : null,
    isCompleted: !!t.listedPoolId,
    pairType: 'SUI',
    virtualSuiReserves:   BigInt(t.virtualSuiReserves   ?? 0),
    virtualTokenReserves: BigInt(t.virtualTokenReserves ?? 0),
  };
}

/**
 * Constant-product estimator for the moonbags bonding curve.
 *
 * The curve is a virtual-reserves AMM: k = vsr * vtr.  A buy of `out`
 * tokens requires net SUI in such that
 *   (vsr + suiInNet) * (vtr - out) = k  ⇒
 *   suiInNet = (vsr * out) / (vtr - out)
 *
 * Inverting for the more useful direction (given suiIn, what's out):
 *   suiInNet = suiInGross * (1 - feeBps/10000)
 *   out      = (vtr * suiInNet) / (vsr + suiInNet)
 *
 * Returns { amountOutRaw, suiInNet }.  All inputs/outputs are bigints.
 */
export function estimateMoonbagsBuy({
  virtualSuiReserves, virtualTokenReserves, suiInMistGross,
}) {
  const vsr = BigInt(virtualSuiReserves);
  const vtr = BigInt(virtualTokenReserves);
  const gross = BigInt(suiInMistGross);
  if (vsr <= 0n || vtr <= 0n || gross <= 0n) {
    return { amountOutRaw: 0n, suiInNet: 0n };
  }
  const suiInNet = (gross * (10_000n - MOONBAGS_FEE_BPS)) / 10_000n;
  const out = (vtr * suiInNet) / (vsr + suiInNet);
  return { amountOutRaw: out, suiInNet };
}

/**
 * Build a PTB that buys a Moonbags bonding-curve token with SUI.
 *
 * Strategy: estimate `amount_out` off-chain from the API's virtual
 * reserves, apply a slippage haircut, and split a SUI coin sized at
 * the user's gross spend (the contract uses what it needs and refunds
 * the rest into the same coin).
 *
 * On-chain signature (verified from tx GmBGrP6da2…):
 *   moonbags::buy_exact_out<T>(
 *     &mut Configuration,
 *     Coin<SUI>,
 *     amount_out: u64,
 *     &mut BurnManager,
 *     &mut CetusPools,
 *     &mut CetusGlobalConfig,
 *     &CoinMetadata<SUI>,
 *     &Clock,
 *     &mut TxContext,
 *   )
 */
export async function buildMoonbagsBuyTx({
  suiClient,
  walletAddress,
  coinType,
  amountInMist,        // bigint — gross SUI to spend
  slippageBps = 500n,  // 5% default; pass your own from u.settings.slippage
  reservesOverride = null,  // { vsr, vtr } — skip API hit if you already have them
}) {
  const amountIn = BigInt(amountInMist);
  if (amountIn <= 0n) throw new Error('amountInMist must be > 0');

  // Pull live reserves (or use whatever the caller passed in)
  let vsr, vtr;
  if (reservesOverride && reservesOverride.vsr && reservesOverride.vtr) {
    vsr = BigInt(reservesOverride.vsr);
    vtr = BigInt(reservesOverride.vtr);
  } else {
    const tok = await fetchMoonbagsCoin(coinType);
    if (!tok) throw new Error(`Moonbags API has no record of ${coinType}`);
    if (tok.isCompleted) throw new Error(`${tok.symbol||coinType} has graduated off the moonbags curve — trade it on Cetus`);
    vsr = tok.virtualSuiReserves;
    vtr = tok.virtualTokenReserves;
  }

  // Off-chain estimate, then apply slippage haircut so amount_out becomes a
  // floor not a target. The contract will charge the SUI coin for the actual
  // (possibly cheaper) amount and refund the surplus.
  const { amountOutRaw } = estimateMoonbagsBuy({
    virtualSuiReserves: vsr, virtualTokenReserves: vtr, suiInMistGross: amountIn,
  });
  if (amountOutRaw <= 0n) throw new Error('Estimated amount_out is zero — reserves stale or amount too small');
  const amountOutMin = (amountOutRaw * (10_000n - BigInt(slippageBps))) / 10_000n;

  const tx = new Transaction();
  tx.setGasBudget(60_000_000); // moonbags PTB is heavier than Odyssey (Cetus refs)
  tx.setSender(walletAddress);

  // The contract refunds excess SUI inside the call, so it's safe to send the
  // full gross amount — we don't add an extra fee buffer on top.
  const [suiCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountIn)]);

  tx.moveCall({
    target: `${MOONBAGS_PKG}::moonbags::buy_exact_in`,
    typeArguments: [coinType],
    arguments: [
      tx.object(MOONBAGS_CONFIG),       // mut Configuration
      suiCoin,                          // Coin<SUI>
      tx.pure.u64(amountIn),            // amount_in (the SUI spend)
      tx.pure.u64(amountOutMin),        // min_amount_out (slippage floor)
      tx.object(MOONBAGS_BURN_MGR),     // mut BurnManager
      tx.object(CETUS_FACTORY_POOLS),   // mut Cetus Pools
      tx.object(CETUS_GLOBAL_CONFIG),   // mut Cetus GlobalConfig
      tx.object(SUI_COIN_METADATA),     // &CoinMetadata<SUI>
      tx.object(CLOCK_OBJ),             // &Clock
    ],
  });

  return tx;
}

/**
 * Build a PTB that sells a Moonbags bonding-curve token for SUI.
 *
 * Sell signature is identical in shape to Odyssey's:
 *   moonbags::sell<T>(&mut Configuration, Coin<T>, min_sui_out: u64,
 *                     &Clock, &mut TxContext)
 * — but the Configuration object ID is the global moonbags one, NOT
 * a per-package object like Odyssey's. So we don't need any on-chain
 * discovery here.
 *
 * Verified against tx AcMh1snDXZPU9WjWgFmxSqGDGD5URmqAENtq7eWv9p9T.
 */
export async function buildMoonbagsSellTx({
  walletAddress,
  coinType,
  tokenCoinIdsToMerge,    // string[]
  amountToSellRaw,        // bigint
  minSuiOutMist = 0n,     // bigint
}) {
  if (!Array.isArray(tokenCoinIdsToMerge) || !tokenCoinIdsToMerge.length) {
    throw new Error('No token coin objects provided to sell');
  }

  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  tx.setSender(walletAddress);

  const primary = tx.object(tokenCoinIdsToMerge[0]);
  if (tokenCoinIdsToMerge.length > 1) {
    tx.mergeCoins(primary, tokenCoinIdsToMerge.slice(1).map(id => tx.object(id)));
  }
  const [coinToSell] = tx.splitCoins(primary, [tx.pure.u64(BigInt(amountToSellRaw))]);

  tx.moveCall({
    target: `${MOONBAGS_PKG}::moonbags::sell`,
    typeArguments: [coinType],
    arguments: [
      tx.object(MOONBAGS_CONFIG),
      coinToSell,
      tx.pure.u64(BigInt(minSuiOutMist)),
      tx.object(CLOCK_OBJ),
    ],
  });

  return tx;
}

export async function executeMoonbagsBuy({
  suiClient, signAndExecute, walletAddress, coinType, amountInMist,
  slippageBps = 500n, reservesOverride = null,
}) {
  const tx = await buildMoonbagsBuyTx({
    suiClient, walletAddress, coinType, amountInMist, slippageBps, reservesOverride,
  });
  return await signAndExecute(tx);
}

export async function executeMoonbagsSell({
  signAndExecute, walletAddress, coinType,
  tokenCoinIdsToMerge, amountToSellRaw, minSuiOutMist = 0n,
}) {
  const tx = await buildMoonbagsSellTx({
    walletAddress, coinType, tokenCoinIdsToMerge, amountToSellRaw, minSuiOutMist,
  });
  return await signAndExecute(tx);
}

// ════════════════════════════════════════════════════════════════
// Combined launchpad-list helper for the /launchpad menu
// ════════════════════════════════════════════════════════════════

/**
 * Returns { agent, odyssey, moonbags } — best-effort, never throws.
 * Used by the /launchpad menu in bot.mjs.
 */
export async function fetchAllLaunchpadTokens({ limit = 10 } = {}) {
  const [agentRes, odyRes, mbRes] = await Promise.allSettled([
    fetchAgentLaunchpadTokens(limit),
    fetchOdysseyTokens({ limit }),
    fetchMoonbagsTokens({ limit }),
  ]);
  return {
    agent:    agentRes.status === 'fulfilled' ? agentRes.value : [],
    odyssey:  odyRes.status   === 'fulfilled' ? odyRes.value   : [],
    moonbags: mbRes.status    === 'fulfilled' ? mbRes.value    : [],
    agentError:    agentRes.status === 'rejected' ? String(agentRes.reason?.message || agentRes.reason) : null,
    odysseyError:  odyRes.status   === 'rejected' ? String(odyRes.reason?.message   || odyRes.reason)   : null,
    moonbagsError: mbRes.status    === 'rejected' ? String(mbRes.reason?.message    || mbRes.reason)    : null,
  };
}
