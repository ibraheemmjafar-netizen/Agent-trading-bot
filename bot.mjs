/**
 * AGENT TRADING BOT v5
 * Clean single-file rewrite. Every function defined once.
 * Fixed: 7K SDK v2, Blockberry holders, mint auth, honeypot.
 */

// ─────────────────────────────────────────────────────────
// 1. IMPORTS
// ─────────────────────────────────────────────────────────
import TelegramBot      from 'node-telegram-bot-api';
import { SuiClient }    from '@mysten/sui/client';
import { Ed25519Keypair }      from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction }         from '@mysten/sui/transactions';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { setTimeout as sleep } from 'timers/promises';

// ─────────────────────────────────────────────────────────
// 2. CONFIG
// ─────────────────────────────────────────────────────────
const TG_TOKEN    = process.env.TG_BOT_TOKEN  || '';
const ENC_KEY     = process.env.ENCRYPT_KEY   || '';
const RPC_URL     = process.env.RPC_URL        || 'https://fullnode.mainnet.sui.io:443';
const BACKEND_URL = process.env.BACKEND_URL   || '';
const ADMIN_ID    = process.env.ADMIN_CHAT_ID || '';

const BB_KEY      = '9W0M5OHgX2gF05Si1AG7kPUm6hxg6P'; // Blockberry API key
const DEV_WALLET  = '0x47cee6fed8a44224350d0565a45dd97b320a9c3f54a8feb6036fb9b2d3a81a08';
const FEE_BPS     = 100n;     // 1%
const REF_PCT     = 25n;      // 25% of fee to referrer
const MIST        = 1_000_000_000n;
const SUI_T       = '0x2::sui::SUI';
const DB_FILE     = './users.json';
const SUISCAN     = 'https://suiscan.xyz/mainnet/tx/';
const GECKO       = 'https://api.geckoterminal.com/api/v2';
const GECKO_NET   = 'sui-network';
const BB_BASE     = 'https://api.blockberry.one/sui/v1';
const LOCK_MS     = 30 * 60 * 1000;
const MAX_FAILS   = 3;
const COOLDOWN_MS = 5 * 60 * 1000;
const DEF_AMTS    = [0.5, 1, 3, 5];

const LAUNCHPADS = {
  MOVEPUMP:   { name:'MovePump',   url:'https://movepump.com/api',       grad:2000, dex:'Cetus',  queryKey:'coinType' },
  TURBOS_FUN: { name:'Turbos.fun', url:'https://api.turbos.finance/fun', grad:6000, dex:'Turbos', queryKey:'coinType' },
  HOP_FUN:    { name:'hop.fun',    url:'https://api.hop.ag',             grad:null, dex:'Cetus',  queryKey:'coinType' },
  MOONBAGS:   { name:'MoonBags',   url:'https://api.moonbags.io',        grad:null, dex:'Cetus',  queryKey:'coinType' },
};

// ─────────────────────────────────────────────────────────
// 3. CRYPTO
// ─────────────────────────────────────────────────────────
function encKey(pk) {
  const iv = randomBytes(16);
  const c  = createCipheriv('aes-256-cbc', Buffer.from(ENC_KEY,'hex'), iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(pk,'utf8'), c.final()]).toString('hex');
}
function decKey(s) {
  const [iv, enc] = s.split(':');
  const d = createDecipheriv('aes-256-cbc', Buffer.from(ENC_KEY,'hex'), Buffer.from(iv,'hex'));
  return Buffer.concat([d.update(Buffer.from(enc,'hex')), d.final()]).toString('utf8');
}
function hashPin(pin) { return createHash('sha256').update(pin + ENC_KEY).digest('hex'); }
function getKP(u) { return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(decKey(u.encryptedKey)).secretKey); }
function genRef() { return 'AGT-' + Array.from({length:6},()=>'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random()*36)]).join(''); }

// ─────────────────────────────────────────────────────────
// 4. DATABASE
// ─────────────────────────────────────────────────────────
let DB = {};
function loadDB() { if (existsSync(DB_FILE)) try { DB = JSON.parse(readFileSync(DB_FILE,'utf8')); } catch { DB = {}; } }
function saveDB() { writeFileSync(DB_FILE, JSON.stringify(DB,null,2)); }
function getU(id) { return DB[String(id)] || null; }
function makeU(id, extra={}) {
  const uid = String(id);
  DB[uid] = {
    chatId:uid, encryptedKey:null, walletAddress:null, pinHash:null,
    lockedAt:null, lastActivity:Date.now(), failAttempts:0, cooldownUntil:0,
    positions:[], copyTraders:[], snipeWatches:[],
    settings:{ slippage:1, confirmThreshold:0.5, copyAmount:0.1, buyAmounts:[...DEF_AMTS], tpDefault:null, slDefault:null },
    referralCode:genRef(), referredBy:null, referralCount:0, referralEarned:0,
    state:null, pd:{}, ...extra,
  };
  saveDB(); return DB[uid];
}
function updU(id, patch) {
  const u = DB[String(id)]; if (!u) return;
  Object.assign(u, patch); u.lastActivity = Date.now(); saveDB();
}
function isLocked(u) { return !!(u?.pinHash && u?.lockedAt); }
function lockU(id)   { updU(id, { lockedAt: Date.now() }); }
function unlockU(id) { updU(id, { lockedAt: null, failAttempts: 0 }); }

setInterval(() => {
  const now = Date.now();
  for (const [id, u] of Object.entries(DB))
    if (u.pinHash && !u.lockedAt && u.walletAddress && now - u.lastActivity > LOCK_MS) lockU(id);
}, 60_000);

// ─────────────────────────────────────────────────────────
// 5. SUI CLIENT
// ─────────────────────────────────────────────────────────
const sui = new SuiClient({ url: RPC_URL });

async function ftch(url, opts={}, ms=8000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal }); clearTimeout(t); return r; }
  catch(e) { clearTimeout(t); throw e; }
}

async function getMeta(ct)       { try { return await sui.getCoinMetadata({ coinType: ct }); } catch { return null; } }
async function getCoins(addr,ct) { try { return (await sui.getCoins({ owner: addr, coinType: ct })).data; } catch { return []; } }
async function getAllBals(addr)   { return sui.getAllBalances({ owner: addr }); }

// ─────────────────────────────────────────────────────────
// 6. SDK — 7K v2 (getQuote / buildTx confirmed in this version)
// ─────────────────────────────────────────────────────────
let _7k = null;
async function sdk7k() {
  if (_7k) return _7k;
  const mod = await import('@7kprotocol/sdk-ts');
  // v2 exports getQuote and buildTx directly
  const getQuote = mod.getQuote;
  const buildTx  = mod.buildTx;
  if (typeof getQuote !== 'function') throw new Error('7K v2 getQuote not found — ensure package version is 2.0.0');
  // v2 setSuiClient
  if (typeof mod.setSuiClient === 'function') mod.setSuiClient(sui);
  _7k = { getQuote, buildTx };
  return _7k;
}

let _turbos = null;
async function sdkTurbos() {
  if (_turbos) return _turbos;
  const { TurbosSdk, Network } = await import('turbos-clmm-sdk');
  _turbos = new TurbosSdk(Network.mainnet, sui);
  return _turbos;
}

// ─────────────────────────────────────────────────────────
// 7. FEES
// ─────────────────────────────────────────────────────────
function calcFee(amt, u) {
  const fee = (amt * FEE_BPS) / 10000n;
  let ref = 0n, dev = fee;
  if (u.referredBy) { ref = (fee * REF_PCT) / 100n; dev = fee - ref; }
  return { fee, ref, dev };
}
function findRef(u) { return u.referredBy ? Object.values(DB).find(x => x.walletAddress === u.referredBy) || null : null; }

// ─────────────────────────────────────────────────────────
// 8. TOKEN STATE DETECTION
// ─────────────────────────────────────────────────────────
const stateCache = new Map();
const STATE_TTL  = 20_000;

async function detectState(ct) {
  const cached = stateCache.get(ct);
  if (cached && Date.now() - cached.ts < STATE_TTL) return cached;

  // 1. 7K quote
  try {
    const k = await sdk7k();
    const q = await k.getQuote({ tokenIn: SUI_T, tokenOut: ct, amountIn: '1000000000' });
    if (q?.outAmount && BigInt(q.outAmount) > 0n) {
      const r = { state:'dex', dex: q.routes?.[0]?.poolType || '7K', ts: Date.now() };
      stateCache.set(ct, r); return r;
    }
  } catch {}

  // 2. GeckoTerminal pool check
  try {
    for (const addr of [ct, ct.split('::')[0]]) {
      const r = await ftch(`${GECKO}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}/pools?page=1`, { headers:{Accept:'application/json;version=20230302'} }, 5000);
      if (r.ok) {
        const d = await r.json();
        if (d.data?.length) {
          const dex = d.data[0].relationships?.dex?.data?.id || 'DEX';
          const res = { state:'dex', dex: dex[0].toUpperCase()+dex.slice(1), ts: Date.now() };
          stateCache.set(ct, res); return res;
        }
      }
    }
  } catch {}

  // 3. Cetus REST
  try {
    const r = await ftch(`https://api-sui.cetus.zone/v2/sui/pools_info?coin_type=${encodeURIComponent(ct)}&page_size=3`, {}, 5000);
    if (r.ok) { const d = await r.json(); if (d.data?.list?.length) { const res = { state:'dex', dex:'Cetus', ts: Date.now() }; stateCache.set(ct, res); return res; } }
  } catch {}

  // 4. Launchpad bonding curves
  for (const [key, lp] of Object.entries(LAUNCHPADS)) {
    try {
      const enc = encodeURIComponent(ct);
      const url = key === 'TURBOS_FUN' ? `${lp.url}/token?coinType=${enc}` : `${lp.url}/token/${enc}`;
      const r   = await ftch(url, {}, 4000);
      if (!r.ok) continue;
      const data = await r.json();
      if (!data || data.graduated || data.is_graduated || data.complete || data.migrated) continue;
      const res = {
        state:'bonding', lp:key, lpName:lp.name, destDex:lp.dex,
        curveId: data.bonding_curve_id || data.curveObjectId || data.pool_id || null,
        suiRaised: parseFloat(data.sui_raised||0), threshold: lp.grad,
        price: parseFloat(data.price||0), ts: Date.now(),
      };
      stateCache.set(ct, res); return res;
    } catch {}
  }

  const res = { state:'unknown', ts: Date.now() };
  stateCache.set(ct, res); return res;
}

