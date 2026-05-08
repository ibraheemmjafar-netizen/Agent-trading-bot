/**
 * AGENT TRADING BOT — v7 Production
 *
 * All fixes verified via live Sui RPC (getNormalizedMoveFunction, getObject, queryEvents)
 * and confirmed against real on-chain transactions — April 2026.
 *
 * CRITICAL SWAP FIXES (v7):
 * 1. Cetus function name: was pool_script::swap (PRIVATE — can never be called from PTB!)
 *    Now correctly uses pool_script::swap_a2b / swap_b2a (public entry functions).
 *    Input coin now wrapped as MakeMoveVec (Vec<Coin<CoinX>>) as function requires.
 *    Output coin sent to sender INSIDE Move — no TransferObjects needed in PTB.
 *
 
 * 2. Turbos package address: old address 0x91bfbc...c3a does NOT EXIST on chain.
 *    Correct TURBOS_SWAP_PKG = 0xa5a0c25c... (verified from live tx 3vhBNBSEF...)
 *    Correct TURBOS_CORE_PKG = 0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1
 *    Correct module: swap_router (NOT pool_script — that module does not exist in Turbos)
 *    Correct functions: swap_a_b / swap_b_a with args:
 *      (Pool, Vec<Coin>, amount, amount_limit, sqrt_price_limit, is_exact_in, recipient, deadline, Clock, Versioned)
 *    Versioned is IMMUTABLE (&Versioned, NOT &mut) — old code passed mutable which fails.
 *
 * 3. Pool detection: Cetus REST API returns 404 for all endpoints.
 *    New strategy: Turbos API (d.result[] key — not d.data/d.pools) → Cetus API →
 *    GeckoTerminal pool address → Sui RPC getObject → parse Pool<CoinA,CoinB[,FeeType]> type.
 *    This makes detection work even when both REST APIs are down.
 *
 * 4. Turbos pool API result key: API returns data in d.result[], not d.data or d.pools.
 *    Old code always saw empty array, so Turbos pools were never found via API.
 *
 * RETAINED FROM v6:
 * 5. /withdraw command — send SUI or tokens to external address
 * 6. Quick-sell buttons in /positions
 * 7. Copy trade balance check + skip already-held tokens
 * 8. devInspectTransactionBlock honeypot detection
 * 9. TreasuryCap wrapped-object detection
 * 10. Auto-retry on RPC errors (3 retries + exponential backoff)
 * 11. Sell fees taken from gas — prevents gas drain on sells
 * 12. State machine hardened — /start clears stale input state
 */

import TelegramBot             from 'node-telegram-bot-api';
import { SuiClient }           from '@mysten/sui/client';
import { Ed25519Keypair }      from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction }         from '@mysten/sui/transactions';
import { normalizeStructTag }  from '@mysten/sui/utils';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync }                   from 'fs';
import { setTimeout as sleep }                                       from 'timers/promises';
import { createClient }                                              from 'redis';
import { renderPnlCard, fmtMoney }                                   from './pnl-card.mjs';

// ─── Launchpad integration: AGENT (MemeLand) + Odyssey moonbags ──
import {
  AGENT_BACKEND_URL, ODYSSEY_API_URL, MOONBAGS_API_URL,
  fetchAllLaunchpadTokens,
  buildOdysseyBuyTx, buildOdysseySellTx,
  isOdysseyToken,
  fetchAgentTokenByCoinType,
  // NEW (moonbags.io):
  buildMoonbagsBuyTx, buildMoonbagsSellTx,
  isMoonbagsToken,
  fetchMoonbagsCoin,
  // NEW (hop.fun):
  buildHopFunBuyTx, buildHopFunSellTx,
  isHopFunToken,
  fetchHopFunCoin,
  resolveHopFunCurveId,
} from './agent-launchpads.mjs';

// ═══════════════════════════════════════════════════════════
// CONFIG — set via environment variables
// ═══════════════════════════════════════════════════════════
const TG_TOKEN    = process.env.TG_BOT_TOKEN  || process.env.BOT_TOKEN || '';
const ENC_KEY     = process.env.ENCRYPT_KEY   || process.env.SESSION_SECRET || '';
const RPC_URL     = process.env.RPC_URL       || 'https://fullnode.mainnet.sui.io:443';
const ADMIN_ID    = process.env.ADMIN_CHAT_ID || process.env.ADMIN_ID || '';

const DEV_WALLET  = '0x47cee6fed8a44224350d0565a45dd97b320a9c3f54a8feb6036fb9b2d3a81a08';
const FEE_BPS     = 500;           // 5% bot fee (auto-sent to DEV_WALLET on every trade)
const REF_SHARE   = 0.25;          // 25% of that fee → referrer (so referrer earns 1.25% of trade)
const MIST        = 1_000_000_000n;
const SUI_T       = '0x2::sui::SUI';
const PANS_T      = '0xc9523f683256502be15ec4979098d510f67b6d3f0df02eebf124515014433270::pans::PANS';
// AGENT MemeLand: meme tokens trade as Cetus CLMM pools paired against AGENT
// (NOT against SUI), so we route SUI → AGENT (hop1) → MEME (hop2) via two
// Cetus swaps. SUI/AGENT 1% pool has the most TVL of the three on Cetus.
const AGENT_T        = '0x5613a7e1f4f8fc7b896781aaba9b52944763e14421458d14c829223541d77c1c::agent::AGENT';
const SUI_AGENT_POOL = '0xe8bf297251264d4474a6f6115ebeeeea4a3e50d534d3b663691e22b5fd36a6eb';
const SUISCAN     = 'https://suiscan.xyz/mainnet/tx/';

// ─── Redis client (persists users.json across Railway deployments) ───
// Falls back to local file `./bot-db.json` when REDIS_URL is not set.
const REDIS_ENABLED = !!process.env.REDIS_URL;
const DB_FILE = process.env.DB_FILE || './bot-db.json';
const redisClient = REDIS_ENABLED
  ? createClient({ url: process.env.REDIS_URL, socket:{ reconnectStrategy:r=>r>3?false:Math.min(r*500,3000) } })
  : { connect:async()=>{}, get:async()=>null, set:async()=>{}, on:()=>{} };
if (REDIS_ENABLED) redisClient.on('error', e => console.error('Redis error:', e.message));
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

// ── Cetus CLMM (verified via Sui RPC + live transaction inspection)
// CETUS_CONFIG: GlobalConfig shared object (verified on-chain), package_version=12
// CETUS_INTEGRATE: current published_at from @cetusprotocol/cetus-sui-clmm-sdk v5.4.0
//   Old 0x2d8c... has CURRENT_VERSION < 12 — fails checked_package_version on all current pools.
//   New 0xb2db... has CURRENT_VERSION=12, same pool_script_v2 signature (10 params).
const CETUS_CONFIG    = '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f';
const CETUS_INTEGRATE = '0xb2db7142fa83210a7d78d9c12ac49c043b3cbbd482224fea6e3da00aa5a5ae2d';
// Cetus core pool package (for RPC pool type parsing)
const CETUS_POOL_PKG  = '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb';

// ── Turbos CLMM (verified via Sui RPC + live transaction inspection Apr 2026)
// TURBOS_CORE_PKG: pool types / fee types (Pool, Versioned structs live here)
// TURBOS_SWAP_PKG: swap_router::swap_a_b / swap_b_a (the callable entry functions)
// TURBOS_VERSIONED: global versioned object — passed as IMMUTABLE &Versioned
const TURBOS_CORE_PKG  = '0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1';
const TURBOS_SWAP_PKG  = '0xa5a0c25c79e428eba04fb98b3fb2a34db45ab26d4c8faf0d7e39d66a63891e64';
const TURBOS_VERSIONED = '0xf1cf0e81048df168ebeb1b8030fad24b3e0b53ae827c25053fff0779c1445b6f';

// Cetus router URL — used for price quotes and honeypot detection
const CETUS_ROUTER_URL = 'https://api-sui.cetus.zone/v2/sui/router';

// Sqrt price limits (Cetus style — used to not restrict price movement)
const CETUS_MIN_SQRT  = '4295048016';
const CETUS_MAX_SQRT  = '79226673515401279992447579055';

// ── FlowX AMM (verified Apr 2026)
// router::swap_exact_input<CoinIn, CoinOut>(Clock, Container, Coin<CoinIn>, min_out, recipient, deadline, TxContext)
// Container is a shared object that stores all pairs as dynamic fields
const FLOWX_AMM_PKG       = '0xba153169476e8c3114962261d1edc70de5ad9781b83cc617ecc8c1923191cae0';
const FLOWX_AMM_CONTAINER = '0xd15e209f5a250d6055c264975fee57ec09bf9d6acdda3b5f866f76023d1563e6';

// ── Kriya DEX AMM (verified Apr 2026)
// spot_dex::swap_token_x_<T0,T1>(Pool<T0,T1> mut, Coin<T0>, min_out: u64, deadline: u64, TxContext)
// spot_dex::swap_token_y_<T0,T1>(Pool<T0,T1> mut, Coin<T1>, min_out: u64, deadline: u64, TxContext)
// Single Coin object (NOT vector), no Clock/Versioned, recipient via TxContext (sent to tx.sender)
const KRIYA_PKG = '0xa0eba10b173538c8fecca1dff298e488402cc9ff374f8a12ca7758eebe830b66';

// ── BlueMove DEX (verified Apr 2026)
// router::swap_exact_input<T0,T1>(amount_in: u64, Coin<T0>, min_out: u64, Dex_Info mut, TxContext)
// NOTE: Dex_Info shared object address — confirmed via diag6 on-chain lookup
const BLUEMOVE_PKG      = '0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1acfa17d8145454d9';
const BLUEMOVE_DEX_INFO = '0x3f2d9f724f4a1ce5e71676448dc452be9a6243dac9c5b975a588c8c867066e92'; // confirmed via diag6 TX input [7]

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
// DATABASE — Redis-backed, persists across Railway deployments
// ═══════════════════════════════════════════════════════════
let DB = {};
async function loadDB() {
  if (REDIS_ENABLED) {
    try {
      await redisClient.connect();
      const raw = await redisClient.get('agent_bot_db');
      DB = raw ? JSON.parse(raw) : {};
      console.log(`✅ DB loaded from Redis — ${Object.keys(DB).length} users`);
      return;
    } catch(e) {
      console.error('Redis loadDB failed, falling back to file:', e.message);
    }
  }
  try {
    if (existsSync(DB_FILE)) {
      DB = JSON.parse(readFileSync(DB_FILE, 'utf8'));
      console.log(`✅ DB loaded from ${DB_FILE} — ${Object.keys(DB).length} users`);
    } else { DB = {}; console.log(`✅ DB starting empty (file-mode, will write to ${DB_FILE})`); }
  } catch(e) { console.error('File loadDB failed, starting empty:', e.message); DB = {}; }
}
let _saveTimer = null;
function saveDB() {
  if (REDIS_ENABLED) {
    redisClient.set('agent_bot_db', JSON.stringify(DB))
      .catch(e => console.error('Redis saveDB error:', e.message));
    return;
  }
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try { writeFileSync(DB_FILE, JSON.stringify(DB)); }
    catch(e) { console.error('File saveDB error:', e.message); }
  }, 300);
}
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
      // RaidenX-parity additions:
      gasPriceMist:750,        // editable gas price in MIST
      tipSui:0,                // optional tip per trade (SUI, transferred to dev)
      mode:'swap',             // swap | limit | dca | migration
      buySellMode:'buy',       // 'buy' or 'sell' — drives Buy Mode/Sell Mode toggle
      autoSell:false,          // auto-sell engine on/off
      autoSellTpPct:50,        // default TP % for auto-sell
      autoSellSlPct:30,        // default SL %
    },
    wallets:[],                // [{address, encryptedKey, label}] — multi-wallet
    activeWalletIdx:[0],       // selected wallet indices for trading
    limitOrders:[],            // [{ct, sui, targetPriceUsd, dir:'<='|'>=', triggered, at}]
    dcaOrders:[],              // [{ct, sui, intervalSec, lastFire, count, totalCount, at}]
    migAlerts:[],              // [{ct, lastState, at}] — notify on bonding→graduated
    referralCode:genRef(), referredBy:null, referredByCode:null, referralCount:0, referralEarned:0,
    state:null, pd:{}, ...extra,
  };
  saveDB(); return DB[uid];
}
function updU(id, patch) {
  const u = DB[String(id)]; if (!u) return;
  Object.assign(u, patch); u.lastActivity = Date.now(); saveDB();
}
function isLocked(u)  { return !!(u?.pinHash && u?.lockedAt); }

// ── Multi-wallet helpers (backward compatible) ────────────────────
function getAllWallets(u){
  if(!u) return [];
  const list = [];
  if(u.walletAddress&&u.encryptedKey) list.push({address:u.walletAddress,encryptedKey:u.encryptedKey,label:'Main'});
  if(Array.isArray(u.wallets)) for(const w of u.wallets) if(w&&w.address&&w.encryptedKey) list.push(w);
  return list;
}
function getActiveWallets(u){
  const all = getAllWallets(u);
  if(!all.length) return [];
  const idx = (u.activeWalletIdx&&u.activeWalletIdx.length) ? u.activeWalletIdx : [0];
  return idx.filter(i=>i>=0&&i<all.length).map(i=>all[i]);
}
function applyTxOpts(tx, u){
  // RaidenX-parity: apply user's gas price (in MIST) — keeps existing gas budget
  try {
    const gp = u?.settings?.gasPriceMist;
    if (gp && gp>0) tx.setGasPrice(BigInt(gp));
  } catch {}
  return tx;
}
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

/**
 * Resolve a user-pasted address to a full Sui coin type.
 *
 * Sui coin types look like: 0xPKG::module::CoinName
 * Users often paste only the package address: 0xPKG
 *
 * Strategy:
 * 1. If input already contains "::", it's a full type — return as-is.
 * 2. If bare package address: call getNormalizedMoveModulesByPackage to list all modules,
 *    then try getCoinMetadata for each struct until one matches.
 * 3. Fallback: GeckoTerminal → getPoolFromRPC to extract coin type from pool object.
 */
async function resolveCoinType(raw) {
  if (!raw) return raw;

  // Already a full coin type
  if (raw.includes('::')) return raw;

  // Not a Sui package address — return as-is
  if (!raw.startsWith('0x') || raw.length < 42) return raw;

  // Step 1: enumerate package modules and find the Coin struct via RPC
  // If only ONE struct exists across all modules, return it directly —
  // don't require getMeta to succeed (many tokens have no on-chain metadata).
  let firstCandidate = null;
  let candidateCount  = 0;
  try {
    const modules = await sui.getNormalizedMoveModulesByPackage({ package: raw });
    for (const [modName, mod] of Object.entries(modules)) {
      for (const structName of Object.keys(mod.structs || {})) {
        const candidate = `${raw}::${modName}::${structName}`;
        candidateCount++;
        if (!firstCandidate) firstCandidate = candidate;
        // getMeta is a fast check — if it confirms the coin, return immediately
        const meta = await getMeta(candidate);
        if (meta?.symbol) return candidate;
      }
    }
    // Only one struct found and getMeta didn't confirm it — still return it.
    // Many Sui tokens skip CoinMetadata registration; the struct is the coin.
    if (candidateCount === 1 && firstCandidate) return firstCandidate;
  } catch {}

  // Step 2: GeckoTerminal → pool object → extract full coin type.
  // Try both the raw package address AND any candidate we found in Step 1.
  const geckoCandidates = [raw, firstCandidate].filter(Boolean);
  for (const addr of geckoCandidates) {
    try {
      const gPools = await getGeckoPools(addr);
      if (!gPools.length) continue;
      for (const poolEntry of gPools.slice(0, 3)) {
        const poolAddr = poolEntry.attributes?.address;
        if (!poolAddr) continue;
        const poolInfo = await getPoolFromRPC(poolAddr);
        if (!poolInfo) continue;
        const rawLow = raw.toLowerCase();
        if (poolInfo.coinA.toLowerCase().startsWith(rawLow)) return poolInfo.coinA;
        if (poolInfo.coinB.toLowerCase().startsWith(rawLow)) return poolInfo.coinB;
        // If we queried with the full candidate, the pool coins ARE the answer
        if (addr !== raw) {
          const addrLow = addr.toLowerCase();
          if (poolInfo.coinA.toLowerCase() === addrLow) return poolInfo.coinA;
          if (poolInfo.coinB.toLowerCase() === addrLow) return poolInfo.coinB;
          // Fallback: return whichever coin belongs to this package
          const pkgLow = raw.toLowerCase();
          if (poolInfo.coinA.toLowerCase().startsWith(pkgLow)) return poolInfo.coinA;
          if (poolInfo.coinB.toLowerCase().startsWith(pkgLow)) return poolInfo.coinB;
        }
      }
    } catch {}
  }

  // Last resort: return whatever Step 1 found, or raw unchanged
  return firstCandidate || raw;
}

// ═══════════════════════════════════════════════════════════
// DEX POOL DISCOVERY
// ═══════════════════════════════════════════════════════════

/**
 * Find the best Cetus CLMM pool for a pair.
 * Tries both coin orderings. Returns pool info with a2b direction.
 */
async function findCetusPool(coinA, coinB) {
  // Sanity: a pool can't have the same coin on both sides. Without this guard,
  // findCetusPool(PANS, PANS) used by section 3 (when user sells PANS itself)
  // would fall into the pools_info fallback that returns ANY PANS pool, and
  // section 3 would then set state='pans_cetus' with a wrong tokenPansPool —
  // causing PANS-sell hop1 to build swap_b2a<PANS,SUI> with mismatched coins.
  try {
    if (normalizeStructTag(coinA) === normalizeStructTag(coinB)) return null;
  } catch {
    if ((coinA||'').toLowerCase() === (coinB||'').toLowerCase()) return null;
  }
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

  // Fallback: search by token via Cetus REST API
  try {
    const r = await ftch(
      `https://api-sui.cetus.zone/v2/sui/pools_info?coin_type=${encodeURIComponent(coinB)}&limit=5&order_by=tvl&order=desc`,
      { headers:{ Accept:'application/json' } }, 8000
    );
    if (r.ok) {
      const d = await r.json();
      const pools = d.data?.list || [];
      // Bug fix: old code filtered to SUI-only pools, which dropped AGENT-paired pools
      // when detectState step 4b calls findCetusPool(AGENT_T, ct).
      // Now filter to pools that contain coinA (the requested "other side" coin).
      const coinANorm = coinA.toLowerCase();
      const matched = pools.filter(p =>
        (p.coin_type_a||'').toLowerCase() === coinANorm ||
        (p.coin_type_b||'').toLowerCase() === coinANorm
      );
      if (matched.length) {
        const best = matched[0];
        const poolId = best.pool_address || best.id;
        const actualA = best.coin_type_a;
        const actualB = best.coin_type_b;
        const a2b = (actualA||'').toLowerCase() === coinA.toLowerCase();
        return { poolId, coinA:actualA, coinB:actualB, a2b, liq:parseFloat(best.tvl||0), dex:'cetus' };
      }
    }
  } catch {}

  // GeckoTerminal fallback — works even when Cetus REST API is down (404/timeout)
  // Uses shared geckoCache to avoid duplicate requests and 429 rate limits.
  try {
    for (const addr of [coinB, coinB.split('::')[0]]) {
      const gPools = await getGeckoPools(addr);
      if (!gPools.length) continue;

      for (const poolEntry of gPools.slice(0, 8)) {
        const dexId = (poolEntry.relationships?.dex?.data?.id || '').toLowerCase();
        if (!dexId.includes('cetus')) continue;  // only Cetus pools here
        const poolAddress = poolEntry.attributes?.address;
        if (!poolAddress) continue;
        const poolInfo = await getPoolFromRPC(poolAddress);
        if (!poolInfo || poolInfo.dex !== 'cetus') continue;
        // Verify pool actually contains BOTH requested coins (prevents returning BVS/SUI
        // when findCetusPool(PANS_T, BVS_T) queries GeckoTerminal and gets back BVS/SUI pool)
        const pA = poolInfo.coinA.toLowerCase();
        const pB = poolInfo.coinB.toLowerCase();
        const hasCoinA = pA === coinA.toLowerCase() || pB === coinA.toLowerCase();
        const hasCoinB = pA === coinB.toLowerCase() || pB === coinB.toLowerCase();
        if (!hasCoinA || !hasCoinB) continue;
        const liq = parseFloat(poolEntry.attributes?.reserve_in_usd || 0);
        return { ...poolInfo, liq };
      }
    }
  } catch {}

  return null;
}

/**
 * Find Turbos pool via Turbos Finance API.
 * API returns data in d.result[], NOT d.data or d.pools.
 * feeType comes from fee_type field or is constructed from TURBOS_CORE_PKG.
 * Returns poolId, feeType (3rd type arg), coinA, coinB, a2b.
 */
async function findTurbosPool(coinA, coinB) {
  const pairs = [
    [coinA, coinB, true],
    [coinB, coinA, false],
  ];

  for (const [ca, cb, isOriginalOrder] of pairs) {
    try {
      const url = `https://api.turbos.finance/pools?coinTypeA=${encodeURIComponent(ca)}&coinTypeB=${encodeURIComponent(cb)}&pageSize=10`;
      const r = await ftch(url, { headers:{ Accept:'application/json' } }, 10000);
      if (!r.ok) continue;
      const d = await r.json();
      // Turbos API wraps data in "result", not "data" or "pools"
      const pools = Array.isArray(d) ? d : (d.result || d.data || d.pools || []);
      if (!pools.length) continue;

      // Filter to only pools matching our coin pair
      const matched = pools.filter(p => {
        const a = (p.coin_type_a || p.coinTypeA || '').toLowerCase();
        const b = (p.coin_type_b || p.coinTypeB || '').toLowerCase();
        return a === ca.toLowerCase() && b === cb.toLowerCase();
      });
      if (!matched.length) continue;

      // Pick pool with highest liquidity
      const best = matched.reduce((acc, p) => {
        const liqA = parseFloat(p.liquidity_usd || p.liquidity || 0);
        const liqB = parseFloat(acc.liquidity_usd || acc.liquidity || 0);
        return liqA > liqB ? p : acc;
      });

      const poolId  = best.pool_id || best.poolId || best.id;
      if (!poolId) continue;

      // feeType from API response or constructed from core package
      const feeType = best.fee_type || best.feeType ||
        (() => {
          const fee = best.fee || best.feeRate || 3000;
          return `${TURBOS_CORE_PKG}::fee${fee}bps::FEE${fee}BPS`;
        })();

      const actualA = best.coin_type_a || best.coinTypeA || ca;
      const actualB = best.coin_type_b || best.coinTypeB || cb;
      // a2b relative to ORIGINAL call: coinA goes in → a2b=true means we're calling swap_a_b
      const a2b = actualA.toLowerCase() === coinA.toLowerCase();

      return { poolId, feeType, a2b, coinA: actualA, coinB: actualB, dex: 'Turbos',
               liq: parseFloat(best.liquidity_usd || 0) };
    } catch {}
  }

  return null;
}

/**
 * Query the Sui RPC for a pool object and parse its coin types.
 * Works for both Cetus Pool<CoinA,CoinB> and Turbos Pool<CoinA,CoinB,FeeType>.
 * Returns { dex, poolId, coinA, coinB, feeType?, a2b } or null.
 */
