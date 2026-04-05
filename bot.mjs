/**
 * AGENT TRADING BOT — Complete clean rewrite
 * No spliced code. Every function defined once. Tested top-to-bottom.
 */

// ═══════════════════════════════════════════
// 1. IMPORTS
// ═══════════════════════════════════════════
import TelegramBot from 'node-telegram-bot-api';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { setTimeout as sleep } from 'timers/promises';

// ═══════════════════════════════════════════
// 2. ENVIRONMENT & CONSTANTS
// ═══════════════════════════════════════════
const TG_TOKEN     = process.env.TG_BOT_TOKEN  || '';
const ENC_KEY      = process.env.ENCRYPT_KEY   || '';
const RPC_URL      = process.env.RPC_URL        || 'https://fullnode.mainnet.sui.io:443';
const BACKEND_URL  = process.env.BACKEND_URL   || '';
const ADMIN_ID     = process.env.ADMIN_CHAT_ID || '';

const DEV_WALLET   = '0x9e0ac3152f035e411164b24c8db59b3f0ee870340ec754ae5f074559baaa15b1';
const FEE_BPS      = 100n;         // 1%
const REF_SHARE    = 25n;          // 25% of fee
const MIST         = 1_000_000_000n;
const SUI_TYPE     = '0x2::sui::SUI';
const DB_FILE      = './users.json';
const SUISCAN      = 'https://suiscan.xyz/mainnet/tx/';
const GECKO        = 'https://api.geckoterminal.com/api/v2';
const GECKO_NET    = 'sui-network';
const LOCK_MS      = 30 * 60 * 1000;
const MAX_FAILS    = 3;
const COOLDOWN_MS  = 5 * 60 * 1000;
const DEFAULT_AMTS = [0.5, 1, 3, 5];

const LAUNCHPADS = {
  MOVEPUMP:   { name: 'MovePump',   api: 'https://movepump.com/api',        grad: 2000, dex: 'Cetus'  },
  TURBOS_FUN: { name: 'Turbos.fun', api: 'https://api.turbos.finance/fun',   grad: 6000, dex: 'Turbos' },
  HOP_FUN:    { name: 'hop.fun',    api: 'https://api.hop.ag',               grad: null, dex: 'Cetus'  },
  MOONBAGS:   { name: 'MoonBags',   api: 'https://api.moonbags.io',          grad: null, dex: 'Cetus'  },
  BLAST_FUN:  { name: 'blast.fun',  api: 'https://api.blast.fun',            grad: null, dex: 'Cetus'  },
};

// ═══════════════════════════════════════════
// 3. CRYPTO HELPERS
// ═══════════════════════════════════════════
function encKey(pk) {
  const iv = randomBytes(16);
  const c  = createCipheriv('aes-256-cbc', Buffer.from(ENC_KEY, 'hex'), iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(pk, 'utf8'), c.final()]).toString('hex');
}

function decKey(stored) {
  const [ivHex, encHex] = stored.split(':');
  const d = createDecipheriv('aes-256-cbc', Buffer.from(ENC_KEY, 'hex'), Buffer.from(ivHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString('utf8');
}

function hashPin(pin) { return createHash('sha256').update(pin + ENC_KEY).digest('hex'); }

function getKP(user) {
  const pk = decKey(user.encryptedKey);
  return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(pk).secretKey);
}

function genRefCode() {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return 'AGT-' + Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// ═══════════════════════════════════════════
// 4. USER STORAGE
// ═══════════════════════════════════════════
let DB = {};

function loadDB() {
  if (existsSync(DB_FILE)) try { DB = JSON.parse(readFileSync(DB_FILE, 'utf8')); } catch { DB = {}; }
}

function saveDB() { writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); }

function getU(id) { return DB[String(id)] || null; }

function createU(id, extras = {}) {
  const uid = String(id);
  DB[uid] = {
    chatId: uid, encryptedKey: null, walletAddress: null, pinHash: null,
    lockedAt: null, lastActivity: Date.now(), failAttempts: 0, cooldownUntil: 0,
    positions: [], copyTraders: [], snipeWatches: [],
    settings: { slippage: 1, confirmThreshold: 0.5, copyAmount: 0.1, buyAmounts: [...DEFAULT_AMTS], tpDefault: null, slDefault: null },
    referralCode: genRefCode(), referredBy: null, referralCount: 0, referralEarned: 0,
    state: null, pd: {},
    ...extras,
  };
  saveDB();
  return DB[uid];
}

function updU(id, patch) {
  const uid = String(id);
  if (!DB[uid]) return;
  for (const [k, v] of Object.entries(patch)) DB[uid][k] = v;
  DB[uid].lastActivity = Date.now();
  saveDB();
}

function isLocked(u) { return !!(u?.pinHash && u?.lockedAt); }
function lockU(id)   { updU(id, { lockedAt: Date.now() }); }
function unlockU(id) { updU(id, { lockedAt: null, failAttempts: 0 }); }

setInterval(() => {
  const now = Date.now();
  for (const [uid, u] of Object.entries(DB))
    if (u.pinHash && !u.lockedAt && u.walletAddress && now - u.lastActivity > LOCK_MS) lockU(uid);
}, 60_000);

// ═══════════════════════════════════════════
// 5. SUI CLIENT
// ═══════════════════════════════════════════
const sui = new SuiClient({ url: RPC_URL });

async function ftch(url, opts = {}, ms = 7000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: ac.signal }); clearTimeout(t); return r; }
  catch (e) { clearTimeout(t); throw e; }
}

async function getCoinMeta(ct) { try { return await sui.getCoinMetadata({ coinType: ct }); } catch { return null; } }
async function getCoins(addr, ct) { try { const r = await sui.getCoins({ owner: addr, coinType: ct }); return r.data; } catch { return []; } }
async function getAllBals(addr) { return sui.getAllBalances({ owner: addr }); }

// ═══════════════════════════════════════════
// 6. SDK SINGLETONS
// ═══════════════════════════════════════════
let _7k = null;
async function sdk7k() {
  if (_7k) return _7k;
  const mod = await import('@7kprotocol/sdk-ts');
  const lib = mod.default && typeof mod.default === 'object' ? mod.default : mod;
  const setSC = typeof mod.setSuiClient === 'function' ? mod.setSuiClient
              : typeof lib.setSuiClient === 'function' ? lib.setSuiClient : null;
  if (setSC) setSC(sui);
  const getQuote = mod.getQuote ?? lib.getQuote;
  const buildTx  = mod.buildTx  ?? lib.buildTx;
  if (!getQuote) throw new Error('7K SDK getQuote not found');
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

// ═══════════════════════════════════════════
// 7. FEES & REFERRAL
// ═══════════════════════════════════════════
function calcFee(amtMist, u) {
  const fee = (amtMist * FEE_BPS) / 10000n;
  let ref = 0n, dev = fee;
  if (u.referredBy) { ref = (fee * REF_SHARE) / 100n; dev = fee - ref; }
  return { fee, ref, dev };
}

function findReferrer(u) {
  if (!u.referredBy) return null;
  return Object.values(DB).find(x => x.walletAddress === u.referredBy) || null;
}

// ═══════════════════════════════════════════
// 8. TOKEN STATE DETECTION
// ═══════════════════════════════════════════
const stateCache = new Map();
const STATE_TTL  = 20_000;

async function detectState(ct) {
  const cached = stateCache.get(ct);
  if (cached && Date.now() - cached.ts < STATE_TTL) return cached;

  // 1. 7K quote — fastest DEX check
  try {
    const k = await sdk7k();
    const q = await k.getQuote({ tokenIn: SUI_TYPE, tokenOut: ct, amountIn: '1000000000' });
    if (q?.outAmount && BigInt(q.outAmount) > 0n) {
      const r = { state: 'dex', dex: q.routes?.[0]?.poolType || '7K Aggregator', ts: Date.now() };
      stateCache.set(ct, r); return r;
    }
  } catch {}

  // 2. Cetus REST API
  try {
    const r = await ftch(`https://api-sui.cetus.zone/v2/sui/pools_info?coin_type=${encodeURIComponent(ct)}&page_size=3`, {}, 5000);
    if (r.ok) { const d = await r.json(); if (d.data?.list?.length) { const res = { state: 'dex', dex: 'Cetus', ts: Date.now() }; stateCache.set(ct, res); return res; } }
  } catch {}

  // 3. GeckoTerminal pool check
  try {
    for (const addr of [ct, ct.split('::')[0]]) {
      const r = await ftch(`${GECKO}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}/pools?page=1`, { headers: { Accept: 'application/json;version=20230302' } }, 5000);
      if (r.ok) { const d = await r.json(); if (d.data?.length) { const res = { state: 'dex', dex: d.data[0].relationships?.dex?.data?.id || 'DEX', ts: Date.now() }; stateCache.set(ct, res); return res; } }
    }
  } catch {}

  // 4. Launchpad bonding curves
  for (const [key, lp] of Object.entries(LAUNCHPADS)) {
    try {
      const enc  = encodeURIComponent(ct);
      const url  = key === 'TURBOS_FUN' ? `${lp.api}/token?coinType=${enc}` : `${lp.api}/token/${enc}`;
      const r    = await ftch(url, {}, 4000);
      if (!r.ok) continue;
      const data = await r.json();
      if (!data) continue;
      if (data.graduated || data.is_graduated || data.complete || data.migrated) continue;
      const res = {
        state: 'bonding_curve', lp: key, lpName: lp.name, destDex: lp.dex,
        curveId: data.bonding_curve_id || data.curveObjectId || data.pool_id || null,
        suiRaised: parseFloat(data.sui_raised || 0), threshold: lp.grad,
        price: parseFloat(data.price || 0), ts: Date.now(),
      };
      stateCache.set(ct, res); return res;
    } catch {}
  }

  const res = { state: 'unknown', ts: Date.now() };
  stateCache.set(ct, res); return res;
}

// ═══════════════════════════════════════════
// 9. SWAP EXECUTION
// ═══════════════════════════════════════════
async function swap7K({ kp, wallet, tokenIn, tokenOut, amtMist, slippage, u }) {
  const k  = await sdk7k();
  const { fee, ref, dev } = calcFee(amtMist, u);
  const tradeMist = amtMist - fee;

  const quote = await k.getQuote({ tokenIn, tokenOut, amountIn: tradeMist.toString() });
  if (!quote?.outAmount || BigInt(quote.outAmount) === 0n) throw new Error('No liquidity found on any DEX.');

  const built = await k.buildTx({ quoteResponse: quote, accountAddress: wallet, slippage: slippage / 100, commission: { partner: DEV_WALLET, commissionBps: 0 } });
  const tx = built.tx;

  const [dc] = tx.splitCoins(tx.gas, [tx.pure.u64(dev)]);
  tx.transferObjects([dc], tx.pure.address(DEV_WALLET));
  if (ref > 0n && u.referredBy) {
    const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(ref)]);
    tx.transferObjects([rc], tx.pure.address(u.referredBy));
    const referrer = findReferrer(u);
    if (referrer) { referrer.referralEarned = (referrer.referralEarned || 0) + Number(ref) / 1e9; saveDB(); }
  }
  if (built.coinOut) tx.transferObjects([built.coinOut], tx.pure.address(wallet));
  tx.setGasBudget(50_000_000);

  const res = await sui.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } });
  if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'TX failed');
  return { digest: res.digest, out: quote.outAmount, fee, route: quote.routes?.[0]?.poolType || '7K' };
}