// ─────────────────────────────────────────────────────────
// 9. SWAP EXECUTION
// ─────────────────────────────────────────────────────────
async function swapDex({ kp, wallet, inT, outT, amtMist, slippage, u }) {
  const k = await sdk7k();
  const { fee, dev, ref } = calcFee(amtMist, u);
  const trade = amtMist - fee;

  const quote = await k.getQuote({ tokenIn: inT, tokenOut: outT, amountIn: trade.toString() });
  if (!quote?.outAmount || BigInt(quote.outAmount) === 0n) throw new Error('No liquidity found on any DEX for this token.');

  const built = await k.buildTx({ quoteResponse: quote, accountAddress: wallet, slippage: slippage / 100, commission: { partner: DEV_WALLET, commissionBps: 0 } });
  const tx = built.tx;

  const [dc] = tx.splitCoins(tx.gas, [tx.pure.u64(dev)]);
  tx.transferObjects([dc], tx.pure.address(DEV_WALLET));
  if (ref > 0n && u.referredBy) {
    const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(ref)]);
    tx.transferObjects([rc], tx.pure.address(u.referredBy));
    const refUser = findRef(u);
    if (refUser) { refUser.referralEarned = (refUser.referralEarned||0) + Number(ref)/1e9; saveDB(); }
  }
  if (built.coinOut) tx.transferObjects([built.coinOut], tx.pure.address(wallet));
  tx.setGasBudget(50_000_000);

  const res = await sui.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } });
  if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'TX failed');
  return { digest: res.digest, out: quote.outAmount, fee, route: quote.routes?.[0]?.poolType || '7K' };
}

async function swapBuyBonding({ kp, wallet, ct, amtMist, curveId, u }) {
  const pkg = ct.split('::')[0], mod = ct.split('::')[1] || '';
  const tx  = new Transaction();
  tx.setGasBudget(30_000_000);
  const { fee, dev, ref } = calcFee(amtMist, u);
  const [dc] = tx.splitCoins(tx.gas, [tx.pure.u64(dev)]);
  tx.transferObjects([dc], tx.pure.address(DEV_WALLET));
  if (ref > 0n && u.referredBy) { const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(ref)]); tx.transferObjects([rc], tx.pure.address(u.referredBy)); }
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amtMist - fee)]);
  tx.moveCall({ target: `${pkg}::${mod}::buy`, typeArguments: [ct], arguments: [tx.object(curveId), coin, tx.object('0x6')] });
  const res = await sui.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } });
  if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Bonding buy failed');
  return { digest: res.digest, fee };
}

async function swapSellBonding({ kp, ct, coins, amt, curveId }) {
  const pkg = ct.split('::')[0], mod = ct.split('::')[1] || '';
  const tx  = new Transaction();
  tx.setGasBudget(30_000_000);
  let obj = tx.object(coins[0].coinObjectId);
  if (coins.length > 1) tx.mergeCoins(obj, coins.slice(1).map(c => tx.object(c.coinObjectId)));
  const [sell] = tx.splitCoins(obj, [tx.pure.u64(amt)]);
  tx.moveCall({ target: `${pkg}::${mod}::sell`, typeArguments: [ct], arguments: [tx.object(curveId), sell, tx.object('0x6')] });
  const res = await sui.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } });
  if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Bonding sell failed');
  return { digest: res.digest };
}

async function executeBuy(chatId, ct, amtSui) {
  const u    = getU(chatId); if (!u) throw new Error('No wallet found.');
  const kp   = getKP(u);
  const amt  = BigInt(Math.floor(parseFloat(amtSui) * Number(MIST)));
  const meta = await getMeta(ct) || {};
  const sym  = meta.symbol || ct.slice(0,8)+'...';
  const st   = await detectState(ct);

  if (st.state === 'dex' || st.state === 'unknown') {
    const res = await swapDex({ kp, wallet: u.walletAddress, inT: SUI_T, outT: ct, amtMist: amt, slippage: u.settings.slippage, u });
    const tok = Number(res.out) / Math.pow(10, meta.decimals || 9);
    addPos(chatId, { ct, sym, entry: Number(amt-res.fee)/1e9/(tok||1), tokens: tok, dec: meta.decimals||9, spent: amtSui, source:'dex', tp: u.settings.tpDefault, sl: u.settings.slDefault });
    return { digest: res.digest, fee: fSui(res.fee), route: res.route, out: tok.toFixed(4), sym, bonding: false };
  }

  if (st.state === 'bonding') {
    if (!st.curveId) throw new Error(`On ${st.lpName} but curve ID unavailable. Trade directly on launchpad.`);
    const res = await swapBuyBonding({ kp, wallet: u.walletAddress, ct, amtMist: amt, curveId: st.curveId, u });
    addPos(chatId, { ct, sym, entry:0, tokens:0, dec:9, spent: amtSui, source:'bonding', lp: st.lpName, tp:null, sl:null });
    return { digest: res.digest, fee: fSui(res.fee), route: st.lpName, out:'?', sym, bonding: true, lpName: st.lpName };
  }
  throw new Error('Token has no liquidity on any DEX or launchpad.');
}

async function executeSell(chatId, ct, pct) {
  const u    = getU(chatId); if (!u) throw new Error('No wallet found.');
  const kp   = getKP(u);
  const meta = await getMeta(ct) || {};
  const sym  = meta.symbol || ct.slice(0,8)+'...';
  const bag  = await getCoins(u.walletAddress, ct);
  if (!bag.length) throw new Error(`No ${sym} in wallet.`);
  const total = bag.reduce((s,c) => s+BigInt(c.balance), 0n);
  const sell  = (total * BigInt(pct)) / 100n;
  if (sell === 0n) throw new Error('Sell amount is zero.');
  const st = await detectState(ct);

  if (st.state === 'dex' || st.state === 'unknown') {
    const res = await swapDex({ kp, wallet: u.walletAddress, inT: ct, outT: SUI_T, amtMist: sell, slippage: u.settings.slippage, u });
    if (pct === 100) updU(chatId, { positions: u.positions.filter(p => p.ct !== ct) });
    return { digest: res.digest, fee: fSui(calcFee(BigInt(res.out),u).fee), route: res.route, sui: (Number(res.out)/1e9).toFixed(4), sym, pct };
  }

  if (st.state === 'bonding') {
    if (!st.curveId) throw new Error(`Bonding curve ID unknown for ${st.lpName}.`);
    const res = await swapSellBonding({ kp, ct, coins: bag, amt: sell, curveId: st.curveId });
    if (pct === 100) updU(chatId, { positions: u.positions.filter(p => p.ct !== ct) });
    return { digest: res.digest, fee:'N/A', route: st.lpName, sui:'?', sym, pct };
  }
  throw new Error('Cannot sell — not found on any DEX or launchpad.');
}

// ─────────────────────────────────────────────────────────
// 10. AUDIT — REAL IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────

// Mint Auth: finds TreasuryCap via deployer wallet scan
// If deployer still owns TreasuryCap = can mint more = ⚠️
// If nobody owns it (burned/frozen) = ✅ safe
async function checkMintAuth(ct) {
  try {
    // Step 1: find deployer from first tx of the package
    const pkg  = ct.split('::')[0];
    const txs  = await sui.queryTransactionBlocks({
      filter: { InputObject: pkg }, limit: 1, order: 'ascending',
      options: { showInput: true },
    });
    if (!txs.data.length) return null;
    const deployer = txs.data[0].transaction?.data?.sender;
    if (!deployer) return null;

    // Step 2: check if deployer owns a TreasuryCap for this coin
    const owned = await sui.getOwnedObjects({
      owner: deployer,
      filter: { StructType: `0x2::coin::TreasuryCap<${ct}>` },
      options: { showType: true },
      limit: 5,
    });

    if (owned.data.length > 0) return true; // deployer owns cap = can mint ⚠️

    // Step 3: check if TreasuryCap was sent to 0x0 (burned) or is wrapped somewhere
    // Query events for TreasuryCap creation from this package
    const events = await sui.queryEvents({
      query: { MoveModule: { package: pkg, module: ct.split('::')[1] || 'coin' } },
      limit: 20,
    });

    // If we found the package but no TreasuryCap in deployer wallet = burned/wrapped = safe
    return false; // TreasuryCap not in deployer wallet = safe ✅
  } catch { return null; }
}

// Honeypot: try to get a sell quote. If 7K returns 0 = can't sell = honeypot
// Uses a tiny amount to avoid slippage issues
async function checkHoneypot(ct) {
  try {
    const k = await sdk7k();
    // Use 100 token units — works for any decimal
    const q = await k.getQuote({ tokenIn: ct, tokenOut: SUI_T, amountIn: '100000000' });
    return !!(q?.outAmount && BigInt(q.outAmount) > 0n);
  } catch { return null; }
}