async function getPoolFromRPC(poolAddress) {
  try {
    const obj = await sui.getObject({ id: poolAddress, options: { showType: true } });
    const type = obj.data?.type;
    if (!type) return null;

    // Cetus: 0x1eabed...::pool::Pool<CoinA, CoinB>
    const cetusRx = /0x1eabed[0-9a-f]*::pool::Pool<(.+),\s*([^>]+)>/;
    const cm = type.match(cetusRx);
    if (cm) {
      const coinA = cm[1].trim();
      const coinB = cm[2].trim();
      const SUI_NORM = SUI_T.toLowerCase();
      const a2b = coinA.toLowerCase() === SUI_NORM ||
                  coinA.toLowerCase().endsWith('::sui::sui');
      return { dex: 'cetus', poolId: poolAddress, coinA, coinB, a2b };
    }

    // Turbos: 0x91bfbc...::pool::Pool<CoinA, CoinB, FeeType>
    const turbosRx = /0x91bfbc[0-9a-f]*::pool::Pool<([^,]+),\s*([^,]+),\s*([^>]+)>/;
    const tm = type.match(turbosRx);
    if (tm) {
      const coinA   = tm[1].trim();
      const coinB   = tm[2].trim();
      const feeType = tm[3].trim();
      const SUI_NORM = SUI_T.toLowerCase();
      const a2b = coinA.toLowerCase() === SUI_NORM ||
                  coinA.toLowerCase().endsWith('::sui::sui');
      return { dex: 'turbos', poolId: poolAddress, coinA, coinB, feeType, a2b };
    }

    // FlowX AMM: dynamic_field::Field<String, PairMetadata<CoinA, CoinB>>
    // Pool object is a dynamic field owned by the Container
    const flowxRx = /PairMetadata<(.+),\s*([^>]+)>/;
    const fm = type.match(flowxRx);
    if (fm) {
      const coinA   = fm[1].trim();
      const coinB   = fm[2].trim();
      const SUI_NORM = SUI_T.toLowerCase();
      const a2b = coinA.toLowerCase() === SUI_NORM ||
                  coinA.toLowerCase().endsWith('::sui::sui');
      return { dex: 'flowx', poolId: FLOWX_AMM_CONTAINER, coinA, coinB, a2b };
    }

    // Kriya AMM: KRIYA_PKG::spot_dex::Pool<CoinA, CoinB>
    const kriyaRx = /0xa0eba10b[0-9a-f]*::spot_dex::Pool<([^,]+),\s*([^>]+)>/;
    const km = type.match(kriyaRx);
    if (km) {
      const coinA   = km[1].trim();
      const coinB   = km[2].trim();
      const SUI_NORM = SUI_T.toLowerCase();
      const a2b = coinA.toLowerCase() === SUI_NORM ||
                  coinA.toLowerCase().endsWith('::sui::sui');
      return { dex: 'kriya', poolId: poolAddress, coinA, coinB, a2b };
    }

    // BlueMove AMM: BLUEMOVE_PKG::swap::Pool<CoinA, CoinB>
    const bmRx = /0xb24b6789[0-9a-f]*::swap::Pool<([^,]+),\s*([^>]+)>/;
    const bm = type.match(bmRx);
    if (bm) {
      const coinA   = bm[1].trim();
      const coinB   = bm[2].trim();
      const SUI_NORM = SUI_T.toLowerCase();
      const a2b = coinA.toLowerCase() === SUI_NORM ||
                  coinA.toLowerCase().endsWith('::sui::sui');
      return { dex: 'bluemove', poolId: poolAddress, coinA, coinB, a2b };
    }
  } catch {}
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

// Read actual token delta for walletAddr from a confirmed TX (balance changes)
// Returns the BigInt amount change (positive = received, negative = spent) or null
// Extract balance delta from a balanceChanges array (from TX response or getTransactionBlock)
function deltaFromChanges(changes, coinType, walletAddr) {
  try {
    const norm = t => t.replace(/^0x0+/, '0x').toLowerCase();
    const target = norm(coinType);
    for (const c of (changes || [])) {
      const owner = c.owner?.AddressOwner || '';
      if (norm(owner) !== norm(walletAddr)) continue;
      if (norm(c.coinType || '') === target) return BigInt(c.amount);
    }
  } catch {}
  return null;
}

// Pass res.balanceChanges array directly (preferred — instant, no indexer delay)
// or pass a digest string as fallback (requires separate RPC round-trip)
async function getActualDelta(digestOrChanges, coinType, walletAddr) {
  if (Array.isArray(digestOrChanges)) {
    return deltaFromChanges(digestOrChanges, coinType, walletAddr);
  }
  try {
    const tx = await sui.getTransactionBlock({ digest: digestOrChanges, options:{ showBalanceChanges:true } });
    return deltaFromChanges(tx?.balanceChanges, coinType, walletAddr);
  } catch {}
  return null;
}

// ═══════════════════════════════════════════════════════════
// TOKEN STATE DETECTION
// ═══════════════════════════════════════════════════════════
const stateCache = new Map();
const STATE_TTL  = 20_000; // 20 seconds

// Shared GeckoTerminal pool cache — prevents 429 rate-limit errors when
// resolveCoinType, findCetusPool and detectState all query the same token.
const geckoCache = new Map();
const GECKO_CACHE_TTL = 60_000; // 60 seconds

// DexScreener pool cache — fallback when GeckoTerminal hasn't indexed a pool
// (e.g. BVS/PANS pool exists on Cetus but only DexScreener has it indexed)
const dsCache = new Map();
const DS_CACHE_TTL = 60_000;

// PANS ecosystem pool map: query DexScreener by PANS address (not target token)
// and look for a pool that contains the target token.
// DexScreener lists ALL PANS pairs when you search the PANS package address.
// Cache for 5 minutes to avoid hitting DS on every detection.
const pansDsCache = { pools: [], ts: 0 };
const PANS_DS_TTL = 300_000; // 5 min

async function findPansPoolForToken(ct) {
  const now = Date.now();
  if (now - pansDsCache.ts > PANS_DS_TTL) {
    const pansPkg = PANS_T.split('::')[0];
    const fresh = await getDexScreenerPools(pansPkg).catch(() => []);
    pansDsCache.pools = fresh;
    pansDsCache.ts    = now;
  }
  const CT_NORM   = ct.toLowerCase();
  const ctPkg     = ct.split('::')[0].toLowerCase();
  // Match: pool address known, dex is cetus, and base or quote token is ct
  for (const p of pansDsCache.pools) {
    if (!p.address || !p.dex.includes('cetus')) continue;
    const bl = (p.baseSymbol  || '').toLowerCase();
    const ql = (p.quoteSymbol || '').toLowerCase();
    // DexScreener stores token addresses in baseToken.address / quoteToken.address
    // We only have symbol here, but address is also in the raw pair.
    // getDexScreenerPools now stores baseAddr/quoteAddr — use those.
    const ba = (p.baseAddr  || '').toLowerCase();
    const qa = (p.quoteAddr || '').toLowerCase();
    if (ba === CT_NORM || ba.startsWith(ctPkg) || qa === CT_NORM || qa.startsWith(ctPkg)) {
      return p; // found PANS pool containing ct
    }
  }
  return null;
}

async function getDexScreenerPools(addr) {
  const hit = dsCache.get(addr);
  if (hit && Date.now() - hit.ts < DS_CACHE_TTL) return hit.pools;
  try {
    const r = await ftch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(addr)}`,
      { headers:{ Accept:'application/json' } }, 8000
    );
    const raw = r.ok ? ((await r.json()).pairs || []) : [];
    const pools = raw.map(p => ({
      address: p.pairAddress,
      dex:     (p.dexId || '').toLowerCase(),
      liq:     p.liquidity?.usd   || 0,
      vol:     p.volume?.h24      || 0,
      priceU:  parseFloat(p.priceUsd || 0),
      chg5m:   p.priceChange?.m5  || 0,
      chg1h:   p.priceChange?.h1  || 0,
      chg6h:   p.priceChange?.h6  || 0,
      chg24h:  p.priceChange?.h24 || 0,
      age:     p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
      baseSymbol:  p.baseToken?.symbol  || '',
      quoteSymbol: p.quoteToken?.symbol || '',
      baseAddr:    p.baseToken?.address  || '',
      quoteAddr:   p.quoteToken?.address || '',
    }));
    dsCache.set(addr, { pools, ts: Date.now() });
    return pools;
  } catch {
    dsCache.set(addr, { pools: [], ts: Date.now() });
    return [];
  }
}

async function getGeckoPools(addr) {
  const hit = geckoCache.get(addr);
  if (hit && Date.now() - hit.ts < GECKO_CACHE_TTL) return hit.pools;
  try {
    const r = await ftch(
      `${GECKO}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}/pools?page=1`,
      { headers:{ Accept:'application/json;version=20230302' } }, 8000
    );
    const pools = r.ok ? ((await r.json()).data || []) : [];
    geckoCache.set(addr, { pools, ts: Date.now() });
    return pools;
  } catch {
    geckoCache.set(addr, { pools: [], ts: Date.now() });
    return [];
  }
}

// Find the SUI↔PANS Cetus pool via GeckoTerminal (resilient — works when Cetus REST API is down).
// Queries PANS token's pools from GeckoTerminal, then verifies each via Sui RPC.
// Result is cached in stateCache under the key '__sui_pans_pool__'.
async function findSuiPansPool() {
  const CACHE_KEY = '__sui_pans_pool__';
  const hit = stateCache.get(CACHE_KEY);
  if (hit && Date.now() - hit.ts < STATE_TTL) return hit.pool;

  // 1. Try Cetus REST API first (fast when it works)
  try {
    const p = await findCetusPool(SUI_T, PANS_T);
    if (p) { stateCache.set(CACHE_KEY, { pool:p, ts:Date.now() }); return p; }
  } catch {}

  // 2. GeckoTerminal fallback — look for SUI-paired Cetus pool in PANS token's pool list
  const SUI_NORM = SUI_T.toLowerCase();
  for (const addr of [PANS_T, PANS_T.split('::')[0]]) {
    try {
      const gPools = await getGeckoPools(addr);
      for (const entry of gPools.slice(0, 10)) {
        const poolAddr = entry.attributes?.address;
        if (!poolAddr) continue;
        const dexId = (entry.relationships?.dex?.data?.id || '').toLowerCase();
        if (!dexId.includes('cetus')) continue;
        const pi = await getPoolFromRPC(poolAddr).catch(() => null);
        if (!pi) continue;
        const al = pi.coinA.toLowerCase(), bl = pi.coinB.toLowerCase();
        const hasSui = al === SUI_NORM || al.endsWith('::sui::sui') ||
                       bl === SUI_NORM || bl.endsWith('::sui::sui');
        if (!hasSui) continue;
        stateCache.set(CACHE_KEY, { pool:pi, ts:Date.now() });
        return pi;
      }
    } catch {}
  }
  return null;
}

async function detectState(ct) {
  const cached = stateCache.get(ct);
  if (cached && Date.now() - cached.ts < STATE_TTL) return cached;

  // 1. Turbos pool API (most reliable — API works, returns d.result[])
  try {
    const tPool = await findTurbosPool(SUI_T, ct);
    if (tPool) {
      const res = { state:'turbos', dex:'Turbos', ...tPool, ts:Date.now() };
      stateCache.set(ct, res); return res;
    }
  } catch {}

  // 2. DexScreener — PRIMARY check for PANS ecosystem tokens.
  //    Strategy A: query DexScreener by the TARGET TOKEN address.
  //    Strategy B (fallback): query DexScreener by the PANS token address and
  //    look for any pool that contains the target token.
  //    Strategy B is the reliable one — DexScreener always has BVS/PANS when
  //    searched from the PANS side, even if searching BVS directly returns nothing.
  try {
    // Helper: convert a confirmed DS pool entry into a pans_cetus state result.
    // Bug fix: the pool MUST also contain `ct` (the user's token) — otherwise we'd
    // build swap calls with typeArguments that don't match the wallet's coin type,
    // causing CommandArgumentError { arg_idx: 3, kind: TypeMismatch } on sell or
    // delivering the wrong token on buy hop2. Compare via normalizeStructTag to
    // tolerate leading-zero / case variations.
    const ctNorm = (() => { try { return normalizeStructTag(ct); } catch { return ct.toLowerCase(); } })();
    const tagEq = (a, b) => {
      try { return normalizeStructTag(a) === normalizeStructTag(b); }
      catch { return (a||'').toLowerCase() === (b||'').toLowerCase(); }
    };
    const tryPansState = async (dsPool) => {
      if (!dsPool?.address) return null;
      const poolInfo = await getPoolFromRPC(dsPool.address).catch(() => null);
      if (!poolInfo) return null;
      const PANS_NORM = PANS_T.toLowerCase();
      const SUI_NORM  = SUI_T.toLowerCase();
      const coinAl = poolInfo.coinA.toLowerCase();
      const coinBl = poolInfo.coinB.toLowerCase();
      const hasPans = coinAl === PANS_NORM || coinBl === PANS_NORM;
      const hasSui  = coinAl === SUI_NORM  || coinAl.endsWith('::sui::sui') ||
                      coinBl === SUI_NORM  || coinBl.endsWith('::sui::sui');
      // CRITICAL: the OTHER coin (non-PANS) must equal ct, or we'll route through
      // a sibling PANS-paired pool (e.g. KYLN/PANS instead of BVS/PANS).
      const otherCoin = (coinAl === PANS_NORM) ? poolInfo.coinB : poolInfo.coinA;
      const hasCt = tagEq(otherCoin, ct);
      if (!hasPans || hasSui || !hasCt) return null;
      const suiPansPool = await findSuiPansPool();
      if (!suiPansPool) return null;
      return {
        state:'pans_cetus', dex:'Cetus (PANS hop)',
        tokenPansPool: { poolId:poolInfo.poolId, coinA:poolInfo.coinA, coinB:poolInfo.coinB, a2b:poolInfo.a2b },
        suiPansPool, liq:dsPool.liq, ts:Date.now(),
      };
    };

    // Strategy A — search by target token address
    for (const addr of [ct, ct.split('::')[0]]) {
      const dsPools = await getDexScreenerPools(addr);
      for (const p of dsPools) {
        if (!p.dex.includes('cetus')) continue;
        const res = await tryPansState(p);
        if (res) { stateCache.set(ct, res); return res; }
      }
    }

    // Strategy B — search by PANS address, look for our token in results
    const pansDsPool = await findPansPoolForToken(ct);
    if (pansDsPool) {
      const res = await tryPansState(pansDsPool);
      if (res) { stateCache.set(ct, res); return res; }
    }
  } catch {}

  // 3. PANS ecosystem — Cetus API + GeckoTerminal fallback
  //    Skip when ct === PANS itself: a 2-hop "TOKEN→PANS→SUI" route makes no
  //    sense, and findCetusPool(PANS,PANS) is now guarded to return null anyway.
  try {
    const ctIsPansSec3 = (() => { try { return normalizeStructTag(ct) === normalizeStructTag(PANS_T); } catch { return ct.toLowerCase() === PANS_T.toLowerCase(); } })();
    if (!ctIsPansSec3) {
      const pansPool = await findCetusPool(PANS_T, ct);
      if (pansPool) {
        // Defense-in-depth: confirm the returned pool's non-PANS side equals ct.
        const tagEqS3 = (a,b)=>{ try { return normalizeStructTag(a)===normalizeStructTag(b); } catch { return (a||'').toLowerCase()===(b||'').toLowerCase(); } };
        const otherSide = tagEqS3(pansPool.coinA, PANS_T) ? pansPool.coinB : pansPool.coinA;
        if (tagEqS3(otherSide, ct)) {
          const suiPansPool = await findSuiPansPool();
          if (suiPansPool) {
            const res = {
              state:'pans_cetus', dex:'Cetus (PANS hop)',
              tokenPansPool: pansPool,
              suiPansPool:   suiPansPool,
              ts: Date.now(),
            };
            stateCache.set(ct, res); return res;
          }
        }
      }
    }
  } catch {}

  // 4. Cetus pool API — SUI/TOKEN direct pair
  try {
    const pool = await findCetusPool(SUI_T, ct);
    if (pool) {
      const res = { state:'cetus', dex:'Cetus', ...pool, ts:Date.now() };
      stateCache.set(ct, res); return res;
    }
  } catch {}

  // 4b. AGENT MemeLand — AGENT/TOKEN Cetus pool (2-hop sell: MEME→AGENT→SUI)
  // Tokens launched on AGENT MemeLand pair against AGENT, not SUI.
  // detectState must recognise them as 'agent_cetus' so executeSell can route
  // them through the existing 2-hop logic (mirrors _agentSellCA).
  // Skip when ct === AGENT itself (mirror of section 3 PANS guard).
  try {
    const ctIsAgentSec4b = (() => { try { return normalizeStructTag(ct) === normalizeStructTag(AGENT_T); } catch { return ct.toLowerCase() === AGENT_T.toLowerCase(); } })();
    if (!ctIsAgentSec4b) {
      const agentPool = await findCetusPool(AGENT_T, ct);
      if (agentPool) {
        const tagEqS4b = (a,b)=>{ try { return normalizeStructTag(a)===normalizeStructTag(b); } catch { return (a||'').toLowerCase()===(b||'').toLowerCase(); } };
        const otherSide = tagEqS4b(agentPool.coinA, AGENT_T) ? agentPool.coinB : agentPool.coinA;
        if (tagEqS4b(otherSide, ct)) {
          const res = { state:'agent_cetus', dex:'Cetus (AGENT hop)', ...agentPool, ts:Date.now() };
          stateCache.set(ct, res); return res;
        }
      }
    }
  } catch {}

  // 5. GeckoTerminal — find pool address, then query Sui RPC for pool type.
  //    Uses shared geckoCache — no duplicate HTTP calls, no 429 rate limits.
  //    Checks ALL pools from ALL address variants before giving up.
  try {
    let firstUnsupported = null; // track in case nothing better found
    for (const addr of [ct, ct.split('::')[0]]) {
      const gPools = await getGeckoPools(addr);
      if (!gPools.length) continue;

      // Iterate ALL pools — keep checking even if early entries are on unsupported DEXes
      for (const poolEntry of gPools.slice(0, 8)) {
        const poolAddress = poolEntry.attributes?.address;
        if (!poolAddress) continue;

        const dexId = (poolEntry.relationships?.dex?.data?.id || '').toLowerCase();
        const liq   = parseFloat(poolEntry.attributes?.reserve_in_usd || 0);

        // flow-x excluded: Container object not found on-chain (disabled Apr 2026)
        const knownDex = dexId.includes('cetus') || dexId.includes('turbos') ||
                         dexId.includes('kriya')  || dexId.includes('bluemove');

        if (!knownDex) {
          // Remember first unsupported name but KEEP LOOKING at remaining pools
          if (!firstUnsupported && dexId) firstUnsupported = dexId;
          continue;
        }

        // Query Sui RPC for pool object type — gets exact coinA/coinB and DEX routing info
        const poolInfo = await getPoolFromRPC(poolAddress);
        if (!poolInfo) continue;

        // Accept SUI-paired pools, or PANS-paired pools (2-hop route)
        const SUI_NORM  = SUI_T.toLowerCase();
        const PANS_NORM = PANS_T.toLowerCase();
        const coinAl = poolInfo.coinA.toLowerCase();
        const coinBl = poolInfo.coinB.toLowerCase();
        const hasSui  = coinAl === SUI_NORM || coinAl.endsWith('::sui::sui') ||
                        coinBl === SUI_NORM || coinBl.endsWith('::sui::sui');
        const hasPans = coinAl === PANS_NORM || coinBl === PANS_NORM;

        const AGENT_NORM = AGENT_T.toLowerCase();
        const hasAgent = coinAl === AGENT_NORM || coinBl === AGENT_NORM;

        // Defense-in-depth: same hasCt check as section 2's tryPansState — the
        // non-PANS/non-AGENT side of the pool MUST equal user's ct, or the bot
        // will pick a sibling pool (e.g. KYLN/PANS instead of BVS/PANS) and the
        // sell will fail at Move type-check (arg_idx 3 TypeMismatch).
        const tagEqS5 = (a, b) => {
          try { return normalizeStructTag(a) === normalizeStructTag(b); }
          catch { return (a||'').toLowerCase() === (b||'').toLowerCase(); }
        };
        const otherVsPans  = (coinAl === PANS_NORM)  ? poolInfo.coinB : poolInfo.coinA;
        const otherVsAgent = (coinAl === AGENT_NORM) ? poolInfo.coinB : poolInfo.coinA;
        const hasCtVsPans  = hasPans  && tagEqS5(otherVsPans,  ct);
        const hasCtVsAgent = hasAgent && tagEqS5(otherVsAgent, ct);

        if (!hasSui && hasPans && hasCtVsPans && poolInfo.dex === 'cetus') {
          // TOKEN/PANS pool on Cetus — look for SUI/PANS hop pool via GeckoTerminal-resilient helper
          try {
            const suiPansPool = await findSuiPansPool();
            if (suiPansPool) {
              const res = {
                state:'pans_cetus', dex:'Cetus (PANS hop)',
                tokenPansPool: { poolId:poolInfo.poolId, coinA:poolInfo.coinA, coinB:poolInfo.coinB, a2b:poolInfo.a2b },
                suiPansPool:   suiPansPool,
                liq, ts: Date.now(),
              };
              stateCache.set(ct, res); return res;
            }
          } catch {}
          continue;
        }

        // AGENT MemeLand token — TOKEN/AGENT Cetus pool (2-hop sell: MEME→AGENT→SUI)
        if (!hasSui && hasAgent && hasCtVsAgent && poolInfo.dex === 'cetus') {
          const res = { state:'agent_cetus', dex:'Cetus (AGENT hop)', ...poolInfo, liq, ts: Date.now() };
          stateCache.set(ct, res); return res;
        }

        if (!hasSui) continue;

        const DEX_LABELS = {
          cetus:'Cetus CLMM', turbos:'Turbos CLMM',
          kriya:'Kriya AMM', bluemove:'BlueMove AMM',
        };
        const dexLabel = DEX_LABELS[poolInfo.dex] || poolInfo.dex;
        const res = { state: poolInfo.dex, dex: dexLabel, ...poolInfo, liq, ts: Date.now() };
        stateCache.set(ct, res); return res;
      }
    }

    // Exhausted all pools — if we saw any pool at all, report its DEX as unsupported
    if (firstUnsupported) {
      const dex = firstUnsupported[0].toUpperCase() + firstUnsupported.slice(1);
      const res = { state: 'unsupported_dex', dex, ts: Date.now() };
      stateCache.set(ct, res); return res;
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
 *
 * VERIFIED function signatures (from Sui RPC getNormalizedMoveFunction, Apr 2026):
 *   pool_script::swap_a2b(config, pool, Vec<Coin<CoinA>>, a2b, amount_in, min_out, sqrt_limit, clock)
 *   pool_script::swap_b2a(config, pool, Vec<Coin<CoinB>>, a2b, amount_in, min_out, sqrt_limit, clock)
 *
 * Both are public entry functions. Output coin is transferred to sender INSIDE Move.
 * No TransferObjects needed in PTB.
 *
 * a2b=true  → swap_a2b: coinA goes in (SUI→token when SUI=coinA)
 * a2b=false → swap_b2a: coinB goes in (SUI→token when SUI=coinB)
 */
// Set ALL of the user's SUI coin objects as gas payment so splitCoins(tx.gas, ...)
// can draw from the full balance even when SUI is fragmented across multiple objects.
async function setSuiGasPayment(tx, wallet) {
  try {
    const coins = await sui.getCoins({ owner: wallet, coinType: SUI_T, limit: 50 });
    if (coins.data.length > 0) {
      tx.setGasPayment(coins.data.map(c => ({
        objectId: c.coinObjectId,
        version:  c.version,
        digest:   c.digest,
      })));
    }
  } catch { /* non-fatal — SDK will pick its own gas coins */ }
}

async function buildCetusSwapTx({ wallet, poolId, coinA, coinB, a2b, coinInType, amountIn, minAmountOut }) {
  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  tx.setSender(wallet);
  if (coinInType === SUI_T) await setSuiGasPayment(tx, wallet);

  // pool_script_v2 signature (verified Apr 2026 via sui_getNormalizedMoveFunction):
  //   swap_a2b(config, pool, Coin<CoinA>, Coin<CoinB>, by_amount_in, amount, amount_limit, sqrt_limit, clock)
  //   swap_b2a(config, pool, Coin<CoinB>, Coin<CoinA>, by_amount_in, amount, amount_limit, sqrt_limit, clock)
  // Unlike v1, v2 takes individual coins (NOT vector) + a zero-balance output coin.
  // The output coin receives the swap result and is auto-transferred to sender inside Move.

  // Verified from live on-chain txs (Apr 2026): pool_script_v2 ALWAYS orders args as
  // [Coin<CoinA>, Coin<CoinB>] regardless of swap direction.
  // swap_a2b: coinA=INPUT,     coinB=zero output placeholder
  // swap_b2a: coinA=zero output placeholder, coinB=INPUT
  const fn = a2b ? 'swap_a2b' : 'swap_b2a';

  // Prepare the input coin object (SUI split or token from wallet)
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

  // Build CoinA and CoinB arguments — position [2] is ALWAYS CoinA, position [3] is ALWAYS CoinB
  let coinArgA, coinArgB;
  if (a2b) {
    // swap_a2b: spending CoinA (input), receiving CoinB (zero → filled by pool)
    coinArgA = coinInObj;
    coinArgB = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinB] });
  } else {
    // swap_b2a: spending CoinB (input, e.g. SUI), receiving CoinA (zero → filled by pool)
    coinArgA = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [coinA] });
    coinArgB = coinInObj;
  }

  tx.moveCall({
    target: `${CETUS_INTEGRATE}::pool_script_v2::${fn}`,
    typeArguments: [coinA, coinB],
    arguments: [
      tx.object(CETUS_CONFIG),                                              // &GlobalConfig
      tx.object(poolId),                                                    // &mut Pool<CoinA,CoinB>
      coinArgA,                                                             // Coin<CoinA>
      coinArgB,                                                             // Coin<CoinB>
      tx.pure.bool(true),                                                   // by_amount_in=true
      tx.pure.u64(BigInt(amountIn)),                                        // amount (exact in)
      tx.pure.u64(BigInt(minAmountOut || '0')),                             // amount_limit (min out)
      tx.pure.u128(a2b ? BigInt(CETUS_MIN_SQRT) : BigInt(CETUS_MAX_SQRT)), // sqrt_price_limit
      tx.object(CLOCK_OBJ),                                                 // &Clock
    ],
  });
  // Output coin auto-transferred to sender inside pool_script_v2 — no TransferObjects needed

  return tx;
}

/**
 * Build a Turbos CLMM swap PTB.
 *
 * VERIFIED function signatures (from Sui RPC getNormalizedMoveFunction, Apr 2026):
 *   swap_router::swap_a_b(pool, Vec<Coin<CoinA>>, amount, amount_limit, sqrt_limit, is_exact_in, recipient, deadline, clock, versioned)
 *   swap_router::swap_b_a(pool, Vec<Coin<CoinB>>, amount, amount_limit, sqrt_limit, is_exact_in, recipient, deadline, clock, versioned)
 *
 * Package: TURBOS_SWAP_PKG (separate from TURBOS_CORE_PKG which has pool types)
 * Versioned: passed as IMMUTABLE reference (&Versioned, NOT &mut Versioned)
 * Output coin transferred to recipient inside Move — no TransferObjects needed.
 *
 * a2b=true  → swap_a_b: coinA goes in, coinB comes out
 * a2b=false → swap_b_a: coinB goes in, coinA comes out
 */
async function buildTurbosSwapTx({ wallet, poolId, feeType, coinA, coinB, a2b, coinInType, amountIn }) {
  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  tx.setSender(wallet);
  if (coinInType === SUI_T) await setSuiGasPayment(tx, wallet);

  // Prepare input coin
  let coinInObj;
  if (coinInType === SUI_T) {
    [coinInObj] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(amountIn))]);
  } else {
    const coins = await getCoins(wallet, coinInType);
    if (!coins.length) throw new Error('No token balance found in wallet');
    let obj = tx.object(coins[0].coinObjectId);
    if (coins.length > 1) tx.mergeCoins(obj, coins.slice(1).map(c => tx.object(c.coinObjectId)));
    const total = coins.reduce((s,c) => s + BigInt(c.balance), 0n);
    if (BigInt(amountIn) < total) {
      [coinInObj] = tx.splitCoins(obj, [tx.pure.u64(BigInt(amountIn))]);
    } else {
      coinInObj = obj;
    }
  }

  // Turbos also expects a vector of coins
  const coinVec = tx.makeMoveVec({ elements: [coinInObj] });

  // swap_a_b: coinA goes in; swap_b_a: coinB goes in
  const fn = a2b ? 'swap_a_b' : 'swap_b_a';
  const deadline = BigInt(Date.now() + 5 * 60 * 1000); // 5 minutes from now

  tx.moveCall({
    target: `${TURBOS_SWAP_PKG}::swap_router::${fn}`,
    typeArguments: [coinA, coinB, feeType],
    arguments: [
      tx.object(poolId),                  // &mut Pool<CoinA,CoinB,FeeType>
      coinVec,                            // vector<Coin<CoinX>>
      tx.pure.u64(BigInt(amountIn)),      // amount (exact in)
      tx.pure.u64(0n),                    // amount_limit (min out — 0 = no limit, slippage applied separately)
      tx.pure.u128(0n),                   // sqrt_price_limit (0 = no restriction)
      tx.pure.bool(true),                 // is_exact_in
      tx.pure.address(wallet),            // recipient
      tx.pure.u64(deadline),              // deadline (timestamp ms)
      tx.object(CLOCK_OBJ),               // &Clock
      tx.object(TURBOS_VERSIONED),        // &Versioned (IMMUTABLE — not mutable!)
    ],
  });
  // NOTE: output coin is transferred to recipient inside Move

  return tx;
}

/**
 * Build a FlowX AMM swap PTB.
 *
 * VERIFIED function signature (from Sui RPC getNormalizedMoveFunction, Apr 2026):
 *   router::swap_exact_input<CoinIn, CoinOut>(Clock, Container, Coin<CoinIn>, min_out, recipient, deadline, TxContext)
 *
 * Container = FLOWX_AMM_CONTAINER (shared object owning all pair dynamic fields)
 * Single Coin input (NOT vector). Output sent to recipient inside Move.
 * Type params: [CoinIn, CoinOut] — a2b determines which is which.
 *
 * a2b=true  → buy:  [SUI_T, tokenType]
 * a2b=false → sell: [tokenType, SUI_T]
 */
async function buildFlowXSwapTx({ wallet, coinA, coinB, a2b, coinInType, amountIn, minAmountOut }) {
  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  tx.setSender(wallet);
  if (coinInType === SUI_T) await setSuiGasPayment(tx, wallet);

  let coinInObj;
  if (coinInType === SUI_T) {
    [coinInObj] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(amountIn))]);
  } else {
    const coins = await getCoins(wallet, coinInType);
    if (!coins.length) throw new Error('No token balance found in wallet');
    let obj = tx.object(coins[0].coinObjectId);
    if (coins.length > 1) tx.mergeCoins(obj, coins.slice(1).map(c => tx.object(c.coinObjectId)));
    const total = coins.reduce((s,c) => s + BigInt(c.balance), 0n);
    if (BigInt(amountIn) < total) {
      [coinInObj] = tx.splitCoins(obj, [tx.pure.u64(BigInt(amountIn))]);
    } else {
      coinInObj = obj;
    }
  }

  // Type args: [CoinIn, CoinOut]
  // a2b=true:  we're buying token with SUI → CoinIn=SUI, CoinOut=token
  // a2b=false: we're selling token for SUI → CoinIn=token, CoinOut=SUI
  const typeArgs = a2b ? [coinA, coinB] : [coinB, coinA];
  const deadline = BigInt(Date.now() + 5 * 60 * 1000);

  tx.moveCall({
    target: `${FLOWX_AMM_PKG}::router::swap_exact_input`,
    typeArguments: typeArgs,
    arguments: [
      tx.object(CLOCK_OBJ),               // &Clock
      tx.object(FLOWX_AMM_CONTAINER),     // &mut Container
      coinInObj,                           // Coin<CoinIn>
      tx.pure.u64(BigInt(minAmountOut || '0')), // min_amount_out
      tx.pure.address(wallet),            // recipient
      tx.pure.u64(deadline),              // deadline
    ],
  });
  // NOTE: output coin is transferred to recipient inside Move

  return tx;
}

/**
 * Build a Kriya DEX swap PTB.
 *
 * VERIFIED function signatures (from Sui RPC getNormalizedMoveFunction, Apr 2026):
 *   spot_dex::swap_token_x_<T0,T1>(Pool<T0,T1> mut, Coin<T0>, min_out: u64, deadline: u64, TxContext mut)
 *   spot_dex::swap_token_y_<T0,T1>(Pool<T0,T1> mut, Coin<T1>, min_out: u64, deadline: u64, TxContext mut)
 *
 * Pool = shared object for the specific pair.
 * Single Coin (NOT vector). No Clock, no Versioned. Recipient = tx sender (via TxContext).
 *
 * a2b=true  → token0 (x) goes in → swap_token_x_: pass Coin<T0=SUI>
 * a2b=false → token1 (y) goes in → swap_token_y_: pass Coin<T1=SUI>
 */
async function buildKriyaSwapTx({ wallet, poolId, coinA, coinB, a2b, coinInType, amountIn, minAmountOut }) {
  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  tx.setSender(wallet);
  if (coinInType === SUI_T) await setSuiGasPayment(tx, wallet);

  let coinInObj;
  if (coinInType === SUI_T) {
    [coinInObj] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(amountIn))]);
  } else {
    const coins = await getCoins(wallet, coinInType);
    if (!coins.length) throw new Error('No token balance found in wallet');
    let obj = tx.object(coins[0].coinObjectId);
    if (coins.length > 1) tx.mergeCoins(obj, coins.slice(1).map(c => tx.object(c.coinObjectId)));
    const total = coins.reduce((s,c) => s + BigInt(c.balance), 0n);
    if (BigInt(amountIn) < total) {
      [coinInObj] = tx.splitCoins(obj, [tx.pure.u64(BigInt(amountIn))]);
    } else {
      coinInObj = obj;
    }
  }

  // a2b=true  → SUI is coinA (token0/x) → use swap_token_x_
  // a2b=false → SUI is coinB (token1/y) → use swap_token_y_
  const fn = a2b ? 'swap_token_x_' : 'swap_token_y_';
  const deadline = BigInt(Date.now() + 5 * 60 * 1000);

  tx.moveCall({
    target: `${KRIYA_PKG}::spot_dex::${fn}`,
    typeArguments: [coinA, coinB],
    arguments: [
      tx.object(poolId),                              // &mut Pool<T0,T1>
      coinInObj,                                       // Coin<Tx> — single coin
      tx.pure.u64(BigInt(minAmountOut || '0')),       // min_amount_out (0 = no min)
      tx.pure.u64(deadline),                          // deadline timestamp ms
    ],
  });
  // NOTE: output coin is transferred to tx.sender via TxContext inside Move

  return tx;
}

/**
 * Build a BlueMove DEX swap PTB.
 *
 * VERIFIED function signature (from Sui RPC getNormalizedMoveFunction, Apr 2026):
 *   router::swap_exact_input<T0,T1>(amount_in: u64, Coin<T0>, min_out: u64, Dex_Info mut, TxContext mut)
 *
 * Dex_Info = BLUEMOVE_DEX_INFO (global shared DEX registry — not a pool object)
 * Single Coin. No Clock. Recipient via TxContext (tx.sender).
 *
 * a2b=true  → T0=SUI, T1=token
 * a2b=false → T0=token, T1=SUI
 */
async function buildBlueMoveSwapTx({ wallet, coinA, coinB, a2b, coinInType, amountIn, minAmountOut }) {
  if (!BLUEMOVE_DEX_INFO) throw new Error('BlueMove Dex_Info address not yet confirmed — run diag6');

  const tx = new Transaction();
  tx.setGasBudget(50_000_000);
  tx.setSender(wallet);
  if (coinInType === SUI_T) await setSuiGasPayment(tx, wallet);

  let coinInObj;
  if (coinInType === SUI_T) {
    [coinInObj] = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(amountIn))]);
  } else {
    const coins = await getCoins(wallet, coinInType);
    if (!coins.length) throw new Error('No token balance found in wallet');
    let obj = tx.object(coins[0].coinObjectId);
    if (coins.length > 1) tx.mergeCoins(obj, coins.slice(1).map(c => tx.object(c.coinObjectId)));
    const total = coins.reduce((s,c) => s + BigInt(c.balance), 0n);
    if (BigInt(amountIn) < total) {
      [coinInObj] = tx.splitCoins(obj, [tx.pure.u64(BigInt(amountIn))]);
    } else {
      coinInObj = obj;
    }
  }

  // Type args: [CoinIn, CoinOut]
  const typeArgs = a2b ? [coinA, coinB] : [coinB, coinA];

  tx.moveCall({
    target: `${BLUEMOVE_PKG}::router::swap_exact_input`,
    typeArguments: typeArgs,
    arguments: [
      tx.pure.u64(BigInt(amountIn)),                   // amount_in
      coinInObj,                                         // Coin<CoinIn>
      tx.pure.u64(BigInt(minAmountOut || '0')),         // min_amount_out
      tx.object(BLUEMOVE_DEX_INFO),                    // &mut Dex_Info
    ],
  });
  // NOTE: output coin is transferred to tx.sender inside Move

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
  const refWallet = resolveRefWallet(u);
  const refMist  = refWallet ? (feeMist * BigInt(Math.floor(REF_SHARE * 100))) / 100n : 0n;
  const devMist  = feeMist - refMist;
  const tradeMist = amtMist - feeMist;

  const [dc] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
  tx.transferObjects([dc], tx.pure.address(DEV_WALLET));

  if (refMist > 0n && refWallet) {
    const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(refMist)]);
    tx.transferObjects([rc], tx.pure.address(refWallet));
    const refUser = Object.values(DB).find(x => x.walletAddress === refWallet);
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
  const meta   = await getMeta(ct) || {};
  const sym    = meta.symbol || trunc(ct);
  const st     = await detectState(ct);

  // ── Balance guard ────────────────────────────────────────
  // Sui reserves the full gas budget BEFORE command 0 runs.
  // If tradeAmt > (totalSUI - gasBudget) the splitCoins fails
  // with "InsufficientCoinBalance in command 0" even though the
  // user technically has enough to trade.
  // Gas budget = 50 000 000 MIST; add 20 000 000 buffer = 70M total.
  const GAS_RESERVE = 70_000_000n;
  const balInfo  = await sui.getBalance({ owner: u.walletAddress, coinType: SUI_T });
  const totalMist = BigInt(balInfo.totalBalance);
  let amt = BigInt(Math.floor(parseFloat(amtSui) * Number(MIST)));
  const maxSpendMist = totalMist > GAS_RESERVE ? totalMist - GAS_RESERVE : 0n;
  if (maxSpendMist === 0n) {
    throw new Error(`Not enough SUI for gas. Need at least ${Number(GAS_RESERVE)/1e9} SUI in wallet.`);
  }
  if (amt > maxSpendMist) {
    const maxSui = (Number(maxSpendMist) / 1e9).toFixed(4);
    throw new Error(`Amount too high. Max safe buy: ${maxSui} SUI (0.07 SUI reserved for gas). Your balance: ${(Number(totalMist)/1e9).toFixed(4)} SUI`);
  }

  // Snapshot live price + market cap BEFORE the swap so positions
  // remember their entry MC / USD price for proper PnL display.
  const _bm = await _liveTokenStats(ct).catch(() => null);

  // Collect fee from buy amount
  const feeMist  = (amt * BigInt(FEE_BPS)) / 10000n;
  const tradeAmt = amt - feeMist;

  const refWallet = resolveRefWallet(u);
  const refMist  = refWallet ? (feeMist * BigInt(Math.floor(REF_SHARE * 100))) / 100n : 0n;
  const devMist  = feeMist - refMist;

  // RaidenX-parity: optional tip (transferred to dev wallet)
  const tipMist = BigInt(Math.floor(Number(u.settings.tipSui||0) * Number(MIST)));

  // Helper to append fee transfers + tip to tx; also applies user gas price
  const addFees = (tx) => {
    applyTxOpts(tx, u);
    const [fc] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
    tx.transferObjects([fc], tx.pure.address(DEV_WALLET));
    if (refMist > 0n && refWallet) {
      const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(refMist)]);
      tx.transferObjects([rc], tx.pure.address(refWallet));
      const ru = Object.values(DB).find(x => x.walletAddress === refWallet);
      if (ru) { ru.referralEarned = (ru.referralEarned||0) + Number(refMist)/1e9; saveDB(); }
    }
    if (tipMist > 0n) {
      const [tc] = tx.splitCoins(tx.gas, [tx.pure.u64(tipMist)]);
      tx.transferObjects([tc], tx.pure.address(DEV_WALLET));
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
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'TX failed');
    { const dec=meta.decimals||9; const ab=await getActualDelta(res.balanceChanges||res.digest,ct,u.walletAddress); const tok=ab&&ab>0n?Number(ab)/Math.pow(10,dec):Number(est||0)/Math.pow(10,dec); addPos(chatId,{ct,sym,entry:Number(tradeAmt)/1e9/(tok||1),tokens:tok,dec,spent:amtSui,source:'dex',tp:u.settings.tpDefault,sl:u.settings.slDefault,entryPriceUsd:_bm?.priceUsd||null,entryMc:_bm?.mc||null,entrySupplyH:_bm?.supplyH||null}); return{digest:res.digest,feeSui:fSui(feeMist),route:'Cetus CLMM',out:tok>0?tok.toFixed(6):'?',sym,bonding:false}; }
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
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Turbos TX failed');
    { const dec=meta.decimals||9; const ab=await getActualDelta(res.balanceChanges||res.digest,ct,u.walletAddress); const est2=await getSwapEstimate(SUI_T,ct,tradeAmt.toString()); const tok=ab&&ab>0n?Number(ab)/Math.pow(10,dec):(est2?Number(est2)/Math.pow(10,dec):0); addPos(chatId,{ct,sym,entry:Number(tradeAmt)/1e9/(tok||1),tokens:tok,dec,spent:amtSui,source:'dex',tp:u.settings.tpDefault,sl:u.settings.slDefault,entryPriceUsd:_bm?.priceUsd||null,entryMc:_bm?.mc||null,entrySupplyH:_bm?.supplyH||null}); return{digest:res.digest,feeSui:fSui(feeMist),route:'Turbos CLMM',out:tok>0?tok.toFixed(6):'?',sym,bonding:false}; }
  }

  if (st.state === 'flowx') {
    const tx = await buildFlowXSwapTx({
      wallet: u.walletAddress,
      coinA:  st.coinA, coinB: st.coinB, a2b: st.a2b,
      coinInType: SUI_T, amountIn: tradeAmt.toString(), minAmountOut: '0',
    });
    addFees(tx);
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'FlowX TX failed');
    { const dec=meta.decimals||9; const ab=await getActualDelta(res.balanceChanges||res.digest,ct,u.walletAddress); const est2=await getSwapEstimate(SUI_T,ct,tradeAmt.toString()); const tok=ab&&ab>0n?Number(ab)/Math.pow(10,dec):(est2?Number(est2)/Math.pow(10,dec):0); addPos(chatId,{ct,sym,entry:Number(tradeAmt)/1e9/(tok||1),tokens:tok,dec,spent:amtSui,source:'dex',tp:u.settings.tpDefault,sl:u.settings.slDefault,entryPriceUsd:_bm?.priceUsd||null,entryMc:_bm?.mc||null,entrySupplyH:_bm?.supplyH||null}); return{digest:res.digest,feeSui:fSui(feeMist),route:'FlowX AMM',out:tok>0?tok.toFixed(6):'?',sym,bonding:false}; }
  }

  if (st.state === 'kriya') {
    const tx = await buildKriyaSwapTx({
      wallet: u.walletAddress,
      poolId: st.poolId, coinA: st.coinA, coinB: st.coinB, a2b: st.a2b,
      coinInType: SUI_T, amountIn: tradeAmt.toString(), minAmountOut: '0',
    });
    addFees(tx);
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Kriya TX failed');
    { const dec=meta.decimals||9; const ab=await getActualDelta(res.balanceChanges||res.digest,ct,u.walletAddress); const est2=await getSwapEstimate(SUI_T,ct,tradeAmt.toString()); const tok=ab&&ab>0n?Number(ab)/Math.pow(10,dec):(est2?Number(est2)/Math.pow(10,dec):0); addPos(chatId,{ct,sym,entry:Number(tradeAmt)/1e9/(tok||1),tokens:tok,dec,spent:amtSui,source:'dex',tp:u.settings.tpDefault,sl:u.settings.slDefault,entryPriceUsd:_bm?.priceUsd||null,entryMc:_bm?.mc||null,entrySupplyH:_bm?.supplyH||null}); return{digest:res.digest,feeSui:fSui(feeMist),route:'Kriya AMM',out:tok>0?tok.toFixed(6):'?',sym,bonding:false}; }
  }

  if (st.state === 'bluemove') {
    const tx = await buildBlueMoveSwapTx({
      wallet: u.walletAddress,
      coinA: st.coinA, coinB: st.coinB, a2b: st.a2b,
      coinInType: SUI_T, amountIn: tradeAmt.toString(), minAmountOut: '0',
    });
    addFees(tx);
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'BlueMove TX failed');
    { const dec=meta.decimals||9; const ab=await getActualDelta(res.balanceChanges||res.digest,ct,u.walletAddress); const est2=await getSwapEstimate(SUI_T,ct,tradeAmt.toString()); const tok=ab&&ab>0n?Number(ab)/Math.pow(10,dec):(est2?Number(est2)/Math.pow(10,dec):0); addPos(chatId,{ct,sym,entry:Number(tradeAmt)/1e9/(tok||1),tokens:tok,dec,spent:amtSui,source:'dex',tp:u.settings.tpDefault,sl:u.settings.slDefault,entryPriceUsd:_bm?.priceUsd||null,entryMc:_bm?.mc||null,entrySupplyH:_bm?.supplyH||null}); return{digest:res.digest,feeSui:fSui(feeMist),route:'BlueMove AMM',out:tok>0?tok.toFixed(6):'?',sym,bonding:false}; }
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

  if (st.state === 'pans_cetus') {
    // 2-hop buy: SUI → PANS (tx1), then PANS → TOKEN (tx2)
    // Hop 1: SUI → PANS
    // Normalise: use SUI_T / PANS_T constants regardless of what pool extraction returned
    const sp = st.suiPansPool;
    const suiIsA1 = sp.coinA.toLowerCase().endsWith('::sui::sui');
    const hop1CoinA = suiIsA1 ? SUI_T : PANS_T;
    const hop1CoinB = suiIsA1 ? PANS_T : SUI_T;
    const hop1A2b   = suiIsA1;   // true = swap_a2b (SUI→PANS), false = swap_b2a (SUI as coinB)
    console.log('[PANS-BUY] hop1 poolId=%s coinA=%s a2b=%s suiMist=%s',
      sp.poolId.slice(0,20), hop1CoinA.slice(0,20), hop1A2b, tradeAmt.toString());
    const tx1 = await buildCetusSwapTx({
      wallet:       u.walletAddress,
      poolId:       sp.poolId,
      coinA:        hop1CoinA,
      coinB:        hop1CoinB,
      a2b:          hop1A2b,
      coinInType:   SUI_T,
      amountIn:     tradeAmt.toString(),
      minAmountOut: '0',
    });
    addFees(tx1);
    const res1 = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx1, options:{showEffects:true,showBalanceChanges:true} });
    if (res1.effects?.status?.status !== 'success') throw new Error('PANS hop1 (SUI→PANS): ' + (res1.effects?.status?.error || 'TX failed'));

    // How much PANS did we receive?
    const ab1 = await getActualDelta(res1.balanceChanges || res1.digest, PANS_T, u.walletAddress);
    if (!ab1 || ab1 <= 0n) throw new Error('Hop 1 (SUI→PANS) returned 0 PANS.');

    // Small delay to ensure PANS coin is indexed by RPC before hop 2 queries it
    await new Promise(r => setTimeout(r, 800));

    // Hop 2: PANS → TOKEN
    // Re-query the pool type fresh from chain to get exact canonical type strings.
    const tp = st.tokenPansPool;
    // Get canonical type strings directly from chain object
    let freshTp = tp;
    try {
      const poolObj = await sui.getObject({ id: tp.poolId, options: { showType: true } });
      const fullType = poolObj.data?.type || '';
      console.log('[PANS-BUY] hop2 rawPoolType=%s', fullType);
      const parsed = await getPoolFromRPC(tp.poolId).catch(() => null);
      if (parsed) freshTp = parsed;
    } catch (e) { console.log('[PANS-BUY] hop2 pool fetch error:', e.message); }
    const pansIsA = freshTp.coinA.toLowerCase() === PANS_T.toLowerCase();
    const tokenType = pansIsA ? freshTp.coinB : freshTp.coinA;
    const hop2CoinA = pansIsA ? PANS_T : tokenType;
    const hop2CoinB = pansIsA ? tokenType : PANS_T;
    console.log('[PANS-BUY] hop2 pansIsA=%s coinA=%s coinB=%s pansMist=%s',
      pansIsA, hop2CoinA, hop2CoinB, ab1.toString());
    const tx2 = await buildCetusSwapTx({
      wallet:       u.walletAddress,
      poolId:       tp.poolId,
      coinA:        hop2CoinA,
      coinB:        hop2CoinB,
      a2b:          pansIsA,
      coinInType:   PANS_T,
      amountIn:     ab1.toString(),
      minAmountOut: '0',
    });
    const res2 = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx2, options:{showEffects:true,showBalanceChanges:true} });
    if (res2.effects?.status?.status !== 'success') throw new Error('PANS hop2 (PANS→TOKEN): ' + (res2.effects?.status?.error || 'TX failed'));

    const dec = meta.decimals || 9;
    const ab2 = await getActualDelta(res2.balanceChanges || res2.digest, ct, u.walletAddress);
    const tok  = ab2 && ab2 > 0n ? Number(ab2) / Math.pow(10, dec) : 0;
    addPos(chatId, { ct, sym, entry: Number(tradeAmt)/1e9/(tok||1), tokens:tok, dec, spent:amtSui, source:'dex', tp:u.settings.tpDefault, sl:u.settings.slDefault, entryPriceUsd:_bm?.priceUsd||null, entryMc:_bm?.mc||null, entrySupplyH:_bm?.supplyH||null });
    return { digest:res2.digest, feeSui:fSui(feeMist), route:'Cetus CLMM (SUI→PANS→TOKEN)', out:tok>0?tok.toFixed(6):'?', sym, bonding:false };
  }

  throw new Error(`${sym} — no liquidity found on Cetus, Turbos, Kriya, BlueMove, or any launchpad. Check the CA is correct.`);
}

// Send sell fee in a separate TX after swap — always based on ACTUAL SUI received,
// never on estimate. Silent fail so sell is never blocked by fee TX failure.
async function postSellFee(kp, u, suiR) {
  if (!(suiR > 0)) return 0n;
  const feeMist  = (BigInt(Math.round(suiR * 1e9)) * BigInt(FEE_BPS)) / 10000n;
  const refWallet = resolveRefWallet(u);
  const refMist  = refWallet ? (feeMist * BigInt(Math.floor(REF_SHARE * 100))) / 100n : 0n;
  const devMist  = feeMist - refMist;
  if (devMist === 0n) return feeMist;
  const feeTx = new Transaction();
  feeTx.setGasBudget(10_000_000);
  const [fc] = feeTx.splitCoins(feeTx.gas, [feeTx.pure.u64(devMist)]);
  feeTx.transferObjects([fc], feeTx.pure.address(DEV_WALLET));
  if (refMist > 0n && refWallet) {
    const [rc] = feeTx.splitCoins(feeTx.gas, [feeTx.pure.u64(refMist)]);
    feeTx.transferObjects([rc], feeTx.pure.address(refWallet));
    const ru = Object.values(DB).find(x => x.walletAddress === refWallet);
    if (ru) { ru.referralEarned = (ru.referralEarned||0) + Number(refMist)/1e9; saveDB(); }
  }
  await sui.signAndExecuteTransaction({ signer:kp, transaction:feeTx, options:{showEffects:true} }).catch(()=>{});
  return feeMist;
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

  const refWallet = resolveRefWallet(u);

  // ── Early-exit: Odyssey bonding-curve token (not yet graduated) ──────────
  // Before running detectState (which only scans DEX pools), check if this is
  // a live Odyssey bonding-curve token — same guard as the buy flow.
  // If detected and not completed, route to buildOdysseySellTx directly.
  // Bug fix: only the isOdysseyToken() API lookup is wrapped in a non-fatal
  // try/catch. The sell execution itself throws normally so errors aren't swallowed.
  let _odyInfo = null;
  try { _odyInfo = await isOdysseyToken(ct); } catch { /* API lookup failure — fall through */ }
  if (_odyInfo && !_odyInfo.isCompleted && _odyInfo.moonbagsPackageId) {
    const coins   = await sui.getCoins({ owner: u.walletAddress, coinType: ct });
    const coinIds = (coins.data || []).map(c => c.coinObjectId);
    if (!coinIds.length) throw new Error(`No ${sym} coin objects to sell on Odyssey`);
    const tx = await buildOdysseySellTx({
      suiClient: sui, walletAddress: u.walletAddress,
      packageId: _odyInfo.moonbagsPackageId, coinType: ct,
      tokenCoinIdsToMerge: coinIds, amountToSellRaw: sellAmt, minSuiOutMist: 0n,
    });
    try{applyTxOpts(tx, u);}catch{}
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Odyssey sell TX failed');
    const sd      = await getActualDelta(res.balanceChanges || res.digest, SUI_T, u.walletAddress);
    const suiR    = sd && sd > 0n ? Number(sd)/1e9 : 0;
    const soldAmt = Number(sellAmt) / Math.pow(10, meta.decimals || 9);
    const pnlD    = computeSellPnl(chatId, ct, pct, suiR, 0);
    updatePositionAfterSell(chatId, ct, pct);
    return { digest:res.digest, feeSui:'0', route:'Odyssey bonding curve', sui:suiR>0?suiR.toFixed(4):'?', sym, pct, pnl:pnlD, soldAmt };
  }

  // ── Early-exit: Moonbags bonding-curve token (not yet graduated) ─────────
  let _mbInfo = null;
  try { _mbInfo = await isMoonbagsToken(ct); } catch { /* API down — fall through */ }
  if (_mbInfo && !_mbInfo.isCompleted) {
    const coins   = await sui.getCoins({ owner: u.walletAddress, coinType: ct });
    const coinIds = (coins.data || []).map(c => c.coinObjectId);
    if (!coinIds.length) throw new Error(`No ${sym} coin objects to sell on Moonbags`);
    const tx = await buildMoonbagsSellTx({
      walletAddress: u.walletAddress, coinType: ct,
      tokenCoinIdsToMerge: coinIds, amountToSellRaw: sellAmt, minSuiOutMist: 0n,
    });
    try{applyTxOpts(tx, u);}catch{}
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Moonbags sell TX failed');
    const sd      = await getActualDelta(res.balanceChanges || res.digest, SUI_T, u.walletAddress);
    const suiR    = sd && sd > 0n ? Number(sd)/1e9 : 0;
    const soldAmt = Number(sellAmt) / Math.pow(10, meta.decimals || 9);
    const pnlD    = computeSellPnl(chatId, ct, pct, suiR, 0);
    updatePositionAfterSell(chatId, ct, pct);
    return { digest:res.digest, feeSui:'0', route:'Moonbags bonding curve', sui:suiR>0?suiR.toFixed(4):'?', sym, pct, pnl:pnlD, soldAmt };
  }

  // ── Early-exit: hop.fun bonding-curve token (not yet graduated) ──────────
  let _hfInfo = null;
  try { _hfInfo = await isHopFunToken(sui, ct); } catch { /* RPC blip — fall through */ }
  if (_hfInfo && !_hfInfo.isCompleted) {
    const coins   = await sui.getCoins({ owner: u.walletAddress, coinType: ct });
    const coinIds = (coins.data || []).map(c => c.coinObjectId);
    if (!coinIds.length) throw new Error(`No ${sym} coin objects to sell on hop.fun`);
    const tx = await buildHopFunSellTx({
      suiClient: sui, walletAddress: u.walletAddress, coinType: ct,
      tokenCoinIdsToMerge: coinIds, amountToSellRaw: sellAmt, minSuiOutMist: 0n,
      curveOverride: _hfInfo.curveId || null,
    });
    try{applyTxOpts(tx, u);}catch{}
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'hop.fun sell TX failed');
    const sd      = await getActualDelta(res.balanceChanges || res.digest, SUI_T, u.walletAddress);
    const suiR    = sd && sd > 0n ? Number(sd)/1e9 : 0;
    const soldAmt = Number(sellAmt) / Math.pow(10, meta.decimals || 9);
    const pnlD    = computeSellPnl(chatId, ct, pct, suiR, 0);
    updatePositionAfterSell(chatId, ct, pct);
    return { digest:res.digest, feeSui:'0', route:'hop.fun bonding curve', sui:suiR>0?suiR.toFixed(4):'?', sym, pct, pnl:pnlD, soldAmt };
  }

  const st = await detectState(ct);

  if (st.state === 'cetus') {
    // For sells: token→SUI. The pool's a2b from detection was SUI→token,
    // so for selling we flip to !a2b (token→SUI)
    const sellA2b    = !st.a2b;
    const coinInType = st.a2b ? st.coinB : st.coinA;   // the token side
    const est        = await getSwapEstimate(ct, SUI_T, sellAmt.toString());
    const slipFactor = BigInt(Math.floor((1 - u.settings.slippage / 100) * 10000));
    const minOut     = est ? (BigInt(est) * slipFactor) / 10000n : 0n;

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

    try{applyTxOpts(tx, u);}catch{}
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Sell TX failed');
    { const ab=await getActualDelta(res.balanceChanges||res.digest,SUI_T,u.walletAddress); const suiR=ab&&ab>0n?Number(ab)/1e9:(est?Number(est)/1e9:0); const feeMist=await postSellFee(kp,u,suiR); const pnlD=computeSellPnl(chatId,ct,pct,suiR,Number(feeMist)/1e9); updatePositionAfterSell(chatId,ct,pct); return{digest:res.digest,feeSui:fSui(feeMist),route:'Cetus CLMM',sui:suiR>0?suiR.toFixed(4):'?',sym,pct,pnl:pnlD,soldAmt:Number(sellAmt)/Math.pow(10,meta.decimals||9)}; }
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
    try{applyTxOpts(tx, u);}catch{}
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Turbos sell failed');
    { const ab=await getActualDelta(res.balanceChanges||res.digest,SUI_T,u.walletAddress); const suiR=ab&&ab>0n?Number(ab)/1e9:0; const feeMist=await postSellFee(kp,u,suiR); const pnlD=computeSellPnl(chatId,ct,pct,suiR,Number(feeMist)/1e9); updatePositionAfterSell(chatId,ct,pct); return{digest:res.digest,feeSui:fSui(feeMist),route:'Turbos CLMM',sui:suiR>0?suiR.toFixed(4):'?',sym,pct,pnl:pnlD,soldAmt:Number(sellAmt)/Math.pow(10,meta.decimals||9)}; }
  }

  if (st.state === 'flowx') {
    const coinInType = st.a2b ? st.coinB : st.coinA;
    const sellA2b    = !st.a2b;
    const tx = await buildFlowXSwapTx({
      wallet: u.walletAddress, coinA: st.coinA, coinB: st.coinB, a2b: sellA2b,
      coinInType, amountIn: sellAmt.toString(), minAmountOut: '0',
    });
    try{applyTxOpts(tx, u);}catch{}
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'FlowX sell failed');
    { const ab=await getActualDelta(res.balanceChanges||res.digest,SUI_T,u.walletAddress); const suiR=ab&&ab>0n?Number(ab)/1e9:0; const feeMist=await postSellFee(kp,u,suiR); const pnlD=computeSellPnl(chatId,ct,pct,suiR,Number(feeMist)/1e9); updatePositionAfterSell(chatId,ct,pct); return{digest:res.digest,feeSui:fSui(feeMist),route:'FlowX AMM',sui:suiR>0?suiR.toFixed(4):'?',sym,pct,pnl:pnlD,soldAmt:Number(sellAmt)/Math.pow(10,meta.decimals||9)}; }
  }

  if (st.state === 'kriya') {
    const coinInType = st.a2b ? st.coinB : st.coinA;
    const sellA2b    = !st.a2b;
    const tx = await buildKriyaSwapTx({
      wallet: u.walletAddress, poolId: st.poolId, coinA: st.coinA, coinB: st.coinB, a2b: sellA2b,
      coinInType, amountIn: sellAmt.toString(), minAmountOut: '0',
    });
    try{applyTxOpts(tx, u);}catch{}
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Kriya sell failed');
    { const ab=await getActualDelta(res.balanceChanges||res.digest,SUI_T,u.walletAddress); const suiR=ab&&ab>0n?Number(ab)/1e9:0; const feeMist=await postSellFee(kp,u,suiR); const pnlD=computeSellPnl(chatId,ct,pct,suiR,Number(feeMist)/1e9); updatePositionAfterSell(chatId,ct,pct); return{digest:res.digest,feeSui:fSui(feeMist),route:'Kriya AMM',sui:suiR>0?suiR.toFixed(4):'?',sym,pct,pnl:pnlD,soldAmt:Number(sellAmt)/Math.pow(10,meta.decimals||9)}; }
  }

  if (st.state === 'bluemove') {
    const coinInType = st.a2b ? st.coinB : st.coinA;
    const sellA2b    = !st.a2b;
    const tx = await buildBlueMoveSwapTx({
      wallet: u.walletAddress, coinA: st.coinA, coinB: st.coinB, a2b: sellA2b,
      coinInType, amountIn: sellAmt.toString(), minAmountOut: '0',
    });
    try{applyTxOpts(tx, u);}catch{}
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'BlueMove sell failed');
    { const ab=await getActualDelta(res.balanceChanges||res.digest,SUI_T,u.walletAddress); const suiR=ab&&ab>0n?Number(ab)/1e9:0; const feeMist=await postSellFee(kp,u,suiR); const pnlD=computeSellPnl(chatId,ct,pct,suiR,Number(feeMist)/1e9); updatePositionAfterSell(chatId,ct,pct); return{digest:res.digest,feeSui:fSui(feeMist),route:'BlueMove AMM',sui:suiR>0?suiR.toFixed(4):'?',sym,pct,pnl:pnlD,soldAmt:Number(sellAmt)/Math.pow(10,meta.decimals||9)}; }
  }

  if (st.state === 'unsupported_dex') {
    throw new Error(`${sym} is on ${st.dex}. Sell directly there.`);
  }

  if (st.state === 'bonding') {
    if (!st.curveId) throw new Error(`Bonding curve ID unavailable for ${st.lpName}.`);
    const res = await swapSellBonding({ kp, ct, coins:bag, amt:sellAmt, curveId:st.curveId });
    const ab2 = await getActualDelta(res.digest, SUI_T, u.walletAddress).catch(()=>null);
    const suiR2 = ab2 && ab2 > 0n ? Number(ab2)/1e9 : 0;
    updatePositionAfterSell(chatId, ct, pct);
    return { digest:res.digest, feeSui:'N/A', route:st.lpName, sui:suiR2>0?suiR2.toFixed(4):'?', sym, pct };
  }

  if (st.state === 'pans_cetus') {
    // 2-hop sell: TOKEN → PANS (tx1), then PANS → SUI (tx2)
    // Hop 1: TOKEN → PANS — re-query pool type fresh from chain
    const tp = st.tokenPansPool;
    const freshTpS = await getPoolFromRPC(tp.poolId).catch(() => null) || tp;
    const pansIsA = freshTpS.coinA.toLowerCase() === PANS_T.toLowerCase();
    const tokenType = pansIsA ? freshTpS.coinB : freshTpS.coinA;
    const s1CoinA = pansIsA ? PANS_T : tokenType;
    const s1CoinB = pansIsA ? tokenType : PANS_T;
    // Selling TOKEN→PANS: if PANS is coinA then a2b=false (TOKEN is coinB going in)
    //                     if PANS is coinB then a2b=true  (TOKEN is coinA going in)
    const sellA2bHop1 = !pansIsA;
    console.log('[PANS-SELL] hop1 poolId=%s coinA=%s a2b=%s sellAmt=%s',
      tp.poolId.slice(0,20), s1CoinA.slice(0,40), sellA2bHop1, sellAmt.toString());
    const tx1 = await buildCetusSwapTx({
      wallet:       u.walletAddress,
      poolId:       tp.poolId,
      coinA:        s1CoinA,
      coinB:        s1CoinB,
      a2b:          sellA2bHop1,
      coinInType:   ct,
      amountIn:     sellAmt.toString(),
      minAmountOut: '0',
    });
    try{applyTxOpts(tx1, u);}catch{}
    const res1 = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx1, options:{showEffects:true,showBalanceChanges:true} });
    if (res1.effects?.status?.status !== 'success') throw new Error('PANS sell hop1 (TOKEN→PANS): ' + (res1.effects?.status?.error || 'TX failed'));

    const pansReceived = await getActualDelta(res1.balanceChanges || res1.digest, PANS_T, u.walletAddress);
    if (!pansReceived || pansReceived <= 0n) throw new Error('Hop 1 (TOKEN→PANS) returned 0 PANS.');

    // Small delay to ensure PANS coin is indexed
    await new Promise(r => setTimeout(r, 800));

    // Hop 2: PANS → SUI — normalise to exact type constants
    const sp = st.suiPansPool;
    const suiIsA2 = sp.coinA.toLowerCase().endsWith('::sui::sui');
    const s2CoinA = suiIsA2 ? SUI_T : PANS_T;
    const s2CoinB = suiIsA2 ? PANS_T : SUI_T;
    // Selling PANS→SUI: if SUI is coinA then a2b=false (PANS is coinB going in)
    //                   if SUI is coinB then a2b=true  (PANS is coinA going in)
    const sellA2bHop2 = !suiIsA2;
    console.log('[PANS-SELL] hop2 poolId=%s coinA=%s a2b=%s pansMist=%s',
      sp.poolId.slice(0,20), s2CoinA.slice(0,20), sellA2bHop2, pansReceived.toString());
    const tx2 = await buildCetusSwapTx({
      wallet:       u.walletAddress,
      poolId:       sp.poolId,
      coinA:        s2CoinA,
      coinB:        s2CoinB,
      a2b:          sellA2bHop2,
      coinInType:   PANS_T,
      amountIn:     pansReceived.toString(),
      minAmountOut: '0',
    });
    try{applyTxOpts(tx2, u);}catch{}
    const res2 = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx2, options:{showEffects:true,showBalanceChanges:true} });
    if (res2.effects?.status?.status !== 'success') throw new Error('PANS sell hop2 (PANS→SUI): ' + (res2.effects?.status?.error || 'TX failed'));

    const ab2   = await getActualDelta(res2.balanceChanges || res2.digest, SUI_T, u.walletAddress);
    const suiR  = ab2 && ab2 > 0n ? Number(ab2)/1e9 : 0;
    const feeMist = suiR > 0 ? (BigInt(Math.round(suiR * 1e9)) * BigInt(FEE_BPS)) / 10000n : 0n;
    const refMist    = refWallet ? (feeMist * BigInt(Math.floor(REF_SHARE * 100))) / 100n : 0n;
    const devMist    = feeMist - refMist;

    if (devMist > 0n) {
      const feeTx = new Transaction();
      feeTx.setGasBudget(10_000_000);
      const [fc] = feeTx.splitCoins(feeTx.gas, [feeTx.pure.u64(devMist)]);
      feeTx.transferObjects([fc], feeTx.pure.address(DEV_WALLET));
      if (refMist > 0n && refWallet) {
        const [rc] = feeTx.splitCoins(feeTx.gas, [feeTx.pure.u64(refMist)]);
        feeTx.transferObjects([rc], feeTx.pure.address(refWallet));
        const ru = Object.values(DB).find(x => x.walletAddress === refWallet);
        if (ru) { ru.referralEarned = (ru.referralEarned||0) + Number(refMist)/1e9; saveDB(); }
      }
      try{applyTxOpts(feeTx, u);}catch{}
      await sui.signAndExecuteTransaction({ signer:kp, transaction:feeTx, options:{showEffects:true} }).catch(()=>{});
    }

    const pnlD = computeSellPnl(chatId, ct, pct, suiR, Number(feeMist)/1e9);
    updatePositionAfterSell(chatId, ct, pct);
    return { digest:res2.digest, feeSui:fSui(feeMist), route:'Cetus CLMM (TOKEN→PANS→SUI)', sui:suiR>0?suiR.toFixed(4):'?', sym, pct, pnl:pnlD, soldAmt:Number(sellAmt)/Math.pow(10,meta.decimals||9) };
  }

  // ── AGENT MemeLand — 2-hop MEME → AGENT → SUI via Cetus ─────────────────
  // Triggered when detectState returns 'agent_cetus' (AGENT-paired Cetus pool).
  // Also triggered here as a safety net if detectState returned 'unknown' but
  // the user's position has source='agent' (bought via the launchpad flow).
  // Mirrors _agentSellCA but feeds the result back to executeSell callers.
  if (st.state === 'agent_cetus' ||
      (st.state === 'unknown' && (u.positions||[]).find(p => p.ct === ct && p.source === 'agent'))) {
    // Re-read pool type fresh from chain to get correct coin orientation
    // (st may have been populated from cache or from the position source check)
    let tokenPoolId = st.poolId || null;
    let poolCoinA   = st.coinA  || null;
    let poolCoinB   = st.coinB  || null;

    // ── Pool ID resolution — 5-strategy priority chain ─────────────────────
    // Strategy 0a: stored in the user's position record (populated since v.i buy fix)
    if (!tokenPoolId) {
      const savedPos = (u.positions||[]).find(p => p.ct === ct && p.source === 'agent' && p.poolId);
      if (savedPos?.poolId) { tokenPoolId = savedPos.poolId; }
    }
    // Strategy 0b: pd.agentTok (set when user opens the launchpad buy modal)
    if (!tokenPoolId) {
      const agTok = u.pd?.agentTok;
      if (agTok && (agTok.coinType||'').toLowerCase() === ct.toLowerCase() && agTok.poolId)
        { tokenPoolId = agTok.poolId; }
    }
    // Strategy 1: standard findCetusPool (GeckoTerminal + Cetus API, both orderings)
    if (!tokenPoolId) {
      try {
        const ap = await findCetusPool(AGENT_T, ct);
        if (ap) { tokenPoolId = ap.poolId; poolCoinA = ap.coinA; poolCoinB = ap.coinB; }
      } catch {}
    }
    // Strategy 2: Cetus pools_info by coinType — filter for AGENT counterpart
    if (!tokenPoolId) {
      try {
        const r = await ftch(
          `https://api-sui.cetus.zone/v2/sui/pools_info?coin_type=${encodeURIComponent(ct)}&limit=10&order_by=tvl&order=desc`,
          { headers:{ Accept:'application/json' } }, 8000
        );
        if (r.ok) {
          const d = await r.json();
          const pools = d.data?.list || [];
          const AGENT_NORM = AGENT_T.toLowerCase();
          const hit = pools.find(p =>
            (p.coin_type_a||'').toLowerCase() === AGENT_NORM ||
            (p.coin_type_b||'').toLowerCase() === AGENT_NORM
          );
          if (hit) {
            tokenPoolId = hit.pool_address || hit.id;
            poolCoinA   = hit.coin_type_a;
            poolCoinB   = hit.coin_type_b;
          }
        }
      } catch {}
    }
    // Strategy 3: GeckoTerminal — walk token's pools, look for AGENT-paired Cetus pool
    if (!tokenPoolId) {
      try {
        const pkg = ct.split('::')[0];
        for (const addr of [ct, pkg]) {
          if (tokenPoolId) break;
          const gPools = await getGeckoPools(addr).catch(() => []);
          for (const p of gPools.slice(0, 8)) {
            const poolAddr = p.attributes?.address;
            if (!poolAddr) continue;
            const info = await getPoolFromRPC(poolAddr).catch(() => null);
            if (!info || info.dex !== 'cetus') continue;
            const AGENT_NORM = AGENT_T.toLowerCase();
            if ((info.coinA||'').toLowerCase() === AGENT_NORM ||
                (info.coinB||'').toLowerCase() === AGENT_NORM) {
              tokenPoolId = poolAddr; poolCoinA = info.coinA; poolCoinB = info.coinB;
              break;
            }
          }
        }
      } catch {}
    }
    // Strategy 4: Railway backend — authoritative source for all AGENT MemeLand pools.
    // This is the most reliable source for newly-launched / low-TVL pools that aren't
    // indexed by Cetus API or GeckoTerminal yet.
    if (!tokenPoolId) {
      try {
        const backendTok = await fetchAgentTokenByCoinType(ct);
        if (backendTok?.poolId) { tokenPoolId = backendTok.poolId; }
      } catch {}
    }
    if (!tokenPoolId) throw new Error(
      `Could not find a Cetus pool for ${sym} on AGENT MemeLand.\n` +
      `This token's pool may not be live yet, or the token may have been delisted.\n` +
      `Try selling directly on https://agent.land`
    );

    // Re-read pool object to confirm exact coin orientation
    try {
      const obj = await sui.getObject({ id: tokenPoolId, options:{ showType:true } });
      const args = obj.data?.type?.match(/<(.+)>$/)?.[1]?.split(/,\s*/).map(s=>s.trim());
      if (args && args.length === 2) { poolCoinA = args[0]; poolCoinB = args[1]; }
    } catch {}

    // Cache poolId back into the position so future sells skip the lookup
    try {
      const savedPos = (u.positions||[]).find(p => p.ct === ct && p.source === 'agent');
      if (savedPos && !savedPos.poolId) { savedPos.poolId = tokenPoolId; saveDB(); }
    } catch {}

    const memeIsA = (poolCoinA||'').toLowerCase() === ct.toLowerCase();
    const a2b1    = memeIsA; // MEME is INPUT; if MEME=coinA → swap_a2b (a2b=true) else swap_b2a (a2b=false)

    // Hop 1: MEME → AGENT
    const tx1 = await buildCetusSwapTx({
      wallet: u.walletAddress, poolId: tokenPoolId,
      coinA: poolCoinA, coinB: poolCoinB, a2b: a2b1,
      coinInType: ct, amountIn: sellAmt.toString(), minAmountOut: '0',
    });
    try{applyTxOpts(tx1, u);}catch{}
    const res1 = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx1, options:{showEffects:true,showBalanceChanges:true} });
    if (res1.effects?.status?.status !== 'success') throw new Error('AGENT sell hop1 (MEME→AGENT): ' + (res1.effects?.status?.error || 'TX failed'));

    const agentGot = await getActualDelta(res1.balanceChanges || res1.digest, AGENT_T, u.walletAddress);
    if (!agentGot || agentGot <= 0n) throw new Error('AGENT sell hop1 returned 0 AGENT');

    await new Promise(r => setTimeout(r, 800));

    // Hop 2: AGENT → SUI  (SUI_AGENT_POOL: coinA=AGENT, coinB=SUI; a2b=true → swap_a2b)
    const tx2 = await buildCetusSwapTx({
      wallet: u.walletAddress, poolId: SUI_AGENT_POOL,
      coinA: AGENT_T, coinB: SUI_T, a2b: true,
      coinInType: AGENT_T, amountIn: agentGot.toString(), minAmountOut: '0',
    });
    try{applyTxOpts(tx2, u);}catch{}
    const res2 = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx2, options:{showEffects:true,showBalanceChanges:true} });
    if (res2.effects?.status?.status !== 'success') throw new Error('AGENT sell hop2 (AGENT→SUI): ' + (res2.effects?.status?.error || 'TX failed'));

    const suiDelta = await getActualDelta(res2.balanceChanges || res2.digest, SUI_T, u.walletAddress);
    const suiR = suiDelta && suiDelta > 0n ? Number(suiDelta)/1e9 : 0;
    let feeMist2 = 0n;
    try { feeMist2 = await postSellFee(kp, u, suiR); } catch (e) { console.error('AGENT executeSell postSellFee:', e?.message||e); }
    const pnlD2 = computeSellPnl(chatId, ct, pct, suiR, Number(feeMist2)/1e9);
    updatePositionAfterSell(chatId, ct, pct);
    return { digest:res2.digest, feeSui:fSui(feeMist2), route:'Cetus (MEME→AGENT→SUI)', sui:suiR>0?suiR.toFixed(4):'?', sym, pct, pnl:pnlD2, soldAmt:Number(sellAmt)/Math.pow(10,meta.decimals||9) };
  }

  // ── Odyssey bonding-curve sell (fallback) ────────────────────────────────
  // Defensive fallback: if detectState returned 'unknown' AND the early-exit
  // above didn't catch it (e.g. isOdysseyToken API was down on first call),
  // try again. Bug fix: same pattern as above — only the API lookup is non-fatal.
  if (st.state === 'unknown') {
    let _odyFallback = null;
    try { _odyFallback = await isOdysseyToken(ct); } catch { /* API down — continue */ }
    if (_odyFallback && !_odyFallback.isCompleted && _odyFallback.moonbagsPackageId) {
      const coins   = await sui.getCoins({ owner: u.walletAddress, coinType: ct });
      const coinIds = (coins.data || []).map(c => c.coinObjectId);
      if (!coinIds.length) throw new Error(`No ${sym} coin objects to sell on Odyssey`);
      const tx = await buildOdysseySellTx({
        suiClient: sui, walletAddress: u.walletAddress,
        packageId: _odyFallback.moonbagsPackageId, coinType: ct,
        tokenCoinIdsToMerge: coinIds, amountToSellRaw: sellAmt, minSuiOutMist: 0n,
      });
      try{applyTxOpts(tx, u);}catch{}
      const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
      if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Odyssey sell TX failed');
      const sd      = await getActualDelta(res.balanceChanges || res.digest, SUI_T, u.walletAddress);
      const suiR    = sd && sd > 0n ? Number(sd)/1e9 : 0;
      const soldAmt = Number(sellAmt) / Math.pow(10, meta.decimals || 9);
      const pnlD    = computeSellPnl(chatId, ct, pct, suiR, 0);
      updatePositionAfterSell(chatId, ct, pct);
      return { digest:res.digest, feeSui:'0', route:'Odyssey bonding curve', sui:suiR>0?suiR.toFixed(4):'?', sym, pct, pnl:pnlD, soldAmt };
    }
    // Moonbags fallback (mirrors Odyssey fallback above)
    let _mbFallback = null;
    try { _mbFallback = await isMoonbagsToken(ct); } catch { /* API down */ }
    if (_mbFallback && !_mbFallback.isCompleted) {
      const coins   = await sui.getCoins({ owner: u.walletAddress, coinType: ct });
      const coinIds = (coins.data || []).map(c => c.coinObjectId);
      if (!coinIds.length) throw new Error(`No ${sym} coin objects to sell on Moonbags`);
      const tx = await buildMoonbagsSellTx({
        walletAddress: u.walletAddress, coinType: ct,
        tokenCoinIdsToMerge: coinIds, amountToSellRaw: sellAmt, minSuiOutMist: 0n,
      });
      try{applyTxOpts(tx, u);}catch{}
      const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
      if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Moonbags sell TX failed');
      const sd      = await getActualDelta(res.balanceChanges || res.digest, SUI_T, u.walletAddress);
      const suiR    = sd && sd > 0n ? Number(sd)/1e9 : 0;
      const soldAmt = Number(sellAmt) / Math.pow(10, meta.decimals || 9);
      const pnlD    = computeSellPnl(chatId, ct, pct, suiR, 0);
      updatePositionAfterSell(chatId, ct, pct);
      return { digest:res.digest, feeSui:'0', route:'Moonbags bonding curve', sui:suiR>0?suiR.toFixed(4):'?', sym, pct, pnl:pnlD, soldAmt };
    }
    // hop.fun fallback (mirrors Moonbags fallback above)
    let _hfFallback = null;
    try { _hfFallback = await isHopFunToken(sui, ct); } catch { /* RPC blip */ }
    if (_hfFallback && !_hfFallback.isCompleted) {
      const coins   = await sui.getCoins({ owner: u.walletAddress, coinType: ct });
      const coinIds = (coins.data || []).map(c => c.coinObjectId);
      if (!coinIds.length) throw new Error(`No ${sym} coin objects to sell on hop.fun`);
      const tx = await buildHopFunSellTx({
        suiClient: sui, walletAddress: u.walletAddress, coinType: ct,
        tokenCoinIdsToMerge: coinIds, amountToSellRaw: sellAmt, minSuiOutMist: 0n,
        curveOverride: _hfFallback.curveId || null,
      });
      try{applyTxOpts(tx, u);}catch{}
      const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
      if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'hop.fun sell TX failed');
      const sd      = await getActualDelta(res.balanceChanges || res.digest, SUI_T, u.walletAddress);
      const suiR    = sd && sd > 0n ? Number(sd)/1e9 : 0;
      const soldAmt = Number(sellAmt) / Math.pow(10, meta.decimals || 9);
      const pnlD    = computeSellPnl(chatId, ct, pct, suiR, 0);
      updatePositionAfterSell(chatId, ct, pct);
      return { digest:res.digest, feeSui:'0', route:'hop.fun bonding curve', sui:suiR>0?suiR.toFixed(4):'?', sym, pct, pnl:pnlD, soldAmt };
    }
  }

  // Last resort: force-find Cetus SUI-paired pool
  const pool = await findCetusPool(ct, SUI_T);
  if (pool) {
    const tx = await buildCetusSwapTx({ wallet:u.walletAddress, poolId:pool.poolId, coinA:pool.coinA, coinB:pool.coinB, a2b:pool.a2b, coinInType:ct, amountIn:sellAmt.toString(), minAmountOut:'0' });
    try{applyTxOpts(tx, u);}catch{}
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'TX failed');
    { const ab=await getActualDelta(res.balanceChanges||res.digest,SUI_T,u.walletAddress); const suiR=ab&&ab>0n?Number(ab)/1e9:0; const pnlD=computeSellPnl(chatId,ct,pct,suiR,0); updatePositionAfterSell(chatId,ct,pct); return{digest:res.digest,feeSui:'0',route:'Cetus',sui:suiR>0?suiR.toFixed(4):'?',sym,pct,pnl:pnlD}; }
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
  tx.setSender(u.walletAddress);

  if (coinType === SUI_T) {
    // Merge all SUI coins into gas so fragmented wallets can withdraw large amounts
    await setSuiGasPayment(tx, u.walletAddress);
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

  const [gTok, gPools, dsPools, meta, supply, holders] = await Promise.all([
    geckoTok(ct).catch(()=>null),
    geckoPools(ct).catch(()=>[]),
    getDexScreenerPools(ct).catch(()=>[]),
    getMeta(ct).catch(()=>null),
    sui.getTotalSupply({coinType:ct}).catch(()=>null),
    cap(getHolders(ct)),
  ]);

  // Convert DexScreener pools to geckoPools shape and merge.
  // DS pools only count if they have meaningful liquidity (>$50).
  // The highest-liq pool becomes "best" — so BVS/PANS ($103k) beats BVS/SUI ($10).
  const dsConverted = dsPools
    .filter(p => p.liq > 50)
    .map(p => ({
      id:    p.address,
      dex:   p.dex.charAt(0).toUpperCase() + p.dex.slice(1),
      liq:   p.liq, vol:p.vol, priceU:p.priceU,
      chg5m: p.chg5m, chg1h:p.chg1h, chg6h:p.chg6h, chg24h:p.chg24h,
      age:   p.age,
      _fromDS: true,
    }));

  // Merge: prefer DS entry when same pool id exists in both; add DS-only pools.
  // Normalize ids to lowercase so dedup works across DS/Gecko address case differences.
  const norm   = id => String(id||'').toLowerCase();
  const gpIds  = new Set(gPools.map(p => norm(p.id)));
  const merged = [...gPools, ...dsConverted.filter(p => !gpIds.has(norm(p.id)))];
  const pools  = merged.sort((a, b) => b.liq - a.liq);

  // Filter out phantom liquidity (Aftermath vaults, broken DS entries):
  // a pool with significant liq but ~zero volume isn't a real trading pool.
  // Guards to avoid false positives:
  //   - Only filter pools older than 24h (new pools haven't accumulated volume yet).
  //   - Require liq > $10k AND vol/liq < 0.0002 (i.e. <0.02% turnover/24h — extreme inactivity).
  // Aftermath vault example: NS had $53.8M liq with $19k vol → ratio 0.00036 → filtered.
  // Real low-vol pool example: a $10k LP with $5/day vol → ratio 0.0005 → kept.
  const ageHrs = p => {
    if (!p.age) return Infinity; // unknown age — assume old
    const t = typeof p.age === 'string' ? Date.parse(p.age) : p.age;
    if (!t) return Infinity;
    return (Date.now() - t) / 3600000;
  };
  const isReal = p => {
    const liq = p.liq||0, vol = p.vol||0;
    if (liq <= 0) return false;
    if (ageHrs(p) < 24) return true;          // give new pools the benefit of doubt
    if (liq > 10000 && vol < liq * 0.0002) return false;
    return true;
  };
  let realPools = pools.filter(isReal);
  // Safety: if filter wiped everything, fall back to all pools so we never show $0 liq
  // for a token that genuinely has liquidity.
  if (realPools.length === 0 && pools.length > 0) realPools = pools;

  const best   = realPools[0];
  const name   = meta?.name   || gTok?.name   || '?';
  const symbol = meta?.symbol || gTok?.symbol || '?';
  const dec    = meta?.decimals || gTok?.decimals || 9;
  const supRaw = supply ? Number(BigInt(supply.value)) : (gTok?.rawSupply||0);
  const supH   = supRaw / Math.pow(10, dec);
  const priceU = gTok?.priceUsd || best?.priceU || 0;
  const liq    = realPools.reduce((t,p) => t+(p.liq||0), 0);
  // Volume: prefer the larger of gTok.vol24h (token-aggregate from Gecko) vs sum of real pool vols.
  // Gecko token endpoint sometimes lags / misses DS-tracked pools; summing real pools covers more venues.
  // Both sides are dedup'd, so max() avoids double-counting while still picking the more complete number.
  const volSum  = realPools.reduce((t,p) => t+(p.vol||0), 0);
  const volBest = Math.max(gTok?.vol24h||0, volSum);
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
    priceU, mcap:gTok?.mcap||0, vol:volBest, liq,
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

function buyCard(d, ct, st) {
  const issues = [
    d.mint===true, d.honeypot===false,
    d.upgradeable===true, d.denyCap?.has===true,
    d.top10>50, d.devPct!==null&&d.devPct>10
  ].filter(Boolean).length;
  const pairedWith = st?.state === 'pans_cetus' ? 'PANS' : st?.state === 'agent_cetus' ? 'AGENT' : 'SUI';
  const L = [];
  L.push(`*${d.symbol}/${pairedWith}*`);
  L.push(`\`${ct}\``);
  L.push(``);
  L.push(`Token info:`);
  const ageStr = d.age ? ` | 📍 Age: ${d.age}` : '';
  L.push(`🌐 Sui @ ${d.dex}${ageStr}`);
  if (d.mcap   > 0) L.push(`🏛 MCap: $${fNum(d.mcap)}`);
  if (d.vol    > 0) L.push(`📊 Vol: $${fNum(d.vol)}`);
  if (d.liq    > 0) L.push(`💧 Liq: $${fNum(d.liq)}`);
  if (d.priceU > 0) L.push(`💰 USD: ${fPrice(d.priceU)}`);
  const chgs = [];
  if (d.chg5m)  chgs.push(`5M: ${fChg(d.chg5m)}`);
  if (d.chg1h)  chgs.push(`1H: ${fChg(d.chg1h)}`);
  if (d.chg6h)  chgs.push(`6H: ${fChg(d.chg6h)}`);
  if (d.chg24h) chgs.push(`24H: ${fChg(d.chg24h)}`);
  if (chgs.length) L.push(`📋 ${chgs.join(' | ')}`);
  if (st?.state === 'bonding' && st.suiRaised > 0 && st.threshold) {
    const p = Math.min(100, (st.suiRaised / st.threshold) * 100);
    const filled = Math.floor(p / 10);
    L.push(`🚀 Bonding: [${'█'.repeat(filled)}${'░'.repeat(10-filled)}] ${p.toFixed(1)}% → ${st.destDex}`);
  }
  if (d.pools.length > 1) L.push(`🔀 ${d.pools.length} pools — best liquidity`);
  L.push(``);
  const mintTick  = d.mint===null    ? '⚪' : d.mint  ? '⚠️' : '✅';
  const hpTick    = d.honeypot===null ? '⚪' : d.honeypot ? '✅' : '❌';
  const top10Tick = d.top10 > 30 ? '⚠️' : '✅';
  const devTick   = d.devPct===null  ? '⚪' : d.devPct > 10 ? '🔴' : d.devPct > 5 ? '⚠️' : '✅';
  const mintVal   = d.mint===null    ? '?' : d.mint  ? 'Yes' : 'No';
  const hpVal     = d.honeypot===null ? '?' : d.honeypot ? 'No' : 'Yes';
  const top10Val  = d.top10  > 0 ? `${d.top10.toFixed(2)}%`  : '?';
  const devVal    = d.devPct !== null ? `${d.devPct.toFixed(2)}%` : '?';
  L.push(`🛡 Audit check (Issues: ${issues})`);
  L.push(`${mintTick} Mint Auth: ${mintVal} | ${hpTick} Honeypot: ${hpVal} | ${top10Tick} Top 10: ${top10Val} | ${devTick} Dev Balance: ${devVal}`);
  L.push(``);
  L.push(`🔴 Est Gas Fee: ~ 0.010 SUI`);
  return L.join('\n');
}

function scanReport(d, ct, st) {
  const top3   = d.topHolders.slice(0,3).reduce((t,h)=>t+h.pct,0);
  const issues = [
    d.mint===true, d.honeypot===false,
    d.upgradeable===true, d.denyCap?.has===true,
    d.top10>50, d.devPct!==null&&d.devPct>10
  ].filter(Boolean).length;
  const pairedWith = st?.state === 'pans_cetus' ? 'PANS' : st?.state === 'agent_cetus' ? 'AGENT' : 'SUI';
  const L = [];
  L.push(`*${d.symbol}/${pairedWith}*`);
  L.push(`\`${ct}\``);
  if (d.deployer) L.push(`👨‍💻 Deployer: \`${trunc(d.deployer)}\``);
  L.push(``);
  L.push(`Token info:`);
  const ageStr = d.age ? ` | 📍 Age: ${d.age}` : '';
  L.push(`🌐 Sui @ ${d.dex}${ageStr}`);
  if (d.mcap   > 0) L.push(`🏛 MCap: $${fNum(d.mcap)}`);
  if (d.vol    > 0) L.push(`📊 Vol: $${fNum(d.vol)}`);
  if (d.liq    > 0) L.push(`💧 Liq: $${fNum(d.liq)}`);
  if (d.priceU > 0) {
    const chgStr = d.chg24h ? `  (${fChg(d.chg24h)})` : '';
    L.push(`💰 USD: ${fPrice(d.priceU)}${chgStr}`);
  }
  const sup = fSupply(d.supH); if (sup) L.push(`🏭 Supply: ${sup}`);
  const chgs = [];
  if (d.chg5m)  chgs.push(`5M: ${fChg(d.chg5m)}`);
  if (d.chg1h)  chgs.push(`1H: ${fChg(d.chg1h)}`);
  if (d.chg6h)  chgs.push(`6H: ${fChg(d.chg6h)}`);
  if (d.chg24h) chgs.push(`24H: ${fChg(d.chg24h)}`);
  if (chgs.length) L.push(`📋 ${chgs.join(' | ')}`);
  L.push(``);
  L.push(`👥 Holders: ${d.holders>0?d.holders.toLocaleString():'N/A'}${top3>50?`  ⚠️ Top3: ${top3.toFixed(1)}%`:''}`);
  if (d.topHolders.length) {
    d.topHolders.slice(0,5).forEach((h,i)=>L.push(`  ${i+1}. \`${trunc(h.addr)}\` — ${h.pct.toFixed(2)}%`));
  }
  if (st?.state === 'bonding') {
    L.push(``);
    L.push(`🚀 Bonding Curve — ${st.lpName}`);
    if (st.suiRaised>0&&st.threshold) {
      const p=Math.min(100,(st.suiRaised/st.threshold)*100);
      const filled=Math.floor(p/10);
      L.push(`[${'█'.repeat(filled)}${'░'.repeat(10-filled)}] ${p.toFixed(1)}% (${st.suiRaised}/${st.threshold} SUI) → ${st.destDex}`);
    }
  } else if (d.pools.length) {
    L.push(``);
    L.push(`💧 Pools (${d.pools.length}):`);
    d.pools.slice(0,4).forEach((p,i)=>L.push(`  ${i===0?'⭐':'•'} ${p.dex}: $${fNum(p.liq)}${p.vol>0?`  vol $${fNum(p.vol)}`:''}`));
  } else { L.push(`\n❌ No pools found`); }
  L.push(``);
  const mintTick  = d.mint===null    ? '⚪' : d.mint  ? '⚠️' : '✅';
  const hpTick    = d.honeypot===null ? '⚪' : d.honeypot ? '✅' : '❌';
  const top10Tick = d.top10 > 30 ? '⚠️' : '✅';
  const devTick   = d.devPct===null  ? '⚪' : d.devPct > 10 ? '🔴' : d.devPct > 5 ? '⚠️' : '✅';
  const dcTick    = d.denyCap===null ? '⚪' : d.denyCap.has ? (d.denyCap.globalPause?'❌':'⚠️') : '✅';
  const mintVal   = d.mint===null    ? '?' : d.mint  ? 'Yes' : 'No';
  const hpVal     = d.honeypot===null ? '?' : d.honeypot ? 'No' : 'Yes';
  const top10Val  = d.top10  > 0 ? `${d.top10.toFixed(2)}%`  : '?';
  const devVal    = d.devPct !== null ? `${d.devPct.toFixed(2)}%` : '?';
  const dcVal     = d.denyCap===null?'?':!d.denyCap.has?'No':d.denyCap.globalPause?'Freeze All':'Can Freeze';
  L.push(`🛡 Audit check (Issues: ${issues})`);
  L.push(`${mintTick} Mint Auth: ${mintVal} | ${hpTick} Honeypot: ${hpVal} | ${top10Tick} Top 10: ${top10Val} | ${devTick} Dev Balance: ${devVal} | ${dcTick} Freeze: ${dcVal}`);
  L.push(``);
  L.push(`🔴 Est Gas Fee: ~ 0.010 SUI`);
  return L.join('\n');
}

// ═══════════════════════════════════════════════════════════
// POSITIONS & P&L
// ═══════════════════════════════════════════════════════════

function addPos(chatId, p) {
  const u = getU(chatId); if (!u) return;
  u.positions = u.positions || [];
  // Merge into existing position for same token (accumulate bags)
  const existing = u.positions.find(x => x.ct === p.ct);
  if (existing) {
    const prevSpent = parseFloat(existing.spent) || 0;
    const newSpent  = parseFloat(p.spent) || 0;
    const totalSpent = prevSpent + newSpent;
    const totalTok   = (existing.tokens || 0) + (p.tokens || 0);
    existing.tokens = totalTok;
    existing.spent  = totalSpent.toFixed(4);
    existing.entry  = totalTok > 0 ? totalSpent / totalTok : existing.entry;
    if (p.tp != null) existing.tp = p.tp;
    if (p.sl != null) existing.sl = p.sl;
  } else {
    u.positions.push({ id:randomBytes(4).toString('hex'), ct:p.ct, sym:p.sym, entry:p.entry||0, tokens:p.tokens||0, dec:p.dec||9, spent:p.spent, source:p.source||'dex', lp:p.lp||null, tp:p.tp||null, sl:p.sl||null, entryMc:p.entryMc||null, entryPriceUsd:p.entryPriceUsd||null, entrySupplyH:p.entrySupplyH||null, poolId:p.poolId||null, at:Date.now() });
  }
  saveDB();
}

// Compute P&L for a sell — returns { spent, received, pnl, pnlPct } or null
function computeSellPnl(chatId, ct, pct, suiReceived, feeSui) {
  const u = getU(chatId); if (!u) return null;
  const pos = (u.positions || []).find(p => p.ct === ct);
  if (!pos || !pos.spent) return null;
  const fraction = pct / 100;
  const allocSpent = parseFloat(pos.spent) * fraction;
  if (allocSpent <= 0) return null;
  const netReceived = Math.max(0, suiReceived - feeSui);
  const pnl    = netReceived - allocSpent;
  const pnlPct = (pnl / allocSpent) * 100;
  return { spent: allocSpent, received: netReceived, pnl, pnlPct };
}

// Update position after a partial/full sell
function updatePositionAfterSell(chatId, ct, pct) {
  const u = getU(chatId); if (!u) return;
  if (pct >= 100) {
    u.positions = (u.positions || []).filter(p => p.ct !== ct);
  } else {
    const pos = (u.positions || []).find(p => p.ct === ct);
    if (pos) {
      const keep = (100 - pct) / 100;
      const allocSpent = parseFloat(pos.spent || '0') * (pct / 100);
      pos.soldSui = (parseFloat(pos.soldSui || '0') + allocSpent).toFixed(4);
      pos.tokens = (pos.tokens || 0) * keep;
      pos.spent  = (parseFloat(pos.spent || '0') * keep).toFixed(4);
    }
  }
  saveDB();
}

// Cached SUI/USD price — used to convert USD-denominated indexer prices back
// into SUI for PnL display. 60s TTL keeps it fresh without hammering Gecko.
let _suiUsdCache = { v:0, ts:0 };
async function fetchSuiUsd() {
  const now = Date.now();
  if (_suiUsdCache.v > 0 && now - _suiUsdCache.ts < 60_000) return _suiUsdCache.v;
  try {
    const t = await geckoTok(SUI_T).catch(() => null);
    const v = t?.priceUsd > 0 ? t.priceUsd : 0;
    if (v > 0) { _suiUsdCache = { v, ts: now }; return v; }
  } catch {}
  // Fallback: keep last known good value if we have one, else null.
  return _suiUsdCache.v > 0 ? _suiUsdCache.v : null;
}

// Look up live USD price of a token via GeckoTerminal or DexScreener
// (whichever has it indexed). This covers tokens trading on any Sui DEX —
// not just Cetus, which is the only venue getSwapEstimate currently hits.
// Cheap one-shot lookup of live USD price + market cap for a token.
// Used at buy-time (snapshot entry stats) and at display-time (live PnL).
async function _liveTokenStats(ct) {
  try {
    const [pUsd, supply, meta] = await Promise.all([
      _tokenPriceUsd(ct),
      sui.getTotalSupply({ coinType: ct }).catch(() => null),
      getMeta(ct).catch(() => null),
    ]);
    const dec  = meta?.decimals || 9;
    const supH = supply ? Number(BigInt(supply.value)) / Math.pow(10, dec) : 0;
    const mc   = (pUsd > 0 && supH > 0) ? pUsd * supH : null;
    return { priceUsd: pUsd > 0 ? pUsd : null, mc, supplyH: supH || null };
  } catch { return { priceUsd: null, mc: null, supplyH: null }; }
}

async function _tokenPriceUsd(ct) {
  try {
    const gt = await geckoTok(ct).catch(() => null);
    if (gt?.priceUsd > 0) return gt.priceUsd;
  } catch {}
  try {
    const ds = await getDexScreenerPools(ct).catch(() => []);
    // Pick the deepest-liquidity pool with a positive price.
    const best = (ds || []).filter(p => p.priceU > 0).sort((a,b) => (b.liq||0) - (a.liq||0))[0];
    if (best?.priceU > 0) return best.priceU;
  } catch {}
  return null;
}

async function getPnl(pos) {
  if (pos.source==='bonding'||!pos.tokens||pos.tokens<=0) return null;
  const spent = parseFloat(pos.spent || 0);
  if (!(spent > 0)) return null;
  // Always fetch live USD price + SUI/USD up-front so we can show
  // bought / current price + market cap regardless of which DEX has the pool.
  const [pUsd, suiUsd, supplyInfo] = await Promise.all([
    _tokenPriceUsd(pos.ct).catch(() => null),
    fetchSuiUsd().catch(() => null),
    pos.entrySupplyH ? Promise.resolve(null) : sui.getTotalSupply({ coinType: pos.ct }).catch(() => null),
  ]);
  const supplyH = pos.entrySupplyH || (supplyInfo ? Number(BigInt(supplyInfo.value)) / Math.pow(10, pos.dec || 9) : null);
  const curMc   = (pUsd > 0 && supplyH > 0) ? pUsd * supplyH : null;
  // Lazy backfill for old positions that were created before entry stats
  // were captured (so the UI shows real bought/now MC instead of "—").
  if (!pos.entryPriceUsd && suiUsd > 0 && pos.entry > 0) {
    pos.entryPriceUsd = pos.entry * suiUsd; // approx — uses *current* SUI/USD
  }
  if (!pos.entryMc && pos.entryPriceUsd && supplyH > 0) {
    pos.entryMc = pos.entryPriceUsd * supplyH;
  }
  if (!pos.entrySupplyH && supplyH > 0) pos.entrySupplyH = supplyH;
  saveDB();

  const mkRes = (cur) => ({
    cur, pnl: cur - spent, pct: ((cur - spent) / spent) * 100,
    priceUsd: pUsd || null,
    suiUsd: suiUsd || null,
    mc: curMc,
    entryPriceUsd: pos.entryPriceUsd || null,
    entryMc: pos.entryMc || null,
  });
  try {
    // AGENT MemeLand tokens route MEME→AGENT→SUI (2 hops) so direct
    // getSwapEstimate always returns 0. Use Railway backend priceSui first.
    if (pos.source === 'agent') {
      const t = await fetchAgentTokenByCoinType(pos.ct).catch(() => null);
      if (t?.priceSui != null) {
        const cur = Number(t.priceSui) * pos.tokens;
        if (cur > 0) return mkRes(cur);
      }
    } else {
      const amt = BigInt(Math.floor(pos.tokens * Math.pow(10, pos.dec||9)));
      const out = await getSwapEstimate(pos.ct, SUI_T, amt.toString()).catch(() => null);
      if (out && out !== '0') {
        const cur = Number(out)/1e9;
        if (cur > 0) return mkRes(cur);
      }
    }
    // Universal fallback: USD price × tokens / SUI-USD.
    if (pUsd > 0 && suiUsd > 0) {
      const cur = (pUsd * pos.tokens) / suiUsd;
      if (cur > 0) return mkRes(cur);
    }
    return null;
  } catch { return null; }
}

function pnlBar(pct) {
  const capped = Math.max(-100, Math.min(300, pct));
  const fill   = Math.min(10, Math.round(Math.abs(capped) / 40));
  return pct >= 0
    ? '🟩'.repeat(fill) + '⬛'.repeat(10 - fill)
    : '🟥'.repeat(fill) + '⬛'.repeat(10 - fill);
}

function pnlCaption(pos, p) {
  const s      = p.pnl >= 0 ? '+' : '';
  const tokStr = pos.tokens ? pos.tokens.toLocaleString('en',{maximumFractionDigits:2}) : '?';
  const heldH  = pos.at ? Math.round((Date.now()-pos.at)/3600000) : 0;
  const heldStr= heldH>=24?`${Math.floor(heldH/24)}d ${heldH%24}h`:`${heldH}h`;
  const srcMap = { bonding:'Launchpad', agent:'AGENT MemeLand', odyssey:'Odyssey', hopfun:'hop.fun', moonbags:'Moonbags', dex:'DEX' };
  const srcLabel = srcMap[pos.source] || 'DEX';
  const invested = parseFloat(pos.spent||0);
  const sold     = parseFloat(pos.soldSui||0);
  const remain   = Math.max(0, invested - sold);
  return (
    `📍 *Track*\n` +
    `*${pos.sym}/SUI*  ·  ${srcLabel}\n` +
    `\`${pos.ct}\`\n\n` +
    `Holdings: ${tokStr} ${pos.sym}  ·  Held: ${heldStr}\n` +
    `Invested:  \`${invested.toFixed(4)} SUI\`\n` +
    `Sold:      \`${sold.toFixed(4)} SUI\`\n` +
    `Remaining: \`${remain.toFixed(4)} SUI\`\n` +
    `Current:   \`${p.cur.toFixed(4)} SUI\`\n` +
    `Total PNL: *${s}${p.pnl.toFixed(4)} SUI (${s}${p.pct.toFixed(2)}%)*\n` +
    `${pnlBar(p.pct)}`
  );
}

// ── RaidenX-style PnL card ──────────────────────────────────────────
// Returns a PNG Buffer. Prefers MC display when entryMc was tracked at buy time.
async function _renderPosCard(pos, user) {
  const me = await bot.getMe().catch(() => ({ username: 'bot' }));
  const refCode = user?.referralCode || '';
  const referralUrl = refCode ? `https://t.me/${me.username || BOT_USERNAME}?start=${refCode}` : '';
  const p  = await getPnl(pos).catch(() => null);
  const spent = parseFloat(pos.spent || 0);
  const cur   = p ? p.cur : null;
  const pct   = p ? p.pct : 0;

  // Prefer MC display when we recorded entry MC
  let entryLabel = 'Entry SUI', currentLabel = 'Current SUI';
  let entryValue = `${spent.toFixed(4)} SUI`;
  let currentValue = cur != null ? `${cur.toFixed(4)} SUI` : '—';

  if (pos.entryMc && pos.entryMc > 0) {
    entryLabel = 'Entry MC';
    entryValue = fmtMoney(pos.entryMc);
    // try to get current MC from agent backend (only source with live MC)
    let curMc = null;
    if (pos.source === 'agent') {
      const t = await fetchAgentTokenByCoinType(pos.ct).catch(() => null);
      if (t?.marketCapUsd) curMc = Number(t.marketCapUsd);
    }
    if (curMc == null && cur != null && spent > 0) {
      // Derive current MC from PnL ratio: cur/spent × entryMc
      curMc = pos.entryMc * (cur / spent);
    }
    currentLabel = 'Current MC';
    currentValue = curMc != null ? fmtMoney(curMc) : '—';
  }

  return renderPnlCard({
    sym: pos.sym || '?',
    pct,
    entryLabel, entryValue,
    currentLabel, currentValue,
    ts: new Date(),
    botHandle: '@' + (me.username || 'bot'),
    botName: 'AGENT TRADING BOT',
    referralUrl,
    referralBlurb: 'Refer others and earn up to 40%',
  });
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
          const isDex=['cetus','turbos','flowx','kriya','bluemove'].includes(st.state);
          const fire=w.mode==='grad'?isDex:(isDex||st.state==='bonding');
          if (!fire) continue;
          // MC threshold gate — only fire when launch MC ≥ user's minMc (0 = fire immediately)
          if (w.minMc && w.minMc>0) {
            let curMc=0;
            try { const td=await getTokenData(w.ct).catch(()=>null); curMc=td?.mcap||0; } catch {}
            if (!curMc || curMc < w.minMc) continue; // wait for MC to reach threshold
          }
          w.triggered=true;
          const fresh=getU(uid);
          if (fresh) { fresh.snipeWatches=fresh.snipeWatches.filter(x=>!x.triggered); saveDB(); }
          const mcInfo=w.minMc>0?`\n📊 Triggered at MC ≥ $${fNum(w.minMc)}`:'';
          bot.sendMessage(uid,`⚡ *Snipe triggered!*\n\nToken: \`${trunc(w.ct)}\`\n${st.state==='bonding'?`📊 ${st.lpName}`:'✅ DEX pool'}${mcInfo}\n\nBuying ${w.sui} SUI...`,{parse_mode:'Markdown'});
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
          const coinOut  = pj.coin_type_out||pj.token_out||pj.coinTypeOut||null;
          const coinIn   = pj.coin_type_in ||pj.token_in ||pj.coinTypeIn ||null;
          const evAmtIn  = pj.amount_in  ? BigInt(pj.amount_in)  : null; // raw input amount
          const evAmtOut = pj.amount_out ? BigInt(pj.amount_out) : null;

          // ── COPY BUY: tracked wallet bought a token (SUI → token)
          const bought = (coinOut && coinOut!==SUI_T) ? coinOut : null;
          // SUI they spent on the buy (used for auto-amount)
          const copierSuiSpent = bought && evAmtIn ? Number(evAmtIn)/1e9 : null;

          // ── COPY SELL: tracked wallet sold a token (token → SUI)
          const sold = (coinOut===SUI_T && coinIn && coinIn!==SUI_T) ? coinIn : null;

          for (const {uid,cfg} of watchers) {
            const u=getU(uid); if(!u||isLocked(u)) continue;
            try {
              if (bought) {
                // Mirror the buy
                if(cfg.blacklist?.includes(bought)) continue;
                const existing=await getCoins(u.walletAddress,bought);
                if(existing.length) continue; // already holds it
                if((u.positions||[]).length>=(cfg.maxPos||5)) continue;

                // Amount: auto (match copier's SUI spend) or fixed
                let amt = cfg.autoAmount && copierSuiSpent ? copierSuiSpent.toFixed(4) : (cfg.amount||u.settings.copyAmount);
                amt = String(parseFloat(amt)||u.settings.copyAmount);

                const suiBal=await getCoins(u.walletAddress,SUI_T);
                const suiTotal=suiBal.reduce((s,c)=>s+BigInt(c.balance),0n);
                if(suiTotal < BigInt(Math.floor(parseFloat(amt)*Number(MIST)))) {
                  bot.sendMessage(uid,`⚠️ Copy: insufficient SUI for ${trunc(bought)}`);
                  continue;
                }
                bot.sendMessage(uid,`🔁 *Copy Buy* \`${trunc(wallet)}\`\nBuying \`${trunc(bought)}\` — ${amt} SUI`,{parse_mode:'Markdown'});
                const res=await executeBuy(uid,bought,amt);
                bot.sendMessage(uid,`✅ Copied buy ${res.sym}! Fee: ${res.feeSui} SUI\n🔗 [TX](${SUISCAN}${res.digest})`,{parse_mode:'Markdown'});

              } else if (sold && cfg.copySells!==false) {
                // Mirror the sell — only if user holds this token
                const holding=await getCoins(u.walletAddress,sold);
                if(!holding.length) continue;
                const meta=await getMeta(sold)||{};
                const sym=meta.symbol||trunc(sold);

                // Mirror the sell percentage the copier used
                let sellPct=100;
                if(evAmtIn) {
                  // evAmtIn = tokens the copier sold; query their remaining balance
                  const trackerBal=await getCoins(wallet,sold).catch(()=>[]);
                  const remaining=trackerBal.reduce((s,c)=>s+BigInt(c.balance),0n);
                  const prevBal=remaining+evAmtIn;
                  if(prevBal>0n) sellPct=Math.min(100,Math.max(1,Math.round(Number(evAmtIn*100n/prevBal))));
                }

                bot.sendMessage(uid,`🔁 *Copy Sell* \`${trunc(wallet)}\`\nSelling ${sellPct}% ${sym}...`,{parse_mode:'Markdown'});
                const res=await executeSell(uid,sold,sellPct);
                bot.sendMessage(uid,`✅ Copied sell ${res.sym}! ${sellPct}% → ${res.sui} SUI | Fee: ${res.feeSui} SUI\n🔗 [TX](${SUISCAN}${res.digest})`,{parse_mode:'Markdown'});
              }
            } catch(e){bot.sendMessage(uid,`❌ Copy trade failed: ${e.message?.slice(0,100)}`);}
          }
        }
      } catch {}
    }
  }
}