async function swapBondingBuy({ kp, wallet, ct, amtMist, curveId, u }) {
  const pkg = ct.split('::')[0], mod = ct.split('::')[1] || '';
  const tx = new Transaction();
  tx.setGasBudget(30_000_000);
  const { fee, dev, ref } = calcFee(amtMist, u);
  const [dc] = tx.splitCoins(tx.gas, [tx.pure.u64(dev)]);
  tx.transferObjects([dc], tx.pure.address(DEV_WALLET));
  if (ref > 0n && u.referredBy) {
    const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(ref)]);
    tx.transferObjects([rc], tx.pure.address(u.referredBy));
  }
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amtMist - fee)]);
  tx.moveCall({ target: `${pkg}::${mod}::buy`, typeArguments: [ct], arguments: [tx.object(curveId), coin, tx.object('0x6')] });
  const res = await sui.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } });
  if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Bonding curve buy failed');
  return { digest: res.digest, fee };
}

async function swapBondingSell({ kp, wallet, ct, coins, amt, curveId }) {
  const pkg = ct.split('::')[0], mod = ct.split('::')[1] || '';
  const tx = new Transaction();
  tx.setGasBudget(30_000_000);
  let obj = tx.object(coins[0].coinObjectId);
  if (coins.length > 1) tx.mergeCoins(obj, coins.slice(1).map(c => tx.object(c.coinObjectId)));
  const [sell] = tx.splitCoins(obj, [tx.pure.u64(amt)]);
  tx.moveCall({ target: `${pkg}::${mod}::sell`, typeArguments: [ct], arguments: [tx.object(curveId), sell, tx.object('0x6')] });
  const res = await sui.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } });
  if (res.effects?.status?.status !== 'success') throw new Error(res.effects?.status?.error || 'Bonding curve sell failed');
  return { digest: res.digest };
}

async function executeBuy(chatId, ct, amtSui) {
  const u   = getU(chatId); if (!u) throw new Error('No user');
  const kp  = getKP(u);
  const amt = BigInt(Math.floor(parseFloat(amtSui) * Number(MIST)));
  const meta = await getCoinMeta(ct) || {};
  const sym  = meta.symbol || ct.slice(0, 8) + '...';
  const st   = await detectState(ct);

  if (st.state === 'dex' || st.state === 'unknown') {
    const res = await swap7K({ kp, wallet: u.walletAddress, tokenIn: SUI_TYPE, tokenOut: ct, amtMist: amt, slippage: u.settings.slippage, u });
    const estTok = Number(res.out) / Math.pow(10, meta.decimals || 9);
    addPos(chatId, { ct, sym, entry: Number(amt - res.fee) / 1e9 / (estTok || 1), tokens: estTok, dec: meta.decimals || 9, spent: amtSui, source: 'dex', tp: u.settings.tpDefault, sl: u.settings.slDefault });
    return { digest: res.digest, feeSui: fmtSui(res.fee), route: res.route, out: estTok.toFixed(4), sym, bonding: false };
  }

  if (st.state === 'bonding_curve') {
    if (!st.curveId) throw new Error(`On ${st.lpName} but curve ID unknown. Trade on the launchpad directly.`);
    const res = await swapBondingBuy({ kp, wallet: u.walletAddress, ct, amtMist: amt, curveId: st.curveId, u });
    addPos(chatId, { ct, sym, entry: 0, tokens: 0, dec: 9, spent: amtSui, source: 'bonding', lp: st.lpName, tp: null, sl: null });
    return { digest: res.digest, feeSui: fmtSui(res.fee), route: st.lpName, out: '?', sym, bonding: true, lpName: st.lpName };
  }

  throw new Error('Token has no liquidity on any DEX or launchpad.');
}

async function executeSell(chatId, ct, pct) {
  const u    = getU(chatId); if (!u) throw new Error('No user');
  const kp   = getKP(u);
  const meta = await getCoinMeta(ct) || {};
  const sym  = meta.symbol || ct.slice(0, 8) + '...';
  const coins = await getCoins(u.walletAddress, ct);
  if (!coins.length) throw new Error(`No ${sym} balance in wallet.`);
  const total = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
  const sellAmt = (total * BigInt(pct)) / 100n;
  if (sellAmt === 0n) throw new Error('Sell amount is zero.');
  const st = await detectState(ct);

  if (st.state === 'dex' || st.state === 'unknown') {
    const res = await swap7K({ kp, wallet: u.walletAddress, tokenIn: ct, tokenOut: SUI_TYPE, amtMist: sellAmt, slippage: u.settings.slippage, u });
    if (pct === 100) updU(chatId, { positions: u.positions.filter(p => p.ct !== ct) });
    const suiOut = Number(res.out) / 1e9;
    return { digest: res.digest, feeSui: fmtSui(calcFee(BigInt(res.out), u).fee), route: res.route, sui: suiOut.toFixed(4), sym, pct };
  }

  if (st.state === 'bonding_curve') {
    if (!st.curveId) throw new Error(`Bonding curve ID unknown for ${st.lpName}.`);
    const res = await swapBondingSell({ kp, wallet: u.walletAddress, ct, coins, amt: sellAmt, curveId: st.curveId });
    if (pct === 100) updU(chatId, { positions: u.positions.filter(p => p.ct !== ct) });
    return { digest: res.digest, feeSui: 'N/A', route: st.lpName, sui: '?', sym, pct };
  }

  throw new Error('Cannot sell — token not found on any DEX or launchpad.');
}

// ═══════════════════════════════════════════
// 10. FORMAT HELPERS
// ═══════════════════════════════════════════
function fmtSui(mist) { return (Number(mist) / 1e9).toFixed(4); }
function fmtN(n) { if (!n) return '0'; if (n>=1e9) return (n/1e9).toFixed(2)+'B'; if (n>=1e6) return (n/1e6).toFixed(2)+'M'; if (n>=1e3) return (n/1e3).toFixed(1)+'K'; return n.toFixed(0); }
function trunc(a) { return (!a||a.length<12) ? (a||'') : a.slice(0,6)+'...'+a.slice(-4); }
function pkg(ct) { return ct.split('::')[0]; }

function fmtPrice(p) {
  if (!p||p===0) return '$0';
  if (p>=1) return `$${p.toFixed(4)}`;
  if (p>=0.01) return `$${p.toFixed(6)}`;
  const s = p.toFixed(20), dec = s.split('.')[1]||'';
  let z=0; for (const c of dec) { if(c==='0') z++; else break; }
  if (z>=4) {
    const sub=['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉'];
    const ss = z.toString().split('').map(d=>sub[+d]).join('');
    return `$0.0${ss}${dec.slice(z,z+4)}`;
  }
  return `$${p.toFixed(z+4)}`;
}

function fmtChg(p) { if(p===null||p===undefined) return 'N/A'; return `${p>=0?'+':''}${p.toFixed(2)}%`; }

function fmtAge(d) {
  if (!d) return null;
  try {
    const ms=Date.now()-new Date(d).getTime(), m=Math.floor(ms/60000), h=Math.floor(m/60), days=Math.floor(h/24);
    if(days>0) return `${days}d`; if(h>0) return `${h}h${m%60}m`; return `${m}m`;
  } catch { return null; }
}

function fmtSupply(n) {
  if(!n||n===0) return null;
  if(n>=1e9) return (n/1e9).toFixed(2)+'B';
  if(n>=1e6) return (n/1e6).toFixed(2)+'M';
  if(n>=1e3) return (n/1e3).toFixed(1)+'K';
  return n.toLocaleString();
}

// ═══════════════════════════════════════════
// 11. TOKEN DATA — Fast parallel fetch (5s cap)
// ═══════════════════════════════════════════
async function geckoToken(ct) {
  try {
    for (const addr of [ct, pkg(ct)]) {
      const r = await ftch(`${GECKO}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}`, { headers: { Accept: 'application/json;version=20230302' } }, 6000);
      if (!r.ok) continue;
      const a = (await r.json()).data?.attributes || {};
      if (!a.name && !a.symbol) continue;
      return { name: a.name, symbol: a.symbol, decimals: parseInt(a.decimals)||9, rawSupply: parseFloat(a.total_supply||0), priceUsd: parseFloat(a.price_usd||0), fdv: parseFloat(a.fdv_usd||0), mcap: parseFloat(a.market_cap_usd||0), vol24h: parseFloat(a.volume_usd?.h24||0), chg24h: parseFloat(a.price_change_percentage?.h24||0) };
    }
  } catch {}
  return null;
}

