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
//     0x9bc9ddc5cd0220ef810489c73e770f8587a8aa09cad064a0d8e0d1ad903a9e0f
//   • Original package (type origin, kept for reference):
//     0x8f70ad5db84e1a99b542f86ccfb1a932ca7ba010a2fa12a1504d839ff4c111c6
//   • Reference BUY tx:  84u13QkitHfZ6zYRbK1H375D8CDfb1xWqYvoswobW6S7  (May 2026)
//   • Reference SELL tx: CUhkKui54SWH1jhFo5FY4VKaetay2XAz6rJuUfgHRbwQ  (May 2026)
//   • TokenLock Configuration shared object (NEW arg #2 on every buy):
//     0xfb09822d9808980abd04c51321adb850701f5f55535c6206658ef4d910c3e9be
//   • Buy fn (current):  moonbags::buy_exact_in_with_lock<T>(
//                            Configuration mut,
//                            &moonbags_token_lock::Configuration,  // NEW
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
// upgraded multiple times. Type origins still point at the original
// package, which is fine — Sui resolves type identity across upgrades.)
// Latest upgrade (May 2026) gates buys behind a token-lock check; we
// must call `buy_exact_in_with_lock` and pass the new TokenLock
// Configuration shared object below.
export const MOONBAGS_PKG          = '0x9bc9ddc5cd0220ef810489c73e770f8587a8aa09cad064a0d8e0d1ad903a9e0f';
export const MOONBAGS_PKG_ORIGIN   = '0x8f70ad5db84e1a99b542f86ccfb1a932ca7ba010a2fa12a1504d839ff4c111c6';
export const MOONBAGS_CONFIG       = '0x74aecf86067c6913960ba4925333aefd2b1f929cafca7e21fd55a8f244b70499';
// New TokenLock Configuration shared object introduced with the
// post-May 2026 upgrade. Required as 2nd arg to `buy_exact_in_with_lock`.
// Verified live as Input #1 in tx 84u13QkitHfZ6zYRbK1H375D8CDfb1xWqYvoswobW6S7.
export const MOONBAGS_LOCK_CFG     = '0xfb09822d9808980abd04c51321adb850701f5f55535c6206658ef4d910c3e9be';
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
  const amtIn = BigInt(suiInMistGross);
  if (vsr <= 0n || vtr <= 0n || amtIn <= 0n) {
    return { amountOutRaw: 0n, suiInNet: 0n };
  }
  // Post-May-2026 contract: amount_in IS the swap amount. The 1% fee is
  // taken from the input *coin* on top of amount_in (verified live via
  // tx 8emKXB9iUWHDDxAtmLctrfrbJ32Lbsnmw5DGcwf8ARkw — coin=505000001 for
  // amount_in=500000000, fee=5000000). So the swap math uses amtIn as-is.
  const out = (vtr * amtIn) / (vsr + amtIn);
  return { amountOutRaw: out, suiInNet: amtIn };
}