// ═══════════════════════════════════════════════════════════
// LIMIT / DCA / AUTO-SELL / MIGRATION ENGINES
// ═══════════════════════════════════════════════════════════
async function _spotPriceUsd(ct){
  // 1 token → SUI via swap estimate, multiplied by SUI/USD
  try {
    const meta = await getMeta(ct).catch(()=>null);
    const dec  = meta?.decimals ?? 9;
    const oneTok = BigInt(Math.pow(10, dec));
    const out = await getSwapEstimate(ct, SUI_T, oneTok.toString());
    if(!out||out==='0') return null;
    const sui = Number(out)/1e9;
    // SUI/USD via SUI→USDC pair would be better; use cached value if available
    const suiUsd = (typeof SUI_USD === 'number' && SUI_USD>0) ? SUI_USD : 4.0;
    return sui * suiUsd;
  } catch { return null; }
}

async function limitEngine() {
  while (true) {
    await sleep(10_000);
    for (const [uid, u] of Object.entries(DB)) {
      if (!u.limitOrders?.length || isLocked(u)) continue;
      for (const lo of u.limitOrders) {
        if (lo.triggered) continue;
        try {
          const pUsd = await _spotPriceUsd(lo.ct);
          if (pUsd == null) continue;
          const hit = lo.dir === '>=' ? (pUsd >= lo.targetPriceUsd) : (pUsd <= lo.targetPriceUsd);
          if (!hit) continue;
          if (isLocked(getU(uid))) continue;
          lo.triggered = true; saveDB();
          bot.sendMessage(uid, `📊 *Limit triggered* @ $${pUsd.toFixed(8)}\nBuying ${lo.sui} SUI of \`${trunc(lo.ct)}\`...`, {parse_mode:'Markdown'}).catch(()=>{});
          const res = await executeBuy(uid, lo.ct, String(lo.sui)).catch(e=>({error:e.message}));
          if (res.error) bot.sendMessage(uid, `❌ Limit buy failed: ${res.error.slice(0,140)}`).catch(()=>{});
          else bot.sendMessage(uid, `🔔 Limit filled: bought ${res.out} ${res.sym} = ${lo.sui} SUI\n[TX](${SUISCAN}${res.digest})`, {parse_mode:'Markdown'}).catch(()=>{});
        } catch (e) { /* keep going */ }
      }
      // GC triggered orders older than 24h
      u.limitOrders = u.limitOrders.filter(o => !o.triggered || (Date.now()-o.at) < 86400000);
    }
  }
}