async function geckoPools(ct) {
  const pools = [], seen = new Set();
  try {
    for (const addr of [ct, pkg(ct)]) {
      const r = await ftch(`${GECKO}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}/pools?page=1`, { headers: { Accept: 'application/json;version=20230302' } }, 6000);
      if (!r.ok) continue;
      for (const p of ((await r.json()).data||[]).slice(0,6)) {
        const id = p.attributes?.address || p.id;
        if (seen.has(id)) continue; seen.add(id);
        const a = p.attributes||{}, dex = p.relationships?.dex?.data?.id || a.dex_id || 'DEX';
        pools.push({ dex: dex[0].toUpperCase()+dex.slice(1), id, liq: parseFloat(a.reserve_in_usd||0), vol24h: parseFloat(a.volume_usd?.h24||0), chg5m: parseFloat(a.price_change_percentage?.m5||0), chg1h: parseFloat(a.price_change_percentage?.h1||0), chg6h: parseFloat(a.price_change_percentage?.h6||0), chg24h: parseFloat(a.price_change_percentage?.h24||0), priceN: parseFloat(a.base_token_price_native_currency||0), priceU: parseFloat(a.base_token_price_usd||0), createdAt: a.pool_created_at||null });
      }
      if (pools.length) break;
    }
  } catch {}
  // Bluefin fallback
  if (!pools.length) {
    try {
      const r = await ftch(`https://dapi.api.sui-prod.bluefin.io/pools?coinType=${encodeURIComponent(ct)}`, {}, 5000);
      if (r.ok) { const d = await r.json(); for (const p of (d.data||d||[]).slice(0,3)) { const id=p.address||p.poolId||p.id||''; if(!id||seen.has(id)) continue; seen.add(id); pools.push({ dex:'Bluefin', id, liq: parseFloat(p.liquidityUSD||p.tvl||0), vol24h: parseFloat(p.volume24h||0), chg5m:0,chg1h:0,chg6h:0,chg24h:0, priceN: parseFloat(p.price||0), priceU:0, createdAt:null }); } }
    } catch {}
  }
  return pools.sort((a,b) => b.liq - a.liq);
}

async function getHolders(ct) {
  // Sui GraphQL — real on-chain data
  try {
    const gql = `query($t:String!){coins(type:$t,first:50){nodes{owner{...on AddressOwner{owner{address}}}balance}}}`;
    const r = await ftch('https://sui-mainnet.mystenlabs.com/graphql', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ query: gql, variables: { t: ct } }) }, 6000);
    if (r.ok) {
      const nodes = ((await r.json()).data?.coins?.nodes)||[];
      if (nodes.length) {
        const by={}; let tot=0n;
        for (const n of nodes) { const a=n.owner?.owner?.address; if(!a) continue; const b=BigInt(n.balance||0); by[a]=(by[a]||0n)+b; tot+=b; }
        const sorted=Object.entries(by).sort((a,b)=>b[1]>a[1]?1:-1);
        const top = sorted.slice(0,10).map(([addr,bal])=>({ addr, pct: tot>0n ? Number(bal*10000n/tot)/100 : 0 }));
        // get total count from gecko
        let total = sorted.length;
        try { for (const addr of [ct,pkg(ct)]) { const ri = await ftch(`${GECKO}/networks/${GECKO_NET}/tokens/${encodeURIComponent(addr)}/info`, {headers:{Accept:'application/json;version=20230302'}},4000); if(ri.ok){const di=await ri.json();const h=di.data?.attributes?.holders;if(h){total=parseInt(h)||total;break;}} } } catch {}
        return { total, top };
      }
    }
  } catch {}

  // Blockberry fallback
  try {
    const r = await ftch(`https://api.blockberry.one/sui/v1/coins/${encodeURIComponent(ct)}/holders?page=0&size=10&sortBy=AMOUNT&orderBy=DESC`, { headers:{Accept:'application/json','Origin':'https://suiscan.xyz'} }, 6000);
    if (r.ok) {
      const d=await r.json(), list=d.content||d.data||d.holders||[];
      if (list.length) return { total: d.totalElements||d.total||list.length, top: list.slice(0,10).map(h=>({ addr: h.address||h.owner||'', pct: parseFloat(h.percentage||h.pct||0) })) };
    }
  } catch {}

  return { total: 0, top: [] };
}

async function checkMint(ct) {
  try {
    const r = await sui.queryObjects({ query:{MatchType:`0x2::coin::TreasuryCap<${ct}>`}, options:{showOwner:true}, limit:1 });
    if (!r.data?.length) return false;
    return !!(r.data[0].data?.owner?.AddressOwner);
  } catch { return null; }
}

// Full token data — capped at 6s total, never blocks on slow calls
async function getTokenData(ct) {
  const timeout = new Promise(res => setTimeout(() => res(null), 6000));

  const [gTok, pls, meta, supply, holders, mint] = await Promise.all([
    Promise.race([geckoToken(ct), timeout]),
    Promise.race([geckoPools(ct), timeout]),
    getCoinMeta(ct).catch(()=>null),
    sui.getTotalSupply({coinType:ct}).catch(()=>null),
    Promise.race([getHolders(ct), timeout]),
    Promise.race([checkMint(ct), timeout]),
  ]);

  const pools   = pls || [];
  const best    = pools[0];
  const name    = meta?.name   || gTok?.name   || '?';
  const symbol  = meta?.symbol || gTok?.symbol || '?';
  const dec     = meta?.decimals || gTok?.decimals || 9;
  const rawSup  = supply ? Number(BigInt(supply.value)) : (gTok?.rawSupply||0);
  const supHuman= rawSup / Math.pow(10, dec);
  const priceU  = gTok?.priceUsd || best?.priceU || 0;
  const mcap    = gTok?.mcap || 0;
  const vol     = gTok?.vol24h || best?.vol24h || 0;
  const liq     = pools.reduce((t,p)=>t+(p.liq||0),0);
  const top10   = (holders?.top||[]).slice(0,10).reduce((t,h)=>t+h.pct,0);

  return {
    name, symbol, dec, supHuman,
    priceU, mcap, vol, liq,
    chg5m: best?.chg5m||0, chg1h: best?.chg1h||0, chg6h: best?.chg6h||0, chg24h: best?.chg24h||0,
    pools, best, dex: best?.dex||'Sui',
    age: best?.createdAt ? fmtAge(best.createdAt) : null,
    holders: holders?.total||0, topHolders: holders?.top||[], top10,
    mint, honeypot: null, // honeypot checked separately (slow)
  };
}

// Honeypot check — separate, fast
async function checkHoneypot(ct) {
  try { const k=await sdk7k(); const q=await k.getQuote({tokenIn:ct,tokenOut:SUI_TYPE,amountIn:'1000000'}); return !!(q&&BigInt(q.outAmount||0)>0n); } catch { return null; }
}

// ═══════════════════════════════════════════
// 12. BUY CARD (RaidenX style)
// ═══════════════════════════════════════════
function buyCard(d, ct) {
  const L = [];
  const issues = [d.mint===true, d.honeypot===false, d.top10>50].filter(Boolean).length;
  const t = (v,g) => v===null||v===undefined ? '⚪' : v===g ? '✅' : '⚠️';

  L.push(`*${d.symbol}/SUI*`);
  L.push(`\`${ct}\``);
  L.push(`\n🌐 Sui @ ${d.dex}${d.age?` | 📍 Age: ${d.age}`:''}`);
  if (d.mcap>0)   L.push(`📊 MCap: $${fmtN(d.mcap)}`);
  if (d.vol>0)    L.push(`💲 Vol: $${fmtN(d.vol)}`);
  if (d.liq>0)    L.push(`💧 Liq: $${fmtN(d.liq)}`);
  if (d.priceU>0) L.push(`💰 USD: ${fmtPrice(d.priceU)}`);
  const chgs=[];
  if (d.chg5m)  chgs.push(`5M: ${fmtChg(d.chg5m)}`);
  if (d.chg1h)  chgs.push(`1H: ${fmtChg(d.chg1h)}`);
  if (d.chg6h)  chgs.push(`6H: ${fmtChg(d.chg6h)}`);
  if (d.chg24h) chgs.push(`24H: ${fmtChg(d.chg24h)}`);
  if (chgs.length) L.push(`📉 ${chgs.join(' | ')}`);
  if (d.pools.length>1) L.push(`🔀 ${d.pools.length} pools — 7K routes best price`);
  L.push(`\n🛡 *Audit* (Issues: ${issues})`);
  L.push(`${t(d.mint,false)} Mint: ${d.mint===null?'?':d.mint?'Yes ⚠️':'No'} | ${t(d.honeypot,true)} Honeypot: ${d.honeypot===null?'?':d.honeypot?'No':'Yes ❌'}`);
  L.push(`${d.top10<30?'✅':'⚠️'} Top 10: ${d.top10>0?d.top10.toFixed(1)+'%':'?'}`);
  L.push(`\n⛽️ Est. Gas: ~0.010 SUI`);
  return L.join('\n');
}