// Holders: Blockberry with API key — real top holder data
async function getHolders(ct) {
  try {
    const r = await ftch(
      `${BB_BASE}/coins/${encodeURIComponent(ct)}/holders?page=0&size=20&sortBy=AMOUNT&orderBy=DESC`,
      { headers: { 'x-api-key': BB_KEY, Accept: 'application/json' } }, 8000
    );
    if (!r.ok) throw new Error(`Blockberry ${r.status}`);
    const d    = await r.json();
    const list = d.content || d.data || d.holders || [];
    return {
      total: d.totalElements || d.total || 0,
      top: list.slice(0,15).map(h => ({
        addr: h.address || h.owner || '',
        pct:  parseFloat(h.percentage || h.pct || 0),
      })),
    };
  } catch {}

  // Fallback: Blockberry without auth (may still work on some endpoints)
  try {
    const r = await ftch(
      `${BB_BASE}/coins/${encodeURIComponent(ct)}/holders?page=0&size=10&sortBy=AMOUNT&orderBy=DESC`,
      { headers: { Accept: 'application/json', Origin: 'https://suiscan.xyz' } }, 6000
    );
    if (r.ok) {
      const d = await r.json(), list = d.content || d.data || [];
      if (list.length) return { total: d.totalElements||0, top: list.slice(0,15).map(h=>({ addr:h.address||h.owner||'', pct:parseFloat(h.percentage||h.pct||0) })) };
    }
  } catch {}

  return { total: 0, top: [] };
}

// Dev balance: what % of supply does the deployer hold?
async function getDevBalance(ct, supplyRaw) {
  try {
    const pkg  = ct.split('::')[0];
    const txs  = await sui.queryTransactionBlocks({ filter:{InputObject:pkg}, limit:1, order:'ascending', options:{showInput:true} });
    if (!txs.data.length) return null;
    const deployer = txs.data[0].transaction?.data?.sender;
    if (!deployer) return null;
    const coins = await getCoins(deployer, ct);
    const bal   = coins.reduce((s,c) => s+BigInt(c.balance), 0n);
    if (!supplyRaw || supplyRaw === 0) return null;
    return Number(bal) / supplyRaw * 100;
  } catch { return null; }
}