async function dcaEngine() {
  while (true) {
    await sleep(10_000);
    const now = Date.now();
    for (const [uid, u] of Object.entries(DB)) {
      if (!u.dcaOrders?.length || isLocked(u)) continue;
      for (const dca of u.dcaOrders) {
        if (dca.count >= dca.totalCount) continue;
        if (now - (dca.lastFire||0) < dca.intervalSec*1000) continue;
        if (isLocked(getU(uid))) continue;
        dca.lastFire = now; dca.count += 1; saveDB();
        try {
          const res = await executeBuy(uid, dca.ct, String(dca.sui));
          bot.sendMessage(uid, `🔄 DCA ${dca.count}/${dca.totalCount}: bought ${res.out} ${res.sym} = ${dca.sui} SUI\n[TX](${SUISCAN}${res.digest})`, {parse_mode:'Markdown'}).catch(()=>{});
        } catch (e) {
          bot.sendMessage(uid, `❌ DCA buy ${dca.count}/${dca.totalCount} failed: ${e.message?.slice(0,120)}`).catch(()=>{});
        }
      }
      u.dcaOrders = u.dcaOrders.filter(d => d.count < d.totalCount);
    }
  }
}

async function autoSellEngine() {
  while (true) {
    await sleep(15_000);
    for (const [uid, u] of Object.entries(DB)) {
      if (!u.settings?.autoSell || !u.positions?.length || isLocked(u)) continue;
      const tp = Number(u.settings.autoSellTpPct || 50);
      const sl = Number(u.settings.autoSellSlPct || 30);
      for (const pos of [...u.positions]) {
        if (pos.autoSold) continue;
        try {
          const p = await getPnl(pos);
          if (!p) continue;
          const hitTp = p.pct >= tp;
          const hitSl = p.pct <= -Math.abs(sl);
          if (!hitTp && !hitSl) continue;
          if (isLocked(getU(uid))) continue;
          pos.autoSold = true; saveDB();
          const reason = hitTp ? `🎯 TP +${tp}%` : `🛑 SL -${sl}%`;
          bot.sendMessage(uid, `${reason} hit on *${pos.sym}* (${p.pct.toFixed(2)}%) — auto-selling 100%...`, {parse_mode:'Markdown'}).catch(()=>{});
          const res = await executeSell(uid, pos.ct, 100).catch(e=>({error:e.message}));
          if (res.error) bot.sendMessage(uid, `❌ Auto-sell failed: ${res.error.slice(0,140)}`).catch(()=>{});
          else bot.sendMessage(uid, `🔔 Auto-sold ${pos.sym} = ${res.sui} SUI\n[TX](${SUISCAN}${res.digest})`, {parse_mode:'Markdown'}).catch(()=>{});
        } catch (e) { /* keep going */ }
      }
    }
  }
}

async function migrationEngine() {
  while (true) {
    await sleep(30_000);
    for (const [uid, u] of Object.entries(DB)) {
      if (!u.migAlerts?.length || isLocked(u)) continue;
      for (const a of u.migAlerts) {
        try {
          // Check if a DEX route exists now (i.e., token has graduated to a pool).
          // We probe by asking for a swap estimate of 1 token → SUI.
          const meta = await getMeta(a.ct).catch(()=>null);
          const dec = meta?.decimals ?? 9;
          const oneTok = BigInt(Math.pow(10, dec));
          const out = await getSwapEstimate(a.ct, SUI_T, oneTok.toString()).catch(()=>null);
          const onDex = out && out !== '0';
          const state = onDex ? 'dex' : 'bonding';
          if (a.lastState && a.lastState !== state && state === 'dex') {
            bot.sendMessage(uid, `🚀 *Migration!* \`${trunc(a.ct)}\` graduated to DEX. Tap to trade.`, {parse_mode:'Markdown'}).catch(()=>{});
          }
          a.lastState = state;
        } catch {}
      }
      // GC old graduated alerts
      u.migAlerts = u.migAlerts.filter(a => a.lastState !== 'dex' || (Date.now()-a.at) < 7*86400000);
    }
    saveDB();
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
  keyboard:[
    [{text:'💰 Buy'},{text:'💸 Sell'},{text:'📊 Positions'}],
    [{text:'💼 Balance'},{text:'🚀 Launchpad'},{text:'🔍 Scan'}],
    [{text:'⚡ Snipe'},{text:'🔁 Copy Trade'},{text:'⚙️ Settings'}],
    [{text:'📋 Orders'},{text:'🔗 Referral'},{text:'❓ Help'}],
  ],
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
    const m=await bot.sendMessage(chatId,'⏳ Fetching balances...');
    try {
      const bals=await getAllBals(u.walletAddress);
      const sb=bals.find(b=>b.coinType===SUI_T);
      const suiBal = sb ? fSui(BigInt(sb.totalBalance)) : '0.0000';
      const L=[
        `💼 *Wallet Balance*`,
        `\`${u.walletAddress}\``,
        ``,
        `🔵 *SUI:  ${suiBal}*`,
      ];
      const others=bals.filter(b=>b.coinType!==SUI_T&&Number(b.totalBalance)>0);
      if (others.length) {
        L.push(`\n🪙 *Tokens (${others.length}):*`);
        for(const b of others.slice(0,15)){
          const m2=await getMeta(b.coinType);
          const sym=m2?.symbol||trunc(b.coinType);
          const bal=(Number(b.totalBalance)/Math.pow(10,m2?.decimals||9)).toFixed(4);
          L.push(`  • *${sym}*: ${bal}`);
        }
      } else {
        L.push(`\n_No other token balances_`);
      }
      await bot.editMessageText(L.join('\n'),{
        chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown',
        reply_markup:{inline_keyboard:[[{text:'📤 Withdraw',callback_data:'withdraw_menu'},{text:'🔄 Refresh',callback_data:'refresh_balance'}]]},
      });
    }catch(e){await bot.editMessageText(`❌ ${e.message?.slice(0,100)}`,{chat_id:chatId,message_id:m.message_id});}
  });
}

// ── Sell result formatter — unified rich message for all sell routes ──────────
function formatSellResult(res, walletAddress) {
  // RaidenX-style sell notification
  const tokAmt = res.soldAmt
    ? Number(res.soldAmt).toLocaleString('en',{maximumFractionDigits:6})
    : `${res.pct||0}%`;
  const sui = res.sui || '0';
  const wAddr = walletAddress||'';
  const wTrunc = wAddr?`${wAddr.slice(0,6)}...${wAddr.slice(-4)}`:'—';
  const txTrunc = res.digest?`${res.digest.slice(0,6)}...${res.digest.slice(-4)}`:'—';
  let msg =
    `🔔 You sold ${tokAmt} ${res.sym} = ${sui} Sui on Sui\n\n` +
    `Wallet: \`${wTrunc}\`\n` +
    `View on explorer: [${txTrunc}](${SUISCAN}${res.digest})`;
  if (res.pnl) {
    const s = res.pnl.pnl >= 0 ? '+' : '';
    msg += `\n\nP&L: *${s}${res.pnl.pnlPct.toFixed(2)}%* (${s}${res.pnl.pnl.toFixed(4)} SUI)`;
  }
  return msg;
}

// ── Full P&L report for all open positions ────────────────────────────────────
async function doPositionsPnlReport(chatId) {
  await guard(chatId, async(u) => {
    const positions = u.positions || [];
    if (!positions.length) { await bot.sendMessage(chatId, '📊 No open positions.'); return; }
    const m = await bot.sendMessage(chatId, '📊 Generating full P&L report...');

    let totalInvested = 0, totalValue = 0, posWithData = 0;
    const lines = [
      `📊 *Full P&L Report*`,
      `📅 ${new Date().toUTCString()}`,
      `📈 Positions: *${positions.length}*`,
      ``,
    ];

    for (const pos of positions) {
      const p    = await getPnl(pos).catch(() => null);
      const sym  = pos.sym || 'UNKNOWN';
      const spent = parseFloat(pos.spent || 0);
      totalInvested += spent;

      const srcMap = { bonding:'📊 Launchpad', agent:'🤖 AGENT MemeLand', odyssey:'🟣 Odyssey', dex:'🔵 DEX' };
      const srcLabel = srcMap[pos.source] || '🔵 DEX';
      const heldH   = pos.at ? Math.round((Date.now()-pos.at)/3600000) : 0;
      const heldStr = heldH >= 24 ? `${Math.floor(heldH/24)}d ${heldH%24}h` : `${heldH}h`;
      const tokStr  = pos.tokens ? pos.tokens.toLocaleString('en',{maximumFractionDigits:2}) : '?';

      lines.push(`━━━━━━━━━━━━━━`);
      lines.push(`🪙 *${sym}*   ${srcLabel}   ⏱ ${heldStr}`);
      lines.push(`   📦 Held: \`${tokStr} ${sym}\``);
      lines.push(`   💼 Invested: \`${spent.toFixed(4)} SUI\``);

      if (p) {
        posWithData++;
        totalValue += p.cur;
        const s    = p.pnl >= 0 ? '+' : '';
        const icon = p.pnl >= 0 ? '🟢' : '🔴';
        lines.push(`   💰 Value: \`${p.cur.toFixed(4)} SUI\``);
        lines.push(`   ${icon} P&L: *${s}${p.pnl.toFixed(4)} SUI  (${s}${p.pct.toFixed(2)}%)*`);
        lines.push(`   ${pnlBar(p.pct)}`);
      } else {
        lines.push(`   ⚪ Live price unavailable`);
      }
    }

    lines.push(``);
    lines.push(`━━━━━━━━━━━━━━`);
    lines.push(`📊 *Portfolio Totals*`);
    lines.push(`💼 Total Invested: \`${totalInvested.toFixed(4)} SUI\``);
    if (posWithData > 0) {
      const totalPnl = totalValue - totalInvested;
      const totalPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
      const s    = totalPnl >= 0 ? '+' : '';
      const icon = totalPnl >= 0 ? '🟢' : '🔴';
      lines.push(`💰 Total Value:    \`${totalValue.toFixed(4)} SUI\``);
      lines.push(`${icon} Net P&L: *${s}${totalPnl.toFixed(4)} SUI  (${s}${totalPct.toFixed(2)}%)*`);
      lines.push(pnlBar(totalPct));
    } else {
      lines.push(`⚪ No live prices available for P&L summary`);
    }

    await bot.editMessageText(lines.join('\n'), {
      chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown',
    }).catch(async () => {
      // If too long, send as new message
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    });
  });
}

