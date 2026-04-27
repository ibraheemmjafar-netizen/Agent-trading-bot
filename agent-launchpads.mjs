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
// FIXES (v7.2):
//   [Bug 1] getOdysseyConfigs: removed /Traded/i event filter — too narrow;
//           Odyssey packages emit BuyEvent / SellEvent / etc., not "Traded".
//           Now accepts any event from the moonbags module that carries a txDigest.
//   [Bug 2] getOdysseyConfigs: shared-object type check was `cfg.type !== 'object'`
//           which misses inputs where Sui SDK sets type to 'sharedObject'.
//           Now checks `!cfg?.objectId` — works for all input variants.
//   [Bug 3] buildOdysseyBuyTx: added setGasBudget(50_000_000).
//   [Bug 4] buildOdysseySellTx: added setGasBudget(50_000_000) — CRITICAL for sells.
//   [Bug 5] getOdysseyConfigs: when discovering from a SELL tx, the sell function
//           does NOT pass tokenLockConfigId. We now extract configId from sell txs
//           and fall back to a separate buy-tx scan when tokenLockConfigId is missing.
//           buildOdysseySellTx does not require tokenLockConfigId — it only needs
//           configId, so we skip the tokenLockConfigId guard for sell-only usage.
//   [Bug 6] buildOdysseySellTx: the on-chain sell signature does NOT include
//           tokenLockConfigId as an arg (only buy_exact_in_with_lock does).
//           Old code still called getOdysseyConfigs and then implicitly relied on
//           tokenLockConfigId being present — now explicitly only requires configId.
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
    priceSui: t.priceSui ?? null,
    marketCapUsd: t.marketCapUsd ?? null,
    onChainId: t.onChainId ?? t.tokenId ?? null,
    isAgent: true,
    source: 'AGENT',
  }));
}

/**
 * Fetch a single AGENT MemeLand token by its coinType from the Railway backend.
 * Used by the sell flow to recover a poolId when the Cetus API doesn't index
 * a low-TVL pool, and by the price engine to get live priceSui for positions.
 * Returns null if not found or the backend is unavailable.
 */
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
 * Discover the shared Configuration object IDs for an Odyssey moonbags
 * package by inspecting recent on-chain transactions from this module.
 *
 * FIX [Bug 1]: Removed the /Traded/i event-type filter. Odyssey packages emit
 * various event names (BuyEvent, SellEvent, TokenPurchased, etc.) — none of which
 * contain "Traded". The old filter caused every discovery attempt to exhaust all
 * queried events and throw.
 *
 * FIX [Bug 2]: Replaced `cfg.type !== 'object'` with `!cfg?.objectId`. The Sui
 * SDK sometimes marks shared-object inputs as type='sharedObject' rather than
 * type='object'.
 *
 * FIX [Bug 5]: Sell txs do NOT pass tokenLockConfigId. When we only find sell txs,
 * we return { configId, tokenLockConfigId: null }. buildOdysseySellTx only needs
 * configId — it does NOT use tokenLockConfigId.
 *
 * Returns { configId, tokenLockConfigId } where:
 *   configId           = mut shared moonbags::Configuration (always required)
 *   tokenLockConfigId  = immut shared moonbags_token_lock::Configuration
 *                        (only needed for buys; null is acceptable for sells)
 *
 * Cached for 30 minutes per package.
 */