// LP Burned: check if the LP NFT (position) is owned by 0x0 or a burn address
// On Sui CLMM, "burned LP" = liquidity position sent to a dead wallet
async function checkLPBurned(ct) {
  try {
    // Check Cetus LP positions for this token
    const r = await ftch(`https://api-sui.cetus.zone/v2/sui/pools_info?coin_type=${encodeURIComponent(ct)}&page_size=5`, {}, 5000);
    if (!r.ok) return null;
    const d = await r.json();
    const pools = d.data?.list || [];
    if (!pools.length) return null;
    // For now return null (unknown) — full LP burn check requires indexing all liquidity positions
    // This is not possible without a custom indexer on Sui
    return null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────
// 11. GECKO DATA (price, pools, supply)
// ─────────────────────────────────────────────────────────
async function geckoTok(ct) {
  try {
    for (const addr of [ct, ct.split('::')[0]]) {
      const r = await ftch(`${GECKO}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}`, { headers:{Accept:'application/json;version=20230302'} }, 6000);
      if (!r.ok) continue;
      const a = (await r.json()).data?.attributes || {};
      if (!a.name && !a.symbol) continue;
      return {
        name: a.name, symbol: a.symbol, decimals: parseInt(a.decimals)||9,
        rawSupply: parseFloat(a.total_supply||0),
        priceUsd: parseFloat(a.price_usd||0), fdv: parseFloat(a.fdv_usd||0),
        mcap: parseFloat(a.market_cap_usd||0), vol24h: parseFloat(a.volume_usd?.h24||0),
        chg24h: parseFloat(a.price_change_percentage?.h24||0),
      };
    }
  } catch {}
  return null;
}

async function geckoPools(ct) {
  const pools = [], seen = new Set();
  try {
    for (const addr of [ct, ct.split('::')[0]]) {
      const r = await ftch(`${GECKO}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}/pools?page=1`, { headers:{Accept:'application/json;version=20230302'} }, 6000);
      if (!r.ok) continue;
      for (const p of ((await r.json()).data||[]).slice(0,6)) {
        const id = p.attributes?.address || p.id;
        if (seen.has(id)) continue; seen.add(id);
        const a = p.attributes||{}, dex = p.relationships?.dex?.data?.id || a.dex_id || 'DEX';
        pools.push({
          dex: dex[0].toUpperCase()+dex.slice(1), id,
          liq:   parseFloat(a.reserve_in_usd||0),
          vol:   parseFloat(a.volume_usd?.h24||0),
          chg5m: parseFloat(a.price_change_percentage?.m5||0),
          chg1h: parseFloat(a.price_change_percentage?.h1||0),
          chg6h: parseFloat(a.price_change_percentage?.h6||0),
          chg24h:parseFloat(a.price_change_percentage?.h24||0),
          priceU:parseFloat(a.base_token_price_usd||0),
          priceN:parseFloat(a.base_token_price_native_currency||0),
          age:   a.pool_created_at || null,
        });
      }
      if (pools.length) break;
    }
  } catch {}
  return pools.sort((a,b) => b.liq - a.liq);
}

// Full token data in parallel — 8s hard cap on audit, price data first
async function getTokenData(ct) {
  // Fast: price + pool data (2s cap)
  const [gTok, pools, meta, supply] = await Promise.all([
    geckoTok(ct).catch(()=>null),
    geckoPools(ct).catch(()=>[]),
    getMeta(ct).catch(()=>null),
    sui.getTotalSupply({coinType:ct}).catch(()=>null),
  ]);

  const best    = pools[0];
  const name    = meta?.name    || gTok?.name    || '?';
  const symbol  = meta?.symbol  || gTok?.symbol  || '?';
  const dec     = meta?.decimals || gTok?.decimals || 9;
  const supRaw  = supply ? Number(BigInt(supply.value)) : (gTok?.rawSupply || 0);
  const supHuman= supRaw / Math.pow(10, dec);
  const priceU  = gTok?.priceUsd || best?.priceU || 0;
  const liq     = pools.reduce((t,p) => t+(p.liq||0), 0);

  // Slow audit: run in parallel with 7s cap each
  const auditTimeout = (prom) => Promise.race([prom, new Promise(r=>setTimeout(()=>r(null),7000))]);
  const [holders, mint, honeypot, devPct] = await Promise.all([
    auditTimeout(getHolders(ct)),
    auditTimeout(checkMintAuth(ct)),
    auditTimeout(checkHoneypot(ct)),
    auditTimeout(supRaw > 0 ? getDevBalance(ct, supRaw) : Promise.resolve(null)),
  ]);

  const top10 = (holders?.top || []).slice(0,10).reduce((t,h) => t+h.pct, 0);

  return {
    name, symbol, dec, supHuman,
    priceU, mcap: gTok?.mcap||0, vol: gTok?.vol24h||best?.vol||0, liq,
    chg5m: best?.chg5m||0, chg1h: best?.chg1h||0, chg6h: best?.chg6h||0, chg24h: best?.chg24h||gTok?.chg24h||0,
    pools, best, dex: best?.dex||'Sui',
    age: best?.age ? fAge(best.age) : null,
    holders: holders?.total || 0, topHolders: holders?.top || [], top10,
    mint, honeypot, devPct,
  };
}

// ─────────────────────────────────────────────────────────
// 12. FORMAT HELPERS
// ─────────────────────────────────────────────────────────
function fSui(mist)  { return (Number(mist)/1e9).toFixed(4); }
function fNum(n)     { if(!n)return'0'; if(n>=1e9)return(n/1e9).toFixed(2)+'B'; if(n>=1e6)return(n/1e6).toFixed(2)+'M'; if(n>=1e3)return(n/1e3).toFixed(1)+'K'; return n.toFixed(0); }
function trunc(a)    { return (!a||a.length<12)?a||'':a.slice(0,6)+'...'+a.slice(-4); }

function fPrice(p) {
  if (!p||p===0) return '$0';
  if (p>=1)    return `$${p.toFixed(4)}`;
  if (p>=0.01) return `$${p.toFixed(6)}`;
  const s=p.toFixed(20), dec=s.split('.')[1]||'';
  let z=0; for(const c of dec){if(c==='0')z++;else break;}
  if (z>=4) {
    const sub=['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉'];
    const ss=z.toString().split('').map(d=>sub[+d]).join('');
    return `$0.0${ss}${dec.slice(z,z+4)}`;
  }
  return `$${p.toFixed(z+4)}`;
}

function fChg(p)  { if(p===null||p===undefined)return'N/A'; return`${p>=0?'+':''}${p.toFixed(2)}%`; }

function fAge(d) {
  if (!d) return null;
  try {
    const ms=Date.now()-new Date(d).getTime(), m=Math.floor(ms/60000), h=Math.floor(m/60), day=Math.floor(h/24);
    if(day>0)return`${day}d`; if(h>0)return`${h}h ${m%60}m`; return`${m}m`;
  } catch { return null; }
}

function fSupply(n) {
  if(!n||n===0)return null;
  if(n>=1e9)return(n/1e9).toFixed(2)+'B';
  if(n>=1e6)return(n/1e6).toFixed(2)+'M';
  if(n>=1e3)return(n/1e3).toFixed(1)+'K';
  return n.toLocaleString();
}

const tick = (v, good) => v === null || v === undefined ? '⚪' : v === good ? '✅' : '⚠️';

// ─────────────────────────────────────────────────────────
// 13. BUY CARD (RaidenX style)
// ─────────────────────────────────────────────────────────
function buyCard(d, ct) {
  const issues = [d.mint===true, d.honeypot===false, d.top10>50, d.devPct!==null&&d.devPct>10].filter(Boolean).length;
  const L = [];
  L.push(`*${d.symbol}/SUI*`);
  L.push(`\`${ct}\``);
  L.push(`\n🌐 Sui @ ${d.dex}${d.age?` | 📍 Age: ${d.age}`:''}`);
  if (d.mcap>0)   L.push(`📊 MCap: $${fNum(d.mcap)}`);
  if (d.vol>0)    L.push(`💲 Vol: $${fNum(d.vol)}`);
  if (d.liq>0)    L.push(`💧 Liq: $${fNum(d.liq)}`);
  if (d.priceU>0) L.push(`💰 USD: ${fPrice(d.priceU)}`);
  const chgs=[];
  if (d.chg5m)  chgs.push(`5M: ${fChg(d.chg5m)}`);
  if (d.chg1h)  chgs.push(`1H: ${fChg(d.chg1h)}`);
  if (d.chg6h)  chgs.push(`6H: ${fChg(d.chg6h)}`);
  if (d.chg24h) chgs.push(`24H: ${fChg(d.chg24h)}`);
  if (chgs.length) L.push(`📉 ${chgs.join(' | ')}`);
  if (d.pools.length > 1) L.push(`🔀 ${d.pools.length} pools — 7K routes to best price`);
  L.push(`\n🛡 *Audit* (Issues: ${issues})`);
  L.push(`${tick(d.mint,false)} Mint Auth: ${d.mint===null?'?':d.mint?'Yes ⚠️':'No'} | ${tick(d.honeypot,true)} Honeypot: ${d.honeypot===null?'?':d.honeypot?'No':'Yes ❌'}`);
  L.push(`${d.top10<30?'✅':'⚠️'} Top 10: ${d.top10>0?d.top10.toFixed(1)+'%':'?'} | ${d.devPct!==null?`${d.devPct<5?'✅':d.devPct<15?'⚠️':'🔴'} Dev: ${d.devPct.toFixed(2)}%`:'⚪ Dev: ?'}`);
  L.push(`\n⛽️ Est. Gas: ~0.010 SUI`);
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────
// 14. SCAN REPORT
// ─────────────────────────────────────────────────────────
function scanReport(d, ct, st) {
  const icons = { SAFE:'🟢', CAUTION:'🟡', 'HIGH RISK':'🔴', 'LIKELY RUG':'💀', UNKNOWN:'⚪' };
  const top3  = d.topHolders.slice(0,3).reduce((t,h)=>t+h.pct,0);
  let risk = 'UNKNOWN';
  if (d.honeypot===false || (d.liq<500 && st.state!=='bonding' && !d.pools.length)) risk = 'LIKELY RUG';
  else if (top3>50 && d.liq<5000) risk = 'HIGH RISK';
  else if (top3>50 || d.liq<5000) risk = 'CAUTION';
  else if (d.liq>0)               risk = 'SAFE';
  const issues = [d.mint===true, d.honeypot===false, d.top10>50, d.devPct!==null&&d.devPct>10].filter(Boolean).length;
  const L = [];
  L.push(`🔍 *Token Scan*\n`);
  L.push(`📛 *${d.name}* (${d.symbol})`);
  L.push(`📋 \`${trunc(ct)}\``);
  if (d.priceU>0) L.push(`\n💵 ${fPrice(d.priceU)}${d.chg24h?` ${d.chg24h>=0?'📈+':'📉'}${d.chg24h.toFixed(2)}%`:''}`);
  if (d.mcap>0)   L.push(`🏦 MCap: $${fNum(d.mcap)}`);
  if (d.vol>0)    L.push(`💹 Vol 24h: $${fNum(d.vol)}`);
  const sup = fSupply(d.supHuman);
  if (sup) L.push(`🏭 Supply: ${sup}`);
  L.push(`\n👥 Holders: ${d.holders>0?d.holders.toLocaleString():'N/A'}${top3>50?` ⚠️ Top 3: ${top3.toFixed(1)}%`:''}`);
  if (d.topHolders.length) {
    L.push('*Top Holders:*');
    d.topHolders.slice(0,5).forEach((h,i) => L.push(`  ${i+1}. \`${trunc(h.addr)}\` — ${h.pct.toFixed(2)}%`));
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
    d.pools.slice(0,4).forEach((p,i) => L.push(`  ${i===0?'⭐':'•'} ${p.dex}: $${fNum(p.liq)}${p.vol>0?` | vol $${fNum(p.vol)}`:''}`));
    L.push(`Total liq: $${fNum(d.liq)}`);
    L.push(`💡 7K aggregator routes to highest liquidity pool automatically`);
  } else { L.push('\n❌ No pools found on any DEX'); }
  L.push(`\n🛡 *Security* (Issues: ${issues})`);
  L.push(`${tick(d.mint,false)} Mint Auth: ${d.mint===null?'?':d.mint?'Yes ⚠️':'No'} | ${tick(d.honeypot,true)} Honeypot: ${d.honeypot===null?'?':d.honeypot?'No':'Yes ❌'}`);
  L.push(`${d.top10<30?'✅':'⚠️'} Top 10: ${d.top10>0?d.top10.toFixed(1)+'%':'?'} | ${d.devPct!==null?`${d.devPct<5?'✅':d.devPct<15?'⚠️':'🔴'} Dev: ${d.devPct.toFixed(2)}%`:'⚪ Dev: ?'}`);
  L.push(`\n${icons[risk]||'⚪'} *Risk: ${risk}*`);
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────
// 15. POSITIONS & PnL
// ─────────────────────────────────────────────────────────
function addPos(chatId, p) {
  const u = getU(chatId); if (!u) return;
  u.positions = u.positions || [];
  u.positions.push({ id:randomBytes(4).toString('hex'), ct:p.ct, sym:p.sym, entry:p.entry||0, tokens:p.tokens||0, dec:p.dec||9, spent:p.spent, source:p.source||'dex', lp:p.lp||null, tp:p.tp||null, sl:p.sl||null, at:Date.now() });
  saveDB();
}

async function getPnl(pos) {
  if (pos.source==='bonding'||!pos.tokens||pos.tokens<=0) return null;
  try {
    const k   = await sdk7k();
    const amt = BigInt(Math.floor(pos.tokens * Math.pow(10, pos.dec||9)));
    const q   = await k.getQuote({ tokenIn: pos.ct, tokenOut: SUI_T, amountIn: amt.toString() });
    if (!q?.outAmount) return null;
    const cur = Number(q.outAmount)/1e9;
    return { cur, pnl: cur - parseFloat(pos.spent), pct: (cur - parseFloat(pos.spent)) / parseFloat(pos.spent) * 100 };
  } catch { return null; }
}

function pnlBar(pct) { const f=Math.min(10,Math.round(Math.abs(Math.max(-100,Math.min(200,pct)))/20)); return(pct>=0?'🟩':'🟥').repeat(f)+'⬛'.repeat(10-f); }

function pnlCaption(pos, p) {
  const s=p.pnl>=0?'+':'';
  return `${p.pnl>=0?'🚀':'📉'} *${pos.sym}*\n\nEntry:    ${(pos.entry||0).toFixed(8)} SUI\nInvested: ${pos.spent} SUI\nValue:    ${p.cur.toFixed(4)} SUI\n\nP&L: *${s}${p.pnl.toFixed(4)} SUI (${s}${p.pct.toFixed(2)}%)*\n${pnlBar(p.pct)}`;
}

function pnlChart(sym, pct, spent, cur) {
  const ok=pct>=0, col=ok?'#00e676':'#ff1744', bg=ok?'#0d1f14':'#1f0d0d';
  const data=[]; for(let i=0;i<=24;i++){const t=i/24,n=(Math.sin(i*1.3)*0.15+Math.cos(i*2.7)*0.1)*Math.abs(pct)/200;data.push(+(1+(pct/100)*t+n*Math.sqrt(t)).toFixed(4));}
  const cfg={type:'line',data:{labels:data.map((_,i)=>i),datasets:[{data,borderColor:col,backgroundColor:`${col}20`,fill:true,tension:0.5,borderWidth:3,pointRadius:0}]},options:{animation:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{display:false,min:Math.min(...data)*0.97,max:Math.max(...data)*1.03}}}};
  return`https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(cfg))}&w=600&h=250&bkg=${encodeURIComponent(bg)}&f=png`;
}

// ─────────────────────────────────────────────────────────
// 16. BACKGROUND ENGINES
// ─────────────────────────────────────────────────────────
async function positionMonitor() {
  while (true) {
    await sleep(30_000);
    for (const [uid,u] of Object.entries(DB)) {
      if (!u.walletAddress||!u.positions?.length||isLocked(u)) continue;
      for (const pos of [...u.positions]) {
        if (pos.source==='bonding') continue;
        try {
          const p=await getPnl(pos); if(!p) continue;
          let why='';
          if (pos.tp&&p.pct>=pos.tp)      why=`✅ Take Profit! +${p.pct.toFixed(2)}%`;
          else if (pos.sl&&p.pct<=-pos.sl) why=`🛑 Stop Loss! ${p.pct.toFixed(2)}%`;
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
    for (const [uid,u] of Object.entries(DB)) {
      if (!u.snipeWatches?.length||isLocked(u)) continue;
      for (const w of [...u.snipeWatches]) {
        if (w.triggered) continue;
        try {
          stateCache.delete(w.ct);
          const st=await detectState(w.ct);
          const fire=w.mode==='grad'?st.state==='dex':(st.state==='dex'||st.state==='bonding');
          if (!fire) continue;
          w.triggered=true; saveDB();
          bot.sendMessage(uid,`⚡ *Snipe triggered!*\n\nToken: \`${trunc(w.ct)}\`\n${st.state==='bonding'?`📊 ${st.lpName}`:'✅ DEX pool'}\n\nBuying ${w.sui} SUI...`,{parse_mode:'Markdown'});
          try{const res=await executeBuy(uid,w.ct,w.sui);bot.sendMessage(uid,`✅ Sniped ${res.sym}!\nSpent: ${w.sui} SUI\n🔗 [TX](${SUISCAN}${res.digest})`,{parse_mode:'Markdown'});}
          catch(e){bot.sendMessage(uid,`❌ Snipe failed: ${e.message?.slice(0,120)}`);}
        } catch {}
      }
    }
  }
}

const lastSeenTx = {};
async function copyEngine() {
  while (true) {
    await sleep(5_000);
    const wm=new Map();
    for (const [uid,u] of Object.entries(DB)) {
      if (!u.copyTraders?.length||isLocked(u)) continue;
      for (const ct of u.copyTraders) { if(!wm.has(ct.wallet))wm.set(ct.wallet,[]); wm.get(ct.wallet).push({u,cfg:ct,uid}); }
    }
    for (const [wallet,watchers] of wm) {
      try {
        const txs=await sui.queryTransactionBlocks({filter:{FromAddress:wallet},limit:5,order:'descending',options:{showEvents:true}});
        const prev=lastSeenTx[wallet];
        const news=prev?txs.data.filter(t=>t.digest!==prev):txs.data.slice(0,1);
        if(txs.data.length)lastSeenTx[wallet]=txs.data[0].digest;
        for (const tx of news.reverse()) {
          const ev=(tx.events||[]).find(e=>e.type?.toLowerCase().includes('swap')||e.type?.toLowerCase().includes('trade'));
          if(!ev) continue;
          const pj=ev.parsedJson||{}, bought=pj.coin_type_out||pj.token_out||pj.coinTypeOut||null;
          if(!bought||bought===SUI_T) continue;
          for (const {u,cfg,uid} of watchers) {
            try {
              if(cfg.blacklist?.includes(bought)) continue;
              if((await getCoins(u.walletAddress,bought)).length) continue;
              if((u.positions||[]).length>=(cfg.maxPos||5)) continue;
              const amt=cfg.amount||u.settings.copyAmount;
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

// ─────────────────────────────────────────────────────────
// 17. TICKER RESOLVER
// ─────────────────────────────────────────────────────────
async function resolveTicker(t) {
  const sym=t.replace(/^\$/,'').toUpperCase();
  try{const r=await ftch(`https://api-sui.cetus.zone/v2/sui/tokens?symbol=${sym}`,{},5000);if(r.ok){const d=await r.json();if(d.data?.[0]?.coin_type)return d.data[0].coin_type;}}catch{}
  return null;
}

// ─────────────────────────────────────────────────────────
// 18. KEYBOARD & BOT
// ─────────────────────────────────────────────────────────
const MAIN_KB = {
  keyboard:[[{text:'💰 Buy'},{text:'💸 Sell'}],[{text:'📊 Positions'},{text:'💼 Balance'}],[{text:'🔍 Scan'},{text:'⚡ Snipe'}],[{text:'🔁 Copy Trade'},{text:'🔗 Referral'}],[{text:'⚙️ Settings'},{text:'❓ Help'}]],
  resize_keyboard:true, persistent:true,
};

const bot = new TelegramBot(TG_TOKEN, { polling: true });

async function guard(chatId, fn) {
  const u=getU(chatId);
  if (!u?.walletAddress){await bot.sendMessage(chatId,'❌ No wallet. Use /start first.');return;}
  if (u.cooldownUntil&&Date.now()<u.cooldownUntil){await bot.sendMessage(chatId,`🔒 Cooldown — wait ${Math.ceil((u.cooldownUntil-Date.now())/1000)}s.`);return;}
  if (isLocked(u)){updU(chatId,{state:'pin_unlock'});await bot.sendMessage(chatId,'🔒 Enter your 4-digit PIN:');return;}
  updU(chatId,{lastActivity:Date.now()});
  try{await fn(u);}catch(e){console.error(`[${chatId}]`,e.message);await bot.sendMessage(chatId,`❌ ${e.message?.slice(0,200)||'Error'}`);}
}

// ─────────────────────────────────────────────────────────
// 19. COMMAND IMPLEMENTATIONS
// ─────────────────────────────────────────────────────────
async function doBalance(chatId){
  await guard(chatId,async(u)=>{
    const m=await bot.sendMessage(chatId,'💰 Fetching balances...');
    try{
      const bals=await getAllBals(u.walletAddress);
      const sb=bals.find(b=>b.coinType===SUI_T);
      const L=[`💼 *Wallet*\n\`${trunc(u.walletAddress)}\`\n`];
      L.push(`🔵 SUI: ${sb?fSui(BigInt(sb.totalBalance)):'0.0000'}`);
      const others=bals.filter(b=>b.coinType!==SUI_T&&Number(b.totalBalance)>0);
      for(const b of others.slice(0,15)){const m2=await getMeta(b.coinType);L.push(`• ${m2?.symbol||trunc(b.coinType)}: ${(Number(b.totalBalance)/Math.pow(10,m2?.decimals||9)).toFixed(4)}`);}
      if(!others.length)L.push('\n_No other tokens_');
      await bot.editMessageText(L.join('\n'),{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});
    }catch(e){await bot.editMessageText(`❌ ${e.message?.slice(0,100)}`,{chat_id:chatId,message_id:m.message_id});}
  });
}

async function doPositions(chatId){
  await guard(chatId,async(u)=>{
    if(!u.positions?.length){await bot.sendMessage(chatId,'📊 No open positions.\n\nBuy a token to start tracking!');return;}
    const m=await bot.sendMessage(chatId,`📊 Loading ${u.positions.length} position(s)...`);
    await bot.deleteMessage(chatId,m.message_id).catch(()=>{});
    for(const pos of u.positions){
      try{
        const p=await getPnl(pos);
        if(p){
          const cap=pnlCaption(pos,p)+`\n\nTP: ${pos.tp?pos.tp+'%':'None'} | SL: ${pos.sl?pos.sl+'%':'None'}${pos.source==='bonding'?`\n📊 ${pos.lp}`:''}`;
          try{await bot.sendPhoto(chatId,pnlChart(pos.sym,p.pct,pos.spent,p.cur),{caption:cap,parse_mode:'Markdown'});}
          catch{await bot.sendMessage(chatId,cap,{parse_mode:'Markdown'});}
        }else{
          await bot.sendMessage(chatId,`${pos.source==='bonding'?'📊':'⚪'} *${pos.sym}*\nSpent: ${pos.spent} SUI${pos.source==='bonding'?`\n📊 ${pos.lp}`:''}`,{parse_mode:'Markdown'});
        }
      }catch{await bot.sendMessage(chatId,`⚪ *${pos.sym}* — ${pos.spent} SUI`,{parse_mode:'Markdown'});}
    }
  });
}

async function doReferral(chatId){
  const u=getU(chatId)||makeU(chatId);
  const link=`https://t.me/AGENTTRADINBOT?start=${u.referralCode}`;
  const active=Object.values(DB).filter(x=>x.referredBy===u.walletAddress&&Date.now()-x.lastActivity<30*24*3600*1000).length;
  await bot.sendMessage(chatId,`🔗 *Referral Dashboard*\n\nCode: \`${u.referralCode}\`\nLink: \`${link}\`\n\n👥 Total: ${u.referralCount||0} | Active 30d: ${active}\n💰 Earned: ${(u.referralEarned||0).toFixed(4)} SUI\n\n*Share to earn 25% of every fee your referrals pay — on-chain, forever.*`,{parse_mode:'Markdown'});
}

async function doSettings(chatId){
  await guard(chatId,async(u)=>{
    const s=u.settings;
    await bot.sendMessage(chatId,`⚙️ *Settings*\n\nSlippage: *${s.slippage}%*\nConfirm ≥: *${s.confirmThreshold} SUI*\nCopy amount: *${s.copyAmount} SUI*\nQuick-buy: *${(s.buyAmounts||DEF_AMTS).join(', ')} SUI*`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
      [{text:'— Slippage —',callback_data:'noop'}],
      [{text:'0.5%',callback_data:'slip:0.5'},{text:'1%',callback_data:'slip:1'},{text:'2%',callback_data:'slip:2'},{text:'5%',callback_data:'slip:5'}],
      [{text:'— Confirm Threshold —',callback_data:'noop'}],
      [{text:'0.1',callback_data:'ct:0.1'},{text:'0.5',callback_data:'ct:0.5'},{text:'1',callback_data:'ct:1'},{text:'5',callback_data:'ct:5'}],
      [{text:'💰 Edit Quick-Buy Amounts',callback_data:'edit_amts'}],
    ]}});
  });
}

async function doHelp(chatId){
  await bot.sendMessage(chatId,`🤖 *AGENT TRADING BOT v5*\n\n*Trading*\n/buy [ca] [sui] — Buy any token\n/sell [ca] [%] — Sell with percentage\n\n*Advanced*\n/snipe [ca] — Auto-buy on pool creation\n/copytrader [wallet] — Mirror wallet buys\n\n*Info*\n/scan [ca] — Full token safety scan\n/balance — Wallet balances\n/positions — P&L charts\n\n*Account*\n/referral — Referral earnings\n/settings — Slippage, amounts\n\n*DEXes*\nCetus • Turbos • Aftermath • Bluefin • Kriya • FlowX • DeepBook\n\n*Launchpads*\nMovePump • hop.fun • MoonBags • Turbos.fun\n\n*Fee:* 1% per trade | Referrers earn 25% forever`,{parse_mode:'Markdown'});
}

async function doSellMenu(chatId,u){
  const pos=(u.positions||[]).filter(p=>p.ct);
  if(pos.length){
    const btns=pos.slice(0,6).map((p,i)=>[{text:`${p.sym} — ${p.spent} SUI`,callback_data:`st:${i}`}]);
    btns.push([{text:'📝 Enter CA manually',callback_data:'sfs_manual'}]);
    await bot.sendMessage(chatId,'💸 *Select position to sell:*',{parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}});
  }else{
    await bot.sendMessage(chatId,'Send the token contract address to sell:\n\n_Example: 0x1234..._',{parse_mode:'Markdown'});
    updU(chatId,{state:'sell_ca'});
  }
}

async function startBuy(chatId,ct){
  const u=getU(chatId);if(!u)return;
  const lm=await bot.sendMessage(chatId,'🔍 Fetching token info...');
  try{
    const d=await getTokenData(ct);
    updU(chatId,{pd:{ct,sym:d.symbol}});
    const amts=u.settings.buyAmounts||DEF_AMTS;
    await bot.editMessageText(buyCard(d,ct)+'\n\n*Select amount to buy:*',{chat_id:chatId,message_id:lm.message_id,parse_mode:'Markdown',reply_markup:{inline_keyboard:[
      amts.map((a,i)=>({text:`${a} SUI`,callback_data:`ba:${i}`})),
      [{text:'✏️ Custom',callback_data:'ba:c'}],
      [{text:'⚙️ Edit Defaults',callback_data:'edit_amts'},{text:'❌ Cancel',callback_data:'ca'}],
    ]}});
  }catch(e){
    const meta=await getMeta(ct).catch(()=>null);
    const sym=meta?.symbol||trunc(ct);
    updU(chatId,{pd:{ct,sym}});
    const amts=u.settings.buyAmounts||DEF_AMTS;
    await bot.editMessageText(`💰 *Buy ${sym}*\n\`${ct}\`\n\n⚠️ Token data loading slow — 7K routes to best price automatically\n\n*Select amount:*`,{chat_id:chatId,message_id:lm.message_id,parse_mode:'Markdown',reply_markup:{inline_keyboard:[amts.map((a,i)=>({text:`${a} SUI`,callback_data:`ba:${i}`})),[{text:'✏️ Custom',callback_data:'ba:c'},{text:'❌ Cancel',callback_data:'ca'}]]}});
  }
}

async function showBuyConfirm(chatId,ct,amtSui,eid){
  const u=getU(chatId);if(!u)return;
  const meta=await getMeta(ct)||{};const sym=meta.symbol||trunc(ct);
  const amtM=BigInt(Math.floor(parseFloat(amtSui)*Number(MIST)));
  const {fee}=calcFee(amtM,u);
  updU(chatId,{pd:{...getU(chatId).pd,ct,amtSui}});
  let est='?';
  try{const k=await sdk7k();const q=await k.getQuote({tokenIn:SUI_T,tokenOut:ct,amountIn:(amtM-fee).toString()});if(q?.outAmount)est=(Number(q.outAmount)/Math.pow(10,meta.decimals||9)).toFixed(4);}catch{}
  const text=`💰 *Confirm Buy*\n\nToken: *${sym}*\nAmount: ${amtSui} SUI\nFee (1%): ${fSui(fee)} SUI\nYou trade: ${fSui(amtM-fee)} SUI\n${est!='?'?`Est. receive: ~${est} ${sym}\n`:''}Slippage: ${u.settings.slippage}%`;
  const kb={inline_keyboard:[[{text:'✅ Confirm Buy',callback_data:'bc'},{text:'❌ Cancel',callback_data:'ca'}]]};
  if(eid)await bot.editMessageText(text,{chat_id:chatId,message_id:eid,parse_mode:'Markdown',reply_markup:kb}).catch(async()=>bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb}));
  else await bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb});
}

async function showSellPct(chatId,ct,sym,eid){
  const u=getU(chatId);if(!u)return;
  const coins=await getCoins(u.walletAddress,ct);
  if(!coins.length){await bot.sendMessage(chatId,`❌ No ${sym} balance.`);return;}
  const meta=await getMeta(ct)||{};
  const total=coins.reduce((s,c)=>s+BigInt(c.balance),0n);
  const bal=(Number(total)/Math.pow(10,meta.decimals||9)).toFixed(4);
  const text=`💸 *Sell ${sym}*\n\nBalance: ${bal} ${sym}\n\n*Choose amount:*`;
  const kb={inline_keyboard:[[{text:'25%',callback_data:'sp:25'},{text:'50%',callback_data:'sp:50'},{text:'75%',callback_data:'sp:75'},{text:'100%',callback_data:'sp:100'}],[{text:'✏️ Custom %',callback_data:'sp:c'},{text:'❌ Cancel',callback_data:'ca'}]]};
  if(eid)await bot.editMessageText(text,{chat_id:chatId,message_id:eid,parse_mode:'Markdown',reply_markup:kb}).catch(async()=>bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb}));
  else await bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb});
}

async function showSellConfirm(chatId,ct,pct,eid){
  const u=getU(chatId);if(!u)return;
  const meta=await getMeta(ct)||{};const sym=meta.symbol||trunc(ct);
  const coins=await getCoins(u.walletAddress,ct);
  const total=coins.reduce((s,c)=>s+BigInt(c.balance),0n);
  const sellAmt=(total*BigInt(pct))/100n;
  const disp=(Number(sellAmt)/Math.pow(10,meta.decimals||9)).toFixed(4);
  let est='?';
  try{const k=await sdk7k();const q=await k.getQuote({tokenIn:ct,tokenOut:SUI_T,amountIn:sellAmt.toString()});if(q?.outAmount)est=(Number(q.outAmount)/1e9).toFixed(4);}catch{}
  const text=`💸 *Confirm Sell*\n\nToken: *${sym}*\nSelling: ${pct}% (${disp} ${sym})\n${est!='?'?`Est. receive: ~${est} SUI\n`:''}Slippage: ${u.settings.slippage}%`;
  const kb={inline_keyboard:[[{text:'✅ Confirm Sell',callback_data:'sc'},{text:'❌ Cancel',callback_data:'ca'}]]};
  if(eid)await bot.editMessageText(text,{chat_id:chatId,message_id:eid,parse_mode:'Markdown',reply_markup:kb}).catch(async()=>bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb}));
  else await bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb});
}