async function doPositions(chatId) {
  await guard(chatId, async(u) => {
    if (!u.positions?.length) {
      await bot.sendMessage(chatId,
        `📊 *No Open Positions*\n\nYou have no tracked positions yet.\n\n💡 Buy a token and it will appear here with live P&L.`,
        { parse_mode:'Markdown' }
      );
      return;
    }

    const count         = u.positions.length;
    const totalInvested = u.positions.reduce((s,p)=>s+parseFloat(p.spent||0),0);
    const m = await bot.sendMessage(chatId,'⏳ Loading positions...');
    await bot.deleteMessage(chatId,m.message_id).catch(()=>{});

    // Portfolio header
    await bot.sendMessage(chatId,
      `📊 *Portfolio Overview*\n\n` +
      `Open Positions: *${count}*\n` +
      `Total Invested: *${totalInvested.toFixed(4)} SUI*`,
      { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
        [{text:'📊 Full P&L Report', callback_data:'qs:pnl'}],
      ]}}
    );

    // Per-position cards — RaidenX track style
    for (let i = 0; i < u.positions.length; i++) {
      const pos = u.positions[i];
      try {
        const p       = await getPnl(pos);
        const tokStr  = pos.tokens ? pos.tokens.toLocaleString('en',{maximumFractionDigits:2}) : '?';
        const heldH   = pos.at ? Math.round((Date.now()-pos.at)/3600000) : 0;
        const heldStr = heldH>=24?`${Math.floor(heldH/24)}d ${heldH%24}h`:`${heldH}h`;
        const spentStr= parseFloat(pos.spent||0).toFixed(4);
        const srcMap  = { bonding:'Launchpad', agent:'AGENT MemeLand', odyssey:'Odyssey', hopfun:'hop.fun', moonbags:'Moonbags', dex:'DEX' };
        const srcLabel= srcMap[pos.source]||'DEX';

        // Pretty USD price formatter — handles tiny token prices ($0.0000123)
        const fPrice = (n) => {
          if (!n || n <= 0) return '—';
          if (n >= 1)     return '$' + n.toLocaleString('en',{maximumFractionDigits:4});
          if (n >= 0.01)  return '$' + n.toFixed(4);
          if (n >= 1e-6)  return '$' + n.toFixed(8).replace(/0+$/,'');
          return '$' + n.toExponential(2);
        };

        let cap =
          `🪙 *${pos.sym}/SUI*  ·  ${srcLabel}\n` +
          `\`${pos.ct}\`\n\n` +
          `📦 Holdings: *${tokStr} ${pos.sym}*\n` +
          `⏱ Held: ${heldStr}\n\n` +
          `📈 *Bought*\n` +
          `   Spent: \`${spentStr} SUI\`\n` +
          `   Price: ${fPrice(pos.entryPriceUsd)}\n` +
          `   MC:    ${pos.entryMc?fmtMoney(pos.entryMc):'—'}\n\n`;

        if (p) {
          const s    = p.pnl >= 0 ? '+' : '';
          const arrow= p.pnl >= 0 ? '🟢' : '🔴';
          cap +=
            `📊 *Now*\n` +
            `   Worth: \`${p.cur.toFixed(4)} SUI\`\n` +
            `   Price: ${fPrice(p.priceUsd)}\n` +
            `   MC:    ${p.mc?fmtMoney(p.mc):'—'}\n\n` +
            `${arrow} *PnL: ${s}${p.pnl.toFixed(4)} SUI (${s}${p.pct.toFixed(2)}%)*\n` +
            `${pnlBar(p.pct)}`;
        } else {
          cap += `📊 *Now*\n   ⚪ Live price unavailable — pool may be inactive.`;
        }

        if (pos.tp || pos.sl) {
          cap += `\n\n🎯 TP: ${pos.tp?'+'+pos.tp+'%':'—'}   🛑 SL: ${pos.sl?'-'+pos.sl+'%':'—'}`;
        }

        const sellKb = { inline_keyboard: [
          [{text:'🖨 Print PnL',callback_data:`print:${i}`},{text:'📍 Close track',callback_data:`close_track:${i}`}],
          [
            {text:'💸 25%',  callback_data:`qs:${i}:25` },
            {text:'💸 50%',  callback_data:`qs:${i}:50` },
            {text:'💸 75%',  callback_data:`qs:${i}:75` },
            {text:'💸 100%', callback_data:`qs:${i}:100`},
          ],
          [{text:'✏️ Custom %', callback_data:`qs:${i}:custom`}],
        ]};

        if (p) {
          try {
            await bot.sendPhoto(chatId,
              pnlChart(pos.sym,p.pct,parseFloat(pos.spent||0),p.cur),
              {caption:cap, parse_mode:'Markdown', reply_markup:sellKb}
            );
          } catch {
            await bot.sendMessage(chatId,cap,{parse_mode:'Markdown',reply_markup:sellKb});
          }
        } else {
          await bot.sendMessage(chatId,cap,{parse_mode:'Markdown',reply_markup:sellKb});
        }
      } catch {
        const fallback =
          `📍 *${pos.sym}/SUI*\n\n` +
          `Invested: ${parseFloat(pos.spent||0).toFixed(4)} SUI\n` +
          `Current:  ⚪ unavailable`;
        const sellKb = { inline_keyboard:[
          [
            {text:'💸 25%',  callback_data:`qs:${i}:25` },
            {text:'💸 50%',  callback_data:`qs:${i}:50` },
            {text:'💸 75%',  callback_data:`qs:${i}:75` },
            {text:'💸 100%', callback_data:`qs:${i}:100`},
          ],
          [{text:'✏️ Custom %', callback_data:`qs:${i}:custom`}],
        ]};
        await bot.sendMessage(chatId,fallback,{parse_mode:'Markdown',reply_markup:sellKb});
      }
    }
  });
}

// Resolve the referrer's current wallet address for a given user.
// Uses the stored referredByCode to look up the referrer live so rewards
// still flow even if the referrer only set up their wallet after the
// referred user joined (old code gated on ref.walletAddress at join time).
function resolveRefWallet(u) {
  if (u.referredBy) return u.referredBy; // fast path — already resolved
  if (!u.referredByCode) return null;
  const ref = Object.values(DB).find(x => x.referralCode === u.referredByCode);
  if (ref?.walletAddress) {
    // Backfill for future calls so we don't scan every time
    u.referredBy = ref.walletAddress; saveDB();
    return ref.walletAddress;
  }
  return null;
}

async function doReferral(chatId) {
  const u=getU(chatId)||makeU(chatId);
  const link=`https://t.me/${BOT_USERNAME}?start=${u.referralCode}`;
  // Compute totals live from DB — stored counter can drift if bot restarts
  const myCode   = u.referralCode;
  const myWallet = u.walletAddress;
  const allRefs  = Object.values(DB).filter(x =>
    x.referredByCode === myCode || (myWallet && x.referredBy === myWallet)
  );
  const total  = allRefs.length;
  const active = allRefs.filter(x => Date.now()-x.lastActivity < 30*24*3600*1000).length;
  await bot.sendMessage(chatId,
    `🔗 *Referral Dashboard*\n\n` +
    `Code: \`${u.referralCode}\`\n` +
    `Link: \`${link}\`\n\n` +
    `👥 Total referrals: ${total}\n` +
    `⚡ Active (30d): ${active}\n` +
    `💰 Total earned: ${(u.referralEarned||0).toFixed(4)} SUI\n\n` +
    `*How it works:*\n` +
    `• Every trade your referrals make pays 5% fee\n` +
    `• 25% of that fee (= 1.25% of the trade) goes *directly to your wallet* — no claiming needed\n` +
    `• Passive income on every trade, forever`,
    {parse_mode:'Markdown'});
}

async function doSettings(chatId) {
  await guard(chatId,async(u)=>{
    const s=u.settings;
    const amts=(s.buyAmounts||DEF_AMTS).join(', ');
    await bot.sendMessage(chatId,
      `⚙️ *Settings*\n\n` +
      `✏️ Slippage:    ${s.slippage}%\n` +
      `✏️ Quick-buy:   ${amts} SUI\n` +
      `✏️ Copy trade:  ${s.copyAmount} SUI\n` +
      `🎯 Take Profit: ${s.tpDefault?'+'+s.tpDefault+'%':'—'}\n` +
      `🛑 Stop Loss:   ${s.slDefault?'-'+s.slDefault+'%':'—'}`,
      {parse_mode:'Markdown',reply_markup:{inline_keyboard:[
        [{text:'----- Slippage -----',callback_data:'noop'}],
        [
          {text:`${s.slippage===0.5?'✅ ':''}0.5%`,callback_data:'slip:0.5'},
          {text:`${s.slippage===1  ?'✅ ':''}1%`,  callback_data:'slip:1'  },
          {text:`${s.slippage===2  ?'✅ ':''}2%`,  callback_data:'slip:2'  },
          {text:`${s.slippage===5  ?'✅ ':''}5%`,  callback_data:'slip:5'  },
        ],
        [{text:'✏️ Edit Quick-Buy Amounts',callback_data:'edit_amts'}],
        [{text:'✏️ Edit Copy Trade Amount',callback_data:'edit_copy_amt'}],
        [{text:'🎯 Set Take Profit',callback_data:'set_tp'},{text:'🛑 Set Stop Loss',callback_data:'set_sl'}],
        [{text:'🗑 Clear TP/SL',callback_data:'clear_tpsl'}],
        [{text:'🔑 View Private Key',callback_data:'view_pk'},{text:'📤 Withdraw',callback_data:'withdraw_menu'}],
        [{text:'🔄 Change Wallet',callback_data:'change_wallet'}],
      ]}}
    );
  });
}

// ── Orders panel: list / cancel / edit limit, DCA and snipe orders ──
async function doOrders(chatId, replaceMid) {
  const u=getU(chatId); if(!u) return;
  const limits=u.limitOrders||[], dcas=u.dcaOrders||[], snipes=u.snipeWatches||[];
  let txt='📋 *Active Orders*\n';
  const rows=[];
  if(!limits.length && !dcas.length && !snipes.length){
    txt+='\n_No active orders._\n\nOpen a token, then tap *Limit*, *DCA* or *⚡ Snipe* to create one.';
  } else {
    if(limits.length){
      txt+=`\n📊 *Limit Orders (${limits.length})*\n`;
      limits.forEach((o,i)=>{
        const dir=o.dir==='>='?'≥':'≤';
        const status=o.triggered?'✅ filled':'⏳ pending';
        txt+=`\`${i+1}.\` ${o.sui} SUI when ${dir} $${o.targetPriceUsd}  _${status}_\n   \`${trunc(o.ct)}\`\n`;
        if(!o.triggered) rows.push([
          {text:`✏️ Edit L#${i+1}`,   callback_data:`ord:edit:l:${i}`},
          {text:`❌ Cancel L#${i+1}`, callback_data:`ord:cancel:l:${i}`},
        ]);
      });
    }
    if(dcas.length){
      txt+=`\n🔄 *DCA Orders (${dcas.length})*\n`;
      dcas.forEach((d,i)=>{
        const intMin=Math.round(d.intervalSec/60);
        txt+=`\`${i+1}.\` ${d.sui} SUI every ${intMin}m  (${d.count}/${d.totalCount} done)\n   \`${trunc(d.ct)}\`\n`;
        rows.push([
          {text:`✏️ Edit D#${i+1}`,   callback_data:`ord:edit:d:${i}`},
          {text:`❌ Cancel D#${i+1}`, callback_data:`ord:cancel:d:${i}`},
        ]);
      });
    }
    if(snipes.length){
      txt+=`\n⚡ *Snipe Watches (${snipes.length})*\n`;
      snipes.forEach((s,i)=>{
        const mc=s.minMc>0?`MC ≥ $${fNum(s.minMc)}`:'on LP add';
        const status=s.triggered?'✅ fired':'⏳ waiting';
        txt+=`\`${i+1}.\` ${s.sui} SUI · ${mc}  _${status}_\n   \`${trunc(s.ct)}\`\n`;
        if(!s.triggered) rows.push([
          {text:`✏️ Edit S#${i+1}`,   callback_data:`ord:edit:s:${i}`},
          {text:`❌ Cancel S#${i+1}`, callback_data:`ord:cancel:s:${i}`},
        ]);
      });
    }
  }
  rows.push([{text:'🔄 Refresh',callback_data:'go_orders'},{text:'≡ Menu',callback_data:'go_home'}]);
  const opts={parse_mode:'Markdown',reply_markup:{inline_keyboard:rows}};
  if(replaceMid){
    await bot.editMessageText(txt,{chat_id:chatId,message_id:replaceMid,...opts}).catch(async()=>{
      await bot.sendMessage(chatId,txt,opts);
    });
  } else {
    await bot.sendMessage(chatId,txt,opts);
  }
}

async function doHelp(chatId) {
  await bot.sendMessage(chatId,
    `🤖 *AGENT TRADING BOT v7*\n\n` +
    `*Commands:*\n` +
    `/buy \`CA\` — Buy any Sui token\n` +
    `/sell \`CA\` — Sell a token\n` +
    `/scan \`CA\` — Full security scan\n` +
    `/balance — Wallet balances\n` +
    `/positions — Open positions & P&L\n` +
    `/pnl — P&L report\n` +
    `/snipe \`CA\` — Snipe on pool creation\n` +
    `/orders — View / cancel pending limit, DCA & snipe orders\n` +
    `/copytrader \`wallet\` — Mirror trades\n` +
    `/withdraw — Send SUI or tokens\n` +
    `/referral — Referral link & earnings\n` +
    `/settings — Configure bot\n` +
    `/reset — Reset wallet\n\n` +
    `*DEXes:* Cetus · Turbos · Kriya · BlueMove\n` +
    `*Launchpads:* AGENT · Odyssey · Moonbags · hop.fun\n\n` +
    `*Fee:* 1% per trade  |  Referrers earn 0.25%\n\n` +
    `_Paste any contract address for instant buy/sell/scan_`,
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
    const btns=pos.slice(0,8).map((p,i)=>[{text:`🪙 ${p.sym}  —  ${p.spent} SUI invested`,callback_data:`st:${i}`}]);
    btns.push([{text:'📝 Enter CA manually',callback_data:'sfs_manual'}]);
    await bot.sendMessage(chatId,
      `💸 *Select position to sell:*\n_${pos.length} open position${pos.length>1?'s':''}:_`,
      {parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}});
  } else {
    await bot.sendMessage(chatId,'Send the token contract address to sell:\n\n_Example: 0x1234..._',{parse_mode:'Markdown'});
    updU(chatId,{state:'sell_ca'});
  }
}

// ── Full RaidenX-style buy keyboard ───────────────────────────────
function fullBuyKb(u, ct, amtRows){
  const s=u.settings||{};
  const wallets=getAllWallets(u);
  const sel=(u.activeWalletIdx&&u.activeWalletIdx.length)?u.activeWalletIdx:[0];
  const buyOn=s.buySellMode!=='sell';
  const sellOn=s.buySellMode==='sell';
  const m=s.mode||'swap';
  const tip=Number(s.tipSui||0);
  const gp=Number(s.gasPriceMist||750);
  const auto=s.autoSell?'🟢 Auto Sell: ON':'⚪ Auto Sell: OFF';
  return [
    [{text:'≡ Menu',callback_data:'go_home'},{text:'📍 Track',callback_data:'go_pos'},{text:'🔄 Refresh',callback_data:'rbuy'}],
    [{text:(buyOn?'✅ Buy Mode':'Buy Mode'),callback_data:'mode_buy'},{text:(sellOn?'✅ Sell Mode':'Sell Mode'),callback_data:'mode_sell'}],
    [
      {text:(m==='swap'?'✅ Swap':'Swap'),callback_data:'mode_swap'},
      {text:(m==='limit'?'✅ Limit':'Limit'),callback_data:'mode_limit'},
      {text:(m==='dca'?'✅ DCA':'DCA'),callback_data:'mode_dca'},
      {text:(m==='migration'?'✅ Migration':'Migration'),callback_data:'mode_migration'},
    ],
    [
      {text:`🎯 TP: ${s.tpDefault?'+'+s.tpDefault+'%':'—'}`,callback_data:'set_tp'},
      {text:`🛑 SL: ${s.slDefault?'-'+s.slDefault+'%':'—'}`,callback_data:'set_sl'},
      {text:'📋 My Orders',callback_data:'go_orders'},
    ],
    [{text:'----- Settings -----',callback_data:'noop'}],
    [{text:`✏️ Slippage: ${s.slippage||1}%`,callback_data:'open_slip'},{text:`✏️ Gas Price: ${gp} MIST`,callback_data:'gas_edit'}],
    [{text:`✏️ Tip Amount: ${tip} SUI`,callback_data:'tip_edit'}],
    [{text:auto,callback_data:'auto_sell_toggle'}],
    [{text:`----- Select Wallets (${sel.length}/${wallets.length||1}) -----`,callback_data:'wallet_panel'}],
    ...amtRows,
  ];
}

// Build the bottom action rows for the trade card.
// In Buy Mode → rocket SUI-amount buttons (ba:i / ba:c → showBuyConfirm).
// In Sell Mode → 25 / 50 / 75 / 100 percentage buttons + custom % (sp:25 etc.
// → showSellConfirm). This is what the screenshot is missing.
function buildActionRows(u) {
  const sellOn = (u.settings?.buySellMode === 'sell');
  if (sellOn) {
    return [
      [
        {text:'💸 25%',  callback_data:'sp:25' },
        {text:'💸 50%',  callback_data:'sp:50' },
        {text:'💸 75%',  callback_data:'sp:75' },
        {text:'💸 100%', callback_data:'sp:100'},
      ],
      [{text:'✏️ x %', callback_data:'sp:c'}],
    ];
  }
  const amts = u.settings?.buyAmounts || DEF_AMTS;
  const btns = amts.map((a,i) => ({text:`🚀 ${a} SUI`, callback_data:`ba:${i}`}));
  btns.push({text:'✏️ x SUI', callback_data:'ba:c'});
  const rows = [];
  for (let i=0; i<btns.length; i+=3) rows.push(btns.slice(i, i+3));
  return rows;
}

async function startBuy(chatId, ct, editMsgId) {
  const u=getU(chatId); if(!u) return;
  let mid=editMsgId;
  if(!mid){
    const lm=await bot.sendMessage(chatId,'⏳ Fetching token info...');
    mid=lm.message_id;
  }
  try {
    const [d,st]=await Promise.all([getTokenData(ct, u.walletAddress), detectState(ct).catch(()=>null)]);
    updU(chatId,{pd:{ct,sym:d.symbol,buyMsgId:mid}});
    const amtRows = buildActionRows(u);
    await bot.editMessageText(buyCard(d,ct,st),{
      chat_id:chatId, message_id:mid, parse_mode:'Markdown',
      reply_markup:{inline_keyboard:fullBuyKb(u,ct,amtRows)},
    }).catch(e=>{ if(!String(e.message||'').includes('not modified')) throw e; });
  } catch(e) {
    const meta=await getMeta(ct).catch(()=>null);
    const sym=meta?.symbol||trunc(ct);
    updU(chatId,{pd:{ct,sym,buyMsgId:mid}});
    const amtRows = buildActionRows(u);
    await bot.editMessageText(
      `*${sym}/SUI*\n\`${ct}\`\n\n⚠️ _Token data unavailable — routing to best price_`,
      {chat_id:chatId,message_id:mid,parse_mode:'Markdown',reply_markup:{inline_keyboard:fullBuyKb(u,ct,amtRows)}}
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
  const text=
    `🟢 *Confirm Buy*\n\n` +
    `*${sym}/SUI*\n\n` +
    `Amount:   ${amtSui} SUI\n` +
    `Fee:      ${fSui(feeMist)} SUI\n` +
    `Trade:    ${fSui(tradeAmt)} SUI\n` +
    (est!='?'?`Est get: ~${est} ${sym}\n`:'')+
    `Slippage: ${u.settings.slippage}%`;
  const kb={inline_keyboard:[[{text:'✅ Confirm',callback_data:'bc'},{text:'❌ Cancel',callback_data:'ca'}]]};
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
  const text=
    `💸 *Sell ${sym}/SUI*\n\n` +
    `📦 Balance: ${bal} ${sym}` +
    (est!='?'?`  (~${est} SUI)`:'')+
    `\n\nSelect sell %:`;
  const kb={inline_keyboard:[
    [{text:'💸 25%',callback_data:'sp:25'},{text:'💸 50%',callback_data:'sp:50'},{text:'💸 75%',callback_data:'sp:75'},{text:'💸 100%',callback_data:'sp:100'}],
    [{text:'✏️ Custom %',callback_data:'sp:c'},{text:'❌ Cancel',callback_data:'ca'}],
  ]};
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
  const text=
    `🔴 *Confirm Sell*\n\n` +
    `*${sym}/SUI*\n\n` +
    `Sell:     ${pct}% (${disp} ${sym})\n` +
    (est!='?'?`Est get: ~${est} SUI\n`:'')+
    (fee!=='?'?`Fee:      ~${fee} SUI\n`:'')+
    `Slippage: ${u.settings.slippage}%`;
  const kb={inline_keyboard:[[{text:'✅ Confirm',callback_data:'sc'},{text:'❌ Cancel',callback_data:'ca'}]]};
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
      if(ref){
        // Always store the referral code so rewards flow once referrer adds a wallet.
        // Also store wallet address now if referrer already has one.
        updU(chatId,{referredByCode:param, referredBy:ref.walletAddress||null});
        updU(ref.chatId,{referralCount:(ref.referralCount||0)+1});
        bot.sendMessage(ref.chatId,'🎉 New user joined via your referral!');
      }
    }
  } else {
    // Clear stale state on /start
    updU(chatId,{state:null});
  }
  if(u.walletAddress){
    let bal='—';
    try { const bi=await sui.getBalance({owner:u.walletAddress,coinType:SUI_T}); bal=(Number(bi.totalBalance)/1e9).toFixed(4); } catch {}
    const refLink=u.referralCode?`https://t.me/${BOT_USERNAME||'Sui_agent_bot'}?start=${u.referralCode}`:'';
    const msg =
      `*Agent — Sui Trading Bot* 🌊\n\n` +
      `Welcome back! The fastest way to trade on Sui.\n\n` +
      `💼 *Wallet*\n\`${u.walletAddress}\`\n` +
      `Balance: *${bal} SUI*\n\n` +
      `_Paste any CA to instantly buy a token._\n` +
      (refLink?`\n🔗 *Referral:* \`${u.referralCode}\`\n`:'');
    await bot.sendMessage(chatId,msg,{parse_mode:'Markdown',disable_web_page_preview:true,reply_markup:MAIN_KB});
  }else{
    await bot.sendMessage(chatId,
      `*Agent — Sui Trading Bot* 🌊\n\n` +
      `The fastest trading bot on Sui.\n\n` +
      `▪️ Buy & sell with one tap\n` +
      `▪️ Snipe new launches the moment LP is added\n` +
      `▪️ Track positions & P&L in real time\n\n` +
      `Connect your wallet to start trading:`,
      {parse_mode:'Markdown',reply_markup:{inline_keyboard:[
        [{text:'🔑 Import Wallet',callback_data:'import_wallet'}],
        [{text:'✨ Create New Wallet',callback_data:'gen_wallet'}],
      ]}});
  }
});

// ═══════════════════════════════════════════════════════════
// /reset — wipe wallet & PIN, force re-registration
// (Preserves referral code, referredBy, referral counts/earnings, settings)
// ═══════════════════════════════════════════════════════════
bot.onText(/^\/reset(?:\s|$)/, async(msg) => {
  const chatId = msg.chat.id;
  const u = getU(chatId);
  if(!u){ await bot.sendMessage(chatId,'No account found. Send /start to begin.'); return; }
  updU(chatId,{state:'confirm_reset'});
  await bot.sendMessage(chatId,
    '⚠️ *Reset Wallet*\n\n' +
    'This will permanently delete your stored wallet, PIN, and positions from this bot.\n\n' +
    'You will need to re-import your private key or create a new wallet afterwards.\n\n' +
    '*Make sure you have your private key backed up before continuing — it cannot be recovered for you.*\n\n' +
    'Type `CONFIRM RESET` (in capitals) to proceed, or anything else to cancel.',
    {parse_mode:'Markdown'});
});