/**
 * Build a PTB that buys a Moonbags bonding-curve token with SUI.
 *
 * Strategy: estimate `amount_out` off-chain from the API's virtual
 * reserves, apply a slippage haircut, and split a SUI coin sized at
 * the user's gross spend (the contract uses what it needs and refunds
 * the rest into the same coin).
 *
 * On-chain signature (verified from successful tx
 * 84u13QkitHfZ6zYRbK1H375D8CDfb1xWqYvoswobW6S7, May 2026):
 *   moonbags::buy_exact_in_with_lock<T>(
 *     &mut Configuration,
 *     &moonbags_token_lock::Configuration,    // NEW — gates buy
 *     Coin<SUI>,
 *     amount_in: u64,
 *     min_amount_out: u64,
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

  // IMPORTANT: the contract takes the 1% platform fee from the *coin* you
  // pass in (NOT from amount_in). So the Coin<SUI> must hold at least
  // amount_in + 1% fee. We add 1 extra mist for any integer-rounding edge
  // case (matches how the official frontend sizes its split — e.g.
  // amount_in 500000000 → split 505000001).
  const feeBuf  = (amountIn * MOONBAGS_FEE_BPS + 9_999n) / 10_000n; // ceil(1%)
  const coinSz  = amountIn + feeBuf + 1n;
  const [suiCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(coinSz)]);

  tx.moveCall({
    target: `${MOONBAGS_PKG}::moonbags::buy_exact_in_with_lock`,
    typeArguments: [coinType],
    arguments: [
      tx.object(MOONBAGS_CONFIG),       // mut Configuration
      tx.object(MOONBAGS_LOCK_CFG),     // & TokenLock Configuration  (NEW)
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
// 4. HOP.FUN — bonding curve via package 0x3b2612ad…  (NEW v7.4)
// ════════════════════════════════════════════════════════════════
// Reverse-engineered from on-chain inspection (verified May 2026):
//   • Curve package:   0x3b2612ad888338fb054bd485513095646a0c113b2d491fcc6feba46db0967aa3
//   • Events package:  0x4cf881ad2ba05c0eb54b599897b3606b438b10136f5a6eb52d56781ef5d6f37e
//   • HopConfig:       0x1e9e187c0877b6cf059370259b24ac6a7733961f69dfbdc8ffd808815521b377
//   • DynamicFee:      0x3bc5dd26cb2e4215623d4c0fd51376bf660c119d0a57b2e0db0b7294e46c26ca
//   • LaunchConfig:    0xbb8d6f6e4f6a3b11965dc4c3aa487f0d3b98a6f458f2a98b00fab05fc34c0297
//   • Reference BUY:   32LRmG6QnM3VWfEphRMrM3S7r2yqczLTrMpEKCp3tw8M
//   • Reference SELL:  BzcP6HSSUAv7Asbm9ZRjyKNyCVY8JsEYCfXwK9HZ1wTj
//
//   Buy fn:   curve::buy<T>(
//               &HopConfig,
//               &DynamicFee,
//               &mut BondingCurve<T>,
//               &LaunchConfig,
//               Coin<SUI>,
//               min_amount_out: u64,
//               &mut TxContext,
//             )
//   Sell fn:  curve::sell<T>(
//               &mut BondingCurve<T>,
//               &LaunchConfig,
//               Coin<T>,
//               min_sui_out:    u64,
//               &mut TxContext,
//             )
//
// Per-token state (reserves) lives on the BondingCurve<T> shared object.
// We discover curve_id by paginating BondingCurveCreated events and
// matching the curve object's type parameter to the wanted coin type.
// ════════════════════════════════════════════════════════════════

export const HOPFUN_PKG          = '0x3b2612ad888338fb054bd485513095646a0c113b2d491fcc6feba46db0967aa3';
export const HOPFUN_CONFIG       = '0x1e9e187c0877b6cf059370259b24ac6a7733961f69dfbdc8ffd808815521b377';
export const HOPFUN_DYNAMIC_FEE  = '0x3bc5dd26cb2e4215623d4c0fd51376bf660c119d0a57b2e0db0b7294e46c26ca';
export const HOPFUN_LAUNCH_CFG   = '0xbb8d6f6e4f6a3b11965dc4c3aa487f0d3b98a6f458f2a98b00fab05fc34c0297';
export const HOPFUN_EVENTS_PKG   = '0x4cf881ad2ba05c0eb54b599897b3606b438b10136f5a6eb52d56781ef5d6f37e';

// Total fee on input: 0.70% swap_fee_bps + 0.20% creator_fee_bps = 0.90%
// (read from LaunchConfig fields — matches actual on-chain trade event).
const HOPFUN_FEE_BPS = 90n;

// In-process resolver: coinType -> { curveId, ts }.
const _hfCurveCache = new Map();
const HF_CURVE_TTL_MS = 6 * 60 * 60 * 1000;
const HF_PAGE_SIZE   = 50;
const HF_MAX_PAGES   = 6;

function _hfCanon(t) { return (t || '').replace(/^0x0*/, '0x'); }

async function _hfScanPage(suiClient, cursor) {
  const page = await suiClient.queryEvents({
    query: { MoveEventType: `${HOPFUN_EVENTS_PKG}::events::BondingCurveCreated` },
    cursor, limit: HF_PAGE_SIZE, order: 'descending',
  });
  const ids = (page.data || [])
    .map(e => e.parsedJson?.curve_id)
    .filter(Boolean);
  if (!ids.length) return { entries: [], next: page.nextCursor, hasNext: page.hasNextPage };
  // Batch-fetch curve objects to extract their coin type from the type param.
  const objs = await suiClient.multiGetObjects({
    ids,
    options: { showType: true, showContent: true },
  });
  const entries = objs.map((o, i) => {
    const m = (o?.data?.type || '').match(/BondingCurve<(.+)>$/);
    if (!m) return null;
    const coinType = m[1];
    const f = o?.data?.content?.fields || {};
    return {
      curveId: ids[i],
      coinType,
      isOpen: f.open === true,
      virtualSuiReserves:    BigInt(f.virtual_sui_amount || 0) + BigInt(f.sui_balance || 0),
      virtualTokenReserves:  BigInt(f.token_balance || 0),
      availableTokenReserves:BigInt(f.available_token_reserves || 0),
      totalSupply:           BigInt(f.total_supply || 0),
      creator:               f.creator || null,
      creatorFees:           BigInt(f.creator_fees || 0),
    };
  }).filter(Boolean);
  // Side-effect: warm the curveId cache for everything we just scanned.
  for (const e of entries) {
    _hfCurveCache.set(e.coinType, { curveId: e.curveId, ts: Date.now() });
  }
  return { entries, next: page.nextCursor, hasNext: page.hasNextPage };
}