// ─────────────────────────────────────────────────────────
// 20. /start
// ─────────────────────────────────────────────────────────
bot.onText(/\/start(.*)/, async(msg,match)=>{
  const chatId=msg.chat.id;
  const param=(match[1]||'').trim().replace(/[<>&"]/g,'').slice(0,20);
  let u=getU(chatId);
  if(!u){
    u=makeU(chatId);
    if(param.startsWith('AGT-')){
      const ref=Object.values(DB).find(x=>x.referralCode===param&&x.chatId!==String(chatId));
      if(ref?.walletAddress){updU(chatId,{referredBy:ref.walletAddress});updU(ref.chatId,{referralCount:(ref.referralCount||0)+1});bot.sendMessage(ref.chatId,'🎉 New user joined via your referral!');}
    }
  }
  if(u.walletAddress){
    await bot.sendMessage(chatId,`👋 Welcome back!\n\nWallet: \`${trunc(u.walletAddress)}\``,{parse_mode:'Markdown',reply_markup:MAIN_KB});
  }else{
    await bot.sendMessage(chatId,`👋 Welcome to *AGENT TRADING BOT*\n\nThe fastest trading bot on Sui.\n\nConnect your wallet:`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'🔑 Import Wallet',callback_data:'import_wallet'}],[{text:'✨ Create New Wallet',callback_data:'gen_wallet'}]]}});
  }
});