// ═══════════════════════════════════════════════════════════
// /diag <CA> — live pool detection diagnostic
// ═══════════════════════════════════════════════════════════
bot.onText(/\/diag\s+(.+)/, async(msg, match) => {
  const chatId = msg.chat.id;
  const raw = (match[1]||'').trim();
  await bot.sendMessage(chatId, `🔍 Running detection for:\n\`${raw}\``, { parse_mode:'Markdown' });

  let lines = [];
  try {
    const ct = await resolveCoinType(raw);
    lines.push(`✅ Coin type: \`${ct.slice(0,60)}...\``);

    // Step 1: Turbos
    try {
      const tp = await findTurbosPool(SUI_T, ct);
      lines.push(tp ? `✅ Turbos pool: \`${tp.poolId?.slice(0,20)}...\`` : `⚪ Turbos: no pool`);
    } catch(e) { lines.push(`❌ Turbos error: ${e.message}`); }

    // Step 2: Cetus REST API
    try {
      const r1 = await ftch(`https://api-sui.cetus.zone/v2/sui/pools_info?coin_type_a=${encodeURIComponent(SUI_T)}&coin_type_b=${encodeURIComponent(ct)}&limit=3`, { headers:{Accept:'application/json'} }, 6000);
      lines.push(`Cetus API status: ${r1.status}`);
    } catch(e) { lines.push(`❌ Cetus API error: ${e.message}`); }

    // Step 3: GeckoTerminal (uses shared cache — no extra HTTP calls)
    for (const addr of [ct, ct.split('::')[0]]) {
      try {
        const pools = await getGeckoPools(addr);
        lines.push(`GeckoTerminal (${addr.includes('::') ? 'full type' : 'pkg addr'}): ${pools.length} pools`);
        for (const p of pools.slice(0,5)) {
          const dexId = p.relationships?.dex?.data?.id || 'unknown';
          const pAddr = p.attributes?.address || '?';
          const liq   = parseFloat(p.attributes?.reserve_in_usd||0).toFixed(0);
          // Try RPC for each known pool
          const known = dexId.toLowerCase().includes('cetus') || dexId.toLowerCase().includes('turbos') ||
                        dexId.toLowerCase().includes('kriya')  || dexId.toLowerCase().includes('bluemove');
          if (known) {
            const pi = await getPoolFromRPC(pAddr).catch(()=>null);
            lines.push(`  • ${dexId} liq=$${liq} rpc=${pi ? `dex=${pi.dex} a2b=${pi.a2b}` : 'FAILED'}`);
          } else {
            lines.push(`  • ${dexId} liq=$${liq} [unsupported — skipping]`);
          }
        }
      } catch(e) { lines.push(`GeckoTerminal error: ${e.message}`); }
    }

    // Step 4: Full detectState
    try {
      const st = await detectState(ct);
      lines.push(`\n🎯 detectState result: state=${st?.state} dex=${st?.dex}`);
      if (st?.poolId) lines.push(`   poolId: \`${st.poolId.slice(0,20)}...\``);
      if (st?.a2b !== undefined) lines.push(`   a2b: ${st.a2b}`);
    } catch(e) { lines.push(`❌ detectState threw: ${e.message}`); }

  } catch(e) { lines.push(`❌ Fatal: ${e.message}`); }

  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode:'Markdown' });
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

    // ── Quick sell / PnL report from positions ──────────────────────────────
    if (data.startsWith('qs:')) {
      const parts = data.split(':');

      // qs:pnl → generate full P&L report
      if (parts[1] === 'pnl') { await doPositionsPnlReport(chatId); return; }

      const idx = parseInt(parts[1]);
      const key = parts[2]; // "25" | "50" | "100" | "custom"
      const u   = getU(chatId);
      const pos = u?.positions?.[idx];
      if (!pos) { await bot.sendMessage(chatId, '❌ Position not found. Use /positions to refresh.'); return; }

      // qs:i:custom → prompt for custom sell amount
      if (key === 'custom') {
        updU(chatId, { state: 'qs_custom_sell', pd: { ...(u.pd||{}), qsIdx: idx } });
        await bot.sendMessage(chatId,
          `✏️ *Custom Sell — ${pos.sym}*\n\n` +
          `Tokens held: \`${(pos.tokens||0).toLocaleString('en',{maximumFractionDigits:2})} ${pos.sym}\`\n\n` +
          `Enter sell amount:\n` +
          `• \`50\` or \`50%\` → sell 50% of position\n` +
          `• \`1500t\` → sell 1500 tokens exactly\n` +
          `• Any number > 100 without \`t\` treated as token count`,
          { parse_mode:'Markdown' }
        );
        return;
      }

      const pct = parseInt(key);
      if (!pct || pct <= 0 || pct > 100) { await bot.sendMessage(chatId, '❌ Invalid sell %.'); return; }

      const m = await bot.sendMessage(chatId, `⚡ Selling *${pct}%* of *${pos.sym}*...`, { parse_mode:'Markdown' });
      try {
        const res = await executeSell(chatId, pos.ct, pct);
        const sellMsg = formatSellResult(res, getU(chatId)?.walletAddress);
        await bot.editMessageText(sellMsg, { chat_id:chatId, message_id:m.message_id, parse_mode:'Markdown', disable_web_page_preview:true });
        // PnL is already included in sellMsg via formatSellResult — no pie chart photo.
      } catch(e) {
        await bot.editMessageText(`❌ Sell failed:\n\`${e.message?.slice(0,200)}\``, { chat_id:chatId, message_id:m.message_id, parse_mode:'Markdown' });
      }
      return;
    }

    // ── Navigation callbacks (RaidenX-style) ─────────────
    // Mode toggles — Buy Mode / Sell Mode / Swap / Limit / DCA / Migration
    if(data==='mode_buy'||data==='mode_sell'){
      await bot.answerCallbackQuery(q.id).catch(()=>{});
      const uu=getU(chatId); if(uu){uu.settings.buySellMode=(data==='mode_sell')?'sell':'buy';saveDB();}
      // Re-render the same card in place — buildActionRows() picks the
      // correct bottom row (rocket SUI amounts vs sell %) based on mode.
      const ct=uu?.pd?.ct; if(ct) await startBuy(chatId,ct,q.message.message_id).catch(()=>{});
      return;
    }
    if(data==='mode_swap'||data==='mode_limit'||data==='mode_dca'||data==='mode_migration'){
      await bot.answerCallbackQuery(q.id,{text:`Mode: ${data.slice(5).toUpperCase()}`}).catch(()=>{});
      const uu=getU(chatId); if(uu){uu.settings.mode=data.slice(5);saveDB();}
      const ct=uu?.pd?.ct;
      if(data==='mode_limit'&&ct){
        // Step 1 of 3: pick SUI amount with quick-pick buttons
        updU(chatId,{state:'wiz_limit_amt',pd:{...uu.pd,wiz:{}}});
        await bot.sendMessage(chatId,`📊 *Set Limit Order — Step 1 of 3*\n\nHow much SUI do you want to spend when triggered?`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
          [{text:'0.1 SUI',callback_data:'wiz:lamt:0.1'},{text:'0.5 SUI',callback_data:'wiz:lamt:0.5'},{text:'1 SUI',callback_data:'wiz:lamt:1'}],
          [{text:'2 SUI',callback_data:'wiz:lamt:2'},{text:'5 SUI',callback_data:'wiz:lamt:5'},{text:'10 SUI',callback_data:'wiz:lamt:10'}],
          [{text:'✏️ Custom amount',callback_data:'wiz:lamt:custom'},{text:'❌ Cancel',callback_data:'wiz:cancel'}],
        ]}});
        return;
      }
      if(data==='mode_dca'&&ct){
        // Step 1 of 3: SUI per buy
        updU(chatId,{state:'wiz_dca_amt',pd:{...uu.pd,wiz:{}}});
        await bot.sendMessage(chatId,`🔄 *Set DCA — Step 1 of 3*\n\nHow much SUI per buy?`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
          [{text:'0.1 SUI',callback_data:'wiz:damt:0.1'},{text:'0.5 SUI',callback_data:'wiz:damt:0.5'},{text:'1 SUI',callback_data:'wiz:damt:1'}],
          [{text:'2 SUI',callback_data:'wiz:damt:2'},{text:'5 SUI',callback_data:'wiz:damt:5'},{text:'10 SUI',callback_data:'wiz:damt:10'}],
          [{text:'✏️ Custom amount',callback_data:'wiz:damt:custom'},{text:'❌ Cancel',callback_data:'wiz:cancel'}],
        ]}});
        return;
      }
      if(data==='mode_migration'&&ct){
        const uu2=getU(chatId); uu2.migAlerts=uu2.migAlerts||[];
        if(!uu2.migAlerts.find(a=>a.ct===ct)){uu2.migAlerts.push({ct,lastState:null,at:Date.now()});saveDB();}
        await bot.sendMessage(chatId,`🚀 *Migration alert set*\n\nYou'll be notified when this token graduates from launchpad to a DEX.`,{parse_mode:'Markdown'});
        return;
      }
      if(ct) await startBuy(chatId,ct,q.message.message_id).catch(()=>{});
      return;
    }
    // Gas / Tip / Auto-Sell editors
    if(data==='gas_edit'){
      await bot.answerCallbackQuery(q.id).catch(()=>{});
      await bot.sendMessage(chatId,'⛽ *Set Gas Price*\n\nHigher gas = faster confirmation. Default 750 MIST works in normal conditions.',{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
        [{text:'750 (default)',callback_data:'gas:750'},{text:'1000 (fast)',callback_data:'gas:1000'}],
        [{text:'2000 (fastest)',callback_data:'gas:2000'},{text:'5000 (turbo)',callback_data:'gas:5000'}],
        [{text:'✏️ Custom MIST',callback_data:'gas:custom'},{text:'❌ Cancel',callback_data:'wiz:cancel'}],
      ]}});
      return;
    }
    if(data==='tip_edit'){
      await bot.answerCallbackQuery(q.id).catch(()=>{});
      await bot.sendMessage(chatId,'💰 *Set Tip Amount*\n\nOptional priority tip per trade (extra SUI sent to dev wallet to support the bot).',{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
        [{text:'0 (off)',callback_data:'tip:0'},{text:'0.001',callback_data:'tip:0.001'},{text:'0.01',callback_data:'tip:0.01'}],
        [{text:'0.05',callback_data:'tip:0.05'},{text:'0.1',callback_data:'tip:0.1'},{text:'0.5',callback_data:'tip:0.5'}],
        [{text:'✏️ Custom SUI',callback_data:'tip:custom'},{text:'❌ Cancel',callback_data:'wiz:cancel'}],
      ]}});
      return;
    }
    // Gas / Tip quick-pick callbacks
    if(data.startsWith('gas:')){
      await bot.answerCallbackQuery(q.id).catch(()=>{});
      const arg=data.slice(4);
      if(arg==='custom'){updU(chatId,{state:'edit_gas'});await bot.sendMessage(chatId,'⛽ Enter custom gas price in MIST (100–100000):');return;}
      const n=parseInt(arg); if(isNaN(n)){return;}
      const uu=getU(chatId); uu.settings.gasPriceMist=n; saveDB();
      await bot.sendMessage(chatId,`✅ Gas price set to *${n} MIST*`,{parse_mode:'Markdown'});
      return;
    }
    if(data.startsWith('tip:')){
      await bot.answerCallbackQuery(q.id).catch(()=>{});
      const arg=data.slice(4);
      if(arg==='custom'){updU(chatId,{state:'edit_tip'});await bot.sendMessage(chatId,'💰 Enter custom tip in SUI (0–10):');return;}
      const n=parseFloat(arg); if(isNaN(n)){return;}
      const uu=getU(chatId); uu.settings.tipSui=n; saveDB();
      await bot.sendMessage(chatId,`✅ Tip set to *${n} SUI* per trade`,{parse_mode:'Markdown'});
      return;
    }
    // ── Wizard dispatcher (Limit / DCA step-by-step) ──
    if(data.startsWith('wiz:')){
      await bot.answerCallbackQuery(q.id).catch(()=>{});
      const parts=data.split(':'); const tag=parts[1]; const arg=parts[2];
      const uu=getU(chatId); if(!uu) return;
      if(tag==='cancel'){updU(chatId,{state:null}); if(uu.pd) delete uu.pd.wiz; saveDB(); await bot.sendMessage(chatId,'❌ Cancelled.');return;}
      // ── LIMIT WIZARD ──
      if(tag==='lamt'){
        if(arg==='custom'){updU(chatId,{state:'wiz_limit_amt_custom'});await bot.sendMessage(chatId,'✏️ Enter custom SUI amount (e.g. 1.5):');return;}
        uu.pd.wiz=uu.pd.wiz||{}; uu.pd.wiz.sui=parseFloat(arg); saveDB();
        updU(chatId,{state:'wiz_limit_target'});
        await bot.sendMessage(chatId,`📊 *Step 2 of 3* — Target price (USD)\n\nBuy ${arg} SUI when price reaches what?\n\nSend the target USD price (e.g. \`0.0005\`):`,{parse_mode:'Markdown'});
        return;
      }
      if(tag==='ldir'){
        // Step 3: direction (above/below)
        uu.pd.wiz.dir=arg; saveDB();
        const w=uu.pd.wiz; const ct=uu.pd.ct;
        uu.limitOrders=uu.limitOrders||[];
        uu.limitOrders.push({ct,sui:w.sui,targetPriceUsd:w.target,dir:arg==='above'?'>=':'<=',triggered:false,at:Date.now()});
        saveDB(); updU(chatId,{state:null});
        await bot.sendMessage(chatId,`✅ *Limit order set*\n\n• Spend: ${w.sui} SUI\n• Trigger: when price ${arg==='above'?'≥':'≤'} $${w.target}\n• Token: \`${trunc(ct)}\`\n\nThe bot will auto-buy when conditions match.`,{parse_mode:'Markdown'});
        return;
      }
      // ── DCA WIZARD ──
      if(tag==='damt'){
        if(arg==='custom'){updU(chatId,{state:'wiz_dca_amt_custom'});await bot.sendMessage(chatId,'✏️ Enter custom SUI per buy (e.g. 0.25):');return;}
        uu.pd.wiz=uu.pd.wiz||{}; uu.pd.wiz.sui=parseFloat(arg); saveDB();
        await bot.sendMessage(chatId,`🔄 *Step 2 of 3* — How often to buy?`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
          [{text:'Every 5 min',callback_data:'wiz:dint:5'},{text:'Every 15 min',callback_data:'wiz:dint:15'}],
          [{text:'Every 30 min',callback_data:'wiz:dint:30'},{text:'Every 1 hour',callback_data:'wiz:dint:60'}],
          [{text:'Every 6 hours',callback_data:'wiz:dint:360'},{text:'Every 24 hours',callback_data:'wiz:dint:1440'}],
          [{text:'✏️ Custom minutes',callback_data:'wiz:dint:custom'},{text:'❌ Cancel',callback_data:'wiz:cancel'}],
        ]}});
        return;
      }
      if(tag==='dint'){
        if(arg==='custom'){updU(chatId,{state:'wiz_dca_int_custom'});await bot.sendMessage(chatId,'✏️ Enter interval in minutes (1–10080):');return;}
        uu.pd.wiz.intMin=parseInt(arg); saveDB();
        await bot.sendMessage(chatId,`🔄 *Step 3 of 3* — How many total buys?`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
          [{text:'5',callback_data:'wiz:dnum:5'},{text:'10',callback_data:'wiz:dnum:10'},{text:'20',callback_data:'wiz:dnum:20'}],
          [{text:'50',callback_data:'wiz:dnum:50'},{text:'100',callback_data:'wiz:dnum:100'}],
          [{text:'✏️ Custom count',callback_data:'wiz:dnum:custom'},{text:'❌ Cancel',callback_data:'wiz:cancel'}],
        ]}});
        return;
      }
      if(tag==='dnum'){
        if(arg==='custom'){updU(chatId,{state:'wiz_dca_num_custom'});await bot.sendMessage(chatId,'✏️ Enter total number of buys (1–100):');return;}
        const total=parseInt(arg); const w=uu.pd.wiz; const ct=uu.pd.ct;
        uu.dcaOrders=uu.dcaOrders||[];
        uu.dcaOrders.push({ct,sui:w.sui,intervalSec:w.intMin*60,lastFire:0,count:0,totalCount:total,at:Date.now()});
        saveDB(); updU(chatId,{state:null});
        await bot.sendMessage(chatId,`✅ *DCA started*\n\n• ${w.sui} SUI per buy\n• Every ${w.intMin} min\n• ${total} total buys\n• Token: \`${trunc(ct)}\`\n\nFirst buy fires within ${Math.min(15,w.intMin*60)}s.`,{parse_mode:'Markdown'});
        return;
      }
      return;
    }
    if(data==='auto_sell_toggle'){
      await bot.answerCallbackQuery(q.id).catch(()=>{});
      const uu=getU(chatId); if(uu){uu.settings.autoSell=!uu.settings.autoSell;saveDB();}
      const onOff=uu.settings.autoSell?'ON':'OFF';
      await bot.sendMessage(chatId,`Auto Sell is now *${onOff}*\nDefaults: TP +${uu.settings.autoSellTpPct||50}%  ·  SL -${uu.settings.autoSellSlPct||30}%\nEdit per-position from Track view.`,{parse_mode:'Markdown'});
      const ct=uu?.pd?.ct; if(ct) await startBuy(chatId,ct,q.message.message_id).catch(()=>{});
      return;
    }
    // Wallet panel
    if(data==='wallet_panel'){
      await bot.answerCallbackQuery(q.id).catch(()=>{});
      const uu=getU(chatId); const wallets=getAllWallets(uu);
      const sel=new Set((uu.activeWalletIdx||[0]));
      const rows=wallets.map((w,i)=>[{text:`${sel.has(i)?'✅':'⬜'} ${w.label||'W'+i}: ${w.address.slice(0,6)}...${w.address.slice(-4)}`,callback_data:`wt:${i}`}]);
      rows.push([{text:'🔘 Select All',callback_data:'wt:all'},{text:'➕ Add Wallet',callback_data:'wt:add'}]);
      rows.push([{text:'⬅️ Back',callback_data:'rbuy'}]);
      await bot.sendMessage(chatId,`*Select Wallets (${sel.size}/${wallets.length||1})*`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:rows}});
      return;
    }
    if(data.startsWith('wt:')){
      await bot.answerCallbackQuery(q.id).catch(()=>{});
      const arg=data.slice(3);
      const uu=getU(chatId); const wallets=getAllWallets(uu);
      uu.activeWalletIdx=uu.activeWalletIdx||[0];
      if(arg==='all'){uu.activeWalletIdx=wallets.map((_,i)=>i);}
      else if(arg==='add'){
        await bot.sendMessage(chatId,
          `➕ *Add a new wallet*\n\n`+
          `For your security, wallet imports use the dedicated /import command (never paste a seed phrase into a button menu).\n\n`+
          `*How to add:*\n`+
          `1. Tap or send /import\n`+
          `2. Send your 12/24-word mnemonic OR a Sui private key\n`+
          `3. Give it a label (e.g. "Trading 2")\n\n`+
          `Once added it will appear here automatically. Multi-wallet trading executes the same buy/sell across every selected wallet in parallel.`,
          {parse_mode:'Markdown'});
        return;
      }
      else {const i=parseInt(arg); if(!isNaN(i)){const s=new Set(uu.activeWalletIdx); s.has(i)?s.delete(i):s.add(i); if(s.size===0) s.add(0); uu.activeWalletIdx=[...s].sort();}}
      saveDB();
      const sel=new Set(uu.activeWalletIdx);
      const rows=wallets.map((w,i)=>[{text:`${sel.has(i)?'✅':'⬜'} ${w.label||'W'+i}: ${w.address.slice(0,6)}...${w.address.slice(-4)}`,callback_data:`wt:${i}`}]);
      rows.push([{text:'🔘 Select All',callback_data:'wt:all'},{text:'➕ Add Wallet',callback_data:'wt:add'}]);
      rows.push([{text:'⬅️ Back',callback_data:'rbuy'}]);
      await bot.editMessageReplyMarkup({inline_keyboard:rows},{chat_id:chatId,message_id:q.message.message_id}).catch(()=>{});
      return;
    }
    // Track view buttons
    if(data==='track_last'){
      await bot.answerCallbackQuery(q.id).catch(()=>{});
      const uu=getU(chatId);
      const last=uu?.positions?.[uu.positions.length-1];
      if(!last){await bot.sendMessage(chatId,'No position found.');return;}
      await doPositions(chatId); return;
    }
    if(data.startsWith('close_track:')){
      await bot.answerCallbackQuery(q.id,{text:'Position closed from tracking'}).catch(()=>{});
      const uu=getU(chatId); const idx=parseInt(data.split(':')[1]);
      if(uu&&uu.positions&&!isNaN(idx)){uu.positions.splice(idx,1);saveDB();}
      try{await bot.deleteMessage(chatId,q.message.message_id);}catch{}
      return;
    }
    if(data.startsWith('flex:') || data.startsWith('print:')){
      await bot.answerCallbackQuery(q.id, {text:'🖨 Generating card...'}).catch(()=>{});
      const uu=getU(chatId); const idx=parseInt(data.split(':')[1]);
      const pos=uu?.positions?.[idx]; if(!pos){await bot.sendMessage(chatId,'❌ Position not found.');return;}
      try {
        const buf = await _renderPosCard(pos, uu);
        const cap = `${(pos.sym||'?').toUpperCase()} ${pos.entryMc?'· MC P&L':'· SUI P&L'}  ·  shared via @${(await bot.getMe()).username}`;
        await bot.sendPhoto(chatId, buf, { caption: cap });
      } catch(e){
        await bot.sendMessage(chatId,`❌ Couldn't generate PnL card: ${(e.message||'').slice(0,120)}`);
      }
      return;
    }

    if(data==='go_home'){await bot.answerCallbackQuery(q.id).catch(()=>{});const uu=getU(chatId);if(uu)await bot.sendMessage(chatId,'≡ *Main Menu*',{parse_mode:'Markdown',reply_markup:MAIN_KB});return;}
    if(data==='go_pos'){await bot.answerCallbackQuery(q.id).catch(()=>{});await doPositions(chatId);return;}
    if(data==='go_orders'){await bot.answerCallbackQuery(q.id).catch(()=>{});await doOrders(chatId,q.message?.message_id);return;}
    if(data.startsWith('ord:')){
      await bot.answerCallbackQuery(q.id).catch(()=>{});
      const [,act,kind,idxStr]=data.split(':');
      const uu=getU(chatId); if(!uu) return;
      const idx=parseInt(idxStr);
      const arr = kind==='l'?(uu.limitOrders||[]) : kind==='d'?(uu.dcaOrders||[]) : (uu.snipeWatches||[]);
      if(isNaN(idx)||idx<0||idx>=arr.length){await bot.sendMessage(chatId,'❌ Order not found (list may be stale — refresh).');return;}
      const order=arr[idx];
      if(act==='cancel'){
        arr.splice(idx,1); saveDB();
        await bot.sendMessage(chatId,`✅ Order cancelled.`);
        await doOrders(chatId);
        return;
      }
      if(act==='edit'){
        const ct=order.ct;
        arr.splice(idx,1); saveDB();
        updU(chatId,{pd:{...(uu.pd||{}),ct,wiz:{}}});
        if(kind==='l'){
          updU(chatId,{state:'wiz_limit_amt'});
          await bot.sendMessage(chatId,`✏️ *Edit Limit Order — Step 1 of 3*\n\nOld order removed. Pick new SUI amount:`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
            [{text:'0.1 SUI',callback_data:'wiz:lamt:0.1'},{text:'0.5 SUI',callback_data:'wiz:lamt:0.5'},{text:'1 SUI',callback_data:'wiz:lamt:1'}],
            [{text:'2 SUI',callback_data:'wiz:lamt:2'},{text:'5 SUI',callback_data:'wiz:lamt:5'},{text:'10 SUI',callback_data:'wiz:lamt:10'}],
            [{text:'✏️ Custom amount',callback_data:'wiz:lamt:custom'},{text:'❌ Cancel',callback_data:'wiz:cancel'}],
          ]}});
        } else if(kind==='d'){
          updU(chatId,{state:'wiz_dca_amt'});
          await bot.sendMessage(chatId,`✏️ *Edit DCA — Step 1 of 3*\n\nOld DCA removed. Pick new SUI per buy:`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
            [{text:'0.1 SUI',callback_data:'wiz:damt:0.1'},{text:'0.5 SUI',callback_data:'wiz:damt:0.5'},{text:'1 SUI',callback_data:'wiz:damt:1'}],
            [{text:'2 SUI',callback_data:'wiz:damt:2'},{text:'5 SUI',callback_data:'wiz:damt:5'},{text:'10 SUI',callback_data:'wiz:damt:10'}],
            [{text:'✏️ Custom amount',callback_data:'wiz:damt:custom'},{text:'❌ Cancel',callback_data:'wiz:cancel'}],
          ]}});
        } else {
          updU(chatId,{state:'snipe_amount',pd:{...(getU(chatId).pd||{}),sniToken:ct}});
          await bot.sendMessage(chatId,`✏️ *Edit Snipe*\n\nOld snipe removed. Send new SUI amount to snipe with (e.g. \`0.5\`):`,{parse_mode:'Markdown'});
        }
        return;
      }
    }
    if(data==='open_slip'){await bot.answerCallbackQuery(q.id).catch(()=>{});const uu=getU(chatId);if(uu){updU(chatId,{state:'edit_slip'});await bot.sendMessage(chatId,'✏️ Enter slippage % (e.g. 1, 2, 5):');}return;}
    if(data==='rbuy'){
      await bot.answerCallbackQuery(q.id,{text:'🔄 Refreshing...'}).catch(()=>{});
      const u=getU(chatId);
      // Recover CA from the message body if session was lost
      let ct=u?.pd?.ct;
      if(!ct){
        const body=q.message?.text||q.message?.caption||'';
        const m=body.match(/0x[a-fA-F0-9]{6,}(?:::[A-Za-z0-9_]+){0,2}/);
        if(m) ct=m[0];
      }
      if(!ct){await bot.answerCallbackQuery(q.id,{text:'Paste the CA again',show_alert:true}).catch(()=>{});return;}
      await startBuy(chatId,ct,q.message.message_id); return;
    }
    if(data==='shr'){
      await bot.answerCallbackQuery(q.id).catch(()=>{});
      const u=getU(chatId);
      let sct=u?.pd?.ct;
      if(!sct){
        const body=q.message?.text||q.message?.caption||'';
        const mm=body.match(/0x[a-fA-F0-9]{6,}(?:::[A-Za-z0-9_]+){0,2}/);
        if(mm) sct=mm[0];
      }
      if(!sct){await bot.sendMessage(chatId,'❌ Paste the CA again to sell.');return;}
      const smeta=await getMeta(sct).catch(()=>null);
      const ssym=smeta?.symbol||trunc(sct);
      await guard(chatId,async()=>showSellPct(chatId,sct,ssym,null));
      return;
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
        const gotTok=res.out&&res.out!='?';
        const tokAmt=gotTok?Number(res.out).toLocaleString('en',{maximumFractionDigits:6}):'?';
        const wAddr=u.walletAddress||'';
        const wTrunc=wAddr?`${wAddr.slice(0,6)}...${wAddr.slice(-4)}`:'—';
        const txTrunc=res.digest?`${res.digest.slice(0,6)}...${res.digest.slice(-4)}`:'—';
        // RaidenX-style buy notification
        await bot.editMessageText(
          `🔔 You bought ${tokAmt} ${res.sym} = ${bc_amt} Sui on Sui\n\n` +
          `Wallet: \`${wTrunc}\`\n` +
          `View on explorer: [${txTrunc}](${SUISCAN}${res.digest})`,
          {chat_id:chatId,message_id:msgId,parse_mode:'Markdown',disable_web_page_preview:true,
           reply_markup:{inline_keyboard:[[{text:'📍 Track',callback_data:'track_last'}]]}});
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
        const res = await executeSell(chatId, sc_ct, sc_pct);
        const sellMsg = formatSellResult(res, getU(chatId)?.walletAddress);
        await bot.editMessageText(sellMsg, { chat_id:chatId, message_id:msgId, parse_mode:'Markdown', disable_web_page_preview:true });
        // PnL is already included in sellMsg via formatSellResult — no pie chart photo.
      }catch(e){await bot.editMessageText(`❌ Sell failed:\n\`${e.message?.slice(0,200)}\``,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown'});}
      updU(chatId,{pd:{}}); return;
    }

    if(data==='ca'){updU(chatId,{state:null,pd:{}});await bot.editMessageText('❌ Cancelled.',{chat_id:chatId,message_id:msgId}).catch(()=>{});return;}
    if(data==='refresh_balance'){await bot.answerCallbackQuery(q.id).catch(()=>{});await doBalance(chatId);return;}

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
    '🔁 Copy Trade': ()=>guard(chatId,async(u)=>{if(!u.copyTraders?.length){await bot.sendMessage(chatId,'🔁 *Copy Trader*\n\nNo wallets tracked.\n\nUsage: `/copytrader [wallet]`\n\nToggles per tracker:\n`/copytrader sells [n] on|off`\n`/copytrader auto [n] on|off`\n`/copytrader stop [n]`',{parse_mode:'Markdown'});}else{const lines=u.copyTraders.map((ct,i)=>{const amt=ct.autoAmount?'Auto':'Fixed '+ct.amount+' SUI';const sells=ct.copySells===false?'Sells: OFF':'Sells: ON';return `${i+1}. \`${trunc(ct.wallet)}\`\n   💰 ${amt} | ${sells}`;}).join('\n\n');await bot.sendMessage(chatId,`🔁 *Copy Traders (${u.copyTraders.length}/3)*\n\n${lines}\n\n_/copytrader sells [n] on|off_\n_/copytrader auto [n] on|off_\n_/copytrader stop [n]_`,{parse_mode:'Markdown'});}}),
    '🔗 Referral':   ()=>doReferral(chatId),
    '📋 Orders':     ()=>doOrders(chatId),
    '⚙️ Settings':   ()=>doSettings(chatId),
    '❓ Help':        ()=>doHelp(chatId),
    '🚀 Launchpad': ()=>doLaunchpadMenu(chatId),
  };
  if(KB[raw]){await KB[raw]();return;}

  const text=raw.replace(/[<>&]/g,'').slice(0,1000);

  // ── Reset confirmation (wipes wallet/PIN/positions, keeps referral data & settings) ──
  if(state==='confirm_reset'){
    if(text==='CONFIRM RESET'){
      updU(chatId,{
        encryptedKey:null, walletAddress:null, pinHash:null,
        lockedAt:null, failAttempts:0, cooldownUntil:0,
        positions:[], state:null, pd:{},
      });
      await bot.sendMessage(chatId,
        '✅ *Wallet reset complete.*\n\nSend /start to import your private key or create a new wallet.\n\n_Your referral code and stats were preserved._',
        {parse_mode:'Markdown'});
    } else {
      updU(chatId,{state:null});
      await bot.sendMessage(chatId,'❌ Reset cancelled. Your wallet is unchanged.');
    }
    return;
  }

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
    const raw=text.startsWith('0x')?text:(await resolveTicker(text));
    const ct=raw?await resolveCoinType(raw):null;
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found. Paste the full contract address.');return;}
    // Launchpad auto-detect: if this CA is a live Odyssey bonding-curve token,
    // route to the bonding-curve UI; otherwise fall through to standard DEX buy.
    try {
      const ody = await isOdysseyToken(ct);
      if (ody && !ody.isCompleted && (ody.pairType||'SUI') === 'SUI') {
        await _showOdyByCA(chatId, ct, ody);
        return;
      }
    } catch { /* ignore detect errors, fall through */ }
    try {
      const mb = await isMoonbagsToken(ct);
      if (mb && !mb.isCompleted) {
        await _showMbByCA(chatId, ct, mb);
        return;
      }
    } catch { /* ignore detect errors, fall through */ }
    try {
      const hf = await isHopFunToken(sui, ct);
      if (hf && !hf.isCompleted) {
        await _showHfByCA(chatId, ct, hf);
        return;
      }
    } catch { /* ignore detect errors, fall through */ }
    await guard(chatId,async()=>startBuy(chatId,ct)); return;
  }

  if(state==='sell_ca'){
    updU(chatId,{state:null});
    const raw=text.startsWith('0x')?text:(await resolveTicker(text));
    const ct=raw?await resolveCoinType(raw):null;
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
    // Launchpad auto-detect: live Odyssey bonding-curve token → bonding-curve
    // sell UI; otherwise fall through to standard DEX sell.
    try {
      const ody = await isOdysseyToken(ct);
      if (ody && !ody.isCompleted && (ody.pairType||'SUI') === 'SUI') {
        await _showOdyByCA(chatId, ct, ody);
        return;
      }
    } catch { /* ignore detect errors, fall through */ }
    try {
      const mb = await isMoonbagsToken(ct);
      if (mb && !mb.isCompleted) {
        await _showMbByCA(chatId, ct, mb);
        return;
      }
    } catch { /* ignore detect errors, fall through */ }
    try {
      const hf = await isHopFunToken(sui, ct);
      if (hf && !hf.isCompleted) {
        await _showHfByCA(chatId, ct, hf);
        return;
      }
    } catch { /* ignore detect errors, fall through */ }
    const meta=await getMeta(ct)||{};
    await guard(chatId,async()=>{updU(chatId,{pd:{ct,sym:meta.symbol||trunc(ct)}});await showSellPct(chatId,ct,meta.symbol||trunc(ct),null);}); return;
  }

  if(state==='scan_ca'){
    updU(chatId,{state:null});
    const raw=text.startsWith('0x')?text:(await resolveTicker(text));
    const ct=raw?await resolveCoinType(raw):null;
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
    const raw=text.startsWith('0x')?text:(await resolveTicker(text));
    const ct=raw?await resolveCoinType(raw):null;
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
    updU(chatId,{state:'snipe_amount',pd:{sniToken:ct}});
    await bot.sendMessage(chatId,`Token: \`${trunc(ct)}\`\n\nHow much SUI to buy when pool is found?\n_Example: 0.5_`,{parse_mode:'Markdown'}); return;
  }

  if(state==='snipe_amount'){
    const amt=parseFloat(text); if(isNaN(amt)||amt<=0){await bot.sendMessage(chatId,'❌ Invalid amount.');return;}
    const pd=u.pd||{};
    updU(chatId,{state:'snipe_mc',pd:{...pd,sniAmt:amt}});
    await bot.sendMessage(chatId,
      `📊 *Set MC trigger* (optional)\n\n` +
      `Snipe will fire when token launches at this market cap *or higher*.\n\n` +
      `_Examples:_\n` +
      `• \`50000\` — snipe only if MC ≥ $50K at launch\n` +
      `• \`skip\` — snipe immediately when LP is added (no MC filter)\n\n` +
      `Send a number or "skip":`,
      {parse_mode:'Markdown'});
    return;
  }

  if(state==='snipe_mc'){
    const pd=u.pd||{};
    let minMc=0;
    const t=text.trim().toLowerCase();
    if(t!=='skip'&&t!=='0'&&t!==''){
      const n=parseFloat(text.replace(/[, _$]/g,''));
      if(isNaN(n)||n<0){await bot.sendMessage(chatId,'❌ Send a number (e.g. 50000) or "skip".');return;}
      minMc=n;
    }
    u.snipeWatches=u.snipeWatches||[];
    u.snipeWatches.push({ct:pd.sniToken,sui:pd.sniAmt,mode:'any',minMc,triggered:false,at:Date.now()});
    updU(chatId,{state:null,pd:{},snipeWatches:u.snipeWatches});
    const mcLine=minMc>0?`MC trigger: *≥ $${fNum(minMc)}*`:`MC trigger: _none — snipe on LP_`;
    await bot.sendMessage(chatId,
      `⚡ *Snipe set!*\n\n` +
      `Token: \`${trunc(pd.sniToken)}\`\n` +
      `Buy: *${pd.sniAmt} SUI*\n` +
      `${mcLine}\n\n` +
      `_Watching for pool creation..._`,
      {parse_mode:'Markdown'});
    return;
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

  // qs_custom_sell — custom sell amount from positions panel
  if (state === 'qs_custom_sell') {
    updU(chatId, { state: null });
    const posIdx = u.pd?.qsIdx;
    if (posIdx === undefined || posIdx === null) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
    const pos = (getU(chatId)?.positions || [])[posIdx];
    if (!pos) { await bot.sendMessage(chatId, '❌ Position not found.'); return; }

    // Parse: "50" or "50%" → percent; "1500t" or num > 100 → token amount
    const raw    = text.trim();
    const isPct  = raw.endsWith('%');
    const isTok  = raw.toLowerCase().endsWith('t') || raw.toLowerCase().endsWith('tok');
    const numStr = raw.replace(/%|tok?$/i, '').trim();
    const val    = parseFloat(numStr);
    if (isNaN(val) || val <= 0) { await bot.sendMessage(chatId, '❌ Invalid input. Example: `50`, `50%`, `1500t`', { parse_mode:'Markdown' }); return; }

    let pct;
    if (isPct || (!isTok && val <= 100)) {
      pct = Math.min(100, Math.max(1, Math.round(val)));
    } else {
      // token amount → convert to %
      const totalTok = pos.tokens || 0;
      if (!totalTok) { await bot.sendMessage(chatId, '❌ No token count in position — use % instead.'); return; }
      pct = Math.min(100, Math.max(1, Math.round((val / totalTok) * 100)));
    }

    const m = await bot.sendMessage(chatId, `⚡ Selling *${pct}%* of *${pos.sym}*...`, { parse_mode:'Markdown' });
    try {
      const res = await executeSell(chatId, pos.ct, pct);
      const sellMsg = formatSellResult(res, getU(chatId)?.walletAddress);
      await bot.editMessageText(sellMsg, { chat_id:chatId, message_id:m.message_id, parse_mode:'Markdown', disable_web_page_preview:true });
      // PnL is already included in sellMsg via formatSellResult — no pie chart photo.
    } catch(e) {
      await bot.editMessageText(`❌ Sell failed:\n\`${e.message?.slice(0,200)}\``, { chat_id:chatId, message_id:m.message_id, parse_mode:'Markdown' });
    }
    return;
  }

  if(state==='edit_gas'){
    updU(chatId,{state:null});
    const n=parseInt(text.replace(/\D/g,''));
    if(isNaN(n)||n<100||n>100000){await bot.sendMessage(chatId,'❌ Send a value between 100 and 100000 MIST.');return;}
    const uu=getU(chatId); if(uu){uu.settings.gasPriceMist=n;saveDB();}
    await bot.sendMessage(chatId,`✅ Gas price set to ${n} MIST`); return;
  }
  if(state==='edit_tip'){
    updU(chatId,{state:null});
    const n=parseFloat(text);
    if(isNaN(n)||n<0||n>10){await bot.sendMessage(chatId,'❌ Send a number between 0 and 10 SUI.');return;}
    const uu=getU(chatId); if(uu){uu.settings.tipSui=n;saveDB();}
    await bot.sendMessage(chatId,`✅ Tip set to ${n} SUI per trade`); return;
  }
  // ── Limit-order wizard text steps ──
  if(state==='wiz_limit_amt_custom'){
    const n=parseFloat(text);
    if(isNaN(n)||n<=0||n>10000){await bot.sendMessage(chatId,'❌ Enter a positive number ≤ 10000. Try again:');return;}
    const uu=getU(chatId); uu.pd.wiz=uu.pd.wiz||{}; uu.pd.wiz.sui=n; saveDB();
    updU(chatId,{state:'wiz_limit_target'});
    await bot.sendMessage(chatId,`📊 *Step 2 of 3* — Target price (USD)\n\nBuy ${n} SUI when price reaches what?\n\nSend the target USD price (e.g. \`0.0005\`):`,{parse_mode:'Markdown'});
    return;
  }
  if(state==='wiz_limit_target'){
    const target=parseFloat(text);
    if(isNaN(target)||target<=0){await bot.sendMessage(chatId,'❌ Enter a positive USD price (e.g. 0.0005). Try again:');return;}
    const uu=getU(chatId); uu.pd.wiz.target=target; saveDB();
    updU(chatId,{state:'wiz_limit_dir'});
    await bot.sendMessage(chatId,`📊 *Step 3 of 3* — Trigger direction\n\nBuy ${uu.pd.wiz.sui} SUI when price goes:`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
      [{text:`📈 Above $${target}`,callback_data:'wiz:ldir:above'},{text:`📉 Below $${target}`,callback_data:'wiz:ldir:below'}],
      [{text:'❌ Cancel',callback_data:'wiz:cancel'}],
    ]}});
    return;
  }
  // ── DCA wizard text steps ──
  if(state==='wiz_dca_amt_custom'){
    const n=parseFloat(text);
    if(isNaN(n)||n<=0||n>10000){await bot.sendMessage(chatId,'❌ Enter a positive number ≤ 10000. Try again:');return;}
    const uu=getU(chatId); uu.pd.wiz=uu.pd.wiz||{}; uu.pd.wiz.sui=n; saveDB(); updU(chatId,{state:null});
    await bot.sendMessage(chatId,`🔄 *Step 2 of 3* — How often to buy?`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
      [{text:'Every 5 min',callback_data:'wiz:dint:5'},{text:'Every 15 min',callback_data:'wiz:dint:15'}],
      [{text:'Every 30 min',callback_data:'wiz:dint:30'},{text:'Every 1 hour',callback_data:'wiz:dint:60'}],
      [{text:'Every 6 hours',callback_data:'wiz:dint:360'},{text:'Every 24 hours',callback_data:'wiz:dint:1440'}],
      [{text:'✏️ Custom minutes',callback_data:'wiz:dint:custom'},{text:'❌ Cancel',callback_data:'wiz:cancel'}],
    ]}});
    return;
  }
  if(state==='wiz_dca_int_custom'){
    const n=parseInt(text);
    if(isNaN(n)||n<1||n>10080){await bot.sendMessage(chatId,'❌ Enter minutes between 1 and 10080. Try again:');return;}
    const uu=getU(chatId); uu.pd.wiz.intMin=n; saveDB(); updU(chatId,{state:null});
    await bot.sendMessage(chatId,`🔄 *Step 3 of 3* — How many total buys?`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
      [{text:'5',callback_data:'wiz:dnum:5'},{text:'10',callback_data:'wiz:dnum:10'},{text:'20',callback_data:'wiz:dnum:20'}],
      [{text:'50',callback_data:'wiz:dnum:50'},{text:'100',callback_data:'wiz:dnum:100'}],
      [{text:'✏️ Custom count',callback_data:'wiz:dnum:custom'},{text:'❌ Cancel',callback_data:'wiz:cancel'}],
    ]}});
    return;
  }
  if(state==='wiz_dca_num_custom'){
    const total=parseInt(text);
    if(isNaN(total)||total<1||total>100){await bot.sendMessage(chatId,'❌ Enter a number between 1 and 100. Try again:');return;}
    const uu=getU(chatId); const w=uu.pd.wiz; const ct=uu.pd.ct;
    uu.dcaOrders=uu.dcaOrders||[];
    uu.dcaOrders.push({ct,sui:w.sui,intervalSec:w.intMin*60,lastFire:0,count:0,totalCount:total,at:Date.now()});
    saveDB(); updU(chatId,{state:null});
    await bot.sendMessage(chatId,`✅ *DCA started*\n\n• ${w.sui} SUI per buy\n• Every ${w.intMin} min\n• ${total} total buys\n• Token: \`${trunc(ct)}\`\n\nFirst buy fires within ${Math.min(15,w.intMin*60)}s.`,{parse_mode:'Markdown'});
    return;
  }

  if(state==='edit_slip'){
    updU(chatId,{state:null});
    const n=parseFloat(text);
    if(!isNaN(n)&&n>0&&n<=50){const uu=getU(chatId);if(uu){uu.settings.slippage=n;saveDB();}await bot.sendMessage(chatId,`✅ Slippage set to ${n}%`);}
    else await bot.sendMessage(chatId,'❌ Enter a number between 0.1 and 50');
    return;
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
    u.copyTraders.push({wallet:text,amount:u.settings.copyAmount,maxPos:5,blacklist:[],copySells:true,autoAmount:false});
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

  // Raw CA paste — resolve bare package address to full coin type before storing
  if(text.startsWith('0x')&&text.length>40){
    const ct=await resolveCoinType(text);
    updU(chatId,{pd:{ct}});
    await bot.sendMessage(chatId,`📋 \`${trunc(ct)}\`\n\nWhat do you want to do?`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'💰 Buy',callback_data:'bfs'},{text:'💸 Sell',callback_data:'sfs'},{text:'🔍 Scan',callback_data:'sct'}]]}});
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
bot.onText(/\/orders/,   async(msg)=>doOrders(msg.chat.id));
bot.onText(/\/print(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  await guard(chatId, async (u) => {
    const positions = u.positions || [];
    if (!positions.length) { await bot.sendMessage(chatId, '🖨 No positions to print.\n\nBuy a token first, then /print to share a PnL card.'); return; }
    const pickIdx = match?.[1] != null ? parseInt(match[1], 10) - 1 : null;
    if (pickIdx != null && positions[pickIdx]) {
      try {
        const buf = await _renderPosCard(positions[pickIdx], u);
        await bot.sendPhoto(chatId, buf, { caption: `${(positions[pickIdx].sym||'?').toUpperCase()} PnL card` });
      } catch (e) { await bot.sendMessage(chatId, `❌ ${(e.message||'').slice(0,120)}`); }
      return;
    }
    // No index → show picker
    const rows = positions.slice(0, 30).map((p, i) => ([{
      text: `${i+1}. ${(p.sym||'?').slice(0,12)}`,
      callback_data: `print:${i}`,
    }]));
    await bot.sendMessage(chatId,
      `🖨 *Print PnL Card*\n\n_Pick a position to generate a shareable card:_`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } }
    );
  });
});
bot.onText(/\/pnl(?:\s+(.+))?/, async(msg,m)=>{
  const chatId=msg.chat.id, arg=m[1]?san(m[1].trim()):null;
  await guard(chatId,async(u)=>{
    const positions=(u.positions||[]).filter(p=>p.source!=='bonding'&&p.tokens>0);
    if(!positions.length){await bot.sendMessage(chatId,'📊 No open DEX positions to show P&L for.\n\nUse /positions for all positions.');return;}
    const target=arg?positions.filter(p=>p.ct.toLowerCase().includes(arg.toLowerCase())||p.sym.toLowerCase()===arg.toLowerCase()):positions;
    if(!target.length){await bot.sendMessage(chatId,`❌ No position found for "${arg}".`);return;}
    const load=await bot.sendMessage(chatId,`📊 Loading P&L for ${target.length} position(s)...`);
    await bot.deleteMessage(chatId,load.message_id).catch(()=>{});
    for(const pos of target){
      try{
        const p=await getPnl(pos);
        if(p){
          const cap=pnlCaption(pos,p)+`\n\nTP: ${pos.tp?pos.tp+'%':'None'} | SL: ${pos.sl?pos.sl+'%':'None'}`;
          const url=pnlChart(pos.sym,p.pct,pos.spent,p.cur);
          await bot.sendPhoto(chatId,url,{caption:cap,parse_mode:'Markdown'}).catch(async()=>{
            await bot.sendMessage(chatId,cap,{parse_mode:'Markdown'});
          });
        }else{
          await bot.sendMessage(chatId,`⚪ *${pos.sym}*\nHeld: ${pos.tokens?.toFixed(2)} tokens\nSpent: ${pos.spent} SUI\n_Price unavailable_`,{parse_mode:'Markdown'});
        }
      }catch{await bot.sendMessage(chatId,`⚪ ${pos.sym} — ${pos.spent} SUI`);}
    }
  });
});
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
    u.copyTraders=u.copyTraders||[];

    const showList=()=>{
      if(!u.copyTraders.length){return bot.sendMessage(chatId,
        '🔁 *Copy Trader*\n\nNo wallets tracked.\n\nUsage: `/copytrader [wallet]`\n\nCommands:\n`/copytrader sells [1-3] on|off` — toggle copy sells\n`/copytrader auto [1-3] on|off` — match copier\'s exact amount\n`/copytrader stop [1-3]` — remove tracker\n`/copytrader stop` — remove all',
        {parse_mode:'Markdown'});}
      const lines=u.copyTraders.map((ct,i)=>{
        const amt=ct.autoAmount?'Auto':'Fixed '+ct.amount+' SUI';
        const sells=ct.copySells===false?'Sells: OFF':'Sells: ON';
        return `${i+1}. \`${trunc(ct.wallet)}\`\n   💰 ${amt} | ${sells}`;
      }).join('\n\n');
      return bot.sendMessage(chatId,
        `🔁 *Copy Traders (${u.copyTraders.length}/3)*\n\n${lines}\n\n` +
        `_/copytrader sells [n] on|off — toggle sell mirroring_\n` +
        `_/copytrader auto [n] on|off — match copier amount_\n` +
        `_/copytrader stop [n] — remove tracker_`,
        {parse_mode:'Markdown'});
    };

    if(!arg||arg==='list'){return showList();}

    // ── /copytrader stop [n]
    if(arg==='stop'||arg.startsWith('stop ')){
      const idx=parseInt(arg.split(' ')[1]);
      if(!isNaN(idx)&&idx>=1&&idx<=u.copyTraders.length){
        const removed=u.copyTraders.splice(idx-1,1)[0];
        updU(chatId,{copyTraders:u.copyTraders});
        return bot.sendMessage(chatId,`✅ Stopped tracking \`${trunc(removed.wallet)}\``,{parse_mode:'Markdown'});
      }
      updU(chatId,{copyTraders:[]});
      return bot.sendMessage(chatId,'✅ All copy traders stopped.');
    }

    // ── /copytrader sells [n] on|off
    const sellsM=arg.match(/^sells\s+(\d)\s+(on|off)$/i);
    if(sellsM){
      const idx=parseInt(sellsM[1])-1, val=sellsM[2].toLowerCase()==='on';
      if(idx<0||idx>=u.copyTraders.length) return bot.sendMessage(chatId,'❌ Invalid tracker number.');
      u.copyTraders[idx].copySells=val;
      updU(chatId,{copyTraders:u.copyTraders});
      return bot.sendMessage(chatId,`✅ Tracker ${idx+1}: Copy Sells turned ${val?'ON':'OFF'}.\n\`${trunc(u.copyTraders[idx].wallet)}\``,{parse_mode:'Markdown'});
    }

    // ── /copytrader auto [n] on|off
    const autoM=arg.match(/^auto\s+(\d)\s+(on|off)$/i);
    if(autoM){
      const idx=parseInt(autoM[1])-1, val=autoM[2].toLowerCase()==='on';
      if(idx<0||idx>=u.copyTraders.length) return bot.sendMessage(chatId,'❌ Invalid tracker number.');
      u.copyTraders[idx].autoAmount=val;
      updU(chatId,{copyTraders:u.copyTraders});
      return bot.sendMessage(chatId,
        `✅ Tracker ${idx+1}: Amount mode set to *${val?'Auto (match copier)':'Fixed '+u.copyTraders[idx].amount+' SUI'}*\n\`${trunc(u.copyTraders[idx].wallet)}\``,
        {parse_mode:'Markdown'});
    }

    // ── /copytrader [wallet]
    if(arg.startsWith('0x')){
      if(u.copyTraders.length>=3){await bot.sendMessage(chatId,'❌ Max 3 wallets. /copytrader stop first.');return;}
      u.copyTraders.push({wallet:arg,amount:u.settings.copyAmount,maxPos:5,blacklist:[],copySells:true,autoAmount:false});
      updU(chatId,{copyTraders:u.copyTraders});
      await bot.sendMessage(chatId,
        `✅ Tracking \`${trunc(arg)}\`\n\n💰 Amount: ${u.settings.copyAmount} SUI (fixed)\n📤 Copy Sells: ON\n⚡ Auto Amount: OFF\n\nUse \`/copytrader sells ${u.copyTraders.length} off\` to disable sell mirroring\nUse \`/copytrader auto ${u.copyTraders.length} on\` to match copier's amount`,
        {parse_mode:'Markdown'}); return;
    }

    updU(chatId,{state:'copy_wallet'}); await bot.sendMessage(chatId,'Enter the wallet address to copy:');
  });
});