// ═══════════════════════════════════════════
// 13. SCAN REPORT
// ═══════════════════════════════════════════
function scanReport(d, ct, st) {
  const icons={SAFE:'🟢',CAUTION:'🟡','HIGH RISK':'🔴','LIKELY RUG':'💀',UNKNOWN:'⚪'};
  const top3=d.topHolders.slice(0,3).reduce((t,h)=>t+h.pct,0);
  const liq=d.liq, noLiq=liq<500&&!st.bonding&&!d.pools.length;
  let risk='UNKNOWN';
  if (d.honeypot===false||noLiq) risk='LIKELY RUG';
  else if (top3>50&&liq<5000)   risk='HIGH RISK';
  else if (top3>50||liq<5000)   risk='CAUTION';
  else if (liq>0)                risk='SAFE';
  const L=[];
  L.push(`🔍 *Token Scan*\n`);
  L.push(`📛 *${d.name}* (${d.symbol})`);
  L.push(`📋 \`${trunc(ct)}\``);
  if (d.priceU>0) L.push(`\n💵 ${fmtPrice(d.priceU)}${d.chg24h?` ${d.chg24h>=0?'📈+':'📉'}${d.chg24h.toFixed(2)}%`:''}`);
  if (d.mcap>0)   L.push(`🏦 MCap: $${fmtN(d.mcap)}`);
  if (d.vol>0)    L.push(`💹 Vol 24h: $${fmtN(d.vol)}`);
  if (d.supHuman>0) L.push(`🏭 Supply: ${fmtSupply(d.supHuman)}`);
  L.push(`\n👥 Holders: ${d.holders>0?d.holders.toLocaleString():'N/A'}${top3>50?` ⚠️ Top 3: ${top3.toFixed(1)}%`:''}`);
  if (d.topHolders.length) { L.push('*Top Holders:*'); d.topHolders.slice(0,5).forEach((h,i)=>L.push(`  ${i+1}. \`${trunc(h.addr)}\` — ${h.pct.toFixed(2)}%`)); }
  if (st.state==='bonding_curve') {
    L.push(`\n📊 *Bonding Curve — ${st.lpName}*`);
    if (st.suiRaised>0&&st.threshold) { const p=Math.min(100,(st.suiRaised/st.threshold)*100); L.push(`[${'█'.repeat(Math.floor(p/10))}${'░'.repeat(10-Math.floor(p/10))}] ${p.toFixed(1)}%`); L.push(`${st.suiRaised} / ${st.threshold} SUI`); }
    L.push(`Graduates to: ${st.destDex}`);
  } else if (d.pools.length) {
    L.push(`\n💧 *Pools (${d.pools.length}):*`);
    d.pools.slice(0,4).forEach((p,i)=>L.push(`  ${i===0?'⭐':'•'} ${p.dex}: $${fmtN(p.liq)}${p.vol24h>0?` vol $${fmtN(p.vol24h)}`:''}`));
    L.push(`Total liq: $${fmtN(d.liq)}`);
    L.push(`💡 7K aggregator routes to best pool automatically`);
  } else { L.push('\n❌ No pools found'); }
  L.push(`\n🍯 Honeypot: ${d.honeypot===true?'✅ Can sell':d.honeypot===false?'❌ CANNOT SELL':' ⚪ Unknown'}`);
  L.push(`\n${icons[risk]||'⚪'} *Risk: ${risk}*`);
  return L.join('\n');
}

// ═══════════════════════════════════════════
// 14. POSITIONS & PnL
// ═══════════════════════════════════════════
function addPos(chatId, p) {
  const u=getU(chatId); if(!u) return;
  u.positions=u.positions||[];
  u.positions.push({ id: randomBytes(4).toString('hex'), ct:p.ct, sym:p.sym, entry:p.entry||0, tokens:p.tokens||0, dec:p.dec||9, spent:p.spent, source:p.source||'dex', lp:p.lp||null, tp:p.tp||null, sl:p.sl||null, at:Date.now() });
  saveDB();
}

async function getPnl(pos) {
  if (pos.source==='bonding'||!pos.tokens||pos.tokens<=0) return null;
  try {
    const k=await sdk7k(); const dec=pos.dec||9;
    const amt=BigInt(Math.floor(pos.tokens*Math.pow(10,dec)));
    const q=await k.getQuote({tokenIn:pos.ct,tokenOut:SUI_TYPE,amountIn:amt.toString()});
    if(!q?.outAmount) return null;
    const cur=Number(q.outAmount)/1e9;
    return { cur, pnl:cur-parseFloat(pos.spent), pct:(cur-parseFloat(pos.spent))/parseFloat(pos.spent)*100 };
  } catch { return null; }
}

function pnlBar(pct) { const f=Math.min(10,Math.round(Math.abs(Math.max(-100,Math.min(200,pct)))/20)); return (pct>=0?'🟩':'🟥').repeat(f)+'⬛'.repeat(10-f); }

function pnlCaption(pos, p) {
  const sign=p.pnl>=0?'+':'';
  return `${p.pnl>=0?'🚀':'📉'} *${pos.sym}*\n\nEntry:    ${(pos.entry||0).toFixed(8)} SUI\nInvested: ${pos.spent} SUI\nValue:    ${p.cur.toFixed(4)} SUI\n\nP&L: *${sign}${p.pnl.toFixed(4)} SUI (${sign}${p.pct.toFixed(2)}%)*\n${pnlBar(p.pct)}`;
}

function pnlChart(sym, pct, spent, cur) {
  const profit=pct>=0, color=profit?'#00e676':'#ff1744', bg=profit?'#0d1f14':'#1f0d0d';
  const data=[]; for(let i=0;i<=24;i++){const t=i/24,n=(Math.sin(i*1.3)*0.15+Math.cos(i*2.7)*0.1)*Math.abs(pct)/200;data.push(+(1+(pct/100)*t+n*Math.sqrt(t)).toFixed(4));}
  const cfg={type:'line',data:{labels:data.map((_,i)=>i),datasets:[{data,borderColor:color,backgroundColor:`${color}20`,fill:true,tension:0.5,borderWidth:3,pointRadius:0}]},options:{animation:false,plugins:{legend:{display:false}},scales:{x:{display:false},y:{display:false,min:Math.min(...data)*0.97,max:Math.max(...data)*1.03}}}};
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(cfg))}&w=600&h=250&bkg=${encodeURIComponent(bg)}&f=png`;
}

// ═══════════════════════════════════════════
// 15. BACKGROUND ENGINES
// ═══════════════════════════════════════════
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
          if (pos.tp&&p.pct>=pos.tp)      why=`✅ Take Profit! +${p.pct.toFixed(2)}%`;
          else if (pos.sl&&p.pct<=-pos.sl) why=`🛑 Stop Loss! ${p.pct.toFixed(2)}%`;
          if (!why) continue;
          try {
            const res=await executeSell(uid,pos.ct,100);
            const cap=`${why}\n\n${pnlCaption(pos,p)}\n\n🔗 [View TX](${SUISCAN}${res.digest})`;
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
          const fire=w.mode==='grad'?st.state==='dex':(st.state==='dex'||st.state==='bonding_curve');
          if (!fire) continue;
          w.triggered=true; saveDB();
          bot.sendMessage(uid,`⚡ *Snipe triggered!*\n\nToken: \`${trunc(w.ct)}\`\n${st.state==='bonding_curve'?`📊 ${st.lpName}`:'✅ DEX pool found'}\n\nBuying ${w.sui} SUI...`,{parse_mode:'Markdown'});
          try { const res=await executeBuy(uid,w.ct,w.sui); bot.sendMessage(uid,`✅ *Sniped!* ${res.sym}\nSpent: ${w.sui} SUI\n🔗 [TX](${SUISCAN}${res.digest})`,{parse_mode:'Markdown'}); }
          catch(e){bot.sendMessage(uid,`❌ Snipe failed: ${e.message?.slice(0,120)}`);}
        } catch {}
      }
    }
  }
}

const lastSeen={};
async function copyEngine() {
  while (true) {
    await sleep(5_000);
    const wm=new Map();
    for (const [uid,u] of Object.entries(DB)) { if(!u.copyTraders?.length||isLocked(u)) continue; for(const ct of u.copyTraders){if(!wm.has(ct.wallet))wm.set(ct.wallet,[]); wm.get(ct.wallet).push({u,cfg:ct,uid});} }
    for (const [wallet,watchers] of wm) {
      try {
        const txs=await sui.queryTransactionBlocks({filter:{FromAddress:wallet},limit:5,order:'descending',options:{showEffects:true,showEvents:true}});
        const prev=lastSeen[wallet];
        const news=prev?txs.data.filter(t=>t.digest!==prev):txs.data.slice(0,1);
        if (txs.data.length) lastSeen[wallet]=txs.data[0].digest;
        for (const tx of news.reverse()) {
          const swapEv=(tx.events||[]).find(e=>e.type?.toLowerCase().includes('swap')||e.type?.toLowerCase().includes('trade'));
          if (!swapEv) continue;
          const pj=swapEv.parsedJson||{}, bought=pj.coin_type_out||pj.token_out||pj.coinTypeOut||null;
          if (!bought||bought===SUI_TYPE) continue;
          for (const {u,cfg,uid} of watchers) {
            try {
              if (cfg.blacklist?.includes(bought)) continue;
              if ((await getCoins(u.walletAddress,bought)).length) continue;
              if ((u.positions||[]).length>=(cfg.maxPos||5)) continue;
              const amt=cfg.amount||u.settings.copyAmount;
              bot.sendMessage(uid,`🔁 *Copy* \`${trunc(wallet)}\`\nBuying ${trunc(bought)} — ${amt} SUI`,{parse_mode:'Markdown'});
              const res=await executeBuy(uid,bought,amt);
              bot.sendMessage(uid,`✅ Copied! ${res.sym} 🔗 [TX](${SUISCAN}${res.digest})`,{parse_mode:'Markdown'});
            } catch(e){bot.sendMessage(uid,`❌ Copy failed: ${e.message?.slice(0,100)}`);}
          }
        }
      } catch {}
    }
  }
}

// ═══════════════════════════════════════════
// 16. SYMBOL RESOLVER
// ═══════════════════════════════════════════
async function resolveTicker(ticker) {
  const sym=ticker.replace(/^\$/,'').toUpperCase();
  try { const r=await ftch(`https://api-sui.cetus.zone/v2/sui/tokens?symbol=${sym}`,{},5000); if(r.ok){const d=await r.json();if(d.data?.[0]?.coin_type)return d.data[0].coin_type;} } catch {}
  return null;
}

