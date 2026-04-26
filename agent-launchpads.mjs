// ════════════════════════════════════════════════════════════════
// AGENT-LAUNCHPADS module — adds two launchpad integrations to the bot:
//
//   1. AGENT Launchpad (MemeLand v6.5b)
//      - Tokens like 007 are direct Cetus CLMM pools from day 1 (no bonding curve).
//      - This module is just a *discovery* layer — fetches token list from the
//        Railway backend and routes each token through the bot's existing
//        executeBuy / executeSell (which already supports Cetus).
//
//   2. Odyssey (theodyssey.fun)
//      - True bonding curve via moonbags::buy_exact_in_with_lock / moonbags::sell.
//      - Each token belongs to a specific moonbags package version. Each package
//        has TWO shared Configuration objects (moonbags + moonbags_token_lock)
//        that we auto-discover by inspecting one recent on-chain trade per pkg.
//      - Verified Apr 2026 against real tx 25rgfW7rZ2tSw19YhATchGNxUefnpuNSqqu71VLjhZLy
//        (SWORD buy on pkg 0xc87ab979...): Configuration object discovery works
//        and the buy_exact_in_with_lock signature is (Configuration mut,
//        TokenLockConfig ref, Coin<SUI>, min_out:u64, deadline:u64, &Clock,
//        &mut TxContext).
//
// Wire-up in bot.mjs (additions only — no existing line changes):
//
//   import {
//     AGENT_BACKEND_URL, ODYSSEY_API_URL,
//     fetchAgentLaunchpadTokens, fetchOdysseyTokens,
//     buildOdysseyBuyTx, buildOdysseySellTx,
//     isOdysseyToken,
//   } from './agent-launchpads.mjs';
//
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

/**
 * GET /memeland/tokens → list of AGENT launchpad tokens.
 * Returns up to `limit` tokens shaped as { coinType, name, symbol, image,
 * poolId, holders, marketCap, priceUsd, isAgent: true }.
 */
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
    onChainId: t.onChainId ?? t.tokenId ?? null,
    isAgent: true,
    source: 'AGENT',
  }));
}

// ════════════════════════════════════════════════════════════════
// 2. ODYSSEY — moonbags bonding curve
// ════════════════════════════════════════════════════════════════

/**
 * GET /api/tokens → list of Odyssey bonding-curve tokens.
 * Filters out completed (graduated) tokens by default — those trade on Cetus
 * and are handled by the bot's regular /buy flow.
 */
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
    pairType: t.pairType || 'SUI',     // 'SUI' or 'AIDA'
    pairToken: t.pairToken || 'SUI',
    progress: t.progress ?? 0,         // 0–100 toward graduation
    threshold: t.threshold ?? null,
    raised: t.realSuiRaised ?? t.realSuiSui ?? 0,
    marketCap: t.marketCap ?? null,
    priceUsd: t.currentPrice ?? null,
    isCompleted: !!t.isCompleted,
    isOdyssey: true,
    source: 'Odyssey',
  }));
}

// ─── In-process cache of discovered Configuration object IDs ───────
// Key:   moonbagsPackageId
// Value: { configId, tokenLockConfigId, discoveredAt }
const _odyConfigCache = new Map();
const ODY_CFG_TTL_MS = 30 * 60 * 1000;

/**
 * Discover the two shared Configuration object IDs for an Odyssey moonbags
 * package by inspecting one recent buy transaction.
 *
 * Returns { configId, tokenLockConfigId } where:
 *   configId           = mut shared moonbags::Configuration
 *   tokenLockConfigId  = immut shared moonbags_token_lock::Configuration
 *
 * Cached for 30 minutes per package.
 */