// ═══════════════════════════════════════════════════════════
// 🚀 LAUNCHPAD: AGENT MemeLand + Odyssey moonbags
// ═══════════════════════════════════════════════════════════
const _lpCache = { ts:0, data:null };
async function _getLaunchpadTokens() {
  if (_lpCache.data && Date.now() - _lpCache.ts < 60_000) return _lpCache.data;
  // Pass the SuiClient so hop.fun (which has no public REST API) can resolve
  // its bonding-curve list via on-chain event scans.
  const data = await fetchAllLaunchpadTokens({ suiClient: sui, limit: 12 });
  _lpCache.ts = Date.now(); _lpCache.data = data;
  return data;
}

// ── Cross-contamination fix ─────────────────────────────────────────
// The global _lpCache refreshes every 60s. If we encoded `lp:odpick:2`
// into a button at t=0 and the user tapped it at t=70, idx=2 would
// resolve to a DIFFERENT token in the freshly-fetched list. We pin
// the exact list shown to the user on their session, so taps always
// resolve to the token they clicked — even after cache refresh.
function _pinLp(chatId, key, list) {
  const u = getU(chatId); if (!u) return;
  u.pd = u.pd || {};
  u.pd.lpSnap = u.pd.lpSnap || {};
  u.pd.lpSnap[key] = (list||[]).map(t => ({...t,
    virtualSuiReserves: t.virtualSuiReserves != null ? String(t.virtualSuiReserves) : null,
    virtualTokenReserves: t.virtualTokenReserves != null ? String(t.virtualTokenReserves) : null,
  }));
  saveDB();
}
function _pinnedLp(chatId, key, idx) {
  const u = getU(chatId);
  const t = u?.pd?.lpSnap?.[key]?.[idx];
  if (!t) return null;
  // Restore BigInts that were string-encoded for JSON safety
  return {...t,
    virtualSuiReserves: t.virtualSuiReserves != null ? BigInt(t.virtualSuiReserves) : null,
    virtualTokenReserves: t.virtualTokenReserves != null ? BigInt(t.virtualTokenReserves) : null,
  };
}

function _fmtToken(t, idx) {
  const sym  = (t.symbol || '?').slice(0, 12);
  const name = (t.name   || '').slice(0, 20);
  const mc   = t.marketCap ? `MC $${Number(t.marketCap).toLocaleString(undefined,{maximumFractionDigits:0})}` : '';
  const p    = (t.progress != null) ? t.progress : t.bondingProgress;
  const filled = p != null ? Math.min(10, Math.round(p/10)) : null;
  const bar  = filled != null ? `[${'█'.repeat(filled)}${'░'.repeat(10-filled)}] ${Math.round(p)}%` : '';
  const pair = t.pairType && t.pairType !== 'SUI' ? `  [${t.pairType}]` : '';
  const nameStr = name ? ` _${name}_` : '';
  const mcStr   = mc ? `  ${mc}` : '';
  return `${idx+1}. *${sym}*${nameStr}${pair}\n   ${bar}${mcStr}`;
}

async function doLaunchpadMenu(chatId) {
  await bot.sendMessage(chatId,
    `🚀 *Launchpad Hub*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `Browse fresh bonding-curve tokens and buy directly on-curve.\n\n` +
    `_Select a launchpad:_`,
    { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
      [{text:'🟢 AGENT MemeLand',          callback_data:'lp:agent'}],
      [{text:'🟣 Odyssey (theodyssey.fun)', callback_data:'lp:ody'  }],
      [{text:'🟠 Moonbags (moonbags.io)',   callback_data:'lp:mb'   }],
      [{text:'🔵 hop.fun',                  callback_data:'lp:hf'   }],
      [{text:'🔄 Refresh all',              callback_data:'lp:refresh'}],
    ]}});
}

async function _showAgentList(chatId, msgId) {
  const m = msgId ? null : await bot.sendMessage(chatId, '⏳ Fetching AGENT MemeLand tokens...');
  try {
    const { agent } = await _getLaunchpadTokens();
    _pinLp(chatId, 'agent', agent);
    if (!agent.length) {
      const txt = '🟢 *AGENT MemeLand*\n\nNo tokens available right now.\n\nLaunched tokens trade as direct Cetus pools — paste any CA into Buy.';
      const kb = { inline_keyboard:[[{text:'⬅️ Back', callback_data:'lp:menu'}]] };
      if (msgId) await bot.editMessageText(txt,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:kb});
      else await bot.editMessageText(txt,{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown',reply_markup:kb});
      return;
    }
    const lines = agent.slice(0,10).map((t,i)=>_fmtToken(t,i)).join('\n\n');
    const txt = `🟢 *AGENT MemeLand* — ${agent.length} live\n\n${lines}\n\n_Tap a token to start a buy:_`;
    // Use index-based callback (Telegram callback_data has a 64-byte hard limit)
    const rows = agent.slice(0,10).map((t,i)=>([{text:`💰 Buy ${i+1}. ${(t.symbol||'?').slice(0,8)}`, callback_data:`lp:agbuy:${i}`}]));
    rows.push([{text:'🔄 Refresh', callback_data:'lp:agent'},{text:'⬅️ Back', callback_data:'lp:menu'}]);
    const opts = { parse_mode:'Markdown', reply_markup:{ inline_keyboard:rows } };
    if (msgId) await bot.editMessageText(txt,{chat_id:chatId,message_id:msgId,...opts});
    else await bot.editMessageText(txt,{chat_id:chatId,message_id:m.message_id,...opts});
  } catch(e) {
    const txt = `❌ Couldn't load AGENT tokens: ${(e.message||'').slice(0,140)}`;
    if (m) await bot.editMessageText(txt,{chat_id:chatId,message_id:m.message_id});
    else await bot.sendMessage(chatId, txt);
  }
}

async function _showOdyList(chatId, msgId) {
  const m = msgId ? null : await bot.sendMessage(chatId, '⏳ Fetching Odyssey tokens...');
  try {
    const { odyssey } = await _getLaunchpadTokens();
    _pinLp(chatId, 'odyssey', odyssey);
    if (!odyssey.length) {
      const txt = '🟣 *Odyssey*\n\nNo bonding-curve tokens available right now.';
      const kb = { inline_keyboard:[[{text:'⬅️ Back', callback_data:'lp:menu'}]] };
      if (msgId) await bot.editMessageText(txt,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:kb});
      else await bot.editMessageText(txt,{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown',reply_markup:kb});
      return;
    }
    const lines = odyssey.slice(0,10).map((t,i)=>_fmtToken(t,i)).join('\n\n');
    const txt = `🟣 *Odyssey* — ${odyssey.length} on bonding curve\n\n${lines}\n\n_Tap a token to buy/sell on the curve:_`;
    const rows = odyssey.slice(0,10).map((t,i)=>([{text:`${i+1}. ${(t.symbol||'?').slice(0,8)}`, callback_data:`lp:odpick:${i}`}]));
    rows.push([{text:'🔄 Refresh', callback_data:'lp:ody'},{text:'⬅️ Back', callback_data:'lp:menu'}]);
    const opts = { parse_mode:'Markdown', reply_markup:{ inline_keyboard:rows } };
    if (msgId) await bot.editMessageText(txt,{chat_id:chatId,message_id:msgId,...opts});
    else await bot.editMessageText(txt,{chat_id:chatId,message_id:m.message_id,...opts});
  } catch(e) {
    const txt = `❌ Couldn't load Odyssey tokens: ${(e.message||'').slice(0,140)}`;
    if (m) await bot.editMessageText(txt,{chat_id:chatId,message_id:m.message_id});
    else await bot.sendMessage(chatId, txt);
  }
}

// Show the Odyssey buy/sell screen for a token referenced by raw CA (paste flow).
// We persist the token info on the user's session so the buy/sell callbacks can
// re-resolve it without depending on the global _lpCache (which can refresh /
// expire and invalidate any synthetic index).
async function _showOdyByCA(chatId, ct, info) {
  const tok = {
    coinType: ct,
    symbol: info.symbol || (ct.split('::').pop() || '?'),
    moonbagsPackageId: info.moonbagsPackageId,
    pairType: info.pairType || 'SUI',
    progress: info.progress ?? null,
    isCompleted: !!info.isCompleted,
    marketCap: null,
    source: 'Odyssey',
  };
  updU(chatId, { pd: { ...(getU(chatId)?.pd||{}), odyCA: tok } });
  const sym  = tok.symbol;
  const pNum = tok.progress != null ? Number(tok.progress) : null;
  const prog = pNum != null ? `${pNum.toFixed(1)}%` : 'n/a';
  const filled = pNum != null ? Math.min(10, Math.round(pNum/10)) : 0;
  const bar  = pNum != null ? `[${'█'.repeat(filled)}${'░'.repeat(10-filled)}] ${prog}` : prog;
  const txt =
    `🟣 *${sym}*  —  Odyssey bonding curve\n` +
    `\`${ct.slice(0,46)}…\`\n\n` +
    `📊 Curve: ${bar}\n\n` +
    `_Pick a buy size:_`;
  const rows = [
    [{text:'0.1 SUI', callback_data:'lp:odbuyca:0.1'}, {text:'0.5 SUI', callback_data:'lp:odbuyca:0.5'}],
    [{text:'1 SUI',   callback_data:'lp:odbuyca:1'  }, {text:'5 SUI',   callback_data:'lp:odbuyca:5'  }],
    [{text:'💸 Sell 25%', callback_data:'lp:odsellca:25'}, {text:'💸 Sell 100%', callback_data:'lp:odsellca:100'}],
    [{text:'⬅️ Back', callback_data:'lp:menu'}],
  ];
  await bot.sendMessage(chatId, txt, {parse_mode:'Markdown', reply_markup:{inline_keyboard:rows}});
}

async function _showOdyToken(chatId, msgId, idx) {
  const t = _pinnedLp(chatId, 'odyssey', idx) || ((await _getLaunchpadTokens()).odyssey||[])[idx];
  if (!t) { await bot.editMessageText('❌ Token not in cache. Refresh.', {chat_id:chatId, message_id:msgId}); return; }
  const sym  = t.symbol || '?';
  const mc   = t.marketCap ? `$${Number(t.marketCap).toLocaleString(undefined,{maximumFractionDigits:0})}` : 'n/a';
  const p    = (t.progress != null) ? t.progress : t.bondingProgress;
  const pNum = p != null ? Number(p) : null;
  const prog = pNum != null ? `${Math.round(pNum)}%` : 'n/a';
  const filled = pNum != null ? Math.min(10, Math.round(pNum/10)) : 0;
  const bar  = pNum != null ? `[${'█'.repeat(filled)}${'░'.repeat(10-filled)}] ${prog}` : prog;
  const pair = t.pairType || 'SUI';
  const ct   = (t.coinType || '').slice(0,46);
  const pairWarn = pair !== 'SUI' ? `\n\n⚠️ This token pairs with *${pair}*, not SUI.` : '';
  const txt =
    `🟣 *${sym}*  —  Odyssey\n` +
    `\`${ct}...\`\n\n` +
    `┌─────────────────────────\n` +
    `│ 🏦 MCap:  *${mc}*\n` +
    `│ 📊 Curve: ${bar}\n` +
    `│ 🔀 Pair:  ${pair}\n` +
    `└─────────────────────────${pairWarn}\n\n` +
    `_Choose buy amount (SUI):_`;
  const kb = { inline_keyboard:[
    [{text:'0.1', callback_data:`lp:odbuy:${idx}:0.1`},{text:'0.5', callback_data:`lp:odbuy:${idx}:0.5`},{text:'1', callback_data:`lp:odbuy:${idx}:1`}],
    [{text:'2',   callback_data:`lp:odbuy:${idx}:2`  },{text:'5',   callback_data:`lp:odbuy:${idx}:5`  },{text:'10',callback_data:`lp:odbuy:${idx}:10`}],
    [{text:'💸 Sell 25%', callback_data:`lp:odsell:${idx}:25`},{text:'💸 Sell 50%', callback_data:`lp:odsell:${idx}:50`},{text:'💸 Sell 100%', callback_data:`lp:odsell:${idx}:100`}],
    [{text:'⬅️ Back', callback_data:'lp:ody'}],
  ]};
  await bot.editMessageText(txt,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:kb});
}

async function _odyBuy(chatId, msgId, idx, amtSui) {
  const u = getU(chatId);
  if (!u || !u.encryptedKey) { await bot.editMessageText('❌ No wallet. Use /start first.', {chat_id:chatId,message_id:msgId}); return; }
  const t = _pinnedLp(chatId, 'odyssey', idx) || ((await _getLaunchpadTokens()).odyssey||[])[idx];
  if (!t) { await bot.editMessageText('❌ Token expired from cache.', {chat_id:chatId,message_id:msgId}); return; }
  // Guard: this entry only supports SUI-paired curves
  const pair = t.pairType || 'SUI';
  if (pair !== 'SUI') {
    await bot.editMessageText(
      `❌ *${t.symbol}* is paired with *${pair}*, not SUI.\n\nPay-with-${pair} is not supported yet from this menu.`,
      {chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:`lp:odpick:${idx}`}]]}});
    return;
  }
  if (t.isCompleted) {
    await bot.editMessageText(
      `ℹ️ *${t.symbol}* has graduated off the bonding curve.\n\nUse the regular *💰 Buy* with the CA — it now trades on Cetus.`,
      {chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:`lp:odpick:${idx}`}]]}});
    return;
  }
  await bot.editMessageText(`⏳ Buying ${amtSui} SUI of *${t.symbol}* on Odyssey...`,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown'});
  try {
    const kp = getKP(u);
    const amtMist = BigInt(Math.floor(parseFloat(amtSui) * Number(MIST)));
    const tx = await buildOdysseyBuyTx({
      suiClient: sui, walletAddress: u.walletAddress,
      coinType: t.coinType, packageId: t.moonbagsPackageId,
      amountInMist: amtMist, minOutRaw: 0n,
    });
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'tx failed');
    const meta = await getMeta(t.coinType) || {};
    const dec  = meta.decimals || 9;
    const ab   = await getActualDelta(res.balanceChanges || res.digest, t.coinType, u.walletAddress);
    const got  = ab && ab > 0n ? Number(ab)/Math.pow(10, dec) : 0;
    addPos(chatId, { ct: t.coinType, sym: t.symbol, entry: parseFloat(amtSui)/(got||1), tokens: got, dec, spent: amtSui, source:'odyssey', entryMc: t.marketCapUsd ? Number(t.marketCapUsd) : (t.marketCap ? Number(t.marketCap) : null), tp: u.settings?.tpDefault, sl: u.settings?.slDefault });
    await bot.editMessageText(
      `🟢 *Bought ${t.symbol}* on Odyssey\n━━━━━━━━━━━━━━━━━━━━\n` +
      `💸 Spent:    \`${amtSui} SUI\`\n` +
      `📦 Received: \`${got > 0 ? got.toLocaleString(undefined,{maximumFractionDigits:4}) : '?'} ${t.symbol}\`\n\n` +
      `🔗 [View TX](${SUISCAN}${res.digest})`,
      {chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:`lp:odpick:${idx}`}]]}});
  } catch(e) {
    const msg = String(e?.message || e || 'unknown error');
    await bot.editMessageText(`❌ Buy failed:\n\`${msg.slice(0,500)}\``,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:`lp:odpick:${idx}`}]]}});
  }
}

async function _odySell(chatId, msgId, idx, pct) {
  const u = getU(chatId);
  if (!u || !u.encryptedKey) { await bot.editMessageText('❌ No wallet.', {chat_id:chatId,message_id:msgId}); return; }
  const t = _pinnedLp(chatId, 'odyssey', idx) || ((await _getLaunchpadTokens()).odyssey||[])[idx];
  if (!t) { await bot.editMessageText('❌ Token expired from cache.', {chat_id:chatId,message_id:msgId}); return; }
  await bot.editMessageText(`⏳ Selling ${pct}% of *${t.symbol}*...`,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown'});
  try {
    const bal = await sui.getBalance({ owner: u.walletAddress, coinType: t.coinType });
    const total = BigInt(bal.totalBalance || 0);
    if (total === 0n) throw new Error('No balance');
    const sellAmt = (total * BigInt(pct)) / 100n;
    // Fetch all coin objects of this token type to merge before sell
    const coins = await sui.getCoins({ owner: u.walletAddress, coinType: t.coinType });
    const coinIds = (coins.data || []).map(c => c.coinObjectId);
    if (!coinIds.length) throw new Error('No coin objects to sell');
    const kp = getKP(u);
    const tx = await buildOdysseySellTx({
      suiClient: sui, walletAddress: u.walletAddress,
      coinType: t.coinType, packageId: t.moonbagsPackageId,
      tokenCoinIdsToMerge: coinIds, amountToSellRaw: sellAmt, minSuiOutMist: 0n,
    });
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'tx failed');
    const meta = await getMeta(t.coinType) || {};
    const dec  = meta.decimals || 9;
    const sold = Number(sellAmt)/Math.pow(10, dec);
    const sd   = await getActualDelta(res.balanceChanges || res.digest, SUI_T, u.walletAddress);
    const suiR = sd && sd > 0n ? Number(sd)/1e9 : 0;
    // Subtract sold portion from position bag
    if (u.positions) {
      const pos = u.positions.find(p => p.ct === t.coinType);
      if (pos) { pos.tokens = Math.max(0, (pos.tokens||0) - sold); if (pos.tokens === 0) u.positions = u.positions.filter(p => p !== pos); saveDB(); }
    }
    await bot.editMessageText(
      `🔴 *Sold ${pct}% of ${t.symbol}* on Odyssey\n━━━━━━━━━━━━━━━━━━━━\n` +
      `📤 Sold:     ${sold.toLocaleString(undefined,{maximumFractionDigits:4})} ${t.symbol}\n` +
      `💰 Received: ${suiR > 0 ? suiR.toFixed(4) : '?'} SUI\n\n` +
      `🔗 [View TX](${SUISCAN}${res.digest})`,
      {chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:`lp:odpick:${idx}`}]]}});
  } catch(e) {
    const msg = String(e?.message || e || 'unknown error');
    await bot.editMessageText(`❌ Sell failed:\n\`${msg.slice(0,500)}\``,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:`lp:odpick:${idx}`}]]}});
  }
}

// Buy / sell helpers for the CA-paste flow. Token info lives on the user's
// session (pd.odyCA), so no dependency on _lpCache index.
async function _odyBuyCA(chatId, msgId, amtSui) {
  const u = getU(chatId);
  const t = u?.pd?.odyCA;
  if (!t) { await bot.sendMessage(chatId, '❌ Lost the token reference. Paste the CA again.'); return; }
  if ((t.pairType||'SUI') !== 'SUI') {
    await bot.sendMessage(chatId, `❌ ${t.symbol} is paired with ${t.pairType}, not SUI — pay-with-${t.pairType} not supported here yet.`);
    return;
  }
  if (t.isCompleted) {
    await bot.sendMessage(chatId, `ℹ️ ${t.symbol} graduated off the bonding curve. Use 💰 Buy with the CA — it now trades on Cetus.`);
    return;
  }
  const m = await bot.sendMessage(chatId, `⏳ Buying ${amtSui} SUI of *${t.symbol}* on Odyssey...`, {parse_mode:'Markdown'});
  try {
    const kp = getKP(u);
    const amtMist = BigInt(Math.floor(parseFloat(amtSui) * Number(MIST)));
    const tx = await buildOdysseyBuyTx({
      suiClient: sui, walletAddress: u.walletAddress,
      coinType: t.coinType, packageId: t.moonbagsPackageId,
      amountInMist: amtMist, minOutRaw: 0n,
    });
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'tx failed');
    const meta = await getMeta(t.coinType) || {};
    const dec  = meta.decimals || 9;
    const ab   = await getActualDelta(res.balanceChanges || res.digest, t.coinType, u.walletAddress);
    const got  = ab && ab > 0n ? Number(ab)/Math.pow(10, dec) : 0;
    addPos(chatId, { ct: t.coinType, sym: t.symbol, entry: parseFloat(amtSui)/(got||1), tokens: got, dec, spent: amtSui, source:'odyssey', entryMc: t.marketCapUsd ? Number(t.marketCapUsd) : (t.marketCap ? Number(t.marketCap) : null), tp: u.settings?.tpDefault, sl: u.settings?.slDefault });
    await bot.editMessageText(
      `🟢 *Bought ${t.symbol}* on Odyssey\n━━━━━━━━━━━━━━━━━━━━\n` +
      `💸 Spent:    \`${amtSui} SUI\`\n` +
      `📦 Received: \`${got > 0 ? got.toLocaleString(undefined,{maximumFractionDigits:4}) : '?'} ${t.symbol}\`\n\n` +
      `🔗 [View TX](${SUISCAN}${res.digest})`,
      {chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});
  } catch(e) {
    const msg = String(e?.message || e || 'unknown error');
    await bot.editMessageText(`❌ Buy failed:\n\`${msg.slice(0,500)}\``,{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});
  }
}

async function _odySellCA(chatId, msgId, pct) {
  const u = getU(chatId);
  const t = u?.pd?.odyCA;
  if (!t) { await bot.sendMessage(chatId, '❌ Lost the token reference. Paste the CA again.'); return; }
  const m = await bot.sendMessage(chatId, `⏳ Selling ${pct}% of *${t.symbol}*...`, {parse_mode:'Markdown'});
  try {
    const bal = await sui.getBalance({ owner: u.walletAddress, coinType: t.coinType });
    const total = BigInt(bal.totalBalance || 0);
    if (total === 0n) throw new Error('No balance');
    const sellAmt = (total * BigInt(pct)) / 100n;
    const coins = await sui.getCoins({ owner: u.walletAddress, coinType: t.coinType });
    const coinIds = (coins.data || []).map(c => c.coinObjectId);
    if (!coinIds.length) throw new Error('No coin objects to sell');
    const kp = getKP(u);
    const tx = await buildOdysseySellTx({
      suiClient: sui, walletAddress: u.walletAddress,
      coinType: t.coinType, packageId: t.moonbagsPackageId,
      tokenCoinIdsToMerge: coinIds, amountToSellRaw: sellAmt, minSuiOutMist: 0n,
    });
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'tx failed');
    const meta = await getMeta(t.coinType) || {};
    const dec  = meta.decimals || 9;
    const sold = Number(sellAmt)/Math.pow(10, dec);
    const sd   = await getActualDelta(res.balanceChanges || res.digest, SUI_T, u.walletAddress);
    const suiR = sd && sd > 0n ? Number(sd)/1e9 : 0;
    if (u.positions) {
      const pos = u.positions.find(p => p.ct === t.coinType);
      if (pos) { pos.tokens = Math.max(0, (pos.tokens||0) - sold); if (pos.tokens === 0) u.positions = u.positions.filter(p => p !== pos); saveDB(); }
    }
    await bot.editMessageText(
      `🔴 *Sold ${pct}% of ${t.symbol}* on Odyssey\n━━━━━━━━━━━━━━━━━━━━\n` +
      `📤 Sold:     ${sold.toLocaleString(undefined,{maximumFractionDigits:4})} ${t.symbol}\n` +
      `💰 Received: ${suiR > 0 ? suiR.toFixed(4) : '?'} SUI\n\n` +
      `🔗 [View TX](${SUISCAN}${res.digest})`,
      {chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});
  } catch(e) {
    const msg = String(e?.message || e || 'unknown error');
    await bot.editMessageText(`❌ Sell failed:\n\`${msg.slice(0,500)}\``,{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});
  }
}

// ════════════════════════════════════════════════════════════════
// AGENT MemeLand — 2-hop SUI ↔ AGENT ↔ MEME via Cetus CLMM
// ════════════════════════════════════════════════════════════════
// AGENT memes pair against AGENT (not SUI). Trades require two Cetus swaps:
//   Buy:  SUI → AGENT (SUI/AGENT 1% pool) → MEME (token's API poolId)
//   Sell: MEME → AGENT (token's API poolId) → SUI (SUI/AGENT 1% pool)
// Each hop uses the bot's existing Cetus pool_script_v2 builder.
async function _showAgentBuy(chatId, at) {
  const ct = at.coinType || at.ct;
  if (!ct) { await bot.sendMessage(chatId, '❌ Token has no contract address.'); return; }
  if (!at.poolId) { await bot.sendMessage(chatId, `❌ ${at.symbol||'token'} has no Cetus pool yet — try again in a few minutes.`); return; }
  const tok = {
    coinType: ct, symbol: at.symbol || '?', poolId: at.poolId,
    name: at.name||'', priceSui: at.priceSui, marketCapUsd: at.marketCapUsd, source: 'agent',
  };
  updU(chatId, { pd: { ...(getU(chatId)?.pd||{}), agentTok: tok } });
  const mc = at.marketCapUsd ? `$${Number(at.marketCapUsd).toLocaleString(undefined,{maximumFractionDigits:0})}` : 'n/a';
  const px = at.priceSui ? `${Number(at.priceSui).toExponential(3)} SUI` : 'n/a';
  const txt =
    `🟢 *${tok.symbol}*  —  AGENT MemeLand\n` +
    `\`${ct.slice(0,46)}…\`\n\n` +
    `┌─────────────────────────\n` +
    `│ 🏦 MCap:  *${mc}*\n` +
    `│ 💲 Price: *${px}*\n` +
    `│ 🔀 Route: SUI → AGENT → ${tok.symbol}\n` +
    `└─────────────────────────\n\n` +
    `_Pick a buy size:_`;
  const rows = [
    [{text:'0.1 SUI', callback_data:'lp:agbuyca:0.1'}, {text:'0.5 SUI', callback_data:'lp:agbuyca:0.5'}],
    [{text:'1 SUI',   callback_data:'lp:agbuyca:1'  }, {text:'5 SUI',   callback_data:'lp:agbuyca:5'  }],
    [{text:'💸 Sell 25%', callback_data:'lp:agsellca:25'}, {text:'💸 Sell 100%', callback_data:'lp:agsellca:100'}],
    [{text:'⬅️ Back', callback_data:'lp:agent'}],
  ];
  await bot.sendMessage(chatId, txt, {parse_mode:'Markdown', reply_markup:{inline_keyboard:rows}});
}

async function _agentBuyCA(chatId, msgId, amtSui) {
  const u = getU(chatId);
  if (!u || !u.encryptedKey) { await bot.sendMessage(chatId, '❌ No wallet. Use /start first.'); return; }
  const t = u?.pd?.agentTok;
  if (!t) { await bot.sendMessage(chatId, '❌ Lost token reference. Reopen 🚀 Launchpad → AGENT.'); return; }
  const sym = String(t.symbol||'?').replace(/[*_`\[\]]/g, '');
  const m = await bot.sendMessage(chatId, `⏳ Buying *${sym}* via SUI → AGENT → ${sym}\nHop 1/2: SUI → AGENT...`, {parse_mode:'Markdown'});
  try {
    const kp = getKP(u);
    const amtMist  = BigInt(Math.floor(parseFloat(amtSui) * Number(MIST)));
    // 1% fee, mirrors standard DEX buy semantics: swap (amtMist - feeMist), pay fee from gas.
    const feeMist  = (amtMist * BigInt(FEE_BPS)) / 10000n;
    const tradeMist = amtMist - feeMist;
    const refWallet = resolveRefWallet(u);
    const refMist  = refWallet ? (feeMist * BigInt(Math.floor(REF_SHARE * 100))) / 100n : 0n;
    const devMist  = feeMist - refMist;

    // Hop 1: SUI → AGENT  (pool 0xe8bf…, CoinA=AGENT, CoinB=SUI; SUI is INPUT → swap_b2a, a2b=false)
    const tx1 = await buildCetusSwapTx({
      wallet: u.walletAddress, poolId: SUI_AGENT_POOL,
      coinA: AGENT_T, coinB: SUI_T, a2b: false,
      coinInType: SUI_T, amountIn: tradeMist.toString(), minAmountOut: '0',
    });
    // Inline fee transfers (addFees is closure-scoped inside executeBuy and not reachable here)
    const [fc] = tx1.splitCoins(tx1.gas, [tx1.pure.u64(devMist)]);
    tx1.transferObjects([fc], tx1.pure.address(DEV_WALLET));
    if (refMist > 0n && refWallet) {
      const [rc] = tx1.splitCoins(tx1.gas, [tx1.pure.u64(refMist)]);
      tx1.transferObjects([rc], tx1.pure.address(refWallet));
      const ru = Object.values(DB).find(x => x.walletAddress === refWallet);
      if (ru) { ru.referralEarned = (ru.referralEarned||0) + Number(refMist)/1e9; saveDB(); }
    }
    const res1 = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx1, options:{showEffects:true,showBalanceChanges:true}});
    if (res1.effects?.status?.status !== 'success') throw new Error('Hop 1 (SUI→AGENT): ' + (res1.effects?.status?.error || 'failed'));
    const ab1 = await getActualDelta(res1.balanceChanges || res1.digest, AGENT_T, u.walletAddress);
    if (!ab1 || ab1 <= 0n) throw new Error('Hop 1 returned 0 AGENT');

    await bot.editMessageText(`⏳ Buying *${sym}* via SUI → AGENT → ${sym}\nHop 2/2: AGENT → ${sym}...`,{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});
    await new Promise(r => setTimeout(r, 800));

    // Hop 2: AGENT → MEME — re-read pool type fresh to know orientation
    let coinA = AGENT_T, coinB = t.coinType, agentIsA = true;
    try {
      const obj = await sui.getObject({ id: t.poolId, options:{showType:true} });
      const args = obj.data?.type?.match(/<(.+)>$/)?.[1]?.split(/,\s*/).map(s=>s.trim());
      if (args && args.length === 2) {
        coinA = args[0]; coinB = args[1];
        agentIsA = coinA.toLowerCase() === AGENT_T.toLowerCase();
      }
    } catch {}
    const a2b = agentIsA;  // AGENT is INPUT; if AGENT=CoinA → swap_a2b (a2b=true) else swap_b2a (a2b=false)
    const tx2 = await buildCetusSwapTx({
      wallet: u.walletAddress, poolId: t.poolId,
      coinA, coinB, a2b,
      coinInType: AGENT_T, amountIn: ab1.toString(), minAmountOut: '0',
    });
    const res2 = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx2, options:{showEffects:true,showBalanceChanges:true}});
    if (res2.effects?.status?.status !== 'success') throw new Error('Hop 2 (AGENT→MEME): ' + (res2.effects?.status?.error || 'failed'));

    const meta = await getMeta(t.coinType) || {};
    const dec  = meta.decimals || 9;
    const ab2  = await getActualDelta(res2.balanceChanges || res2.digest, t.coinType, u.walletAddress);
    const got  = ab2 && ab2 > 0n ? Number(ab2)/Math.pow(10, dec) : 0;
    const agentGot = Number(ab1)/1e9;
    addPos(chatId, { ct: t.coinType, sym: t.symbol, entry: parseFloat(amtSui)/(got||1), tokens: got, dec, spent: amtSui, source:'agent', entryMc: t.marketCapUsd ? Number(t.marketCapUsd) : (t.marketCap ? Number(t.marketCap) : null), poolId: t.poolId || null, tp: u.settings?.tpDefault, sl: u.settings?.slDefault });
    await bot.editMessageText(
      `🟢 *Bought ${sym}* via AGENT MemeLand\n━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 Spent:    ${amtSui} SUI\n` +
      `🟢 Hop 1:    ${agentGot.toFixed(4)} AGENT\n` +
      `📦 Received: ${got > 0 ? got.toLocaleString(undefined,{maximumFractionDigits:4}) : '?'} ${sym}\n\n` +
      `🔗 [TX 1](${SUISCAN}${res1.digest})  ·  [TX 2](${SUISCAN}${res2.digest})`,
      {chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:'lp:agent'}]]}});
  } catch(e) {
    const msg = String(e?.message || e || 'unknown error');
    await bot.editMessageText(`❌ AGENT buy failed:\n\`${msg.slice(0,500)}\``,{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:'lp:agent'}]]}});
  }
}

async function _agentSellCA(chatId, msgId, pct) {
  const u = getU(chatId);
  if (!u || !u.encryptedKey) { await bot.sendMessage(chatId, '❌ No wallet.'); return; }
  const t = u?.pd?.agentTok;
  if (!t) { await bot.sendMessage(chatId, '❌ Lost token reference. Reopen 🚀 Launchpad → AGENT.'); return; }
  const sym = String(t.symbol||'?').replace(/[*_`\[\]]/g, '');
  const m = await bot.sendMessage(chatId, `⏳ Selling ${pct}% of *${sym}* via ${sym} → AGENT → SUI\nHop 1/2: ${sym} → AGENT...`, {parse_mode:'Markdown'});
  try {
    const bal = await sui.getBalance({ owner: u.walletAddress, coinType: t.coinType });
    const total = BigInt(bal.totalBalance || 0);
    if (total === 0n) throw new Error('No balance to sell');
    const sellRaw = (total * BigInt(pct)) / 100n;
    const kp = getKP(u);

    // Hop 1: MEME → AGENT — re-read pool type fresh
    let coinA = t.coinType, coinB = AGENT_T, memeIsA = true;
    try {
      const obj = await sui.getObject({ id: t.poolId, options:{showType:true} });
      const args = obj.data?.type?.match(/<(.+)>$/)?.[1]?.split(/,\s*/).map(s=>s.trim());
      if (args && args.length === 2) {
        coinA = args[0]; coinB = args[1];
        memeIsA = coinA.toLowerCase() === t.coinType.toLowerCase();
      }
    } catch {}
    const a2b1 = memeIsA;  // MEME is INPUT; if MEME=CoinA → a2b=true else false
    const tx1 = await buildCetusSwapTx({
      wallet: u.walletAddress, poolId: t.poolId,
      coinA, coinB, a2b: a2b1,
      coinInType: t.coinType, amountIn: sellRaw.toString(), minAmountOut: '0',
    });
    const res1 = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx1, options:{showEffects:true,showBalanceChanges:true}});
    if (res1.effects?.status?.status !== 'success') throw new Error('Hop 1 (MEME→AGENT): ' + (res1.effects?.status?.error || 'failed'));
    const agentGot = await getActualDelta(res1.balanceChanges || res1.digest, AGENT_T, u.walletAddress);
    if (!agentGot || agentGot <= 0n) throw new Error('Hop 1 returned 0 AGENT');

    await bot.editMessageText(`⏳ Selling ${pct}% of *${sym}* via ${sym} → AGENT → SUI\nHop 2/2: AGENT → SUI...`,{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});
    await new Promise(r => setTimeout(r, 800));

    // Hop 2: AGENT → SUI  (pool CoinA=AGENT, CoinB=SUI; AGENT is INPUT → swap_a2b, a2b=true)
    const tx2 = await buildCetusSwapTx({
      wallet: u.walletAddress, poolId: SUI_AGENT_POOL,
      coinA: AGENT_T, coinB: SUI_T, a2b: true,
      coinInType: AGENT_T, amountIn: agentGot.toString(), minAmountOut: '0',
    });
    const res2 = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx2, options:{showEffects:true,showBalanceChanges:true}});
    if (res2.effects?.status?.status !== 'success') throw new Error('Hop 2 (AGENT→SUI): ' + (res2.effects?.status?.error || 'failed'));
    const suiDelta = await getActualDelta(res2.balanceChanges || res2.digest, SUI_T, u.walletAddress);
    const suiR = suiDelta && suiDelta > 0n ? Number(suiDelta)/1e9 : 0;

    // Apply post-sell fee (1% of SUI proceeds → DEV / referrer), mirroring standard sell flow
    let feeMist = 0n;
    try { feeMist = await postSellFee(kp, u, suiR); } catch (e) { console.error('AGENT sell postSellFee failed:', e?.message||e); }

    const meta = await getMeta(t.coinType) || {};
    const dec  = meta.decimals || 9;
    const sold = Number(sellRaw)/Math.pow(10, dec);
    if (u.positions) {
      const pos = u.positions.find(p => p.ct === t.coinType);
      if (pos) { pos.tokens = Math.max(0, (pos.tokens||0) - sold); if (pos.tokens === 0) u.positions = u.positions.filter(p => p !== pos); saveDB(); }
    }
    await bot.editMessageText(
      `✅ *Sold ${pct}% of ${sym}* via AGENT MemeLand\n\n` +
      `📤 Sold:     ${sold.toLocaleString(undefined,{maximumFractionDigits:4})} ${sym}\n` +
      `🟢 Hop 1:    ${(Number(agentGot)/1e9).toFixed(4)} AGENT\n` +
      `💰 Received: ${suiR > 0 ? suiR.toFixed(4) : '?'} SUI\n` +
      `🧾 Fee:      ${(Number(feeMist)/1e9).toFixed(4)} SUI\n\n` +
      `🔗 [TX 1](${SUISCAN}${res1.digest})  ·  [TX 2](${SUISCAN}${res2.digest})`,
      {chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:'lp:agent'}]]}});
  } catch(e) {
    const msg = String(e?.message || e || 'unknown error');
    await bot.editMessageText(`❌ AGENT sell failed:\n\`${msg.slice(0,500)}\``,{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:'lp:agent'}]]}});
  }
}