// ═══════════════════════════════════════════
// 17. BOT & KEYBOARD
// ═══════════════════════════════════════════
const MAIN_KB = {
  keyboard: [[{text:'💰 Buy'},{text:'💸 Sell'}],[{text:'📊 Positions'},{text:'💼 Balance'}],[{text:'🔍 Scan'},{text:'⚡ Snipe'}],[{text:'🔁 Copy Trade'},{text:'🔗 Referral'}],[{text:'⚙️ Settings'},{text:'❓ Help'}]],
  resize_keyboard: true, persistent: true,
};

const bot = new TelegramBot(TG_TOKEN, { polling: true });

async function guard(chatId, fn) {
  const u=getU(chatId);
  if (!u?.walletAddress) { await bot.sendMessage(chatId,'❌ No wallet. Use /start first.'); return; }
  if (u.cooldownUntil&&Date.now()<u.cooldownUntil) { await bot.sendMessage(chatId,`🔒 Cooldown — wait ${Math.ceil((u.cooldownUntil-Date.now())/1000)}s.`); return; }
  if (isLocked(u)) { updU(chatId,{state:'pin_unlock'}); await bot.sendMessage(chatId,'🔒 Enter your 4-digit PIN:'); return; }
  updU(chatId,{lastActivity:Date.now()});
  try { await fn(u); } catch(e) { console.error(`[${chatId}]`,e.message); await bot.sendMessage(chatId,`❌ ${e.message?.slice(0,200)||'Error'}`); }
}

// ═══════════════════════════════════════════
// 18. STANDALONE COMMAND HANDLERS
// (called by keyboard buttons AND /commands)
// ═══════════════════════════════════════════

async function doBalance(chatId) {
  await guard(chatId, async (u) => {
    const m=await bot.sendMessage(chatId,'💰 Fetching balances...');
    try {
      const bals=await getAllBals(u.walletAddress);
      const sui=bals.find(b=>b.coinType===SUI_TYPE);
      const L=[`💼 *Wallet*\n\`${trunc(u.walletAddress)}\`\n`];
      L.push(`🔵 SUI: ${sui?fmtSui(BigInt(sui.totalBalance)):'0.0000'}`);
      const others=bals.filter(b=>b.coinType!==SUI_TYPE&&Number(b.totalBalance)>0);
      for (const b of others.slice(0,15)) { const m2=await getCoinMeta(b.coinType); L.push(`• ${m2?.symbol||trunc(b.coinType)}: ${(Number(b.totalBalance)/Math.pow(10,m2?.decimals||9)).toFixed(4)}`); }
      if(!others.length) L.push('\n_No other tokens_');
      await bot.editMessageText(L.join('\n'),{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});
    } catch(e){await bot.editMessageText(`❌ ${e.message?.slice(0,100)}`,{chat_id:chatId,message_id:m.message_id});}
  });
}

async function doPositions(chatId) {
  await guard(chatId, async (u) => {
    if (!u.positions?.length) { await bot.sendMessage(chatId,'📊 No open positions.\n\nBuy a token to start tracking!'); return; }
    const m=await bot.sendMessage(chatId,`📊 Loading ${u.positions.length} position(s)...`);
    await bot.deleteMessage(chatId,m.message_id).catch(()=>{});
    for (const pos of u.positions) {
      try {
        const p=await getPnl(pos);
        if (p) {
          const cap=pnlCaption(pos,p)+`\n\nTP: ${pos.tp?pos.tp+'%':'None'} | SL: ${pos.sl?pos.sl+'%':'None'}${pos.source==='bonding'?`\n📊 ${pos.lp}`:''}`;
          try{await bot.sendPhoto(chatId,pnlChart(pos.sym,p.pct,pos.spent,p.cur),{caption:cap,parse_mode:'Markdown'});}
          catch{await bot.sendMessage(chatId,cap,{parse_mode:'Markdown'});}
        } else {
          await bot.sendMessage(chatId,`${pos.source==='bonding'?'📊':'⚪'} *${pos.sym}*\nSpent: ${pos.spent} SUI${pos.source==='bonding'?`\n📊 ${pos.lp}`:''}`,{parse_mode:'Markdown'});
        }
      } catch { await bot.sendMessage(chatId,`⚪ *${pos.sym}* — ${pos.spent} SUI`,{parse_mode:'Markdown'}); }
    }
  });
}

async function doSnipe(chatId, tokenArg) {
  await guard(chatId, async (u) => {
    if (!tokenArg) { await bot.sendMessage(chatId,`⚡ *Sniper*\n\nUsage: /snipe [token address]\n\nBot buys instantly when a DEX pool or bonding curve is created.\n\nExample: /snipe 0x1234...`,{parse_mode:'Markdown'}); return; }
    updU(chatId,{state:'snipe_amount',pd:{sniToken:tokenArg.trim()}});
    await bot.sendMessage(chatId,`Token: \`${trunc(tokenArg)}\`\n\nHow much SUI to buy?\n_Example: 0.5_`,{parse_mode:'Markdown'});
  });
}

async function doCopytrader(chatId, arg) {
  await guard(chatId, async (u) => {
    const a=(arg||'').trim().toLowerCase();
    if (a==='stop') { updU(chatId,{copyTraders:[]}); await bot.sendMessage(chatId,'✅ All copy traders stopped.'); return; }
    if (!a||a==='list') {
      if (!u.copyTraders?.length) { await bot.sendMessage(chatId,`🔁 *Copy Trader*\n\nNo wallets tracked.\n\nUsage: /copytrader [wallet address]\nStop: /copytrader stop`,{parse_mode:'Markdown'}); return; }
      await bot.sendMessage(chatId,`🔁 *Copy Traders (${u.copyTraders.length}/3)*\n\n${u.copyTraders.map((ct,i)=>`${i+1}. \`${trunc(ct.wallet)}\` — ${ct.amount} SUI/trade`).join('\n')}\n\nStop: /copytrader stop`,{parse_mode:'Markdown'}); return;
    }
    if (a.startsWith('0x')) {
      u.copyTraders=u.copyTraders||[];
      if (u.copyTraders.length>=3) { await bot.sendMessage(chatId,'❌ Max 3 wallets. /copytrader stop first.'); return; }
      u.copyTraders.push({wallet:a,amount:u.settings.copyAmount,maxPos:5,blacklist:[]});
      updU(chatId,{copyTraders:u.copyTraders});
      await bot.sendMessage(chatId,`✅ Tracking \`${trunc(a)}\`\n${u.settings.copyAmount} SUI per trade`,{parse_mode:'Markdown'}); return;
    }
    updU(chatId,{state:'copy_wallet'}); await bot.sendMessage(chatId,'Enter the wallet address to copy:');
  });
}

async function doReferral(chatId) {
  const u=getU(chatId)||createU(chatId);
  const link=`https://t.me/AGENTTRADINBOT?start=${u.referralCode}`;
  const active=Object.values(DB).filter(x=>x.referredBy===u.walletAddress&&Date.now()-x.lastActivity<30*24*3600*1000).length;
  await bot.sendMessage(chatId,`🔗 *Referral Dashboard*\n\nCode: \`${u.referralCode}\`\nLink: \`${link}\`\n\n👥 Total: ${u.referralCount||0} | Active 30d: ${active}\n💰 Earned: ${(u.referralEarned||0).toFixed(4)} SUI\n\n*Earn 25% of every fee your referrals pay — forever, paid on-chain automatically.*`,{parse_mode:'Markdown'});
}

async function doSettings(chatId) {
  await guard(chatId, async (u) => {
    const s=u.settings, amts=(s.buyAmounts||DEFAULT_AMTS).join(', ');
    await bot.sendMessage(chatId,`⚙️ *Settings*\n\nSlippage: *${s.slippage}%*\nConfirm ≥: *${s.confirmThreshold} SUI*\nCopy amount: *${s.copyAmount} SUI*\nQuick-buy: *${amts} SUI*\nTP: ${s.tpDefault||'None'} | SL: ${s.slDefault||'None'}`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[
      [{text:'— Slippage —',callback_data:'noop'}],
      [{text:'0.5%',callback_data:'slip:0.5'},{text:'1%',callback_data:'slip:1'},{text:'2%',callback_data:'slip:2'},{text:'5%',callback_data:'slip:5'}],
      [{text:'— Confirm Threshold —',callback_data:'noop'}],
      [{text:'0.1',callback_data:'ct:0.1'},{text:'0.5',callback_data:'ct:0.5'},{text:'1',callback_data:'ct:1'},{text:'5',callback_data:'ct:5'}],
      [{text:'💰 Edit Quick-Buy Amounts',callback_data:'edit_amts'}],
    ]}});
  });
}

async function doHelp(chatId) {
  await bot.sendMessage(chatId,`🤖 *AGENT TRADING BOT*\n\n*Trading*\n/buy [ca] [sui] — Buy any token\n/sell [ca] [%] — Sell with percentage\n\n*Advanced*\n/snipe [ca] — Auto-buy on pool creation\n/copytrader [wallet] — Mirror wallet buys\n\n*Info*\n/scan [ca] — Token safety scan\n/balance — Wallet balances\n/positions — P&L charts per position\n\n*Account*\n/referral — Referral earnings\n/settings — Slippage, buy amounts\n\n*DEXes (7K Aggregator)*\nCetus • Turbos • Aftermath • Bluefin • Kriya • FlowX • DeepBook\n\n*Launchpads*\nMovePump • hop.fun • MoonBags • Turbos.fun • blast.fun\n\n*Fee:* 1% per trade | Referrers earn 25% forever`,{parse_mode:'Markdown'});
}