export async function resolveHopFunCurveId(suiClient, coinType) {
  if (!suiClient || !coinType) return null;
  const ck = _hfCanon(coinType);
  const cached = _hfCurveCache.get(coinType) || _hfCurveCache.get(ck);
  if (cached && Date.now() - cached.ts < HF_CURVE_TTL_MS) return cached.curveId;

  let cursor = null;
  for (let i = 0; i < HF_MAX_PAGES; i++) {
    const { entries, next, hasNext } = await _hfScanPage(suiClient, cursor);
    for (const e of entries) {
      if (_hfCanon(e.coinType) === ck) return e.curveId;
    }
    if (!hasNext) break;
    cursor = next;
  }
  return null;
}

export async function fetchHopFunCoin(suiClient, coinType) {
  if (!suiClient || !coinType) return null;
  const curveId = await resolveHopFunCurveId(suiClient, coinType);
  if (!curveId) return null;
  const obj = await suiClient.getObject({
    id: curveId,
    options: { showContent: true, showType: true },
  }).catch(() => null);
  const f = obj?.data?.content?.fields || {};
  if (!f.id) return null;
  return {
    coinType,
    symbol: (coinType.split('::').pop() || '').slice(0, 12),
    curveId,
    isOpen: f.open === true,
    isCompleted: f.open !== true,
    virtualSuiReserves:   BigInt(f.virtual_sui_amount || 0) + BigInt(f.sui_balance || 0),
    virtualTokenReserves: BigInt(f.token_balance || 0),
    availableTokenReserves: BigInt(f.available_token_reserves || 0),
    totalSupply: BigInt(f.total_supply || 0),
    creatorFees: BigInt(f.creator_fees || 0),
    pairType: 'SUI',
    source: 'hop.fun',
  };
}

export async function isHopFunToken(suiClient, coinType) {
  const t = await fetchHopFunCoin(suiClient, coinType).catch(() => null);
  if (!t) return null;
  return {
    coinType: t.coinType,
    symbol: t.symbol,
    curveId: t.curveId,
    progress: null,
    pairType: 'SUI',
    isCompleted: !t.isOpen,
    virtualSuiReserves: t.virtualSuiReserves,
    virtualTokenReserves: t.virtualTokenReserves,
  };
}

/**
 * List recent OPEN hop.fun bonding-curve tokens for the /launchpad menu.
 * Walks BondingCurveCreated events newest-first, batches curve-object reads,
 * filters for `open=true` (graduated tokens trade as plain Cetus pools and
 * are already supported by the bot's standard /buy flow).
 *
 * Returns shape compatible with the bot's `_fmtToken` renderer.
 */
export async function fetchHopFunTokens(suiClient, { limit = 12 } = {}) {
  if (!suiClient) return [];
  const out = [];
  const seen = new Set();
  let cursor = null;
  for (let i = 0; i < 3 && out.length < limit; i++) {
    const { entries, next, hasNext } = await _hfScanPage(suiClient, cursor);
    for (const e of entries) {
      if (seen.has(e.curveId) || !e.isOpen) continue;
      seen.add(e.curveId);
      // Curve progress estimate — % of token supply already sold off the curve.
      // (avail_reserves never quite hits zero; this is a best-effort UX hint.)
      let progress = null;
      if (e.totalSupply > 0n && e.availableTokenReserves >= 0n) {
        // curve_supply_bps = 8000 (80% of total supply on curve)
        const curveSupply = (e.totalSupply * 8000n) / 10000n;
        const sold = curveSupply > e.availableTokenReserves
          ? curveSupply - e.availableTokenReserves : 0n;
        progress = curveSupply > 0n
          ? Math.min(100, Number((sold * 1000n) / curveSupply) / 10) : null;
      }
      out.push({
        coinType: e.coinType,
        name:     (e.coinType.split('::').pop() || ''),
        symbol:   (e.coinType.split('::').pop() || '').slice(0, 12),
        image:    null,
        poolId:   e.curveId,
        creator:  e.creator,
        pairType: 'SUI',
        progress,
        marketCap: null,
        priceUsd:  null,
        isCompleted: false,
        isHopFun:  true,
        source:    'hop.fun',
        // pre-warm reserves so the buy estimator doesn't need a 2nd RPC
        virtualSuiReserves:   e.virtualSuiReserves,
        virtualTokenReserves: e.virtualTokenReserves,
      });
      if (out.length >= limit) break;
    }
    if (!hasNext) break;
    cursor = next;
  }
  return out;
}