export async function getOdysseyConfigs(suiClient, packageId) {
  const cached = _odyConfigCache.get(packageId);
  if (cached && Date.now() - cached.discoveredAt < ODY_CFG_TTL_MS) return cached;

  // Query a recent TradedEventV2 emitted by this moonbags module
  const evRes = await suiClient.queryEvents({
    query: { MoveModule: { package: packageId, module: 'moonbags' } },
    limit: 5,
    order: 'descending',
  });

  for (const ev of evRes?.data || []) {
    if (!/Traded/i.test(String(ev.type || ''))) continue;
    const digest = ev.id?.txDigest;
    if (!digest) continue;
    try {
      const tx = await suiClient.getTransactionBlock({
        digest,
        options: { showInput: true },
      });
      const inputs = tx?.transaction?.data?.transaction?.inputs || [];
      const calls  = tx?.transaction?.data?.transaction?.transactions || [];

      // Find the moonbags::buy_exact_in_with_lock or sell call
      for (const t of calls) {
        const c = t.MoveCall;
        if (!c || c.module !== 'moonbags') continue;
        if (c.function !== 'buy_exact_in_with_lock' && c.function !== 'sell') continue;
        // Argument index → input index
        const args = c.arguments || [];
        const inpIdx0 = args[0]?.Input;       // configId (mut)
        const inpIdx1 = c.function === 'buy_exact_in_with_lock' ? args[1]?.Input : null;
        if (typeof inpIdx0 !== 'number') continue;
        const cfg = inputs[inpIdx0];
        if (!cfg || cfg.type !== 'object') continue;
        let tokenLockId = null;
        if (typeof inpIdx1 === 'number') {
          const tl = inputs[inpIdx1];
          if (tl?.type === 'object') tokenLockId = tl.objectId;
        }
        const out = {
          configId: cfg.objectId,
          tokenLockConfigId: tokenLockId,
          discoveredAt: Date.now(),
        };
        _odyConfigCache.set(packageId, out);
        return out;
      }
    } catch { /* try next event */ }
  }

  throw new Error(`Could not discover Odyssey Configuration objects for package ${packageId}`);
}

/**
 * Quick check: does this coin type belong to an Odyssey bonding-curve token?
 * Cached against the Odyssey API so it's a single network call per cache window.
 */
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
    } catch { /* keep stale on failure */ }
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

/**
 * Build a PTB that buys an Odyssey bonding-curve token with SUI.
 *
 * On-chain signature (verified from getNormalizedMoveModule + 5 successful txs):
 *   moonbags::buy_exact_in_with_lock<T>(
 *     cfg:        &mut Configuration,
 *     lockCfg:    &Configuration,
 *     suiCoin:    Coin<SUI>,    // must hold amount_in × ~1.03 (fee buffer)
 *     amount_in:  u64,          // exact SUI mist to swap
 *     min_out:    u64,          // minimum token units to receive
 *     clock:      &Clock,
 *   )
 * The bought tokens are transferred to tx.sender by the contract itself.
 */
export async function buildOdysseyBuyTx({
  suiClient,
  walletAddress,
  packageId,
  coinType,
  amountInMist,           // bigint or string — amount of SUI to actually swap
  minOutRaw = 0n,         // min token units out, 0 = accept any
  feeBufferBps = 300n,    // 3% over the swap amount to cover the protocol fee
}) {
  const cfg = await getOdysseyConfigs(suiClient, packageId);
  if (!cfg.tokenLockConfigId) {
    throw new Error('Could not discover Odyssey TokenLock Configuration');
  }

  const amountIn   = BigInt(amountInMist);
  // Ceil so we never underfund by 1 mist on tiny amounts
  const feeBuf     = (amountIn * BigInt(feeBufferBps) + 9999n) / 10000n;
  const coinTotal  = amountIn + feeBuf;

  const tx = new Transaction();
  tx.setSender(walletAddress);

  // Split a coin large enough to cover swap + fee buffer
  const [suiCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(coinTotal)]);

  tx.moveCall({
    target: `${packageId}::moonbags::buy_exact_in_with_lock`,
    typeArguments: [coinType],
    arguments: [
      tx.object(cfg.configId),            // mut Configuration
      tx.object(cfg.tokenLockConfigId),   // TokenLock Configuration
      suiCoin,                            // Coin<SUI>
      tx.pure.u64(amountIn),              // amount_in
      tx.pure.u64(BigInt(minOutRaw)),     // min_out
      tx.object(CLOCK_OBJ),               // Clock
    ],
  });

  return tx;
}