// ═══════════════════════════════════════════
// 19. BUY / SELL FLOW HELPERS
// ═══════════════════════════════════════════
async function doSellMenu(chatId, u) {
  const pos=(u.positions||[]).filter(p=>p.ct);
  if (pos.length) {
    const btns=pos.slice(0,6).map((p,i)=>[{text:`${p.sym} — ${p.spent} SUI`,callback_data:`st:${i}`}]);
    btns.push([{text:'📝 Enter CA manually',callback_data:'sfs_manual'}]);
    await bot.sendMessage(chatId,`💸 *Select position to sell:*`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:btns}});
  } else {
    await bot.sendMessage(chatId,`Send the token contract address to sell:\n\n_Example: 0x1234..._`,{parse_mode:'Markdown'});
    updU(chatId,{state:'sell_ca'});
  }
}

async function startBuy(chatId, ct) {
  const u=getU(chatId); if(!u) return;
  const loadMsg = await bot.sendMessage(chatId, '🔍 Fetching token info...');
  try {
    const [d, hp] = await Promise.all([
      getTokenData(ct),
      checkHoneypot(ct),
    ]);
    d.honeypot = hp;
    updU(chatId, { pd: { ct, sym: d.symbol } });
    const amounts = u.settings.buyAmounts || DEFAULT_AMTS;
    await bot.editMessageText(
      buyCard(d, ct) + '\n\n*Select amount to buy:*',
      { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          amounts.map((a,i)=>({text:`${a} SUI`,callback_data:`ba:${i}`})),
          [{text:'✏️ Custom',callback_data:'ba:c'}],
          [{text:'⚙️ Edit Defaults',callback_data:'edit_amts'},{text:'❌ Cancel',callback_data:'ca'}],
        ]}
      }
    );
  } catch(e) {
    // Even on error — still show buy buttons
    const meta=await getCoinMeta(ct).catch(()=>null);
    const sym=meta?.symbol||trunc(ct);
    updU(chatId,{pd:{ct,sym}});
    const amounts=u.settings.buyAmounts||DEFAULT_AMTS;
    await bot.editMessageText(
      `💰 *Buy ${sym}*\n\`${ct}\`\n\n⚠️ Token data unavailable — 7K aggregator will route to best price\n\n*Select amount:*`,
      { chat_id:chatId, message_id:loadMsg.message_id, parse_mode:'Markdown',
        reply_markup:{inline_keyboard:[amounts.map((a,i)=>({text:`${a} SUI`,callback_data:`ba:${i}`})),[{text:'✏️ Custom',callback_data:'ba:c'},{text:'❌ Cancel',callback_data:'ca'}]]}
      }
    );
  }
}

async function startSell(chatId, ct, sym) {
  updU(chatId,{pd:{ct,sym}});
  await showSellPct(chatId,ct,sym,null);
}

async function showBuyConfirm(chatId, ct, amtSui, editId) {
  const u=getU(chatId); if(!u) return;
  const meta=await getCoinMeta(ct)||{}; const sym=meta.symbol||trunc(ct);
  const amtMist=BigInt(Math.floor(parseFloat(amtSui)*Number(MIST)));
  const {fee}=calcFee(amtMist,u);
  updU(chatId,{pd:{...u.pd,ct,amtSui}});
  let est='?';
  try{const k=await sdk7k();const q=await k.getQuote({tokenIn:SUI_TYPE,tokenOut:ct,amountIn:(amtMist-fee).toString()});if(q?.outAmount)est=(Number(q.outAmount)/Math.pow(10,meta.decimals||9)).toFixed(4);}catch{}
  const text=`💰 *Confirm Buy*\n\nToken: *${sym}*\nAmount: ${amtSui} SUI\nFee (1%): ${fmtSui(fee)} SUI\nYou trade: ${fmtSui(amtMist-fee)} SUI\n${est!='?'?`Est. receive: ~${est} ${sym}\n`:''}Slippage: ${u.settings.slippage}%`;
  const kb={inline_keyboard:[[{text:'✅ Confirm Buy',callback_data:'bc'},{text:'❌ Cancel',callback_data:'ca'}]]};
  if (editId) await bot.editMessageText(text,{chat_id:chatId,message_id:editId,parse_mode:'Markdown',reply_markup:kb}).catch(async()=>bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb}));
  else await bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb});
}

async function showSellPct(chatId, ct, sym, editId) {
  const u=getU(chatId); if(!u) return;
  const coins=await getCoins(u.walletAddress,ct);
  if (!coins.length) { await bot.sendMessage(chatId,`❌ No ${sym} balance.`); return; }
  const meta=await getCoinMeta(ct)||{};
  const total=coins.reduce((s,c)=>s+BigInt(c.balance),0n);
  const bal=(Number(total)/Math.pow(10,meta.decimals||9)).toFixed(4);
  const text=`💸 *Sell ${sym}*\n\nBalance: ${bal} ${sym}\n\n*Choose amount:*`;
  const kb={inline_keyboard:[[{text:'25%',callback_data:'sp:25'},{text:'50%',callback_data:'sp:50'},{text:'75%',callback_data:'sp:75'},{text:'100%',callback_data:'sp:100'}],[{text:'✏️ Custom %',callback_data:'sp:c'},{text:'❌ Cancel',callback_data:'ca'}]]};
  if (editId) await bot.editMessageText(text,{chat_id:chatId,message_id:editId,parse_mode:'Markdown',reply_markup:kb}).catch(async()=>bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb}));
  else await bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb});
}

async function showSellConfirm(chatId, ct, pct, editId) {
  const u=getU(chatId); if(!u) return;
  const meta=await getCoinMeta(ct)||{}; const sym=meta.symbol||trunc(ct);
  const coins=await getCoins(u.walletAddress,ct);
  const total=coins.reduce((s,c)=>s+BigInt(c.balance),0n);
  const sellAmt=(total*BigInt(pct))/100n;
  const dispAmt=(Number(sellAmt)/Math.pow(10,meta.decimals||9)).toFixed(4);
  let est='?';
  try{const k=await sdk7k();const q=await k.getQuote({tokenIn:ct,tokenOut:SUI_TYPE,amountIn:sellAmt.toString()});if(q?.outAmount)est=(Number(q.outAmount)/1e9).toFixed(4);}catch{}
  const text=`💸 *Confirm Sell*\n\nToken: *${sym}*\nSelling: ${pct}% (${dispAmt} ${sym})\n${est!='?'?`Est. receive: ~${est} SUI\n`:''}Slippage: ${u.settings.slippage}%`;
  const kb={inline_keyboard:[[{text:'✅ Confirm Sell',callback_data:'sc'},{text:'❌ Cancel',callback_data:'ca'}]]};
  if (editId) await bot.editMessageText(text,{chat_id:chatId,message_id:editId,parse_mode:'Markdown',reply_markup:kb}).catch(async()=>bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb}));
  else await bot.sendMessage(chatId,text,{parse_mode:'Markdown',reply_markup:kb});
}

// ═══════════════════════════════════════════
// 20. /start
// ═══════════════════════════════════════════
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId=msg.chat.id;
  const param=(match[1]||'').trim().replace(/[<>&"'`]/g,'').slice(0,20);
  let u=getU(chatId);
  if (!u) {
    u=createU(chatId);
    if (param.startsWith('AGT-')) {
      const ref=Object.values(DB).find(x=>x.referralCode===param&&x.chatId!==String(chatId));
      if (ref?.walletAddress) { updU(chatId,{referredBy:ref.walletAddress}); updU(ref.chatId,{referralCount:(ref.referralCount||0)+1}); bot.sendMessage(ref.chatId,'🎉 New user joined via your referral! You earn 25% of their fees forever.'); }
    }
  }
  if (u.walletAddress) {
    await bot.sendMessage(chatId,`👋 Welcome back!\n\nWallet: \`${trunc(u.walletAddress)}\``,{parse_mode:'Markdown',reply_markup:MAIN_KB});
  } else {
    await bot.sendMessage(chatId,`👋 Welcome to *AGENT TRADING BOT*\n\nThe fastest trading bot on Sui.\n\nConnect your wallet:`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'🔑 Import Wallet',callback_data:'import_wallet'}],[{text:'✨ Create New Wallet',callback_data:'gen_wallet'}]]}});
  }
});