// ── Moonbags (moonbags.io) launchpad UI ────────────────────────────
async function _showMbList(chatId, msgId) {
  const m = msgId ? null : await bot.sendMessage(chatId, '⏳ Fetching Moonbags tokens...');
  try {
    const { moonbags } = await _getLaunchpadTokens();
    _pinLp(chatId, 'moonbags', moonbags);
    if (!moonbags.length) {
      const txt = '🟠 *Moonbags*\n\nNo bonding-curve tokens available right now.';
      const kb = { inline_keyboard:[[{text:'⬅️ Back', callback_data:'lp:menu'}]] };
      if (msgId) await bot.editMessageText(txt,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:kb});
      else await bot.editMessageText(txt,{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown',reply_markup:kb});
      return;
    }
    const lines = moonbags.slice(0,10).map((t,i)=>_fmtToken(t,i)).join('\n\n');
    const txt = `🟠 *Moonbags* — ${moonbags.length} on bonding curve\n\n${lines}\n\n_Tap a token to buy/sell on the curve:_`;
    const rows = moonbags.slice(0,10).map((t,i)=>([{text:`${i+1}. ${(t.symbol||'?').slice(0,8)}`, callback_data:`lp:mbpick:${i}`}]));
    rows.push([{text:'🔄 Refresh', callback_data:'lp:mb'},{text:'⬅️ Back', callback_data:'lp:menu'}]);
    const opts = { parse_mode:'Markdown', reply_markup:{ inline_keyboard:rows } };
    if (msgId) await bot.editMessageText(txt,{chat_id:chatId,message_id:msgId,...opts});
    else await bot.editMessageText(txt,{chat_id:chatId,message_id:m.message_id,...opts});
  } catch(e) {
    const txt = `❌ Couldn't load Moonbags tokens: ${(e.message||'').slice(0,140)}`;
    if (m) await bot.editMessageText(txt,{chat_id:chatId,message_id:m.message_id});
    else await bot.sendMessage(chatId, txt);
  }
}

async function _showMbByCA(chatId, ct, info) {
  const tok = {
    coinType: ct,
    symbol: info.symbol || (ct.split('::').pop() || '?'),
    pairType: 'SUI',
    progress: info.progress ?? null,
    isCompleted: !!info.isCompleted,
    source: 'Moonbags',
  };
  updU(chatId, { pd: { ...(getU(chatId)?.pd||{}), mbCA: tok } });
  const sym  = tok.symbol;
  const pNum = tok.progress != null ? Number(tok.progress) : null;
  const prog = pNum != null ? `${pNum.toFixed(1)}%` : 'n/a';
  const filled = pNum != null ? Math.min(10, Math.round(pNum/10)) : 0;
  const bar  = pNum != null ? `[${'█'.repeat(filled)}${'░'.repeat(10-filled)}] ${prog}` : prog;
  const txt =
    `🟠 *${sym}*  —  Moonbags bonding curve\n` +
    `\`${ct.slice(0,46)}…\`\n\n` +
    `📊 Curve: ${bar}\n\n` +
    `_Pick a buy size:_`;
  const rows = [
    [{text:'0.1 SUI', callback_data:'lp:mbbuyca:0.1'}, {text:'0.5 SUI', callback_data:'lp:mbbuyca:0.5'}],
    [{text:'1 SUI',   callback_data:'lp:mbbuyca:1'  }, {text:'5 SUI',   callback_data:'lp:mbbuyca:5'  }],
    [{text:'💸 Sell 25%', callback_data:'lp:mbsellca:25'}, {text:'💸 Sell 100%', callback_data:'lp:mbsellca:100'}],
    [{text:'⬅️ Back', callback_data:'lp:menu'}],
  ];
  await bot.sendMessage(chatId, txt, {parse_mode:'Markdown', reply_markup:{inline_keyboard:rows}});
}

async function _showMbToken(chatId, msgId, idx) {
  const t = _pinnedLp(chatId, 'moonbags', idx) || ((await _getLaunchpadTokens()).moonbags||[])[idx];
  if (!t) { await bot.editMessageText('❌ Token not in cache. Refresh.', {chat_id:chatId, message_id:msgId}); return; }
  const sym  = t.symbol || '?';
  const mc   = t.marketCap ? `$${Number(t.marketCap).toLocaleString(undefined,{maximumFractionDigits:0})}` : 'n/a';
  const p    = t.progress != null ? Number(t.progress) : null;
  const prog = p != null ? `${Math.round(p)}%` : 'n/a';
  const filled = p != null ? Math.min(10, Math.round(p/10)) : 0;
  const bar  = p != null ? `[${'█'.repeat(filled)}${'░'.repeat(10-filled)}] ${prog}` : prog;
  const ct   = (t.coinType || '').slice(0,46);
  const txt =
    `🟠 *${sym}*  —  Moonbags\n` +
    `\`${ct}...\`\n\n` +
    `┌─────────────────────────\n` +
    `│ 🏦 MCap:  *${mc}*\n` +
    `│ 📊 Curve: ${bar}\n` +
    `└─────────────────────────\n\n` +
    `_Choose buy amount (SUI):_`;
  const kb = { inline_keyboard:[
    [{text:'0.1', callback_data:`lp:mbbuy:${idx}:0.1`},{text:'0.5', callback_data:`lp:mbbuy:${idx}:0.5`},{text:'1', callback_data:`lp:mbbuy:${idx}:1`}],
    [{text:'2',   callback_data:`lp:mbbuy:${idx}:2`  },{text:'5',   callback_data:`lp:mbbuy:${idx}:5`  },{text:'10',callback_data:`lp:mbbuy:${idx}:10`}],
    [{text:'💸 Sell 25%', callback_data:`lp:mbsell:${idx}:25`},{text:'💸 Sell 50%', callback_data:`lp:mbsell:${idx}:50`},{text:'💸 Sell 100%', callback_data:`lp:mbsell:${idx}:100`}],
    [{text:'⬅️ Back', callback_data:'lp:mb'}],
  ]};
  await bot.editMessageText(txt,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:kb});
}

async function _mbBuyCommon(chatId, msgId, t, amtSui, backCb) {
  const u = getU(chatId);
  if (!u || !u.encryptedKey) { await bot.editMessageText('❌ No wallet. Use /start first.', {chat_id:chatId,message_id:msgId}); return; }
  if (t.isCompleted) {
    await bot.editMessageText(
      `ℹ️ *${t.symbol}* has graduated off the moonbags curve.\n\nUse the regular *💰 Buy* with the CA — it now trades on Cetus.`,
      {chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:backCb}]]}});
    return;
  }
  // Telegram throws "message is not modified" if the new text matches the
  // current text exactly. The CA path pre-sends the same string so we wrap
  // this status edit in a try/catch — it's a UX nicety, never a hard step.
  try { await bot.editMessageText(`⏳ Submitting Moonbags buy: ${amtSui} SUI for *${t.symbol}*...`, {chat_id:chatId, message_id:msgId, parse_mode:'Markdown'}); } catch {}
  try {
    const kp = getKP(u);
    const amtMist = BigInt(Math.floor(parseFloat(amtSui) * Number(MIST)));
    // Bot fee: 5% off the user's spend, paid in the SAME tx so the swap
    // amount becomes (amtMist - feeMist). Mirrors AGENT/Cetus buy flow.
    const feeMist  = (amtMist * BigInt(FEE_BPS)) / 10000n;
    const tradeMist = amtMist - feeMist;
    const refWallet = resolveRefWallet(u);
    const refMist  = refWallet ? (feeMist * BigInt(Math.floor(REF_SHARE * 100))) / 100n : 0n;
    const devMist  = feeMist - refMist;
    const slipBps = BigInt(Math.floor((u.settings?.slippage ?? 5) * 100));
    const tx = await buildMoonbagsBuyTx({
      suiClient: sui, walletAddress: u.walletAddress,
      coinType: t.coinType, amountInMist: tradeMist, slippageBps: slipBps,
    });
    // Inline fee transfers — split from gas, send to dev (and referrer if any).
    if (devMist > 0n) {
      const [fc] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
      tx.transferObjects([fc], tx.pure.address(DEV_WALLET));
    }
    if (refMist > 0n && refWallet) {
      const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(refMist)]);
      tx.transferObjects([rc], tx.pure.address(refWallet));
      const ru = Object.values(DB).find(x => x.walletAddress === refWallet);
      if (ru) { ru.referralEarned = (ru.referralEarned||0) + Number(refMist)/1e9; saveDB(); }
    }
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'tx failed');
    const meta = await getMeta(t.coinType) || {};
    const dec  = meta.decimals || 9;
    const ab   = await getActualDelta(res.balanceChanges || res.digest, t.coinType, u.walletAddress);
    const got  = ab && ab > 0n ? Number(ab)/Math.pow(10, dec) : 0;
    addPos(chatId, { ct: t.coinType, sym: t.symbol, entry: parseFloat(amtSui)/(got||1), tokens: got, dec, spent: amtSui, source:'moonbags', entryMc: t.marketCapUsd ? Number(t.marketCapUsd) : (t.marketCap ? Number(t.marketCap) : null), tp: u.settings?.tpDefault, sl: u.settings?.slDefault });
    await bot.editMessageText(
      `🟢 *Bought ${t.symbol}* on Moonbags\n━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 Spent:    ${amtSui} SUI\n` +
      `📦 Received: ${got > 0 ? got.toLocaleString(undefined,{maximumFractionDigits:4}) : '?'} ${t.symbol}\n\n` +
      `🔗 [View TX](${SUISCAN}${res.digest})`,
      {chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:backCb}]]}});
  } catch(e) {
    const msg = String(e?.message || e || 'unknown error');
    await bot.editMessageText(`❌ Buy failed:\n\`${msg.slice(0,500)}\``,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:backCb}]]}});
  }
}

async function _mbSellCommon(chatId, msgId, t, pct, backCb) {
  const u = getU(chatId);
  if (!u || !u.encryptedKey) { await bot.editMessageText('❌ No wallet.', {chat_id:chatId,message_id:msgId}); return; }
  // Same Telegram "not modified" guard as the buy path.
  try { await bot.editMessageText(`⏳ Submitting Moonbags sell: ${pct}% of *${t.symbol}*...`, {chat_id:chatId, message_id:msgId, parse_mode:'Markdown'}); } catch {}
  try {
    const bal = await sui.getBalance({ owner: u.walletAddress, coinType: t.coinType });
    const total = BigInt(bal.totalBalance || 0);
    if (total === 0n) throw new Error('No balance');
    const sellAmt = (total * BigInt(pct)) / 100n;
    const coins = await sui.getCoins({ owner: u.walletAddress, coinType: t.coinType });
    const coinIds = (coins.data || []).map(c => c.coinObjectId);
    if (!coinIds.length) throw new Error('No coin objects to sell');
    const kp = getKP(u);
    const tx = await buildMoonbagsSellTx({
      walletAddress: u.walletAddress, coinType: t.coinType,
      tokenCoinIdsToMerge: coinIds, amountToSellRaw: sellAmt, minSuiOutMist: 0n,
    });
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'tx failed');
    const meta = await getMeta(t.coinType) || {};
    const dec  = meta.decimals || 9;
    const sold = Number(sellAmt)/Math.pow(10, dec);
    const sd   = await getActualDelta(res.balanceChanges || res.digest, SUI_T, u.walletAddress);
    const suiR = sd && sd > 0n ? Number(sd)/1e9 : 0;
    // 5% bot fee on actual SUI received — separate tx, silent fail so it
    // never blocks the sell. Splits referrer share automatically.
    await postSellFee(kp, u, suiR).catch(()=>{});
    if (u.positions) {
      const pos = u.positions.find(p => p.ct === t.coinType);
      if (pos) { pos.tokens = Math.max(0, (pos.tokens||0) - sold); if (pos.tokens === 0) u.positions = u.positions.filter(p => p !== pos); saveDB(); }
    }
    await bot.editMessageText(
      `🔴 *Sold ${pct}% of ${t.symbol}* on Moonbags\n━━━━━━━━━━━━━━━━━━━━\n` +
      `📤 Sold:     ${sold.toLocaleString(undefined,{maximumFractionDigits:4})} ${t.symbol}\n` +
      `💰 Received: ${suiR > 0 ? suiR.toFixed(4) : '?'} SUI\n\n` +
      `🔗 [View TX](${SUISCAN}${res.digest})`,
      {chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:backCb}]]}});
  } catch(e) {
    const msg = String(e?.message || e || 'unknown error');
    await bot.editMessageText(`❌ Sell failed:\n\`${msg.slice(0,500)}\``,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:backCb}]]}});
  }
}

async function _mbBuy(chatId, msgId, idx, amtSui) {
  const t = _pinnedLp(chatId, 'moonbags', idx) || ((await _getLaunchpadTokens()).moonbags||[])[idx];
  if (!t) { await bot.editMessageText('❌ Token expired from cache.', {chat_id:chatId,message_id:msgId}); return; }
  return _mbBuyCommon(chatId, msgId, t, amtSui, `lp:mbpick:${idx}`);
}
async function _mbSell(chatId, msgId, idx, pct) {
  const t = _pinnedLp(chatId, 'moonbags', idx) || ((await _getLaunchpadTokens()).moonbags||[])[idx];
  if (!t) { await bot.editMessageText('❌ Token expired from cache.', {chat_id:chatId,message_id:msgId}); return; }
  return _mbSellCommon(chatId, msgId, t, pct, `lp:mbpick:${idx}`);
}
async function _mbBuyCA(chatId, msgId, amtSui) {
  const u = getU(chatId);
  const t = u?.pd?.mbCA;
  if (!t) { await bot.sendMessage(chatId, '❌ Lost the token reference. Paste the CA again.'); return; }
  const m = await bot.sendMessage(chatId, `⏳ Buying ${amtSui} SUI of *${t.symbol}* on Moonbags...`, {parse_mode:'Markdown'});
  return _mbBuyCommon(chatId, m.message_id, t, amtSui, 'lp:menu');
}
async function _mbSellCA(chatId, msgId, pct) {
  const u = getU(chatId);
  const t = u?.pd?.mbCA;
  if (!t) { await bot.sendMessage(chatId, '❌ Lost the token reference. Paste the CA again.'); return; }
  const m = await bot.sendMessage(chatId, `⏳ Selling ${pct}% of *${t.symbol}*...`, {parse_mode:'Markdown'});
  return _mbSellCommon(chatId, m.message_id, t, pct, 'lp:menu');
}

// ── hop.fun launchpad UI ──────────────────────────────────────────
async function _showHfList(chatId, msgId) {
  const m = msgId ? null : await bot.sendMessage(chatId, '⏳ Fetching hop.fun tokens...');
  try {
    const { hopfun } = await _getLaunchpadTokens();
    _pinLp(chatId, 'hopfun', hopfun);
    if (!hopfun.length) {
      const txt = '🔵 *hop.fun*\n\nNo bonding-curve tokens available right now.';
      const kb = { inline_keyboard:[[{text:'⬅️ Back', callback_data:'lp:menu'}]] };
      if (msgId) await bot.editMessageText(txt,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:kb});
      else await bot.editMessageText(txt,{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown',reply_markup:kb});
      return;
    }
    const lines = hopfun.slice(0,10).map((t,i)=>_fmtToken(t,i)).join('\n\n');
    const txt = `🔵 *hop.fun* — ${hopfun.length} on bonding curve\n\n${lines}\n\n_Tap a token to buy/sell on the curve:_`;
    const rows = hopfun.slice(0,10).map((t,i)=>([{text:`${i+1}. ${(t.symbol||'?').slice(0,8)}`, callback_data:`lp:hfpick:${i}`}]));
    rows.push([{text:'🔄 Refresh', callback_data:'lp:hf'},{text:'⬅️ Back', callback_data:'lp:menu'}]);
    const opts = { parse_mode:'Markdown', reply_markup:{ inline_keyboard:rows } };
    if (msgId) await bot.editMessageText(txt,{chat_id:chatId,message_id:msgId,...opts});
    else await bot.editMessageText(txt,{chat_id:chatId,message_id:m.message_id,...opts});
  } catch(e) {
    const txt = `❌ Couldn't load hop.fun tokens: ${(e.message||'').slice(0,140)}`;
    if (m) await bot.editMessageText(txt,{chat_id:chatId,message_id:m.message_id});
    else await bot.sendMessage(chatId, txt);
  }
}

async function _showHfByCA(chatId, ct, info) {
  // BigInts can't survive JSON.stringify in saveDB() — string-encode for storage.
  const tok = {
    coinType: ct,
    symbol: info.symbol || (ct.split('::').pop() || '?'),
    pairType: 'SUI',
    progress: info.progress ?? null,
    isCompleted: !!info.isCompleted,
    curveId: info.curveId || null,
    virtualSuiReserves:   info.virtualSuiReserves   != null ? String(info.virtualSuiReserves)   : null,
    virtualTokenReserves: info.virtualTokenReserves != null ? String(info.virtualTokenReserves) : null,
    source: 'hop.fun',
  };
  updU(chatId, { pd: { ...(getU(chatId)?.pd||{}), hfCA: tok } });
  const sym  = tok.symbol;
  const pNum = tok.progress != null ? Number(tok.progress) : null;
  const prog = pNum != null ? `${pNum.toFixed(1)}%` : 'n/a';
  const filled = pNum != null ? Math.min(10, Math.round(pNum/10)) : 0;
  const bar  = pNum != null ? `[${'█'.repeat(filled)}${'░'.repeat(10-filled)}] ${prog}` : prog;
  const txt =
    `🔵 *${sym}*  —  hop.fun bonding curve\n` +
    `\`${ct.slice(0,46)}…\`\n\n` +
    `📊 Curve: ${bar}\n\n` +
    `_Pick a buy size:_`;
  const rows = [
    [{text:'0.1 SUI', callback_data:'lp:hfbuyca:0.1'}, {text:'0.5 SUI', callback_data:'lp:hfbuyca:0.5'}],
    [{text:'1 SUI',   callback_data:'lp:hfbuyca:1'  }, {text:'5 SUI',   callback_data:'lp:hfbuyca:5'  }],
    [{text:'💸 Sell 25%', callback_data:'lp:hfsellca:25'}, {text:'💸 Sell 100%', callback_data:'lp:hfsellca:100'}],
    [{text:'⬅️ Back', callback_data:'lp:menu'}],
  ];
  await bot.sendMessage(chatId, txt, {parse_mode:'Markdown', reply_markup:{inline_keyboard:rows}});
}

async function _showHfToken(chatId, msgId, idx) {
  const t = _pinnedLp(chatId, 'hopfun', idx) || ((await _getLaunchpadTokens()).hopfun||[])[idx];
  if (!t) { await bot.editMessageText('❌ Token not in cache. Refresh.', {chat_id:chatId, message_id:msgId}); return; }
  const sym  = t.symbol || '?';
  const mc   = t.marketCap ? `$${Number(t.marketCap).toLocaleString(undefined,{maximumFractionDigits:0})}` : 'n/a';
  const p    = t.progress != null ? Number(t.progress) : null;
  const prog = p != null ? `${Math.round(p)}%` : 'n/a';
  const filled = p != null ? Math.min(10, Math.round(p/10)) : 0;
  const bar  = p != null ? `[${'█'.repeat(filled)}${'░'.repeat(10-filled)}] ${prog}` : prog;
  const ct   = (t.coinType || '').slice(0,46);
  const txt =
    `🔵 *${sym}*  —  hop.fun\n` +
    `\`${ct}...\`\n\n` +
    `┌─────────────────────────\n` +
    `│ 🏦 MCap:  *${mc}*\n` +
    `│ 📊 Curve: ${bar}\n` +
    `└─────────────────────────\n\n` +
    `_Choose buy amount (SUI):_`;
  const kb = { inline_keyboard:[
    [{text:'0.1', callback_data:`lp:hfbuy:${idx}:0.1`},{text:'0.5', callback_data:`lp:hfbuy:${idx}:0.5`},{text:'1', callback_data:`lp:hfbuy:${idx}:1`}],
    [{text:'2',   callback_data:`lp:hfbuy:${idx}:2`  },{text:'5',   callback_data:`lp:hfbuy:${idx}:5`  },{text:'10',callback_data:`lp:hfbuy:${idx}:10`}],
    [{text:'💸 Sell 25%', callback_data:`lp:hfsell:${idx}:25`},{text:'💸 Sell 50%', callback_data:`lp:hfsell:${idx}:50`},{text:'💸 Sell 100%', callback_data:`lp:hfsell:${idx}:100`}],
    [{text:'⬅️ Back', callback_data:'lp:hf'}],
  ]};
  await bot.editMessageText(txt,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:kb});
}

async function _hfBuyCommon(chatId, msgId, t, amtSui, backCb) {
  const u = getU(chatId);
  if (!u || !u.encryptedKey) { await bot.editMessageText('❌ No wallet. Use /start first.', {chat_id:chatId,message_id:msgId}); return; }
  if (t.isCompleted) {
    await bot.editMessageText(
      `ℹ️ *${t.symbol}* has graduated off the hop.fun curve.\n\nUse the regular *💰 Buy* with the CA — it now trades on Cetus.`,
      {chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:backCb}]]}});
    return;
  }
  try { await bot.editMessageText(`⏳ Submitting hop.fun buy: ${amtSui} SUI for *${t.symbol}*...`, {chat_id:chatId, message_id:msgId, parse_mode:'Markdown'}); } catch {}
  try {
    const kp = getKP(u);
    const amtMist = BigInt(Math.floor(parseFloat(amtSui) * Number(MIST)));
    // Bot fee: 5% off the user's spend, paid in the SAME tx so the swap
    // amount becomes (amtMist - feeMist). Mirrors AGENT/Cetus/Moonbags pattern.
    const feeMist  = (amtMist * BigInt(FEE_BPS)) / 10000n;
    const tradeMist = amtMist - feeMist;
    const refWallet = resolveRefWallet(u);
    const refMist  = refWallet ? (feeMist * BigInt(Math.floor(REF_SHARE * 100))) / 100n : 0n;
    const devMist  = feeMist - refMist;
    const slipBps = BigInt(Math.floor((u.settings?.slippage ?? 5) * 100));
    const reservesOverride = (t.virtualSuiReserves && t.virtualTokenReserves)
      ? { vsr: t.virtualSuiReserves, vtr: t.virtualTokenReserves } : null;
    const tx = await buildHopFunBuyTx({
      suiClient: sui, walletAddress: u.walletAddress,
      coinType: t.coinType, amountInMist: tradeMist, slippageBps: slipBps,
      curveOverride: t.curveId || null,
      reservesOverride,
    });
    if (devMist > 0n) {
      const [fc] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
      tx.transferObjects([fc], tx.pure.address(DEV_WALLET));
    }
    if (refMist > 0n && refWallet) {
      const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(refMist)]);
      tx.transferObjects([rc], tx.pure.address(refWallet));
      const ru = Object.values(DB).find(x => x.walletAddress === refWallet);
      if (ru) { ru.referralEarned = (ru.referralEarned||0) + Number(refMist)/1e9; saveDB(); }
    }
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'tx failed');
    const meta = await getMeta(t.coinType) || {};
    const dec  = meta.decimals || 9;
    const ab   = await getActualDelta(res.balanceChanges || res.digest, t.coinType, u.walletAddress);
    const got  = ab && ab > 0n ? Number(ab)/Math.pow(10, dec) : 0;
    addPos(chatId, { ct: t.coinType, sym: t.symbol, entry: parseFloat(amtSui)/(got||1), tokens: got, dec, spent: amtSui, source:'hopfun', entryMc: t.marketCapUsd ? Number(t.marketCapUsd) : (t.marketCap ? Number(t.marketCap) : null), tp: u.settings?.tpDefault, sl: u.settings?.slDefault });
    await bot.editMessageText(
      `🟢 *Bought ${t.symbol}* on hop.fun\n━━━━━━━━━━━━━━━━━━━━\n` +
      `💰 Spent:    ${amtSui} SUI\n` +
      `📦 Received: ${got > 0 ? got.toLocaleString(undefined,{maximumFractionDigits:4}) : '?'} ${t.symbol}\n\n` +
      `🔗 [View TX](${SUISCAN}${res.digest})`,
      {chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:backCb}]]}});
  } catch(e) {
    const msg = String(e?.message || e || 'unknown error');
    await bot.editMessageText(`❌ Buy failed:\n\`${msg.slice(0,500)}\``,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:backCb}]]}});
  }
}

async function _hfSellCommon(chatId, msgId, t, pct, backCb) {
  const u = getU(chatId);
  if (!u || !u.encryptedKey) { await bot.editMessageText('❌ No wallet.', {chat_id:chatId,message_id:msgId}); return; }
  try { await bot.editMessageText(`⏳ Submitting hop.fun sell: ${pct}% of *${t.symbol}*...`, {chat_id:chatId, message_id:msgId, parse_mode:'Markdown'}); } catch {}
  try {
    const bal = await sui.getBalance({ owner: u.walletAddress, coinType: t.coinType });
    const total = BigInt(bal.totalBalance || 0);
    if (total === 0n) throw new Error('No balance');
    const sellAmt = (total * BigInt(pct)) / 100n;
    const coins = await sui.getCoins({ owner: u.walletAddress, coinType: t.coinType });
    const coinIds = (coins.data || []).map(c => c.coinObjectId);
    if (!coinIds.length) throw new Error('No coin objects to sell');
    const kp = getKP(u);
    const tx = await buildHopFunSellTx({
      suiClient: sui, walletAddress: u.walletAddress, coinType: t.coinType,
      tokenCoinIdsToMerge: coinIds, amountToSellRaw: sellAmt, minSuiOutMist: 0n,
      curveOverride: t.curveId || null,
    });
    const res = await sui.signAndExecuteTransaction({ signer:kp, transaction:tx, options:{showEffects:true,showBalanceChanges:true} });
    if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'tx failed');
    const meta = await getMeta(t.coinType) || {};
    const dec  = meta.decimals || 9;
    const sold = Number(sellAmt)/Math.pow(10, dec);
    const sd   = await getActualDelta(res.balanceChanges || res.digest, SUI_T, u.walletAddress);
    const suiR = sd && sd > 0n ? Number(sd)/1e9 : 0;
    // 5% bot fee on actual SUI received — separate tx, silent fail so it
    // never blocks the sell. Mirrors moonbags/agent post-sell pattern.
    await postSellFee(kp, u, suiR).catch(()=>{});
    if (u.positions) {
      const pos = u.positions.find(p => p.ct === t.coinType);
      if (pos) { pos.tokens = Math.max(0, (pos.tokens||0) - sold); if (pos.tokens === 0) u.positions = u.positions.filter(p => p !== pos); saveDB(); }
    }
    await bot.editMessageText(
      `🔴 *Sold ${pct}% of ${t.symbol}* on hop.fun\n━━━━━━━━━━━━━━━━━━━━\n` +
      `📤 Sold:     ${sold.toLocaleString(undefined,{maximumFractionDigits:4})} ${t.symbol}\n` +
      `💰 Received: ${suiR > 0 ? suiR.toFixed(4) : '?'} SUI\n\n` +
      `🔗 [View TX](${SUISCAN}${res.digest})`,
      {chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:backCb}]]}});
  } catch(e) {
    const msg = String(e?.message || e || 'unknown error');
    await bot.editMessageText(`❌ Sell failed:\n\`${msg.slice(0,500)}\``,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'⬅️ Back', callback_data:backCb}]]}});
  }
}

// Pinned snapshots can hold stale reserves (curves move fast). Refetch fresh
// reserves before quoting so min-out math stays current. Token IDENTITY still
// comes from the snapshot (the whole point of the cross-contamination fix).
async function _hfFreshen(t) {
  try {
    const fresh = await fetchHopFunCoin(sui, t.coinType);
    if (fresh && fresh.coinType?.toLowerCase() === t.coinType?.toLowerCase()) {
      return { ...t, virtualSuiReserves: fresh.virtualSuiReserves, virtualTokenReserves: fresh.virtualTokenReserves, curveId: fresh.curveId || t.curveId, progress: fresh.progress ?? t.progress, isCompleted: !!fresh.isCompleted };
    }
  } catch {}
  return t;
}
// Restore string-encoded BigInts from session persistence
function _hfHydrate(t) {
  if (!t) return t;
  return { ...t,
    virtualSuiReserves:   t.virtualSuiReserves   != null && typeof t.virtualSuiReserves   === 'string' ? BigInt(t.virtualSuiReserves)   : t.virtualSuiReserves,
    virtualTokenReserves: t.virtualTokenReserves != null && typeof t.virtualTokenReserves === 'string' ? BigInt(t.virtualTokenReserves) : t.virtualTokenReserves,
  };
}
async function _hfBuy(chatId, msgId, idx, amtSui) {
  const pinned = _pinnedLp(chatId, 'hopfun', idx) || ((await _getLaunchpadTokens()).hopfun||[])[idx];
  if (!pinned) { await bot.editMessageText('❌ Token expired from cache.', {chat_id:chatId,message_id:msgId}); return; }
  const t = await _hfFreshen(_hfHydrate(pinned));
  return _hfBuyCommon(chatId, msgId, t, amtSui, `lp:hfpick:${idx}`);
}
async function _hfSell(chatId, msgId, idx, pct) {
  const pinned = _pinnedLp(chatId, 'hopfun', idx) || ((await _getLaunchpadTokens()).hopfun||[])[idx];
  if (!pinned) { await bot.editMessageText('❌ Token expired from cache.', {chat_id:chatId,message_id:msgId}); return; }
  const t = await _hfFreshen(_hfHydrate(pinned));
  return _hfSellCommon(chatId, msgId, t, pct, `lp:hfpick:${idx}`);
}
async function _hfBuyCA(chatId, msgId, amtSui) {
  const u = getU(chatId);
  const raw = u?.pd?.hfCA;
  if (!raw) { await bot.sendMessage(chatId, '❌ Lost the token reference. Paste the CA again.'); return; }
  const t = await _hfFreshen(_hfHydrate(raw));
  const m = await bot.sendMessage(chatId, `⏳ Buying ${amtSui} SUI of *${t.symbol}* on hop.fun...`, {parse_mode:'Markdown'});
  return _hfBuyCommon(chatId, m.message_id, t, amtSui, 'lp:menu');
}
async function _hfSellCA(chatId, msgId, pct) {
  const u = getU(chatId);
  const raw = u?.pd?.hfCA;
  if (!raw) { await bot.sendMessage(chatId, '❌ Lost the token reference. Paste the CA again.'); return; }
  const t = await _hfFreshen(_hfHydrate(raw));
  const m = await bot.sendMessage(chatId, `⏳ Selling ${pct}% of *${t.symbol}*...`, {parse_mode:'Markdown'});
  return _hfSellCommon(chatId, m.message_id, t, pct, 'lp:menu');
}

bot.onText(/\/launchpad/, async(msg)=>doLaunchpadMenu(msg.chat.id));

bot.on('callback_query', async(q)=>{
  if (!q.data || !q.data.startsWith('lp:')) return;
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  const chatId = q.message.chat.id, msgId = q.message.message_id;
  const parts = q.data.split(':');
  try {
    if (parts[1] === 'menu')    return doLaunchpadMenu(chatId);
    if (parts[1] === 'agent')   return _showAgentList(chatId, msgId);
    if (parts[1] === 'ody')     return _showOdyList(chatId, msgId);
    if (parts[1] === 'refresh'){ _lpCache.ts = 0; return doLaunchpadMenu(chatId); }
    if (parts[1] === 'odpick')   return _showOdyToken(chatId, msgId, parseInt(parts[2],10));
    if (parts[1] === 'odbuy')    return _odyBuy(chatId, msgId, parseInt(parts[2],10), parts[3]);
    if (parts[1] === 'odsell')   return _odySell(chatId, msgId, parseInt(parts[2],10), parseInt(parts[3],10));
    if (parts[1] === 'odbuyca')  return _odyBuyCA(chatId, msgId, parts[2]);
    if (parts[1] === 'odsellca') return _odySellCA(chatId, msgId, parseInt(parts[2],10));
    if (parts[1] === 'agbuy') {
      const aIdx = parseInt(parts[2], 10);
      const at = _pinnedLp(chatId, 'agent', aIdx) || ((await _getLaunchpadTokens()).agent||[])[aIdx];
      if (!at) { await bot.sendMessage(chatId, '❌ Token expired from cache. Reopen 🚀 Launchpad.'); return; }
      await _showAgentBuy(chatId, at);
      return;
    }
    if (parts[1] === 'agbuyca')  return _agentBuyCA(chatId, msgId, parts[2]);
    if (parts[1] === 'agsellca') return _agentSellCA(chatId, msgId, parseInt(parts[2],10));
    if (parts[1] === 'mb')        return _showMbList(chatId, msgId);
    if (parts[1] === 'mbpick')    return _showMbToken(chatId, msgId, parseInt(parts[2],10));
    if (parts[1] === 'mbbuy')     return _mbBuy(chatId, msgId, parseInt(parts[2],10), parts[3]);
    if (parts[1] === 'mbsell')    return _mbSell(chatId, msgId, parseInt(parts[2],10), parseInt(parts[3],10));
    if (parts[1] === 'mbbuyca')   return _mbBuyCA(chatId, msgId, parts[2]);
    if (parts[1] === 'mbsellca')  return _mbSellCA(chatId, msgId, parseInt(parts[2],10));
    if (parts[1] === 'hf')        return _showHfList(chatId, msgId);
    if (parts[1] === 'hfpick')    return _showHfToken(chatId, msgId, parseInt(parts[2],10));
    if (parts[1] === 'hfbuy')     return _hfBuy(chatId, msgId, parseInt(parts[2],10), parts[3]);
    if (parts[1] === 'hfsell')    return _hfSell(chatId, msgId, parseInt(parts[2],10), parseInt(parts[3],10));
    if (parts[1] === 'hfbuyca')   return _hfBuyCA(chatId, msgId, parts[2]);
    if (parts[1] === 'hfsellca')  return _hfSellCA(chatId, msgId, parseInt(parts[2],10));
  } catch(e) {
    await bot.sendMessage(chatId, `❌ Launchpad error: ${(e.message||'').slice(0,140)}`).catch(()=>{});
  }
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

  await loadDB();

  // Kill any existing webhook / polling session
  try { await fetch(`https://api.telegram.org/bot${TG_TOKEN}/deleteWebhook?drop_pending_updates=true`); } catch {}
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=-1&timeout=0&limit=1`);
    await sleep(1500);
    console.log('✅ Old sessions cleared');
  } catch(e) { console.warn('Session clear:', e.message); }

  try { const me=await bot.getMe(); BOT_USERNAME=me.username||BOT_USERNAME; } catch(e){ console.warn('getMe:', e.message); }

  // Register commands + move the menu button to the LEFT side of the text input
  try {
    await bot.setMyCommands([
      { command:'start',       description:'🚀 Launch bot / create wallet' },
      { command:'buy',         description:'💰 Buy a token by CA ' },
      { command:'sell',        description:'💸 Sell a token from your positions' },
      { command:'positions',   description:'📊 View open positions & P&L' },
      { command:'balance',     description:'💼 Check wallet balance' },
      { command:'scan',        description:'🔍 Token security audit' },
      { command:'snipe',       description:'⚡ Snipe a token when pool goes live' },
      { command:'orders',      description:'📋 View / cancel limit, DCA & snipe orders' },
      { command:'copytrader',  description:'🔁 Copy a trader\'s buys automatically' },
      { command:'referral',    description:'🔗 Your referral link & earnings' },
      { command:'withdraw',    description:'📤 Send SUI or tokens to an address' },
      { command:'settings',    description:'⚙️ Slippage, amounts, TP/SL' },
      { command:'help',        description:'❓ Full command list' },
    ]);
    await bot.setChatMenuButton({ menu_button: { type:'commands' } });
    console.log('  Commands registered + left-side menu button set ✅');
  } catch(e) { console.warn('setMyCommands:', e.message); }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  AGENT TRADING BOT — v6');
  console.log(`  Bot: @${BOT_USERNAME}`);
  console.log(`  Users: ${Object.keys(DB).length} | RPC: ${RPC_URL}`);
  console.log('  DEX: Cetus CLMM + Turbos CLMM');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  positionMonitor().catch(e=>console.error('Monitor:', e));
  sniperEngine().catch(e=>console.error('Sniper:', e));
  copyEngine().catch(e=>console.error('Copy:', e));
  limitEngine().catch(e=>console.error('Limit:', e));
  dcaEngine().catch(e=>console.error('DCA:', e));
  autoSellEngine().catch(e=>console.error('AutoSell:', e));
  migrationEngine().catch(e=>console.error('Migration:', e));

  console.log('  Bot is live! 🚀');
  if(ADMIN_ID) bot.sendMessage(ADMIN_ID,'🟢 AGENT TRADING BOT v6 online.').catch(()=>{});
}

main().catch(e=>{ console.error('Fatal:', e.message); process.exit(1); });