/**
 * Constant-product estimator for hop.fun bonding curve.
 *  fee taken from input (0.90% protocol+creator):
 *    suiInNet = suiInGross * (1 - 90/10000)
 *    out      = (vtr * suiInNet) / (vsr + suiInNet)
 *  where vsr = virtual_sui_amount + sui_balance (effective SUI reserves)
 *        vtr = token_balance (raw tokens left in curve)
 *
 * Returns { amountOutRaw, suiInNet }. All inputs/outputs are bigints.
 */
export function estimateHopFunBuy({ virtualSuiReserves, virtualTokenReserves, suiInMistGross }) {
  const vsr = BigInt(virtualSuiReserves);
  const vtr = BigInt(virtualTokenReserves);
  const amtIn = BigInt(suiInMistGross);
  if (vsr <= 0n || vtr <= 0n || amtIn <= 0n) return { amountOutRaw: 0n, suiInNet: 0n };
  const suiInNet = (amtIn * (10_000n - HOPFUN_FEE_BPS)) / 10_000n;
  const amountOutRaw = (vtr * suiInNet) / (vsr + suiInNet);
  return { amountOutRaw, suiInNet };
}

/**
 * Build a PTB that BUYS a hop.fun bonding-curve token for SUI.
 *
 * If you already know the curve_id (e.g. it came from `fetchHopFunTokens`),
 * pass it via `curveOverride` to skip the events-scan resolver.
 *
 * Verified shape against tx 32LRmG6QnM3VWfEphRMrM3S7r2yqczLTrMpEKCp3tw8M.
 */
export async function buildHopFunBuyTx({
  suiClient,
  walletAddress,
  coinType,
  amountInMist,         // bigint — gross SUI to spend
  slippageBps = 500n,
  curveOverride = null,
  reservesOverride = null,
}) {
  const amountIn = BigInt(amountInMist);
  if (amountIn <= 0n) throw new Error('amountInMist must be > 0');

  const curveId = curveOverride || await resolveHopFunCurveId(suiClient, coinType);
  if (!curveId) throw new Error(`hop.fun curve not found for ${coinType}`);

  let vsr, vtr;
  if (reservesOverride && reservesOverride.vsr && reservesOverride.vtr) {
    vsr = BigInt(reservesOverride.vsr);
    vtr = BigInt(reservesOverride.vtr);
  } else {
    const tok = await fetchHopFunCoin(suiClient, coinType);
    if (!tok)            throw new Error(`hop.fun curve state unavailable for ${coinType}`);
    if (tok.isCompleted) throw new Error(`${tok.symbol} has graduated off the hop.fun curve — trade it on Cetus`);
    vsr = tok.virtualSuiReserves;
    vtr = tok.virtualTokenReserves;
  }

  const { amountOutRaw } = estimateHopFunBuy({
    virtualSuiReserves: vsr, virtualTokenReserves: vtr, suiInMistGross: amountIn,
  });
  if (amountOutRaw <= 0n) throw new Error('Estimated amount_out is zero — reserves stale or amount too small');
  const amountOutMin = (amountOutRaw * (10_000n - BigInt(slippageBps))) / 10_000n;

  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  tx.setSender(walletAddress);

  const [coinIn] = tx.splitCoins(tx.gas, [tx.pure.u64(amountIn)]);
  tx.moveCall({
    target: `${HOPFUN_PKG}::curve::buy`,
    typeArguments: [coinType],
    arguments: [
      tx.object(HOPFUN_CONFIG),       // &HopConfig
      tx.object(HOPFUN_DYNAMIC_FEE),  // &DynamicFee
      tx.object(curveId),             // &mut BondingCurve<T>
      tx.object(HOPFUN_LAUNCH_CFG),   // &LaunchConfig
      coinIn,                         // Coin<SUI>
      tx.pure.u64(amountOutMin),      // min_amount_out
    ],
  });
  return tx;
}