// ═══════════════════════════════════════════
// 21. CALLBACKS — all short codes, no coinType in data
// ═══════════════════════════════════════════
bot.on('callback_query', async (q) => {
  const chatId=q.message.chat.id, msgId=q.message.message_id, data=q.data;
  await bot.answerCallbackQuery(q.id).catch(()=>{});
  try {
    if (data==='noop') return;

    if (data==='import_wallet') { updU(chatId,{state:'import_key'}); await bot.sendMessage(chatId,`🔑 Send your private key (starts with \`suiprivkey1...\`)\n\n⚠️ It is deleted immediately after import.`,{parse_mode:'Markdown'}); return; }

    if (data==='gen_wallet') {
      const kp=new Ed25519Keypair(), addr=kp.getPublicKey().toSuiAddress(), sk=kp.getSecretKey();
      updU(chatId,{encryptedKey:encKey(sk),walletAddress:addr,state:'set_pin'});
      await bot.sendMessage(chatId,`✅ *Wallet Created!*\n\nAddress:\n\`${addr}\`\n\n🔑 *Private Key — SAVE THIS NOW:*\n\`${sk}\`\n\n⚠️ Write this down. If lost, funds are gone forever.\n\nNow set a 4-digit PIN:`,{parse_mode:'Markdown'}); return;
    }

    // BUY: amount button
    if (data.startsWith('ba:')) {
      const u=getU(chatId); if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      const key=data.split(':')[1];
      if (key==='c'){updU(chatId,{state:'buy_custom_amt'});await bot.sendMessage(chatId,'💬 Enter SUI amount:\n\n_Example: 2.5_',{parse_mode:'Markdown'});return;}
      const amt=(u.settings.buyAmounts||DEFAULT_AMTS)[parseInt(key)];
      if(!amt){await bot.sendMessage(chatId,'❌ Invalid.');return;}
      await showBuyConfirm(chatId,u.pd.ct,amt,msgId); return;
    }

    // BUY: confirm
    if (data==='bc') {
      const u=getU(chatId); if(!u?.pd?.ct||!u?.pd?.amtSui){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      await bot.editMessageText('⚡ Executing buy...',{chat_id:chatId,message_id:msgId});
      try {
        const res=await executeBuy(chatId,u.pd.ct,u.pd.amtSui);
        await bot.editMessageText(`✅ *Buy Executed!*\n\nToken: *${res.sym}*\nSpent: ${u.pd.amtSui} SUI\nFee: ${res.feeSui} SUI\n${res.out!='?'?`Received: ~${res.out} ${res.sym}\n`:''}Route: ${res.route}\n${res.bonding?`📊 On ${res.lpName}\n`:''}\n🔗 [View TX](${SUISCAN}${res.digest})`,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown'});
      } catch(e){await bot.editMessageText(`❌ Buy failed: ${e.message?.slice(0,180)}`,{chat_id:chatId,message_id:msgId});}
      updU(chatId,{pd:{}}); return;
    }

    // SELL: pick from positions
    if (data.startsWith('st:')) {
      const u=getU(chatId); const pos=u?.positions?.[parseInt(data.split(':')[1])];
      if(!pos){await bot.sendMessage(chatId,'❌ Position not found.');return;}
      updU(chatId,{pd:{ct:pos.ct,sym:pos.sym}});
      await showSellPct(chatId,pos.ct,pos.sym,null); return;
    }

    if (data==='sfs_manual'){updU(chatId,{state:'sell_ca'});await bot.sendMessage(chatId,'Send the token CA:');return;}

    // SELL: percent button
    if (data.startsWith('sp:')) {
      const u=getU(chatId); if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      const key=data.split(':')[1];
      if(key==='c'){updU(chatId,{state:'sell_custom_pct'});await bot.sendMessage(chatId,'💬 Enter % to sell (1-100):\n\n_Example: 33_',{parse_mode:'Markdown'});return;}
      const pct=parseInt(key);
      updU(chatId,{pd:{...getU(chatId).pd,pct}});
      await showSellConfirm(chatId,getU(chatId).pd.ct,pct,msgId); return;
    }

    // SELL: confirm
    if (data==='sc') {
      const u=getU(chatId); if(!u?.pd?.ct||!u?.pd?.pct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      await bot.editMessageText('⚡ Executing sell...',{chat_id:chatId,message_id:msgId});
      try {
        const res=await executeSell(chatId,u.pd.ct,u.pd.pct);
        await bot.editMessageText(`✅ *Sell Executed!*\n\nToken: ${res.sym}\nSold: ${res.pct}%\nEst. SUI: ${res.sui}\nFee: ${res.feeSui} SUI\nRoute: ${res.route}\n\n🔗 [View TX](${SUISCAN}${res.digest})`,{chat_id:chatId,message_id:msgId,parse_mode:'Markdown'});
      } catch(e){await bot.editMessageText(`❌ Sell failed: ${e.message?.slice(0,180)}`,{chat_id:chatId,message_id:msgId});}
      updU(chatId,{pd:{}}); return;
    }

    if (data==='ca'){updU(chatId,{state:null,pd:{}});await bot.editMessageText('❌ Cancelled.',{chat_id:chatId,message_id:msgId}).catch(()=>{});return;}

    // Settings
    if(data.startsWith('slip:')){const u=getU(chatId);if(u){u.settings.slippage=parseFloat(data.split(':')[1]);saveDB();}await bot.sendMessage(chatId,`✅ Slippage → ${data.split(':')[1]}%`);return;}
    if(data.startsWith('ct:')){const u=getU(chatId);if(u){u.settings.confirmThreshold=parseFloat(data.split(':')[1]);saveDB();}await bot.sendMessage(chatId,`✅ Confirm threshold → ${data.split(':')[1]} SUI`);return;}
    if(data==='edit_amts'){updU(chatId,{state:'edit_amts'});await bot.sendMessage(chatId,'⚙️ Enter 4 amounts separated by spaces:\n\n_Example: 0.5 1 3 5_',{parse_mode:'Markdown'});return;}

    // CA paste picker
    if(data==='bfs'){const u=getU(chatId);if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}await guard(chatId,async()=>startBuy(chatId,u.pd.ct));return;}
    if(data==='sfs'){const u=getU(chatId);if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}const m=await getCoinMeta(u.pd.ct)||{};await guard(chatId,async()=>startSell(chatId,u.pd.ct,m.symbol||trunc(u.pd.ct)));return;}
    if(data==='sct'){
      const u=getU(chatId);if(!u?.pd?.ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
      const m=await bot.sendMessage(chatId,'🔍 Scanning...');
      try{const[d,st,hp]=await Promise.all([getTokenData(u.pd.ct),detectState(u.pd.ct),checkHoneypot(u.pd.ct)]);d.honeypot=hp;await bot.editMessageText(scanReport(d,u.pd.ct,st),{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});}
      catch(e){await bot.editMessageText(`❌ ${e.message?.slice(0,100)}`,{chat_id:chatId,message_id:m.message_id});}
      return;
    }
  } catch(e){console.error('CB error:',e.message);await bot.sendMessage(chatId,`❌ ${e.message?.slice(0,120)}`);}
});

// ═══════════════════════════════════════════
// 22. MESSAGE HANDLER — state machine + keyboard
// Direct function calls — NO bot.emit
// ═══════════════════════════════════════════
bot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId=msg.chat.id;
  // Sanitize but preserve alphanumeric, spaces, common punctuation — do NOT strip Sui addresses or private keys
  const raw=msg.text.trim();
  if (!raw||raw.startsWith('/')) return; // commands handled by onText

  const u=getU(chatId)||createU(chatId);
  const state=u.state;

  // ── Keyboard buttons — direct function calls
  const KB = {
    '💰 Buy':        ()=>guard(chatId,async()=>{await bot.sendMessage(chatId,'Send the token CA or $TICKER:\n\n_Example: 0x1234... or $AGENT_',{parse_mode:'Markdown'});updU(chatId,{state:'buy_ca'});}),
    '💸 Sell':       ()=>guard(chatId,async(u)=>doSellMenu(chatId,u)),
    '📊 Positions':  ()=>doPositions(chatId),
    '💼 Balance':    ()=>doBalance(chatId),
    '🔍 Scan':       ()=>{bot.sendMessage(chatId,'Send the token CA to scan:\n\n_Example: 0x1234..._',{parse_mode:'Markdown'});updU(chatId,{state:'scan_ca'});},
    '⚡ Snipe':      ()=>doSnipe(chatId,null),
    '🔁 Copy Trade': ()=>doCopytrader(chatId,null),
    '🔗 Referral':   ()=>doReferral(chatId),
    '⚙️ Settings':   ()=>doSettings(chatId),
    '❓ Help':        ()=>doHelp(chatId),
  };
  if (KB[raw]) { await KB[raw](); return; }

  // ── State machine
  const text = raw.replace(/[<>&"]/g,'').slice(0,1000); // safe sanitize preserving 0x addresses and private keys

  if (state==='import_key') {
    updU(chatId,{state:null});
    try { await bot.deleteMessage(chatId,msg.message_id); } catch {}
    try {
      const dec=decodeSuiPrivateKey(text);
      const kp=Ed25519Keypair.fromSecretKey(dec.secretKey);
      const addr=kp.getPublicKey().toSuiAddress();
      updU(chatId,{encryptedKey:encKey(text),walletAddress:addr,state:'set_pin'});
      await bot.sendMessage(chatId,`✅ Wallet imported!\n\nAddress: \`${addr}\`\n🔐 Key encrypted and stored securely.\n\nSet a 4-digit PIN:`,{parse_mode:'Markdown'});
    } catch { await bot.sendMessage(chatId,'❌ Invalid private key. Use /start to try again.'); }
    return;
  }

  if (state==='set_pin') {
    if (!/^\d{4}$/.test(text)) { await bot.sendMessage(chatId,'❌ Must be exactly 4 digits:'); return; }
    updU(chatId,{pinHash:hashPin(text),state:null});
    await bot.sendMessage(chatId,`✅ PIN set! Bot auto-locks after 30min of inactivity.\n\nFund your wallet with SUI and you're ready to trade!`,{reply_markup:MAIN_KB});
    if (BACKEND_URL) ftch(`${BACKEND_URL}/api/bot-user`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatId,walletAddress:getU(chatId).walletAddress,referralCode:getU(chatId).referralCode})}).catch(()=>{});
    return;
  }

  if (state==='pin_unlock') {
    if (!/^\d{4}$/.test(text)) { await bot.sendMessage(chatId,'❌ Enter 4-digit PIN:'); return; }
    if (hashPin(text)===u.pinHash) {
      unlockU(chatId); updU(chatId,{state:null,failAttempts:0,cooldownUntil:0});
      await bot.sendMessage(chatId,'🔓 Unlocked!',{reply_markup:MAIN_KB});
    } else {
      const fails=(u.failAttempts||0)+1;
      if (fails>=MAX_FAILS) { updU(chatId,{failAttempts:0,cooldownUntil:Date.now()+COOLDOWN_MS}); await bot.sendMessage(chatId,'❌ Too many attempts. Locked 5 minutes.'); }
      else { updU(chatId,{failAttempts:fails}); await bot.sendMessage(chatId,`❌ Wrong PIN. ${MAX_FAILS-fails} attempts left.`); }
    }
    return;
  }

  if (state==='buy_ca') {
    updU(chatId,{state:null});
    const ct=text.startsWith('0x')?text:(await resolveTicker(text));
    if (!ct) { await bot.sendMessage(chatId,'❌ Token not found. Use the full contract address.'); return; }
    await guard(chatId,async()=>startBuy(chatId,ct)); return;
  }

  if (state==='sell_ca') {
    updU(chatId,{state:null});
    const ct=text.startsWith('0x')?text:(await resolveTicker(text));
    if (!ct) { await bot.sendMessage(chatId,'❌ Token not found.'); return; }
    const m=await getCoinMeta(ct)||{};
    await guard(chatId,async()=>startSell(chatId,ct,m.symbol||trunc(ct))); return;
  }

  if (state==='scan_ca') {
    updU(chatId,{state:null});
    const ct=text.startsWith('0x')?text:(await resolveTicker(text));
    if (!ct) { await bot.sendMessage(chatId,'❌ Token not found.'); return; }
    const m=await bot.sendMessage(chatId,'🔍 Scanning...');
    try {
      const [d,st,hp]=await Promise.all([getTokenData(ct),detectState(ct),checkHoneypot(ct)]);
      d.honeypot=hp;
      await bot.editMessageText(scanReport(d,ct,st),{chat_id:chatId,message_id:m.message_id,parse_mode:'Markdown'});
    } catch(e){await bot.editMessageText(`❌ Scan failed: ${e.message?.slice(0,100)}`,{chat_id:chatId,message_id:m.message_id});}
    return;
  }

  if (state==='buy_custom_amt') {
    updU(chatId,{state:null});
    const amt=parseFloat(text); if(isNaN(amt)||amt<=0){await bot.sendMessage(chatId,'❌ Enter a number like 2.5');return;}
    const ct=u.pd?.ct; if(!ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
    await showBuyConfirm(chatId,ct,amt,null); return;
  }

  if (state==='sell_custom_pct') {
    updU(chatId,{state:null});
    const pct=parseFloat(text); if(isNaN(pct)||pct<=0||pct>100){await bot.sendMessage(chatId,'❌ Enter 1-100');return;}
    const ct=u.pd?.ct; if(!ct){await bot.sendMessage(chatId,'❌ Session expired.');return;}
    updU(chatId,{pd:{...u.pd,pct}});
    await showSellConfirm(chatId,ct,pct,null); return;
  }

  if (state==='edit_amts') {
    updU(chatId,{state:null});
    const parts=text.split(/\s+/).map(Number).filter(n=>!isNaN(n)&&n>0).slice(0,4);
    if (parts.length<2){await bot.sendMessage(chatId,'❌ Enter at least 2 amounts: 0.5 1 3 5');return;}
    while(parts.length<4) parts.push(parts[parts.length-1]*2);
    const uu=getU(chatId);if(uu){uu.settings.buyAmounts=parts;saveDB();}
    await bot.sendMessage(chatId,`✅ Quick-buy amounts: ${parts.join(', ')} SUI`); return;
  }

  if (state==='snipe_amount') {
    const amt=parseFloat(text); if(isNaN(amt)||amt<=0){await bot.sendMessage(chatId,'❌ Invalid amount.');return;}
    const pd=u.pd||{};
    u.snipeWatches=u.snipeWatches||[];
    u.snipeWatches.push({ct:pd.sniToken,sui:amt,mode:'any',triggered:false,at:Date.now()});
    updU(chatId,{state:null,pd:{},snipeWatches:u.snipeWatches});
    await bot.sendMessage(chatId,`⚡ *Snipe set!*\n\nToken: \`${trunc(pd.sniToken)}\`\nBuy: ${amt} SUI\n\nWatching for pool...`,{parse_mode:'Markdown'}); return;
  }

  if (state==='copy_wallet') {
    if(!text.startsWith('0x')){await bot.sendMessage(chatId,'❌ Invalid wallet address.');return;}
    u.copyTraders=u.copyTraders||[];
    if(u.copyTraders.length>=3){await bot.sendMessage(chatId,'❌ Max 3. /copytrader stop first.');return;}
    u.copyTraders.push({wallet:text,amount:u.settings.copyAmount,maxPos:5,blacklist:[]});
    updU(chatId,{state:null,copyTraders:u.copyTraders});
    await bot.sendMessage(chatId,`✅ Tracking \`${trunc(text)}\``,{parse_mode:'Markdown'}); return;
  }

  // Raw CA paste
  if (text.startsWith('0x')&&text.length>40) {
    updU(chatId,{pd:{ct:text}});
    await bot.sendMessage(chatId,`📋 \`${trunc(text)}\`\n\nWhat do you want to do?`,{parse_mode:'Markdown',reply_markup:{inline_keyboard:[[{text:'💰 Buy',callback_data:'bfs'},{text:'💸 Sell',callback_data:'sfs'},{text:'🔍 Scan',callback_data:'sct'}]]}}); return;
  }
});