/**
 * Build a PTB that sells an Odyssey bonding-curve token for SUI.
 *
 * Calls: moonbags::sell<TokenT>(
 *   &mut Configuration, Coin<TokenT>, min_out:u64, &Clock, &mut TxContext)
 *
 * `tokenCoinIdsToMerge` is a list of owned Coin<TokenT> object IDs to merge
 * before splitting the exact `amountToSellRaw` to send into the sell call.
 */
export async function buildOdysseySellTx({
  suiClient,
  walletAddress,
  packageId,
  coinType,
  tokenCoinIdsToMerge,    // string[]  — at least one coin object ID
  amountToSellRaw,        // bigint    — amount in raw token units
  minSuiOutMist = 0n,     // bigint    — min SUI out in mist, 0 = accept any
}) {
  if (!Array.isArray(tokenCoinIdsToMerge) || !tokenCoinIdsToMerge.length) {
    throw new Error('No token coin objects provided to sell');
  }
  const cfg = await getOdysseyConfigs(suiClient, packageId);

  const tx = new Transaction();
  tx.setSender(walletAddress);

  // Merge all owned coins of this token type into the first one, then split
  // the exact amount we want to sell.
  const primary = tx.object(tokenCoinIdsToMerge[0]);
  if (tokenCoinIdsToMerge.length > 1) {
    tx.mergeCoins(primary, tokenCoinIdsToMerge.slice(1).map(id => tx.object(id)));
  }
  const [coinToSell] = tx.splitCoins(primary, [tx.pure.u64(BigInt(amountToSellRaw))]);

  tx.moveCall({
    target: `${packageId}::moonbags::sell`,
    typeArguments: [coinType],
    arguments: [
      tx.object(cfg.configId),         // mut shared Configuration
      coinToSell,                      // Coin<TokenT>
      tx.pure.u64(BigInt(minSuiOutMist)), // min_out (in SUI mist)
      tx.object(CLOCK_OBJ),
    ],
  });

  return tx;
}

/**
 * Convenience: execute an Odyssey buy end-to-end.
 * Caller must provide `signAndExecute` (e.g. a closure that uses suiClient
 * + the user's keypair). Returns { digest, effects, balanceChanges }.
 */
export async function executeOdysseyBuy({
  suiClient, signAndExecute, walletAddress,
  packageId, coinType, amountInMist, minOutRaw = 0n,
}) {
  const tx = await buildOdysseyBuyTx({
    suiClient, walletAddress, packageId, coinType, amountInMist, minOutRaw,
  });
  return await signAndExecute(tx);
}

export async function executeOdysseySell({
  suiClient, signAndExecute, walletAddress,
  packageId, coinType, tokenCoinIdsToMerge, amountToSellRaw, minSuiOutMist = 0n,
}) {
  const tx = await buildOdysseySellTx({
    suiClient, walletAddress, packageId, coinType,
    tokenCoinIdsToMerge, amountToSellRaw, minSuiOutMist,
  });
  return await signAndExecute(tx);
}

// ════════════════════════════════════════════════════════════════
// Combined launchpad-list helper for the /launchpad menu
// ════════════════════════════════════════════════════════════════

/**
 * Returns { agent: [...], odyssey: [...] } — best-effort, never throws.
 * Used by the /launchpad menu in bot.mjs.
 */
export async function fetchAllLaunchpadTokens({ limit = 10 } = {}) {
  const [agentRes, odyRes] = await Promise.allSettled([
    fetchAgentLaunchpadTokens(limit),
    fetchOdysseyTokens({ limit }),
  ]);
  return {
    agent:   agentRes.status   === 'fulfilled' ? agentRes.value   : [],
    odyssey: odyRes.status     === 'fulfilled' ? odyRes.value     : [],
    agentError:   agentRes.status   === 'rejected' ? String(agentRes.reason?.message || agentRes.reason) : null,
    odysseyError: odyRes.status     === 'rejected' ? String(odyRes.reason?.message || odyRes.reason) : null,
  };
}