/**
 * Build a PTB that SELLS a hop.fun bonding-curve token for SUI.
 *
 * Verified shape against tx BzcP6HSSUAv7Asbm9ZRjyKNyCVY8JsEYCfXwK9HZ1wTj.
 */
export async function buildHopFunSellTx({
  suiClient,
  walletAddress,
  coinType,
  tokenCoinIdsToMerge,
  amountToSellRaw,
  minSuiOutMist = 0n,
  curveOverride = null,
}) {
  if (!Array.isArray(tokenCoinIdsToMerge) || !tokenCoinIdsToMerge.length) {
    throw new Error('No token coin objects provided to sell');
  }
  const curveId = curveOverride || await resolveHopFunCurveId(suiClient, coinType);
  if (!curveId) throw new Error(`hop.fun curve not found for ${coinType}`);

  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  tx.setSender(walletAddress);

  const primary = tx.object(tokenCoinIdsToMerge[0]);
  if (tokenCoinIdsToMerge.length > 1) {
    tx.mergeCoins(primary, tokenCoinIdsToMerge.slice(1).map(id => tx.object(id)));
  }
  const [coinToSell] = tx.splitCoins(primary, [tx.pure.u64(BigInt(amountToSellRaw))]);

  tx.moveCall({
    target: `${HOPFUN_PKG}::curve::sell`,
    typeArguments: [coinType],
    arguments: [
      tx.object(curveId),             // &mut BondingCurve<T>
      tx.object(HOPFUN_LAUNCH_CFG),   // &LaunchConfig
      coinToSell,                     // Coin<T>
      tx.pure.u64(BigInt(minSuiOutMist)),
    ],
  });
  return tx;
}

export async function executeHopFunBuy({
  suiClient, signAndExecute, walletAddress, coinType, amountInMist,
  slippageBps = 500n, curveOverride = null, reservesOverride = null,
}) {
  const tx = await buildHopFunBuyTx({
    suiClient, walletAddress, coinType, amountInMist, slippageBps, curveOverride, reservesOverride,
  });
  return await signAndExecute(tx);
}

export async function executeHopFunSell({
  suiClient, signAndExecute, walletAddress, coinType,
  tokenCoinIdsToMerge, amountToSellRaw, minSuiOutMist = 0n, curveOverride = null,
}) {
  const tx = await buildHopFunSellTx({
    suiClient, walletAddress, coinType, tokenCoinIdsToMerge, amountToSellRaw, minSuiOutMist, curveOverride,
  });
  return await signAndExecute(tx);
}

// ════════════════════════════════════════════════════════════════
// Combined launchpad-list helper for the /launchpad menu
// ════════════════════════════════════════════════════════════════

/**
 * Returns { agent, odyssey, moonbags, hopfun } — best-effort, never throws.
 * Used by the /launchpad menu in bot.mjs.
 *
 * Pass `suiClient` to populate hopfun (which has no public REST API and
 * resolves entirely via on-chain event scans).
 */
export async function fetchAllLaunchpadTokens({ suiClient = null, limit = 10 } = {}) {
  const [agentRes, odyRes, mbRes, hfRes] = await Promise.allSettled([
    fetchAgentLaunchpadTokens(limit),
    fetchOdysseyTokens({ limit }),
    fetchMoonbagsTokens({ limit }),
    suiClient ? fetchHopFunTokens(suiClient, { limit }) : Promise.resolve([]),
  ]);
  return {
    agent:    agentRes.status === 'fulfilled' ? agentRes.value : [],
    odyssey:  odyRes.status   === 'fulfilled' ? odyRes.value   : [],
    moonbags: mbRes.status    === 'fulfilled' ? mbRes.value    : [],
    hopfun:   hfRes.status    === 'fulfilled' ? hfRes.value    : [],
    agentError:    agentRes.status === 'rejected' ? String(agentRes.reason?.message || agentRes.reason) : null,
    odysseyError:  odyRes.status   === 'rejected' ? String(odyRes.reason?.message   || odyRes.reason)   : null,
    moonbagsError: mbRes.status    === 'rejected' ? String(mbRes.reason?.message    || mbRes.reason)    : null,
    hopfunError:   hfRes.status    === 'rejected' ? String(hfRes.reason?.message    || hfRes.reason)    : null,
  };
}