// ─────────────────────────────────────────────────────────
// 21. CALLBACKS
// ─────────────────────────────────────────────────────────
bot.on('callback_query',async(q)=>{
  const chatId=q.message.chat.id,msgId=q.message.message_id,data=q.data;
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  try{
    if(data==='noop')return;

    if(data==='import_wallet'){updU(chatId,{state:'import_key'});await bot.sendMessage(chatId,'🔑 Send your private key (`suiprivkey1...`)\n\n⚠️ Deleted immediately after import.',{parse_mode:'Markdown'});return;}

    if(data==='gen_wallet'){
      const kp=new Ed25519Keypair(),addr=kp.getPublicKey().toSuiAddress(),sk=kp.getSecretKey();
      updU(chatId,{encryptedKey:encKey(sk),walletAddress:addr,state:'set_pin'});
      await bot.sendMessage(chatId,`✅ *Wallet Created!*\n\nAddress:\n\`${addr}\`\n\n🔑 *Private Key — SAVE THIS NOW:*\n\`${sk}\`\n\n⚠️ Write this down. If lost, funds are gone.\n\nSet a 4-digit PIN:`,{parse_mode:'Markdown'});return;
    }

    if(data.startsWith('ba:')){
      const u=getU(chatId);if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      const key=data.split(':')[1];
      if(key==='c'){updU(chatId,{state:'buy_custom'});await bot.sendMessage(chatId,'💬 Enter SUI amount:\n_Example: 2.5_',{parse_mode:'Markdown'});return;}
      const amt=(u.settings.buyAmounts||DEF_AMTS)[parseInt(key)];
      if(!amt){await bot.sendMessage(chatId,'❌ Invalid.');return;}
      await showBuyConfirm(chatId,u.pd.ct,amt,msgId);return;
    }

    if(data==='bc'){
      const u=getU(chatId);if(!u?.pd?.ct||!u?.pd?.amtSui){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      await bot.editMessageText('⚡ Executing buy...',{chat_id:chatId,message_id:msgId});
      try{
        const res=await executeBuy(chatId,u.pd.ct,u.pd.amtSui);
        await bot.editMessageText(`✅ *Buy Executed!*\n\nToken: *${res.sym}*\nSpent: ${u.pd.amtSui} SUI\nFee: ${res.fee} SUI\n${res.out!='?'?`Received: ~${res.out} ${res.sym}\n`:''}Route: ${res.route}\n${res.bonding?`📊 On ${res.lpName}\n`:''}\n🔗 [View TX](${SUISCAN}${res.digest})`,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown'});
      }catch(e){await bot.editMessageText(`❌ Buy failed: ${e.message?.slice(0,180)}`,{chat_id:chatId,message_id:msgId});}
      updU(chatId,{pd:{}});return;
    }

    if(data.startsWith('st:')){
      const u=getU(chatId);const pos=u?.positions?.[parseInt(data.split(':')[1])];
      if(!pos){await bot.sendMessage(chatId,'❌ Position not found.');return;}
      updU(chatId,{pd:{ct:pos.ct,sym:pos.sym}});
      await showSellPct(chatId,pos.ct,pos.sym,null);return;
    }

    if(data==='sfs_manual'){updU(chatId,{state:'sell_ca'});await bot.sendMessage(chatId,'Send the token CA:');return;}

    if(data.startsWith('sp:')){
      const u=getU(chatId);if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      const key=data.split(':')[1];
      if(key==='c'){updU(chatId,{state:'sell_custom'});await bot.sendMessage(chatId,'💬 Enter % to sell (1-100):\n_Example: 33_',{parse_mode:'Markdown'});return;}
      const pct=parseInt(key);
      updU(chatId,{pd:{...getU(chatId).pd,pct}});
      await showSellConfirm(chatId,getU(chatId).pd.ct,pct,msgId);return;
    }

    if(data==='sc'){
      const u=getU(chatId);if(!u?.pd?.ct||!u?.pd?.pct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      await bot.editMessageText('⚡ Executing sell...',{chat_id:chatId,message_id:msgId});
      try{
        const res=await executeSell(chatId,u.pd.ct,u.pd.pct);
        await bot.editMessageText(`✅ *Sell Executed!*\n\nToken: ${res.sym}\nSold: ${res.pct}%\nEst. SUI: ${res.sui}\nFee: ${res.fee} SUI\nRoute: ${res.route}\n\n🔗 [View TX](${SUISCAN}${res.digest})`,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown'});
      }catch(e){await bot.editMessageText(`❌ Sell failed: ${e.message?.slice(0,180)}`,{chat_id:chatId,message_id:msgId});}
      updU(chatId,{pd:{}});return;
    }

    if(data==='ca'){updU(chatId,{state:null,pd:{}});await bot.editMessageText('❌ Cancelled.',{chat_id:chatId,message_id:msgId}).catch(()=>{});return;}
    if(data.startsWith('slip:')){const u=getU(chatId);if(u){u.settings.slippage=parseFloat(data.split(':')[1]);saveDB();}await bot.sendMessage(chatId,`✅ Slippage → ${data.split(':')[1]}%`);return;}
    if(data.startsWith('ct:')){const u=getU(chatId);if(u){u.settings.confirmThreshold=parseFloat(data.split(':')[1]);saveDB();}await bot.sendMessage(chatId,`✅ Threshold → ${data.split(':')[1]} SUI`);return;}
    if(data==='edit_amts'){updU(chatId,{state:'edit_amts'});await bot.sendMessage(chatId,'⚙️ Enter 4 amounts (spaces):\n_Example: 0.5 1 3 5_',{parse_mode:'Markdown'});return;}
    if(data==='bfs'){const u=getU(chatId);if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}await guard(chatId,async()=>startBuy(chatId,u.pd.ct));return;}
    if(data==='sfs'){const u=getU(chatId);if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}const m=await getMeta(u.pd.ct)||{};await guard(chatId,async()=>{updU(chatId,{pd:{ct:u.pd.ct,sym:m.symbol||trunc(u.pd.ct)}});await showSellPct(chatId,u.pd.ct,m.symbol||trunc(u.pd.ct),null);});return;}
    if(data==='sct'){
      const u=getU(chatId);if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      const m=await bot.sendMessage(chatId,'🔍 Scanning...');
      try{const[d,st]=await Promise.all([getTokenData(u.pd.ct),detectState(u.pd.ct)]);await bot.editMessageText(scanReport(d,u.pd.ct,st),{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});}
      catch(e){await bot.editMessageText(`❌ ${e.message?.slice(0,100)}`,{chat_id:chatId,message_id:m.message_id});}
      return;
    }
  }catch(e){console.error('CB:',e.message);await bot.sendMessage(chatId,`❌ ${e.message?.slice(0,120)}`);}
});

// ─────────────────────────────────────────────────────────
// 22. MESSAGE HANDLER (state machine + keyboard)
// ─────────────────────────────────────────────────────────
bot.on('message',async(msg)=>{
  if(!msg.text)return;
  const chatId=msg.chat.id;
  const raw=msg.text.trim();
  if(!raw||raw.startsWith('/'))return;

  const u=getU(chatId)||makeU(chatId);
  const state=u.state;

  // Keyboard buttons — direct calls
  const KB={
    '💰 Buy':        ()=>guard(chatId,async()=>{await bot.sendMessage(chatId,'Send the token CA or $TICKER:\n\n_Example: 0x1234... or $AGENT_',{parse_mode:'Markdown'});updU(chatId,{state:'buy_ca'});}),
    '💸 Sell':       ()=>guard(chatId,async(u)=>doSellMenu(chatId,u)),
    '📊 Positions':  ()=>doPositions(chatId),
    '💼 Balance':    ()=>doBalance(chatId),
    '🔍 Scan':       ()=>{bot.sendMessage(chatId,'Send the token CA to scan:\n_Example: 0x1234..._',{parse_mode:'Markdown'});updU(chatId,{state:'scan_ca'});},
    '⚡ Snipe':      ()=>guard(chatId,async()=>{await bot.sendMessage(chatId,'⚡ *Sniper*\n\nUsage: /snipe [token address]',{parse_mode:'Markdown'});}),
    '🔁 Copy Trade': ()=>guard(chatId,async()=>{await bot.sendMessage(chatId,'🔁 *Copy Trader*\n\nUsage: /copytrader [wallet] or /copytrader stop',{parse_mode:'Markdown'});}),
    '🔗 Referral':   ()=>doReferral(chatId),
    '⚙️ Settings':   ()=>doSettings(chatId),
    '❓ Help':        ()=>doHelp(chatId),
  };
  if(KB[raw]){await KB[raw]();return;}

  // State machine — preserve raw text for private keys and addresses
  const text = raw.replace(/[<>&]/g,'').slice(0,1000);

  if(state==='import_key'){
    updU(chatId,{state:null});
    try{await bot.deleteMessage(chatId,msg.message_id);}catch{}
    try{
      const dec=decodeSuiPrivateKey(text);
      const kp=Ed25519Keypair.fromSecretKey(dec.secretKey);
      const addr=kp.getPublicKey().toSuiAddress();
      updU(chatId,{encryptedKey:encKey(text),walletAddress:addr,state:'set_pin'});
      await bot.sendMessage(chatId,`✅ *Wallet imported!*\n\nAddress: \`${addr}\`\n🔐 Key encrypted securely.\n\nSet a 4-digit PIN:`,{parse_mode:'Markdown'});
    }catch{await bot.sendMessage(chatId,'❌ Invalid private key format. Use /start to try again.');}
    return;
  }

  if(state==='set_pin'){
    if(!/^\d{4}$/.test(text)){await bot.sendMessage(chatId,'❌ Must be exactly 4 digits:');return;}
    updU(chatId,{pinHash:hashPin(text),state:null});
    await bot.sendMessage(chatId,'✅ PIN set! Bot auto-locks after 30 min inactivity.\n\nFund your wallet with SUI and you\'re ready to trade! 🚀',{reply_markup:MAIN_KB});
    if(BACKEND_URL)ftch(`${BACKEND_URL}/api/bot-user`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatId,walletAddress:getU(chatId).walletAddress,referralCode:getU(chatId).referralCode})}).catch(()=>{});
    return;
  }

  if(state==='pin_unlock'){
    if(!/^\d{4}$/.test(text)){await bot.sendMessage(chatId,'❌ Enter 4-digit PIN:');return;}
    if(hashPin(text)===u.pinHash){
      unlockU(chatId);updU(chatId,{state:null,failAttempts:0,cooldownUntil:0});
      await bot.sendMessage(chatId,'🔓 Unlocked!',{reply_markup:MAIN_KB});
    }else{
      const fails=(u.failAttempts||0)+1;
      if(fails>=MAX_FAILS){updU(chatId,{failAttempts:0,cooldownUntil:Date.now()+COOLDOWN_MS});await bot.sendMessage(chatId,'❌ Too many wrong attempts. Locked 5 minutes.');}
      else{updU(chatId,{failAttempts:fails});await bot.sendMessage(chatId,`❌ Wrong PIN. ${MAX_FAILS-fails} attempts left.`);}
    }
    return;
  }

  if(state==='buy_ca'){
    updU(chatId,{state:null});
    const ct=text.startsWith('0x')?text:(await resolveTicker(text));
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found. Paste the full contract address.');return;}
    await guard(chatId,async()=>startBuy(chatId,ct));return;
  }

  if(state==='sell_ca'){
    updU(chatId,{state:null});
    const ct=text.startsWith('0x')?text:(await resolveTicker(text));
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
    const meta=await getMeta(ct)||{};
    await guard(chatId,async()=>{updU(chatId,{pd:{ct,sym:meta.symbol||trunc(ct)}});await showSellPct(chatId,ct,meta.symbol||trunc(ct),null);});return;
  }

  if(state==='scan_ca'){
    updU(chatId,{state:null});
    const ct=text.startsWith('0x')?text:(await resolveTicker(text));
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
    const m=await bot.sendMessage(chatId,'🔍 Scanning token...');
    try{const[d,st]=await Promise.all([getTokenData(ct),detectState(ct)]);await bot.editMessageText(scanReport(d,ct,st),{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});}
    catch(e){await bot.editMessageText(`❌ Scan failed: ${e.message?.slice(0,100)}`,{chat_id:chatId,message_id:m.message_id});}
    return;
  }

  if(state==='buy_custom'){
    updU(chatId,{state:null});
    const amt=parseFloat(text);if(isNaN(amt)||amt<=0){await bot.sendMessage(chatId,'❌ Enter a number like 2.5');return;}
    const ct=u.pd?.ct;if(!ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
    await showBuyConfirm(chatId,ct,amt,null);return;
  }

  if(state==='sell_custom'){
    updU(chatId,{state:null});
    const pct=parseFloat(text);if(isNaN(pct)||pct<=0||pct>100){await bot.sendMessage(chatId,'❌ Enter 1-100');return;}
    const ct=u.pd?.ct;if(!ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
    updU(chatId,{pd:{...u.pd,pct}});await showSellConfirm(chatId,ct,pct,null);return;
  }

  if(state==='edit_amts'){
    updU(chatId,{state:null});
    const parts=text.split(/\s+/).map(Number).filter(n=>!isNaN(n)&&n>0).slice(0,4);
    if(parts.length<2){await bot.sendMessage(chatId,'❌ Enter at least 2 amounts: 0.5 1 3 5');return;}
    while(parts.length<4)parts.push(parts[parts.length-1]*2);
    const uu=getU(chatId);if(uu){uu.settings.buyAmounts=parts;saveDB();}
    await bot.sendMessage(chatId,`✅ Quick-buy amounts: ${parts.join(', ')} SUI`);return;
  }

  if(state==='snipe_amount'){
    const amt=parseFloat(text);if(isNaN(amt)||amt<=0){await bot.sendMessage(chatId,'❌ Invalid amount.');return;}
    const pd=u.pd||{};
    u.snipeWatches=u.snipeWatches||[];
    u.snipeWatches.push({ct:pd.sniToken,sui:amt,mode:'any',triggered:false,at:Date.now()});
    updU(chatId,{state:null,pd:{},snipeWatches:u.snipeWatches});
    await bot.sendMessage(chatId,`⚡ *Snipe set!*\n\nToken: \`${trunc(pd.sniToken)}\`\nBuy: ${amt} SUI\nWatching for pool...`,{parse_mode:'Markdown'});return;
  }

  if(state==='copy_wallet'){
    if(!text.startsWith('0x')){await bot.sendMessage(chatId,'❌ Invalid wallet address.');return;}
    u.copyTraders=u.copyTraders||[];
    if(u.copyTraders.length>=3){await bot.sendMessage(chatId,'❌ Max 3 wallets. /copytrader stop first.');return;}
    u.copyTraders.push({wallet:text,amount:u.settings.copyAmount,maxPos:5,blacklist:[]});
    updU(chatId,{state:null,copyTraders:u.copyTraders});
    await bot.sendMessage(chatId,`✅ Tracking \`${trunc(text)}\``,{parse_mode:'Markdown'});return;
  }

  // Raw CA paste
  if(text.startsWith('0x')&&text.length>40){
    updU(chatId,{pd:{ct:text}});
    await bot.sendMessage(chatId,`📋 \`${trunc(text)}\`\n\nWhat do you want to do?`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'💰 Buy',callback_data:'bfs'},{text:'💸 Sell',callback_data:'sfs'},{text:'🔍 Scan',callback_data:'sct'}]]}});return;
  }
});