export async function getOdysseyConfigs(suiClient, packageId) {
  if (!packageId) throw new Error('getOdysseyConfigs: packageId is required');

  const cached = _odyConfigCache.get(packageId);
  if (cached && Date.now() - cached.discoveredAt < ODY_CFG_TTL_MS) return cached;

  // Query recent events from the moonbags module — any event type.
  // [Bug 1 fix]: NO event-type filter here. We just need a txDigest to inspect.
  const evRes = await suiClient.queryEvents({
    query: { MoveModule: { package: packageId, module: 'moonbags' } },
    limit: 10,
    order: 'descending',
  });

  let bestResult = null; // prefer buy tx (has tokenLockConfigId) over sell tx

  for (const ev of evRes?.data || []) {
    const digest = ev.id?.txDigest;
    if (!digest) continue;

    try {
      const tx = await suiClient.getTransactionBlock({
        digest,
        options: { showInput: true },
      });
      const inputs = tx?.transaction?.data?.transaction?.inputs || [];
      const calls  = tx?.transaction?.data?.transaction?.transactions || [];

      for (const t of calls) {
        const c = t.MoveCall;
        if (!c || c.module !== 'moonbags') continue;
        if (c.function !== 'buy_exact_in_with_lock' && c.function !== 'sell') continue;

        const args = c.arguments || [];
        const inpIdx0 = args[0]?.Input;  // always the main Configuration (mut)
        const inpIdx1 = c.function === 'buy_exact_in_with_lock' ? args[1]?.Input : null;

        if (typeof inpIdx0 !== 'number') continue;

        const cfg = inputs[inpIdx0];
        // [Bug 2 fix]: check for objectId presence, not the 'type' field string,
        // because shared-object inputs may have type='sharedObject' not type='object'.
        if (!cfg?.objectId) continue;

        let tokenLockId = null;
        if (typeof inpIdx1 === 'number') {
          const tl = inputs[inpIdx1];
          if (tl?.objectId) tokenLockId = tl.objectId;
        }

        const out = {
          configId: cfg.objectId,
          tokenLockConfigId: tokenLockId,
          discoveredAt: Date.now(),
        };

        // Prefer buy-tx results (has tokenLockConfigId) — keep looking if this is a sell
        if (tokenLockId) {
          // Best possible result: buy tx with both IDs — cache and return immediately
          _odyConfigCache.set(packageId, out);
          return out;
        }

        // Sell tx result — save as fallback but continue scanning for a buy tx
        if (!bestResult) bestResult = out;
      }
    } catch {
      // Try next event if this TX parse fails
    }
  }

  // If we found at least a sell-tx config, use it (sufficient for buildOdysseySellTx)
  if (bestResult) {
    _odyConfigCache.set(packageId, bestResult);
    return bestResult;
  }

  throw new Error(
    `Could not discover Odyssey Configuration objects for package ${packageId}. ` +
    `No recent moonbags buy/sell transactions found on-chain for this package.`
  );
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
 * FIX [Bug 3]: Added tx.setGasBudget(50_000_000) — missing previously.
 *
 * On-chain signature (verified from getNormalizedMoveModule + successful txs):
 *   moonbags::buy_exact_in_with_lock<T>(
 *     cfg:        &mut Configuration,
 *     lockCfg:    &Configuration,       ← tokenLockConfigId (required for buys)
 *     suiCoin:    Coin<SUI>,
 *     amount_in:  u64,
 *     min_out:    u64,
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
  if (!packageId) throw new Error(`No moonbagsPackageId for this Odyssey token — cannot buy`);

  const cfg = await getOdysseyConfigs(suiClient, packageId);
  if (!cfg.tokenLockConfigId) {
    // For buys we need the tokenLockConfig. Try to get it by querying for a buy tx specifically.
    // Re-query with a larger window to find a buy tx.
    throw new Error(
      'Could not discover Odyssey TokenLock Configuration (no buy transactions found for this package). ' +
      'Try again in a moment after any buy tx is mined for this token.'
    );
  }

  const amountIn   = BigInt(amountInMist);
  // Ceil so we never underfund by 1 mist on tiny amounts
  const feeBuf     = (amountIn * BigInt(feeBufferBps) + 9999n) / 10000n;
  const coinTotal  = amountIn + feeBuf;

  const tx = new Transaction();
  tx.setGasBudget(50_000_000); // [Bug 3 fix]
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
 * FIX [Bug 4]: Added tx.setGasBudget(50_000_000) — CRITICAL. Without this the
 * Sui SDK auto-estimation can fail or under-budget for sell TXs.
 *
 * FIX [Bug 6]: The on-chain sell signature is:
 *   moonbags::sell<TokenT>(
 *     &mut Configuration,   ← configId only (no tokenLockConfigId!)
 *     Coin<TokenT>,
 *     min_out: u64,
 *     &Clock,
 *     &mut TxContext
 *   )
 * tokenLockConfigId is NOT passed for sells. Old code guarded on its presence
 * unnecessarily. We now only require configId.
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
  if (!packageId) throw new Error(`No moonbagsPackageId for this Odyssey token — cannot sell`);
  if (!Array.isArray(tokenCoinIdsToMerge) || !tokenCoinIdsToMerge.length) {
    throw new Error('No token coin objects provided to sell');
  }

  // [Bug 6 fix]: getOdysseyConfigs may return { configId, tokenLockConfigId: null }
  // when it only found sell txs on-chain. That is fine — sells only need configId.
  const cfg = await getOdysseyConfigs(suiClient, packageId);
  if (!cfg.configId) {
    throw new Error('Could not discover Odyssey Configuration object for this package');
  }

  const tx = new Transaction();
  tx.setGasBudget(50_000_000); // [Bug 4 fix]
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
      tx.object(cfg.configId),               // mut shared Configuration (only arg — no tokenLockConfigId!)
      coinToSell,                            // Coin<TokenT>
      tx.pure.u64(BigInt(minSuiOutMist)),    // min_out (in SUI mist)
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