// ═══════════════════════════════════════════
// 23. /command HANDLERS
// ═══════════════════════════════════════════
bot.onText(/\/buy(?:\s+(.+))?/, async (msg, m) => {
  const chatId=msg.chat.id, args=(m[1]||'').trim();
  await guard(chatId, async() => {
    if (!args){await bot.sendMessage(chatId,'Send the token CA or $TICKER:');updU(chatId,{state:'buy_ca'});return;}
    const parts=args.split(/\s+/);
    const ct=parts[0].startsWith('0x')?parts[0]:(await resolveTicker(parts[0]));
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
    if(parts[1]){const a=parseFloat(parts[1]);if(!isNaN(a)&&a>0){updU(chatId,{pd:{ct}});await showBuyConfirm(chatId,ct,a,null);return;}}
    await startBuy(chatId,ct);
  });
});

bot.onText(/\/sell(?:\s+(.+))?/, async (msg, m) => {
  const chatId=msg.chat.id, args=(m[1]||'').trim();
  await guard(chatId, async(u) => {
    if (!args){await doSellMenu(chatId,u);return;}
    const parts=args.split(/\s+/);
    const ct=parts[0].startsWith('0x')?parts[0]:(await resolveTicker(parts[0]));
    if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
    const meta=await getCoinMeta(ct)||{};
    if(parts[1]){const p=parts[1].toLowerCase()==='all'?100:parseFloat(parts[1].replace('%',''));if(!isNaN(p)){updU(chatId,{pd:{ct,sym:meta.symbol}});await showSellConfirm(chatId,ct,p,null);return;}}
    await startSell(chatId,ct,meta.symbol||trunc(ct));
  });
});

bot.onText(/\/scan(?:\s+(.+))?/, async (msg, m) => {
  const chatId=msg.chat.id, arg=(m[1]||'').trim();
  if(!arg){await bot.sendMessage(chatId,'Send the token CA:');updU(chatId,{state:'scan_ca'});return;}
  const ct=arg.startsWith('0x')?arg:(await resolveTicker(arg));
  if(!ct){await bot.sendMessage(chatId,'❌ Token not found.');return;}
  const pm=await bot.sendMessage(chatId,'🔍 Scanning...');
  try{const[d,st,hp]=await Promise.all([getTokenData(ct),detectState(ct),checkHoneypot(ct)]);d.honeypot=hp;await bot.editMessageText(scanReport(d,ct,st),{chat_id:chatId,message_id:pm.message_id,parse_mode:'Markdown'});}
  catch(e){await bot.editMessageText(`❌ Scan failed: ${e.message?.slice(0,100)}`,{chat_id:chatId,message_id:pm.message_id});}
});

bot.onText(/\/balance/,                 async(msg)=>doBalance(msg.chat.id));
bot.onText(/\/positions/,               async(msg)=>doPositions(msg.chat.id));
bot.onText(/\/referral/,                async(msg)=>doReferral(msg.chat.id));
bot.onText(/\/help/,                    async(msg)=>doHelp(msg.chat.id));
bot.onText(/\/settings/,               async(msg)=>doSettings(msg.chat.id));
bot.onText(/\/snipe(?:\s+(.+))?/,      async(msg,m)=>doSnipe(msg.chat.id,m[1]?m[1].trim():null));
bot.onText(/\/copytrader(?:\s+(.+))?/, async(msg,m)=>doCopytrader(msg.chat.id,m[1]?m[1].trim():null));

// ═══════════════════════════════════════════
// 24. ERRORS & STARTUP
// ═══════════════════════════════════════════
bot.on('polling_error', e => {
  console.error('Polling error:', e.message);
  if(ADMIN_ID) bot.sendMessage(ADMIN_ID,`⚠️ ${e.message?.slice(0,150)}`).catch(()=>{});
});
process.on('uncaughtException', e => {
  console.error('Uncaught:', e);
  if(ADMIN_ID) bot.sendMessage(ADMIN_ID,`🚨 ${e.message?.slice(0,150)}`).catch(()=>{});
});
process.on('unhandledRejection', r => console.error('Unhandled:', r));

async function main() {
  if (!TG_TOKEN)              throw new Error('TG_BOT_TOKEN required');
  if (ENC_KEY.length !== 64)  throw new Error('ENCRYPT_KEY must be 64 hex chars');
  loadDB();

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  AGENT TRADING BOT — Starting');
  console.log(`  Users: ${Object.keys(DB).length}`);

  // Init SDKs — warn but don't crash
  await sdk7k().then(()=>console.log('✅ 7K Aggregator')).catch(e=>console.warn('⚠️ 7K:',e.message));
  await sdkTurbos().then(()=>console.log('✅ Turbos SDK')).catch(e=>console.warn('⚠️ Turbos:',e.message));

  // Start background engines
  positionMonitor().catch(e=>console.error('Monitor crash:',e));
  sniperEngine().catch(e=>console.error('Sniper crash:',e));
  copyEngine().catch(e=>console.error('CopyTrader crash:',e));

  console.log('  Bot is live!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if(ADMIN_ID) bot.sendMessage(ADMIN_ID,'🟢 AGENT TRADING BOT online.').catch(()=>{});
}

main().catch(e=>{console.error('Fatal:',e);process.exit(1);});