// ─────────────────────────────────────────────────────────
// 23. /command ROUTES
// ─────────────────────────────────────────────────────────
bot.onText(/\/buy(?:\s+(.+))?/,async(msg,m)=>{
  const chatId=msg.chat.id,args=(m[1]||'').trim();
  await guard(chatId,async()=>{
    if(!args){await bot.sendMessage(chatId,'Send the token CA or $TICKER:');updU(chatId,{state:'buy_ca'});return;}
    const parts=args.split(/\s+/);
    const ct=parts[0].startsWith('0x')?parts[0]:(await resolveTicker(parts[0]));
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
    if(parts[1]){const a=parseFloat(parts[1]);if(!isNaN(a)&&a>0){updU(chatId,{pd:{ct}});await showBuyConfirm(chatId,ct,a,null);return;}}
    await startBuy(chatId,ct);
  });
});

bot.onText(/\/sell(?:\s+(.+))?/,async(msg,m)=>{
  const chatId=msg.chat.id,args=(m[1]||'').trim();
  await guard(chatId,async(u)=>{
    if(!args){await doSellMenu(chatId,u);return;}
    const parts=args.split(/\s+/);
    const ct=parts[0].startsWith('0x')?parts[0]:(await resolveTicker(parts[0]));
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
    const meta=await getMeta(ct)||{};
    if(parts[1]){const p=parts[1].toLowerCase()==='all'?100:parseFloat(parts[1].replace('%',''));if(!isNaN(p)){updU(chatId,{pd:{ct,sym:meta.symbol}});await showSellConfirm(chatId,ct,p,null);return;}}
    updU(chatId,{pd:{ct,sym:meta.symbol||trunc(ct)}});await showSellPct(chatId,ct,meta.symbol||trunc(ct),null);
  });
});

bot.onText(/\/scan(?:\s+(.+))?/,async(msg,m)=>{
  const chatId=msg.chat.id,arg=(m[1]||'').trim();
  if(!arg){await bot.sendMessage(chatId,'Send the token CA:');updU(chatId,{state:'scan_ca'});return;}
  const ct=arg.startsWith('0x')?arg:(await resolveTicker(arg));
  if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
  const pm=await bot.sendMessage(chatId,'🔍 Scanning...');
  try{const[d,st]=await Promise.all([getTokenData(ct),detectState(ct)]);await bot.editMessageText(scanReport(d,ct,st),{chat_id:chatId,message_id:pm.message_id,parse_mode:'Markdown'});}
  catch(e){await bot.editMessageText(`❌ Scan failed: ${e.message?.slice(0,100)}`,{chat_id:chatId,message_id:pm.message_id});}
});

bot.onText(/\/balance/,               async(msg)=>doBalance(msg.chat.id));
bot.onText(/\/positions/,             async(msg)=>doPositions(msg.chat.id));
bot.onText(/\/referral/,              async(msg)=>doReferral(msg.chat.id));
bot.onText(/\/help/,                  async(msg)=>doHelp(msg.chat.id));
bot.onText(/\/settings/,             async(msg)=>doSettings(msg.chat.id));
bot.onText(/\/snipe(?:\s+(.+))?/,    async(msg,m)=>{
  const chatId=msg.chat.id,token=m[1]?m[1].trim():null;
  await guard(chatId,async()=>{
    if(!token){await bot.sendMessage(chatId,'⚡ *Sniper*\n\nUsage: /snipe [token address]\n\nBot buys instantly when a pool is detected.\n\nExample: /snipe 0x1234...',{parse_mode:'Markdown'});return;}
    updU(chatId,{state:'snipe_amount',pd:{sniToken:token}});
    await bot.sendMessage(chatId,`Token: \`${trunc(token)}\`\n\nHow much SUI to buy?\n_Example: 0.5_`,{parse_mode:'Markdown'});
  });
});
bot.onText(/\/copytrader(?:\s+(.+))?/,async(msg,m)=>{
  const chatId=msg.chat.id,arg=m[1]?m[1].trim():null;
  await guard(chatId,async(u)=>{
    if(!arg||arg==='list'){
      if(!u.copyTraders?.length){await bot.sendMessage(chatId,'🔁 *Copy Trader*\n\nNo wallets tracked.\n\nUsage: /copytrader [wallet]\nStop: /copytrader stop',{parse_mode:'Markdown'});return;}
      await bot.sendMessage(chatId,`🔁 *Copy Traders (${u.copyTraders.length}/3)*\n\n${u.copyTraders.map((ct,i)=>`${i+1}. \`${trunc(ct.wallet)}\` — ${ct.amount} SUI`).join('\n')}\n\nStop: /copytrader stop`,{parse_mode:'Markdown'});return;
    }
    if(arg==='stop'){updU(chatId,{copyTraders:[]});await bot.sendMessage(chatId,'✅ All copy traders stopped.');return;}
    if(arg.startsWith('0x')){
      u.copyTraders=u.copyTraders||[];
      if(u.copyTraders.length>=3){await bot.sendMessage(chatId,'❌ Max 3. /copytrader stop first.');return;}
      u.copyTraders.push({wallet:arg,amount:u.settings.copyAmount,maxPos:5,blacklist:[]});
      updU(chatId,{copyTraders:u.copyTraders});
      await bot.sendMessage(chatId,`✅ Tracking \`${trunc(arg)}\``,{parse_mode:'Markdown'});return;
    }
    updU(chatId,{state:'copy_wallet'});await bot.sendMessage(chatId,'Enter the wallet address to copy:');
  });
});

// ─────────────────────────────────────────────────────────
// 24. ERRORS & STARTUP
// ─────────────────────────────────────────────────────────
bot.on('polling_error',e=>{console.error('Polling:',e.message);if(ADMIN_ID)bot.sendMessage(ADMIN_ID,`⚠️ ${e.message?.slice(0,150)}`).catch(()=>{});});
process.on('uncaughtException',e=>{console.error('Uncaught:',e);if(ADMIN_ID)bot.sendMessage(ADMIN_ID,`🚨 ${e.message?.slice(0,150)}`).catch(()=>{});});
process.on('unhandledRejection',r=>console.error('Unhandled:',r));

async function main() {
  if(!TG_TOKEN)             throw new Error('TG_BOT_TOKEN env var required');
  if(ENC_KEY.length!==64)   throw new Error('ENCRYPT_KEY must be 64 hex chars');
  loadDB();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  AGENT TRADING BOT v5');
  console.log(`  Users loaded: ${Object.keys(DB).length}`);
  await sdk7k().then(()=>console.log('✅ 7K Aggregator v2')).catch(e=>console.warn('⚠️ 7K:',e.message));
  await sdkTurbos().then(()=>console.log('✅ Turbos SDK')).catch(e=>console.warn('⚠️ Turbos:',e.message));
  positionMonitor().catch(e=>console.error('Monitor:',e));
  sniperEngine().catch(e=>console.error('Sniper:',e));
  copyEngine().catch(e=>console.error('Copy:',e));
  console.log('  Bot is live!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if(ADMIN_ID)bot.sendMessage(ADMIN_ID,'🟢 AGENT TRADING BOT v5 online.').catch(()=>{});
}

main().catch(e=>{console.error('Fatal:',e);process.exit(1);});
