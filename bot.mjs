/**
 * AGENT TRADING BOT — bot.mjs v4
 * Root-cause fixes:
 *  - bot.emit() doesn't trigger onText → replaced with direct function calls
 *  - Private key shown + exportable from settings
 *  - Bluefin DEX added to pool discovery
 *  - Holders: Birdeye + Blockberry + Suiscan fallback chain
 *  - All keyboard buttons wired directly to named functions
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
const DEFAULT_BUY_AMOUNTS = [0.5, 1, 3, 5];

const LAUNCHPAD_REGISTRY = {
  MOVEPUMP:   { name: 'MovePump',   apiBase: 'https://movepump.com/api',       graduationSui: 2000, destinationDex: 'Cetus',  buyFn: 'buy', sellFn: 'sell' },
  TURBOS_FUN: { name: 'Turbos.fun', apiBase: 'https://api.turbos.finance/fun', graduationSui: 6000, destinationDex: 'Turbos', buyFn: 'buy', sellFn: 'sell' },
  HOP_FUN:    { name: 'hop.fun',    apiBase: 'https://api.hop.ag',             graduationSui: null, destinationDex: 'Cetus',  buyFn: 'buy', sellFn: 'sell' },
  MOONBAGS:   { name: 'MoonBags',   apiBase: 'https://api.moonbags.io',        graduationSui: null, destinationDex: 'Cetus',  buyFn: 'buy', sellFn: 'sell' },
  BLAST_FUN:  { name: 'blast.fun',  apiBase: 'https://api.blast.fun',          graduationSui: null, destinationDex: 'Cetus',  buyFn: 'buy', sellFn: 'sell' },
};

// ─────────────────────────────────────────────
// 2. CRYPTO HELPERS
// ─────────────────────────────────────────────

function encryptKey(privateKey) {
  const keyBuf = Buffer.from(ENCRYPT_KEY, 'hex');
  const iv     = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', keyBuf, iv);
  const enc    = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

// Correct AES-256-CBC decryption: (algorithm, key, iv)
function decryptPrivKey(stored) {
  const parts  = stored.split(':');
  const keyBuf = Buffer.from(ENCRYPT_KEY, 'hex');
  const iv     = Buffer.from(parts[0], 'hex');
  const enc    = Buffer.from(parts[1], 'hex');
  const dec    = createDecipheriv('aes-256-cbc', keyBuf, iv);
  return Buffer.concat([dec.update(enc), dec.final()]).toString('utf8');
}

function hashPin(pin) { return createHash('sha256').update(pin + ENCRYPT_KEY).digest('hex'); }

function generateReferralCode() {
  const ch = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let c = 'AGT-';
  for (let i = 0; i < 6; i++) c += ch[Math.floor(Math.random() * ch.length)];
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

function suiFloat(mist) { return (Number(BigInt(mist)) / 1e9).toFixed(4); }
function mistFromSui(sui) { return BigInt(Math.floor(parseFloat(sui) * 1e9)); }
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
    chatId: uid, encryptedKey: null, walletAddress: null, pinHash: null, lockedAt: null,
    lastActivity: Date.now(), failAttempts: 0, cooldownUntil: 0,
    positions: [], copyTraders: [], snipeWatches: [],
    settings: { slippage: 1, confirmThreshold: 0.5, copyAmount: 0.1, tpDefault: null, slDefault: null, buyAmounts: [...DEFAULT_BUY_AMOUNTS] },
    referralCode: generateReferralCode(), referredBy: null, referralCount: 0, referralEarningsTotal: 0,
    state: null, pendingData: {}, ...extras,
  };
  saveUsers();
  return usersDB[uid];
}

function updateUser(chatId, patch) {
  const uid = String(chatId);
  if (!usersDB[uid]) return;
  for (const [k, v] of Object.entries(patch)) {
    if (k.includes('.')) { const [p, c] = k.split('.'); if (!usersDB[uid][p]) usersDB[uid][p] = {}; usersDB[uid][p][c] = v; }
    else usersDB[uid][k] = v;
  }
  usersDB[uid].lastActivity = Date.now();
  saveUsers();
}

function isLocked(user) { return !!(user?.pinHash && user?.lockedAt); }
function lockUser(chatId)   { updateUser(chatId, { lockedAt: Date.now() }); }
function unlockUser(chatId) { updateUser(chatId, { lockedAt: null, failAttempts: 0 }); }

function checkInactivity() {
  const now = Date.now();
  for (const [uid, user] of Object.entries(usersDB))
    if (user.pinHash && !user.lockedAt && user.walletAddress && now - user.lastActivity > LOCK_TIMEOUT) lockUser(uid);
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
async function getOwnedCoins(address, coinType) { return (await suiClient.getCoins({ owner: address, coinType })).data; }
async function getAllBalances(address) { return suiClient.getAllBalances({ owner: address }); }

function getKeypair(user) {
  const pk  = decryptPrivKey(user.encryptedKey);
  return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(pk).secretKey);
}

// ─────────────────────────────────────────────
// 5. SDK SINGLETONS
// ─────────────────────────────────────────────

let _7k = null;
async function sdk7k() {
  if (_7k) return _7k;
  const mod = await import('@7kprotocol/sdk-ts');
  mod.setSuiClient(suiClient);
  _7k = { getQuote: mod.getQuote, buildTx: mod.buildTx };
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
  if (user.referredBy) { referrerMist = (feeMist * BigInt(Math.floor(REF_SHARE * 100))) / 100n; devMist = feeMist - referrerMist; }
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

  try {
    const k = await sdk7k();
    const q = await k.getQuote({ tokenIn: SUI_TYPE, tokenOut: coinType, amountIn: '1000000000' });
    if (q && q.outAmount && BigInt(q.outAmount) > 0n) {
      const r = { state: 'graduated', quote: q, dex: q.routes?.[0]?.poolType || 'aggregator', ts: Date.now() };
      stateCache.set(coinType, r); return r;
    }
  } catch {}

  for (const [key, lp] of Object.entries(LAUNCHPAD_REGISTRY)) {
    try {
      let data = null, enc = encodeURIComponent(coinType);
      if (key === 'TURBOS_FUN') { const r = await fetchTimeout(`${lp.apiBase}/token?coinType=${enc}`, {}, 4000); if (r.ok) data = await r.json(); }
      else { const r = await fetchTimeout(`${lp.apiBase}/token/${enc}`, {}, 4000); if (r.ok) data = await r.json(); }
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

  const r = { state: 'unknown', ts: Date.now() };
  stateCache.set(coinType, r); return r;
}

// ─────────────────────────────────────────────
// 8. SWAP VIA 7K AGGREGATOR
// ─────────────────────────────────────────────

async function swapVia7K({ keypair, walletAddress, tokenIn, tokenOut, amountIn, slippagePct, user }) {
  const k = await sdk7k();
  const { feeMist, devMist, referrerMist } = calcFee(amountIn, user);
  const tradeMist = amountIn - feeMist;

  const quoteResponse = await k.getQuote({ tokenIn, tokenOut, amountIn: tradeMist.toString() });
  if (!quoteResponse || !quoteResponse.outAmount || BigInt(quoteResponse.outAmount) === 0n)
    throw new Error('No liquidity found across any DEX for this token.');

  const buildResult = await k.buildTx({
    quoteResponse, accountAddress: walletAddress, slippage: slippagePct / 100,
    commission: { partner: DEV_WALLET, commissionBps: 0 },
  });

  const tx = buildResult.tx;
  const [devCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(devMist)]);
  tx.transferObjects([devCoin], tx.pure.address(DEV_WALLET));
  if (referrerMist > 0n && user.referredBy) {
    const [rc] = tx.splitCoins(tx.gas, [tx.pure.u64(referrerMist)]);
    tx.transferObjects([rc], tx.pure.address(user.referredBy));
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
// 9. BONDING CURVE BUY / SELL
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

async function bondingCurveSell({ keypair, coinType, tokenCoins, sellAmountRaw, bondingCurveId, sellFn }) {
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
// 10. UNIFIED BUY / SELL
// ─────────────────────────────────────────────

async function executeBuy(chatId, coinType, amountSui) {
  const user = getUser(chatId); if (!user) throw new Error('User not found');
  const keypair = getKeypair(user), amountMist = mistFromSui(amountSui);
  const state = await detectTokenState(coinType);
  const meta  = await getCoinMeta(coinType) || {};
  const symbol = meta.symbol || truncAddr(coinType);

  if (state.state === 'graduated' || state.state === 'unknown') {
    const res = await swapVia7K({ keypair, walletAddress: user.walletAddress, tokenIn: SUI_TYPE, tokenOut: coinType, amountIn: amountMist, slippagePct: user.settings.slippage, user });
    const estTokens = Number(res.estimatedOut) / Math.pow(10, meta.decimals || 9);
    addPosition(chatId, { coinType, symbol, entryPriceSui: Number(amountMist - res.feeMist) / 1e9 / (estTokens || 1), amountTokens: estTokens, decimals: meta.decimals || 9, spentSui: amountSui, source: 'dex', tp: user.settings.tpDefault, sl: user.settings.slDefault });
    return { digest: res.digest, feeSui: suiFloat(res.feeMist), route: res.route, estOut: estTokens.toFixed(4), symbol, state: 'graduated' };
  }

  if (state.state === 'bonding_curve') {
    if (!state.bondingCurveId) throw new Error(`Found on ${state.launchpadName} but curve ID unavailable.`);
    const res = await bondingCurveBuy({ keypair, walletAddress: user.walletAddress, coinType, suiAmountMist: amountMist, bondingCurveId: state.bondingCurveId, buyFn: state.buyFn || 'buy', user });
    addPosition(chatId, { coinType, symbol, entryPriceSui: state.currentPrice || 0, amountTokens: 0, decimals: meta.decimals || 9, spentSui: amountSui, source: 'bonding_curve', launchpad: state.launchpadName });
    return { digest: res.digest, feeSui: suiFloat(res.feeMist), route: state.launchpadName, estOut: '?', symbol, state: 'bonding_curve', launchpadName: state.launchpadName };
  }
  throw new Error('Token not found on any DEX or launchpad.');
}

async function executeSell(chatId, coinType, pct) {
  const user = getUser(chatId); if (!user) throw new Error('User not found');
  const keypair = getKeypair(user);
  const meta = await getCoinMeta(coinType) || {};
  const coins = await getOwnedCoins(user.walletAddress, coinType);
  if (!coins.length) throw new Error('No balance of this token.');
  const totalBal = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
  const sellAmt  = (totalBal * BigInt(Math.floor(pct))) / 100n;
  if (sellAmt === 0n) throw new Error('Sell amount is zero.');
  const state = await detectTokenState(coinType);

  if (state.state === 'graduated' || state.state === 'unknown') {
    const res = await swapVia7K({ keypair, walletAddress: user.walletAddress, tokenIn: coinType, tokenOut: SUI_TYPE, amountIn: sellAmt, slippagePct: user.settings.slippage, user });
    if (pct === 100) updateUser(chatId, { positions: user.positions.filter(p => p.coinType !== coinType) });
    return { digest: res.digest, feeSui: suiFloat(calcFee(BigInt(res.estimatedOut), user).feeMist), route: res.route, estSui: (Number(res.estimatedOut) / 1e9).toFixed(4), symbol: meta.symbol || truncAddr(coinType), pct };
  }
  if (state.state === 'bonding_curve') {
    if (!state.bondingCurveId) throw new Error(`Curve ID unavailable for ${state.launchpadName}.`);
    const res = await bondingCurveSell({ keypair, walletAddress: user.walletAddress, coinType, tokenCoins: coins, sellAmountRaw: sellAmt, bondingCurveId: state.bondingCurveId, sellFn: state.sellFn || 'sell' });
    if (pct === 100) updateUser(chatId, { positions: user.positions.filter(p => p.coinType !== coinType) });
    return { digest: res.digest, feeSui: 'N/A', route: state.launchpadName, estSui: '?', symbol: meta.symbol || truncAddr(coinType), pct };
  }
  throw new Error('Cannot sell — token not found on any DEX or launchpad.');
}

// ─────────────────────────────────────────────
// 11. POOL DISCOVERY — GeckoTerminal + Bluefin
// ─────────────────────────────────────────────

async function getPoolsFromGecko(coinType) {
  const pools = [];
  // Try full coinType AND package address (GeckoTerminal indexes both)
  const tries = [coinType, packageFromCoinType(coinType)].filter((v, i, a) => a.indexOf(v) === i);
  for (const addr of tries) {
    try {
      const enc = encodeURIComponent(addr);
      const r = await fetchTimeout(`${GECKO_BASE}/networks/${GECKO_NET}/tokens/${enc}/pools?page=1`, { headers: { 'Accept': 'application/json;version=20230302' } }, 8000);
      if (!r.ok) continue;
      const data = await r.json();
      const list = data.data || [];
      if (!list.length) continue;
      for (const p of list.slice(0, 5)) {
        const a = p.attributes || {};
        pools.push({
          dex: (a.dex_id || p.relationships?.dex?.data?.id || 'DEX').replace('_', ' '),
          poolId: a.address || p.id,
          liquidityUsd: parseFloat(a.reserve_in_usd || 0),
          price: parseFloat(a.base_token_price_usd || 0),
          priceNative: parseFloat(a.base_token_price_native_currency || 0),
          volume24h: parseFloat(a.volume_usd?.h24 || 0),
          priceChange24h: parseFloat(a.price_change_percentage?.h24 || 0),
        });
      }
      if (pools.length) break; // found data, stop trying
    } catch {}
  }
  return pools.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

async function getTokenInfoFromGecko(coinType) {
  const tries = [coinType, packageFromCoinType(coinType)].filter((v, i, a) => a.indexOf(v) === i);
  for (const addr of tries) {
    try {
      const enc = encodeURIComponent(addr);
      const r = await fetchTimeout(`${GECKO_BASE}/networks/${GECKO_NET}/tokens/${enc}`, { headers: { 'Accept': 'application/json;version=20230302' } }, 8000);
      if (!r.ok) continue;
      const data = await r.json();
      const attr = data.data?.attributes || {};
      if (!attr.name && !attr.symbol) continue;
      return {
        name: attr.name || null, symbol: attr.symbol || null, decimals: attr.decimals || 9,
        totalSupply: parseFloat(attr.total_supply || 0),
        priceUsd: parseFloat(attr.price_usd || 0), fdvUsd: parseFloat(attr.fdv_usd || 0),
        marketCapUsd: parseFloat(attr.market_cap_usd || 0), volume24h: parseFloat(attr.volume_usd?.h24 || 0),
        priceChange24h: parseFloat(attr.price_change_percentage?.h24 || 0),
      };
    } catch {}
  }
  return null;
}

// Holders: Birdeye → Blockberry → Suiscan
async function getHolders(coinType) {
  // 1. Birdeye (good Sui support, no auth for basic)
  try {
    const r = await fetchTimeout(
      `https://public-api.birdeye.so/defi/token_overview?address=${encodeURIComponent(coinType)}&chain=sui`,
      { headers: { 'accept': 'application/json', 'x-chain': 'sui' } }, 6000
    );
    if (r.ok) {
      const d = await r.json();
      if (d.data?.holder) return { total: d.data.holder, topHolders: [] };
    }
  } catch {}

  // 2. Blockberry (powers Suiscan)
  try {
    const enc = encodeURIComponent(coinType);
    const r = await fetchTimeout(
      `https://api.blockberry.one/sui/v1/coins/${enc}/holders?page=0&size=10&orderBy=DESC&sortBy=AMOUNT`,
      { headers: { 'accept': 'application/json' } }, 6000
    );
    if (r.ok) {
      const d = await r.json();
      const list = d.content || d.data || [];
      return {
        total: d.totalElements || d.total || list.length,
        topHolders: list.slice(0, 10).map(h => ({ address: h.address || h.owner || '', pct: parseFloat(h.percentage || 0) })),
      };
    }
  } catch {}

  // 3. Suiscan API fallback
  try {
    const enc = encodeURIComponent(coinType);
    const r = await fetchTimeout(`https://suiscan.xyz/api/sui/mainnet/coin/${enc}/holders?limit=20`, { headers: { 'accept': 'application/json' } }, 6000);
    if (r.ok) {
      const d = await r.json();
      return { total: d.total || 0, topHolders: (d.data || []).slice(0, 10).map(h => ({ address: h.address, pct: parseFloat(h.percentage || 0) })) };
    }
  } catch {}
  return { total: 0, topHolders: [] };
}

// ─────────────────────────────────────────────
// 12. TOKEN SCANNER
// ─────────────────────────────────────────────

async function scanToken(coinType) {
  const scan = { coinType, name: '?', symbol: '?', decimals: 9, totalSupply: 0, priceUsd: 0, priceNative: 0, fdvUsd: 0, marketCapUsd: 0, volume24h: 0, priceChange24h: 0, holders: 0, topHolders: [], pools: [], totalLiquidityUsd: 0, honeypotPass: null, riskScore: 'UNKNOWN', bondingCurveState: null };

  // All 4 data sources in parallel
  const [geckoInfo, holderData, poolData, chainMeta, chainSupply, state] = await Promise.allSettled([
    getTokenInfoFromGecko(coinType),
    getHolders(coinType),
    getPoolsFromGecko(coinType),
    getCoinMeta(coinType),
    suiClient.getTotalSupply({ coinType }).catch(() => null),
    detectTokenState(coinType),
  ]);

  // Merge GeckoTerminal info
  const gi = geckoInfo.status === 'fulfilled' ? geckoInfo.value : null;
  if (gi) {
    if (gi.name)   scan.name   = gi.name;
    if (gi.symbol) scan.symbol = gi.symbol;
    scan.decimals = gi.decimals; scan.totalSupply = gi.totalSupply;
    scan.priceUsd = gi.priceUsd; scan.fdvUsd = gi.fdvUsd; scan.marketCapUsd = gi.marketCapUsd;
    scan.volume24h = gi.volume24h; scan.priceChange24h = gi.priceChange24h;
  }

  // On-chain metadata fills gaps
  const cm = chainMeta.status === 'fulfilled' ? chainMeta.value : null;
  if (cm) {
    if (scan.name   === '?') scan.name   = cm.name    || '?';
    if (scan.symbol === '?') scan.symbol = cm.symbol  || '?';
    scan.decimals = cm.decimals || scan.decimals;
  }
  // On-chain supply
  if (!scan.totalSupply && chainSupply.status === 'fulfilled' && chainSupply.value)
    scan.totalSupply = Number(chainSupply.value.value) / Math.pow(10, scan.decimals);

  // Holders
  const hd = holderData.status === 'fulfilled' ? holderData.value : { total: 0, topHolders: [] };
  scan.holders = hd.total; scan.topHolders = hd.topHolders;

  // Pools
  scan.pools = poolData.status === 'fulfilled' ? poolData.value : [];
  scan.totalLiquidityUsd = scan.pools.reduce((s, p) => s + (p.liquidityUsd || 0), 0);
  if (scan.pools.length && !scan.priceNative) scan.priceNative = scan.pools[0].priceNative;
  if (scan.pools.length && !scan.priceUsd)    scan.priceUsd    = scan.pools[0].price;

  // Token state
  const st = state.status === 'fulfilled' ? state.value : { state: 'unknown' };
  if (st.state === 'bonding_curve') scan.bondingCurveState = { launchpad: st.launchpadName, suiRaised: st.suiRaised, threshold: st.threshold, destinationDex: st.destinationDex };

  // Honeypot check
  try { const k = await sdk7k(); const q = await k.getQuote({ tokenIn: coinType, tokenOut: SUI_TYPE, amountIn: '1000000' }); scan.honeypotPass = !!(q && BigInt(q.outAmount || 0) > 0n); } catch {}

  // Risk score
  const top3 = scan.topHolders.slice(0, 3).reduce((s, h) => s + h.pct, 0);
  const noLiq = scan.totalLiquidityUsd < 500 && !scan.bondingCurveState && !scan.pools.length;
  const lowLiq = scan.totalLiquidityUsd < 5000;
  if (scan.honeypotPass === false || noLiq)   scan.riskScore = 'LIKELY RUG';
  else if (top3 > 50 && lowLiq)              scan.riskScore = 'HIGH RISK';
  else if (top3 > 50 || lowLiq)             scan.riskScore = 'CAUTION';
  else                                        scan.riskScore = 'SAFE';

  return scan;
}

function formatScanReport(scan) {
  const ICONS = { 'SAFE': '🟢', 'CAUTION': '🟡', 'HIGH RISK': '🔴', 'LIKELY RUG': '💀', 'UNKNOWN': '⚪' };
  const top3  = scan.topHolders.slice(0, 3).reduce((s, h) => s + h.pct, 0);
  const chg   = scan.priceChange24h;
  const lines = [`🔍 *Token Scan*\n`];

  lines.push(`📛 *${scan.name}* (${scan.symbol})`);
  lines.push(`📋 \`${truncAddr(scan.coinType)}\``);

  if (scan.priceUsd > 0) {
    const chgStr = chg !== 0 ? ` ${chg >= 0 ? '📈 +' : '📉 '}${chg.toFixed(2)}%` : '';
    lines.push(`\n💵 $${scan.priceUsd < 0.0001 ? scan.priceUsd.toExponential(3) : scan.priceUsd.toFixed(6)}${chgStr}`);
  }
  if (scan.priceNative > 0) lines.push(`🔵 ${scan.priceNative.toFixed(8)} SUI`);
  if (scan.marketCapUsd > 0) lines.push(`🏦 MCap: $${formatNum(scan.marketCapUsd)}`);
  if (scan.fdvUsd > 0)       lines.push(`📊 FDV: $${formatNum(scan.fdvUsd)}`);
  if (scan.volume24h > 0)    lines.push(`💹 Vol 24h: $${formatNum(scan.volume24h)}`);
  if (scan.totalSupply > 0)  lines.push(`🏭 Supply: ${scan.totalSupply.toLocaleString()}`);
  lines.push(`\n👥 Holders: ${scan.holders > 0 ? scan.holders.toLocaleString() : '~'}${top3 > 50 ? ` ⚠️ Top 3 own ${top3.toFixed(1)}%` : ''}`);

  if (scan.topHolders.length) {
    lines.push('\n*Top Holders:*');
    scan.topHolders.slice(0, 5).forEach((h, i) => lines.push(`  ${i + 1}. \`${truncAddr(h.address)}\` — ${h.pct.toFixed(2)}%`));
  }

  if (scan.bondingCurveState) {
    const bc = scan.bondingCurveState;
    lines.push(`\n📊 *Bonding Curve — ${bc.launchpad}*`);
    if (bc.suiRaised > 0 && bc.threshold) {
      const p = ((bc.suiRaised / bc.threshold) * 100).toFixed(1);
      lines.push(`${'█'.repeat(Math.min(10, Math.floor(parseFloat(p) / 10)))}${'░'.repeat(Math.max(0, 10 - Math.floor(parseFloat(p) / 10)))} ${p}%`);
      lines.push(`${bc.suiRaised} / ${bc.threshold} SUI → ${bc.destinationDex}`);
    }
    lines.push(`⚠️ Not on DEX yet`);
  } else if (scan.pools.length) {
    lines.push('\n*Pools:*');
    scan.pools.slice(0, 4).forEach(p => {
      const liq = p.liquidityUsd > 0 ? `$${formatNum(p.liquidityUsd)}` : 'Unknown';
      const vol = p.volume24h > 0 ? ` | Vol: $${formatNum(p.volume24h)}` : '';
      lines.push(`  • ${p.dex}: ${liq}${vol}`);
    });
    lines.push(`Total: $${formatNum(scan.totalLiquidityUsd)}`);
  } else {
    lines.push('\n❌ No pools found');
  }

  lines.push(`\n🍯 ${scan.honeypotPass === true ? '✅ Sellable' : scan.honeypotPass === false ? '❌ HONEYPOT — CANNOT SELL' : '⚪ Unknown'}`);
  lines.push(`\n${ICONS[scan.riskScore] || '⚪'} *Risk: ${scan.riskScore}*`);
  return lines.join('\n');
}

function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toFixed(0);
}

// ─────────────────────────────────────────────
// 13. POSITIONS & PnL
// ─────────────────────────────────────────────

function addPosition(chatId, pos) {
  const user = getUser(chatId); if (!user) return;
  user.positions.push({
    id: randomBytes(4).toString('hex'), coinType: pos.coinType, symbol: pos.symbol,
    entryPriceSui: pos.entryPriceSui || 0, amountTokens: pos.amountTokens || 0,
    decimals: pos.decimals || 9, spentSui: pos.spentSui,
    tp: pos.tp || null, sl: pos.sl || null,
    source: pos.source || 'dex', launchpad: pos.launchpad || null, openedAt: Date.now(),
  });
  saveUsers();
}

async function getPositionPnl(pos) {
  if (pos.source === 'bonding_curve' || pos.amountTokens <= 0) return null;
  try {
    const k = await sdk7k();
    const dec      = pos.decimals || 9;
    const tokenAmt = BigInt(Math.floor(pos.amountTokens * Math.pow(10, dec)));
    const q = await k.getQuote({ tokenIn: pos.coinType, tokenOut: SUI_TYPE, amountIn: tokenAmt.toString() });
    if (!q || !q.outAmount) return null;
    const currentSui = Number(q.outAmount) / 1e9;
    const pnl        = currentSui - pos.spentSui;
    return { currentSui, pnl, pnlPct: (pnl / pos.spentSui) * 100 };
  } catch { return null; }
}

function buildPnlChartUrl(pnlPct) {
  const isProfit = pnlPct >= 0;
  const color    = isProfit ? '#00e676' : '#ff1744';
  const bgColor  = isProfit ? '#0d1f14' : '#1f0d0d';
  const points = 24;
  const data   = [];
  for (let i = 0; i <= points; i++) {
    const t = i / points;
    data.push(+(1 + pnlPct / 100 * t + (Math.sin(i * 1.3) * 0.15 + Math.cos(i * 2.7) * 0.1) * Math.abs(pnlPct) / 200 * Math.sqrt(t)).toFixed(4));
  }
  const cfg = { type: 'line', data: { labels: data.map((_, i) => i), datasets: [{ data, borderColor: color, backgroundColor: `${color}20`, fill: true, tension: 0.5, borderWidth: 3, pointRadius: 0 }] }, options: { animation: false, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false, min: Math.min(...data) * 0.97, max: Math.max(...data) * 1.03 } } } };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(cfg))}&w=600&h=250&bkg=${encodeURIComponent(bgColor)}&f=png`;
}

function buildPnlCaption(pos, pnl) {
  const plus = pnl.pnl >= 0;
  const bar  = (plus ? '🟩' : '🟥').repeat(Math.min(10, Math.round(Math.abs(pnl.pnlPct) / 20))) + '⬛'.repeat(Math.max(0, 10 - Math.min(10, Math.round(Math.abs(pnl.pnlPct) / 20))));
  return `${plus ? '🚀' : '📉'} *${pos.symbol} Position*\n\n` +
    `Entry:    ${pos.entryPriceSui > 0 ? pos.entryPriceSui.toFixed(8) : '~'} SUI\n` +
    `Invested: ${pos.spentSui} SUI\n` +
    `Value:    ${pnl.currentSui.toFixed(4)} SUI\n\n` +
    `P&L: *${plus ? '+' : ''}${pnl.pnl.toFixed(4)} SUI  (${plus ? '+' : ''}${pnl.pnlPct.toFixed(2)}%)*\n${bar}`;
}

// ─────────────────────────────────────────────
// 14. POSITION MONITOR (TP/SL auto-sell)
// ─────────────────────────────────────────────

async function positionMonitor() {
  while (true) {
    await sleep(30_000);
    for (const [uid, user] of Object.entries(usersDB)) {
      if (!user.walletAddress || !user.positions?.length || isLocked(user)) continue;
      for (const pos of [...user.positions]) {
        if (pos.source === 'bonding_curve') continue;
        try {
          const pnl = await getPositionPnl(pos); if (!pnl) continue;
          let reason = '';
          if (pos.tp && pnl.pnlPct >= pos.tp) reason = `✅ Take Profit +${pnl.pnlPct.toFixed(2)}%`;
          else if (pos.sl && pnl.pnlPct <= -pos.sl) reason = `🛑 Stop Loss ${pnl.pnlPct.toFixed(2)}%`;
          if (!reason) continue;
          try {
            const res = await executeSell(uid, pos.coinType, 100);
            const img = buildPnlChartUrl(pnl.pnlPct);
            const cap = `${reason}\n\n${buildPnlCaption(pos, pnl)}\n\n🔗 [TX](${SUISCAN_TX}${res.digest})`;
            try { await bot.sendPhoto(uid, img, { caption: cap, parse_mode: 'Markdown' }); }
            catch { await bot.sendMessage(uid, cap, { parse_mode: 'Markdown' }); }
          } catch (e) { bot.sendMessage(uid, `⚠️ Auto-sell failed for ${pos.symbol}: ${e.message?.slice(0, 80)}`); }
        } catch {}
      }
    }
  }
}

// ─────────────────────────────────────────────
// 15. SNIPER ENGINE
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
          const st = await detectTokenState(watch.coinType);
          const fire = watch.mode === 'graduation' ? st.state === 'graduated' : (st.state === 'graduated' || st.state === 'bonding_curve');
          if (!fire) continue;
          watch.triggered = true; saveUsers();
          bot.sendMessage(uid, `⚡ *Snipe triggered!*\n\nToken: \`${truncAddr(watch.coinType)}\`\n${st.state === 'bonding_curve' ? `📊 ${st.launchpadName}` : `✅ DEX (${st.dex || 'agg'})`}\nBuying ${watch.buyAmount} SUI...`, { parse_mode: 'Markdown' });
          try {
            const res = await executeBuy(uid, watch.coinType, watch.buyAmount);
            bot.sendMessage(uid, `⚡ *Sniped!*\n\nToken: ${res.symbol}\nSpent: ${watch.buyAmount} SUI\nFee: ${res.feeSui} SUI\n\n🔗 [TX](${SUISCAN_TX}${res.digest})`, { parse_mode: 'Markdown' });
          } catch (e) { bot.sendMessage(uid, `❌ Snipe failed: ${e.message?.slice(0, 120)}`); }
        } catch {}
      }
    }
  }
}

// ─────────────────────────────────────────────
// 16. COPY TRADER ENGINE
// ─────────────────────────────────────────────

const copyLastSeen = {};
async function copyTraderEngine() {
  while (true) {
    await sleep(5_000);
    const watchMap = new Map();
    for (const [uid, user] of Object.entries(usersDB)) {
      if (!user.copyTraders?.length || isLocked(user)) continue;
      for (const ct of user.copyTraders) { if (!watchMap.has(ct.wallet)) watchMap.set(ct.wallet, []); watchMap.get(ct.wallet).push({ user, config: ct, uid }); }
    }
    for (const [wallet, watchers] of watchMap) {
      try {
        const txs = await suiClient.queryTransactionBlocks({ filter: { FromAddress: wallet }, limit: 5, order: 'descending', options: { showEffects: true, showEvents: true } });
        const lastSeen = copyLastSeen[wallet];
        const newTxs   = lastSeen ? txs.data.filter(t => t.digest !== lastSeen) : txs.data.slice(0, 1);
        if (txs.data.length) copyLastSeen[wallet] = txs.data[0].digest;
        for (const tx of newTxs.reverse()) {
          const ev = (tx.events || []).find(e => e.type?.toLowerCase().includes('swap') || e.type?.toLowerCase().includes('trade'));
          if (!ev) continue;
          const pj = ev.parsedJson || {};
          const bought = pj.coin_type_out || pj.token_out || pj.coin_b_type || null;
          if (!bought || bought === SUI_TYPE) continue;
          for (const { user, config, uid } of watchers) {
            try {
              if (config.blacklist?.includes(bought)) continue;
              if ((await getOwnedCoins(user.walletAddress, bought)).length > 0) continue;
              if ((user.positions || []).length >= (config.maxPositions || 5)) continue;
              const copyAmt = config.amount || user.settings.copyAmount;
              bot.sendMessage(uid, `🔁 *Copy Trade*\n\nWallet: \`${truncAddr(wallet)}\`\nBuying: \`${truncAddr(bought)}\`\n${copyAmt} SUI`, { parse_mode: 'Markdown' });
              const res = await executeBuy(uid, bought, copyAmt);
              bot.sendMessage(uid, `✅ *Copy done!*\nToken: ${res.symbol}\nFee: ${res.feeSui} SUI\n🔗 [TX](${SUISCAN_TX}${res.digest})`, { parse_mode: 'Markdown' });
            } catch (e) { bot.sendMessage(uid, `❌ Copy failed: ${e.message?.slice(0, 100)}`); }
          }
        }
      } catch {}
    }
  }
}

// ─────────────────────────────────────────────
// 17. SYMBOL RESOLVER
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
// 18. MAIN KEYBOARD
// ─────────────────────────────────────────────

const MAIN_KB = {
  keyboard: [
    [{ text: '💰 Buy' },       { text: '💸 Sell' }],
    [{ text: '📊 Positions' }, { text: '💼 Balance' }],
    [{ text: '🔍 Scan' },      { text: '⚡ Snipe' }],
    [{ text: '🔁 Copy Trade'}, { text: '🔗 Referral' }],
    [{ text: '⚙️ Settings' },  { text: '❓ Help' }],
  ],
  resize_keyboard: true,
  persistent: true,
};

// ─────────────────────────────────────────────
// 19. NAMED COMMAND FUNCTIONS
// Called directly from keyboard routes AND slash command handlers.
// This is the fix for bot.emit() not triggering onText listeners.
// ─────────────────────────────────────────────

async function cmdBalance(chatId) {
  const m = await bot.sendMessage(chatId, '💰 Fetching balances...');
  try {
    const user = getUser(chatId);
    const bals = await getAllBalances(user.walletAddress);
    const suiBal = bals.find(b => b.coinType === SUI_TYPE);
    const lines  = [`💼 *Wallet*\n\`${truncAddr(user.walletAddress)}\`\n`, `🔵 SUI: ${suiBal ? suiFloat(suiBal.totalBalance) : '0.0000'}`];
    const others = bals.filter(b => b.coinType !== SUI_TYPE && Number(b.totalBalance) > 0);
    for (const bal of others.slice(0, 15)) {
      const meta = await getCoinMeta(bal.coinType).catch(() => null);
      lines.push(`• ${meta?.symbol || truncAddr(bal.coinType)}: ${(Number(bal.totalBalance) / Math.pow(10, meta?.decimals || 9)).toFixed(4)}`);
    }
    if (!others.length) lines.push('\n_No other tokens_');
    await bot.editMessageText(lines.join('\n'), { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' });
  } catch (e) { await bot.editMessageText(`❌ ${e.message?.slice(0, 100)}`, { chat_id: chatId, message_id: m.message_id }); }
}

async function cmdPositions(chatId) {
  const user = getUser(chatId);
  if (!user.positions?.length) { await bot.sendMessage(chatId, '📊 No open positions.'); return; }
  const m = await bot.sendMessage(chatId, '📊 Loading...');
  await bot.deleteMessage(chatId, m.message_id).catch(() => {});
  for (const pos of user.positions) {
    try {
      const pnl = await getPositionPnl(pos);
      if (pnl) {
        const cap = buildPnlCaption(pos, pnl) + `\n\nTP: ${pos.tp ? pos.tp + '%' : 'None'} | SL: ${pos.sl ? pos.sl + '%' : 'None'}` + (pos.source === 'bonding_curve' ? `\n📊 ${pos.launchpad}` : '');
        try { await bot.sendPhoto(chatId, buildPnlChartUrl(pnl.pnlPct), { caption: cap, parse_mode: 'Markdown' }); }
        catch { await bot.sendMessage(chatId, cap, { parse_mode: 'Markdown' }); }
      } else {
        await bot.sendMessage(chatId, `${pos.source === 'bonding_curve' ? '📊' : '⚪'} *${pos.symbol}*\nSpent: ${pos.spentSui} SUI${pos.source === 'bonding_curve' ? '\n📊 ' + pos.launchpad : ''}`, { parse_mode: 'Markdown' });
      }
    } catch { await bot.sendMessage(chatId, `⚪ *${pos.symbol}* — ${pos.spentSui} SUI`, { parse_mode: 'Markdown' }); }
  }
}

async function cmdSnipe(chatId, token) {
  if (!token) {
    await bot.sendMessage(chatId, `⚡ *Sniper*\n\nUsage: /snipe [token address]\nBot buys instantly when a pool or bonding curve appears.\n\nExample: /snipe 0x1234...`, { parse_mode: 'Markdown' });
    return;
  }
  const user = getUser(chatId);
  const pd = user.pendingData || {};
  pd.snipeToken = token; pd.snipeMode = 'any';
  updateUser(chatId, { state: 'awaiting_snipe_amount', pendingData: pd });
  await bot.sendMessage(chatId, `Token: \`${truncAddr(token)}\`\n\nHow much SUI to buy when found? (e.g. 0.5)`, { parse_mode: 'Markdown' });
}

async function cmdCopyTrader(chatId, arg) {
  const user = getUser(chatId);
  const a = (arg || '').toLowerCase().trim();
  if (a === 'stop') { updateUser(chatId, { copyTraders: [] }); await bot.sendMessage(chatId, '✅ All copy traders stopped.'); return; }
  if (!a || a === 'list') {
    if (!user.copyTraders?.length) {
      await bot.sendMessage(chatId, `🔁 *Copy Trader*\n\nNo wallets tracked.\nUsage: /copytrader [wallet]\nStop: /copytrader stop`, { parse_mode: 'Markdown' });
    } else {
      const lines = user.copyTraders.map((ct, i) => `${i + 1}. \`${truncAddr(ct.wallet)}\` — ${ct.amount} SUI/trade`).join('\n');
      await bot.sendMessage(chatId, `🔁 *Copy Traders (${user.copyTraders.length}/3)*\n\n${lines}\n\nStop: /copytrader stop`, { parse_mode: 'Markdown' });
    }
    return;
  }
  if (a.startsWith('0x')) {
    user.copyTraders = user.copyTraders || [];
    if (user.copyTraders.length >= 3) { await bot.sendMessage(chatId, '❌ Max 3 copy traders.'); return; }
    user.copyTraders.push({ wallet: a, amount: user.settings.copyAmount, maxPositions: 5, blacklist: [] });
    updateUser(chatId, { copyTraders: user.copyTraders });
    await bot.sendMessage(chatId, `✅ Tracking \`${truncAddr(a)}\`\n${user.settings.copyAmount} SUI/trade`, { parse_mode: 'Markdown' });
    return;
  }
  updateUser(chatId, { state: 'awaiting_copytrader_wallet' });
  await bot.sendMessage(chatId, 'Enter the wallet address to copy:');
}

async function cmdReferral(chatId) {
  const user   = getUser(chatId) || createUser(chatId);
  const link   = `https://t.me/AGENTTRADINBOT?start=${user.referralCode}`;
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const active = Object.values(usersDB).filter(u => u.referredBy === user.walletAddress && u.lastActivity > cutoff).length;
  await bot.sendMessage(chatId,
    `🔗 *Referral Dashboard*\n\nCode: \`${user.referralCode}\`\nLink: \`${link}\`\n\n👥 Total referrals: ${user.referralCount || 0}\n⚡ Active 30d: ${active}\n💰 Earned: ${(user.referralEarningsTotal || 0).toFixed(4)} SUI\n\n*Earn 25% of every fee your referrals pay — forever.*`,
    { parse_mode: 'Markdown' }
  );
}

async function cmdSettings(chatId) {
  const user = getUser(chatId);
  const s    = user.settings;
  await bot.sendMessage(chatId,
    `⚙️ *Settings*\n\nSlippage: ${s.slippage}%\nConfirm ≥: ${s.confirmThreshold} SUI\nCopy amount: ${s.copyAmount} SUI\nQuick-buy: ${(s.buyAmounts || DEFAULT_BUY_AMOUNTS).join(', ')} SUI\nTP default: ${s.tpDefault || 'None'}\nSL default: ${s.slDefault || 'None'}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📉 Slippage', callback_data: 'noop' }],
          [{ text: '0.5%', callback_data: 'slip:0.5' }, { text: '1%', callback_data: 'slip:1' }, { text: '2%', callback_data: 'slip:2' }, { text: '5%', callback_data: 'slip:5' }],
          [{ text: '💰 Edit Quick-Buy Amounts', callback_data: 'edit_buy_amounts' }],
          [{ text: '🎯 Confirm Threshold', callback_data: 'noop' }],
          [{ text: '0.1 SUI', callback_data: 'ct:0.1' }, { text: '0.5 SUI', callback_data: 'ct:0.5' }, { text: '1 SUI', callback_data: 'ct:1' }, { text: '5 SUI', callback_data: 'ct:5' }],
          [{ text: '🔑 Export Private Key', callback_data: 'export_key' }],
        ],
      },
    }
  );
}

async function cmdHelp(chatId) {
  await bot.sendMessage(chatId,
    `🤖 *AGENT TRADING BOT*\n\n` +
    `*Trading*\n/buy [ca] [sui] — Buy any token\n/sell [ca] [%] — Sell with % control\n\n` +
    `*Advanced*\n/snipe [ca] — Auto-buy on pool creation\n/copytrader [wallet] — Mirror wallet buys\n\n` +
    `*Info*\n/scan [ca] — Full token safety scan\n/balance — Wallet balances\n/positions — P&L charts\n\n` +
    `*Account*\n/referral — Referral earnings\n/settings — Slippage, buy amounts, key export\n\n` +
    `*DEXes:* Cetus · Turbos · Aftermath · Bluefin · Kriya · FlowX · DeepBook (via 7K)\n` +
    `*Launchpads:* MovePump · hop.fun · MoonBags · Turbos.fun · blast.fun\n\n` +
    `*Fee:* 1% per trade · Referrers earn 25% forever`,
    { parse_mode: 'Markdown' }
  );
}

// ─────────────────────────────────────────────
// 20. BOT + GATE (locked/unlocked check)
// ─────────────────────────────────────────────

const bot = new TelegramBot(TG_BOT_TOKEN, { polling: true });

async function requireUnlocked(chatId, fn) {
  const user = getUser(chatId);
  if (!user?.walletAddress) { await bot.sendMessage(chatId, '❌ No wallet. Use /start first.'); return; }
  if (user.cooldownUntil && Date.now() < user.cooldownUntil) {
    await bot.sendMessage(chatId, `🔒 Cooldown — wait ${Math.ceil((user.cooldownUntil - Date.now()) / 1000)}s.`); return;
  }
  if (isLocked(user)) { updateUser(chatId, { state: 'awaiting_unlock_pin' }); await bot.sendMessage(chatId, '🔒 Bot locked. Enter your PIN:'); return; }
  updateUser(chatId, { lastActivity: Date.now() });
  try { await fn(user); }
  catch (e) { console.error(`[${chatId}]`, e.message); await bot.sendMessage(chatId, `❌ ${e.message?.slice(0, 180) || 'Error'}`); }
}

// ─────────────────────────────────────────────
// 21. /start
// ─────────────────────────────────────────────

bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const param  = sanitize((match[1] || '').trim());
  let user = getUser(chatId);

  if (!user) {
    user = createUser(chatId);
    if (param.startsWith('AGT-')) {
      const ref = Object.values(usersDB).find(u => u.referralCode === param && u.chatId !== String(chatId));
      if (ref?.walletAddress) {
        updateUser(chatId, { referredBy: ref.walletAddress });
        updateUser(ref.chatId, { referralCount: (ref.referralCount || 0) + 1 });
        bot.sendMessage(ref.chatId, `🎉 New user joined via your referral!`);
      }
    }
  }

  if (user.walletAddress) {
    await bot.sendMessage(chatId, `👋 Welcome back!\n\nWallet: \`${truncAddr(user.walletAddress)}\``, { parse_mode: 'Markdown', reply_markup: MAIN_KB });
  } else {
    await bot.sendMessage(chatId,
      `👋 Welcome to *AGENT TRADING BOT*\n\nThe fastest trading bot on Sui. Connect your wallet to get started:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '🔑 Import Existing Wallet', callback_data: 'import_wallet' }],
        [{ text: '✨ Create New Wallet',       callback_data: 'gen_wallet'    }],
      ] } }
    );
  }
});

// ─────────────────────────────────────────────
// 22. CALLBACKS
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
      await bot.sendMessage(chatId, `🔑 Send your private key (starts with \`suiprivkey1...\`)\n\n⚠️ Message deleted immediately.`, { parse_mode: 'Markdown' });
      return;
    }

    if (data === 'gen_wallet') {
      const kp   = new Ed25519Keypair();
      const addr = kp.getPublicKey().toSuiAddress();
      const sk   = kp.getSecretKey(); // raw private key string
      updateUser(chatId, { encryptedKey: encryptKey(sk), walletAddress: addr, state: 'awaiting_pin_set' });
      // Show the private key immediately so user can back it up
      await bot.sendMessage(chatId,
        `✅ *Wallet Generated!*\n\nAddress:\n\`${addr}\`\n\n` +
        `🔑 *Private Key (save this offline NOW):*\n\`${sk}\`\n\n` +
        `⚠️ This is the ONLY time this is shown. Store it somewhere safe.\n\nNow set a 4-digit PIN:`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // ── Buy flow
    if (data.startsWith('ba:')) {
      const user = getUser(chatId);
      if (!user?.pendingData?.coinType) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
      const key = data.split(':')[1];
      if (key === 'c') { updateUser(chatId, { state: 'awaiting_buy_custom_amount' }); await bot.sendMessage(chatId, `💬 Enter amount in SUI (e.g. 2.5):`); return; }
      const amtIdx = parseInt(key), amounts = user.settings.buyAmounts || DEFAULT_BUY_AMOUNTS;
      const amountSui = amounts[amtIdx];
      if (!amountSui) { await bot.sendMessage(chatId, '❌ Invalid.'); return; }
      await showBuyConfirm(chatId, user.pendingData.coinType, amountSui, msgId);
      return;
    }

    if (data === 'bc') {
      const user = getUser(chatId);
      if (!user?.pendingData?.coinType || !user?.pendingData?.amountSui) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
      await bot.editMessageText('⚡ Executing buy...', { chat_id: chatId, message_id: msgId });
      try {
        const res = await executeBuy(chatId, user.pendingData.coinType, user.pendingData.amountSui);
        await bot.editMessageText(
          `✅ *Buy Executed!*\n\nToken: *${res.symbol}*\nSpent: ${user.pendingData.amountSui} SUI\nFee: ${res.feeSui} SUI\n${res.estOut !== '?' ? `Received: ~${res.estOut} ${res.symbol}\n` : ''}Route: ${res.route}${res.state === 'bonding_curve' ? `\n📊 ${res.launchpadName}` : ''}\n\n🔗 [View TX](${SUISCAN_TX}${res.digest})`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
        );
      } catch (e) { await bot.editMessageText(`❌ Buy failed: ${e.message?.slice(0, 180)}`, { chat_id: chatId, message_id: msgId }); }
      updateUser(chatId, { pendingData: {} }); return;
    }

    // ── Sell flow
    if (data.startsWith('st:')) {
      const user = getUser(chatId);
      const pos  = user?.positions?.[parseInt(data.split(':')[1])];
      if (!pos) { await bot.sendMessage(chatId, '❌ Position not found.'); return; }
      updateUser(chatId, { pendingData: { ...user.pendingData, coinType: pos.coinType, symbol: pos.symbol } });
      await showSellPercentButtons(chatId, pos.coinType, pos.symbol, msgId);
      return;
    }

    if (data.startsWith('sp:')) {
      const user = getUser(chatId);
      if (!user?.pendingData?.coinType) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
      const key = data.split(':')[1];
      if (key === 'c') { updateUser(chatId, { state: 'awaiting_sell_custom_pct' }); await bot.sendMessage(chatId, `💬 Enter % to sell (1-100):`); return; }
      const pct = parseInt(key);
      updateUser(chatId, { pendingData: { ...user.pendingData, sellPct: pct } });
      await showSellConfirm(chatId, user.pendingData.coinType, pct, msgId);
      return;
    }

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
      } catch (e) { await bot.editMessageText(`❌ Sell failed: ${e.message?.slice(0, 180)}`, { chat_id: chatId, message_id: msgId }); }
      updateUser(chatId, { pendingData: {} }); return;
    }

    if (data === 'ca') { updateUser(chatId, { state: null, pendingData: {} }); await bot.editMessageText('❌ Cancelled.', { chat_id: chatId, message_id: msgId }).catch(() => {}); return; }

    // ── Raw CA paste flow
    if (data === 'bfs') {
      const user = getUser(chatId);
      if (!user?.pendingData?.coinType) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
      await requireUnlocked(chatId, async () => { await startBuyFlow(chatId, user.pendingData.coinType); });
      return;
    }
    if (data === 'sfs') {
      const user = getUser(chatId);
      if (!user?.pendingData?.coinType) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
      const meta = await getCoinMeta(user.pendingData.coinType) || {};
      await requireUnlocked(chatId, async () => { await startSellFlow(chatId, user.pendingData.coinType, meta.symbol || truncAddr(user.pendingData.coinType)); });
      return;
    }
    if (data === 'sct') {
      const user = getUser(chatId);
      if (!user?.pendingData?.coinType) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
      const m = await bot.sendMessage(chatId, '🔍 Scanning...');
      try { const scan = await scanToken(user.pendingData.coinType); await bot.editMessageText(formatScanReport(scan), { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' }); }
      catch (e) { await bot.editMessageText(`❌ ${e.message?.slice(0, 100)}`, { chat_id: chatId, message_id: m.message_id }); }
      return;
    }

    // ── Settings
    if (data.startsWith('slip:')) {
      const u = getUser(chatId); if (u) { u.settings.slippage = parseFloat(data.split(':')[1]); saveUsers(); }
      await bot.sendMessage(chatId, `✅ Slippage set to ${data.split(':')[1]}%`); return;
    }
    if (data.startsWith('ct:')) {
      const u = getUser(chatId); if (u) { u.settings.confirmThreshold = parseFloat(data.split(':')[1]); saveUsers(); }
      await bot.sendMessage(chatId, `✅ Confirm threshold: ${data.split(':')[1]} SUI`); return;
    }
    if (data === 'edit_buy_amounts') {
      updateUser(chatId, { state: 'awaiting_buy_amounts_edit' });
      await bot.sendMessage(chatId, `⚙️ Enter 4 buy amounts (space-separated):\n_Example: 0.5 1 3 5_`, { parse_mode: 'Markdown' }); return;
    }

    // ── Export private key (requires PIN re-entry)
    if (data === 'export_key') {
      const user = getUser(chatId);
      if (!user?.encryptedKey) { await bot.sendMessage(chatId, '❌ No wallet to export.'); return; }
      updateUser(chatId, { state: 'awaiting_export_pin' });
      await bot.sendMessage(chatId, `🔑 *Export Private Key*\n\nEnter your PIN to confirm:`, { parse_mode: 'Markdown' }); return;
    }

  } catch (e) { console.error('CB error:', e.message); await bot.sendMessage(chatId, `❌ ${e.message?.slice(0, 120)}`); }
});

// ─────────────────────────────────────────────
// 23. BUY / SELL FLOW HELPERS
// ─────────────────────────────────────────────

async function startBuyFlow(chatId, coinType) {
  const user   = getUser(chatId); if (!user) return;
  const state  = await detectTokenState(coinType);
  const meta   = await getCoinMeta(coinType) || {};
  const symbol = meta.symbol || truncAddr(coinType);
  updateUser(chatId, { pendingData: { coinType, symbol } });
  const amounts = user.settings.buyAmounts || DEFAULT_BUY_AMOUNTS;
  const amtBtns = amounts.map((a, i) => ({ text: `${a} SUI`, callback_data: `ba:${i}` }));
  let info = `Token: *${symbol}*\n\`${truncAddr(coinType)}\`\n\n`;
  if (state.state === 'graduated')     info += `✅ On DEX — best price via aggregator`;
  else if (state.state === 'bonding_curve') info += `📊 Bonding curve — ${state.launchpadName}\n→ Graduates to ${state.destinationDex}`;
  else                                 info += `⚠️ Token state unknown`;
  info += `\n\n*Select amount to buy:*`;
  await bot.sendMessage(chatId, info, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [amtBtns, [{ text: '✏️ Custom', callback_data: 'ba:c' }, { text: '⚙️ Edit Defaults', callback_data: 'edit_buy_amounts' }, { text: '❌', callback_data: 'ca' }]] } });
}

async function showBuyConfirm(chatId, coinType, amountSui, editMsgId) {
  const user = getUser(chatId); if (!user) return;
  const meta = await getCoinMeta(coinType) || {};
  const symbol = meta.symbol || truncAddr(coinType);
  const amountMist = mistFromSui(amountSui);
  const { feeMist } = calcFee(amountMist, user);
  updateUser(chatId, { pendingData: { ...user.pendingData, amountSui } });
  let estOut = '?';
  try { const k = await sdk7k(); const q = await k.getQuote({ tokenIn: SUI_TYPE, tokenOut: coinType, amountIn: (amountMist - feeMist).toString() }); if (q?.outAmount) estOut = (Number(q.outAmount) / Math.pow(10, meta.decimals || 9)).toFixed(4); } catch {}
  const text = `💰 *Confirm Buy*\n\nToken: *${symbol}*\nAmount: ${amountSui} SUI\nFee (1%): ${suiFloat(feeMist)} SUI\nYou trade: ${suiFloat(amountMist - feeMist)} SUI\n${estOut !== '?' ? `Est. receive: ~${estOut} ${symbol}\n` : ''}Slippage: ${user.settings.slippage}%`;
  const kb = { inline_keyboard: [[{ text: '✅ Confirm', callback_data: 'bc' }, { text: '❌ Cancel', callback_data: 'ca' }]] };
  if (editMsgId) { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: kb }).catch(async () => { await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb }); }); }
  else await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function startSellFlow(chatId, coinType, symbol) {
  const user = getUser(chatId); if (!user) return;
  updateUser(chatId, { pendingData: { coinType, symbol } });
  await showSellPercentButtons(chatId, coinType, symbol, null);
}

async function showSellPercentButtons(chatId, coinType, symbol, editMsgId) {
  const user = getUser(chatId); if (!user) return;
  const coins = await getOwnedCoins(user.walletAddress, coinType).catch(() => []);
  if (!coins.length) { await bot.sendMessage(chatId, `❌ No ${symbol || truncAddr(coinType)} balance.`); return; }
  const meta = await getCoinMeta(coinType) || {};
  const total = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
  const disp  = (Number(total) / Math.pow(10, meta.decimals || 9)).toFixed(4);
  const text  = `💸 *Sell ${symbol || truncAddr(coinType)}*\n\nBalance: ${disp} ${symbol || ''}\n\n*Choose amount:*`;
  const kb    = { inline_keyboard: [[{ text: '25%', callback_data: 'sp:25' }, { text: '50%', callback_data: 'sp:50' }, { text: '75%', callback_data: 'sp:75' }, { text: '100%', callback_data: 'sp:100' }], [{ text: '✏️ Custom %', callback_data: 'sp:c' }, { text: '❌ Cancel', callback_data: 'ca' }]] };
  if (editMsgId) { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: kb }).catch(async () => { await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb }); }); }
  else await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function showSellConfirm(chatId, coinType, pct, editMsgId) {
  const user = getUser(chatId); if (!user) return;
  const meta = await getCoinMeta(coinType) || {};
  const symbol = meta.symbol || truncAddr(coinType);
  const coins = await getOwnedCoins(user.walletAddress, coinType).catch(() => []);
  const total = coins.reduce((s, c) => s + BigInt(c.balance), 0n);
  const sellAm = (total * BigInt(pct)) / 100n;
  const dispAm = (Number(sellAm) / Math.pow(10, meta.decimals || 9)).toFixed(4);
  let estSui = '?';
  try { const k = await sdk7k(); const q = await k.getQuote({ tokenIn: coinType, tokenOut: SUI_TYPE, amountIn: sellAm.toString() }); if (q?.outAmount) estSui = (Number(q.outAmount) / 1e9).toFixed(4); } catch {}
  const text = `💸 *Confirm Sell*\n\nToken: *${symbol}*\nSelling: ${pct}% (${dispAm} ${symbol})\n${estSui !== '?' ? `Est. receive: ~${estSui} SUI\n` : ''}Slippage: ${user.settings.slippage}%`;
  const kb = { inline_keyboard: [[{ text: '✅ Confirm', callback_data: 'sc' }, { text: '❌ Cancel', callback_data: 'ca' }]] };
  if (editMsgId) { await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'Markdown', reply_markup: kb }).catch(async () => { await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb }); }); }
  else await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: kb });
}

async function handleSellButton(chatId, user) {
  const positions = user.positions?.filter(p => p.coinType) || [];
  if (positions.length > 0) {
    const posButtons = positions.slice(0, 6).map((p, i) => [{ text: `${p.symbol} — ${p.spentSui} SUI`, callback_data: `st:${i}` }]);
    posButtons.push([{ text: '📝 Enter CA manually', callback_data: 'ca' }]);
    await bot.sendMessage(chatId, `💸 *Sell — Select Position*\n\nTap a token to sell:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: posButtons } });
    updateUser(chatId, { state: 'awaiting_sell_ca' });
  } else {
    await bot.sendMessage(chatId, `Send the token contract address:\n\n_Example: 0x1234...5678_`, { parse_mode: 'Markdown' });
    updateUser(chatId, { state: 'awaiting_sell_ca' });
  }
}

// ─────────────────────────────────────────────
// 24. MESSAGE HANDLER — state machine + keyboard
// All keyboard buttons call named functions directly.
// NO bot.emit() — that doesn't trigger onText handlers.
// ─────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const text   = sanitize(msg.text);
  if (!text) return;

  const user  = getUser(chatId) || createUser(chatId);
  const state = user.state;

  if (!text.startsWith('/')) {
    // ── Keyboard button routing — direct function calls (not bot.emit)
    const kbRoutes = {
      '💰 Buy':        async () => { await bot.sendMessage(chatId, `Send the token CA or $TICKER:\n\n_Example: 0x1234...5678 or $AGENT_`, { parse_mode: 'Markdown' }); updateUser(chatId, { state: 'awaiting_buy_ca' }); },
      '💸 Sell':       async () => { await requireUnlocked(chatId, async (u) => { await handleSellButton(chatId, u); }); },
      '📊 Positions':  async () => { await requireUnlocked(chatId, async () => { await cmdPositions(chatId); }); },
      '💼 Balance':    async () => { await requireUnlocked(chatId, async () => { await cmdBalance(chatId); }); },
      '🔍 Scan':       async () => { await bot.sendMessage(chatId, `Send the token contract address:\n\n_Example: 0x1234...5678_`, { parse_mode: 'Markdown' }); updateUser(chatId, { state: 'awaiting_scan_ca' }); },
      '⚡ Snipe':      async () => { await requireUnlocked(chatId, async () => { await cmdSnipe(chatId, null); }); },
      '🔁 Copy Trade': async () => { await requireUnlocked(chatId, async () => { await cmdCopyTrader(chatId, null); }); },
      '🔗 Referral':   async () => { await cmdReferral(chatId); },
      '⚙️ Settings':   async () => { await requireUnlocked(chatId, async () => { await cmdSettings(chatId); }); },
      '❓ Help':        async () => { await cmdHelp(chatId); },
    };

    if (kbRoutes[text]) { await kbRoutes[text](); return; }

    // ── State machine
    if (state === 'awaiting_buy_ca') {
      updateUser(chatId, { state: null });
      const ct = text.startsWith('0x') ? text : (await resolveSymbol(text));
      if (!ct) { await bot.sendMessage(chatId, '❌ Token not found. Use full contract address.'); return; }
      await requireUnlocked(chatId, async () => { await startBuyFlow(chatId, ct); }); return;
    }

    if (state === 'awaiting_sell_ca') {
      updateUser(chatId, { state: null });
      const ct = text.startsWith('0x') ? text : (await resolveSymbol(text));
      if (!ct) { await bot.sendMessage(chatId, '❌ Token not found.'); return; }
      const meta = await getCoinMeta(ct) || {};
      await requireUnlocked(chatId, async () => { await startSellFlow(chatId, ct, meta.symbol || truncAddr(ct)); }); return;
    }

    if (state === 'awaiting_scan_ca') {
      updateUser(chatId, { state: null });
      const ct = text.startsWith('0x') ? text : (await resolveSymbol(text));
      if (!ct) { await bot.sendMessage(chatId, '❌ Token not found.'); return; }
      const m = await bot.sendMessage(chatId, '🔍 Scanning...');
      try { await bot.editMessageText(formatScanReport(await scanToken(ct)), { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' }); }
      catch (e) { await bot.editMessageText(`❌ ${e.message?.slice(0, 100)}`, { chat_id: chatId, message_id: m.message_id }); }
      return;
    }

    if (state === 'awaiting_buy_custom_amount') {
      updateUser(chatId, { state: null });
      const amt = parseFloat(text);
      if (isNaN(amt) || amt <= 0) { await bot.sendMessage(chatId, '❌ Enter a number like 2.5'); return; }
      const ct = user.pendingData?.coinType;
      if (!ct) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
      await showBuyConfirm(chatId, ct, amt, null); return;
    }

    if (state === 'awaiting_sell_custom_pct') {
      updateUser(chatId, { state: null });
      const pct = parseFloat(text);
      if (isNaN(pct) || pct <= 0 || pct > 100) { await bot.sendMessage(chatId, '❌ Enter 1-100'); return; }
      const ct = user.pendingData?.coinType;
      if (!ct) { await bot.sendMessage(chatId, '❌ Session expired.'); return; }
      updateUser(chatId, { pendingData: { ...user.pendingData, sellPct: pct } });
      await showSellConfirm(chatId, ct, pct, null); return;
    }

    if (state === 'awaiting_buy_amounts_edit') {
      updateUser(chatId, { state: null });
      const parts = text.split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0).slice(0, 4);
      if (parts.length < 2) { await bot.sendMessage(chatId, '❌ Enter at least 2 amounts, e.g. 0.5 1 3 5'); return; }
      while (parts.length < 4) parts.push(parts[parts.length - 1] * 2);
      const u = getUser(chatId); if (u) { u.settings.buyAmounts = parts; saveUsers(); }
      await bot.sendMessage(chatId, `✅ Quick-buy amounts: ${parts.join(', ')} SUI`); return;
    }

    if (state === 'awaiting_private_key') {
      updateUser(chatId, { state: null });
      try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
      try {
        const decoded = decodeSuiPrivateKey(text);
        const kp      = Ed25519Keypair.fromSecretKey(decoded.secretKey);
        const addr    = kp.getPublicKey().toSuiAddress();
        updateUser(chatId, { encryptedKey: encryptKey(text), walletAddress: addr, state: 'awaiting_pin_set' });
        await bot.sendMessage(chatId, `✅ Wallet imported!\n\nAddress: \`${addr}\`\n\nSet a 4-digit PIN:`, { parse_mode: 'Markdown' });
      } catch { await bot.sendMessage(chatId, '❌ Invalid key. Try /start again.'); }
      return;
    }

    if (state === 'awaiting_pin_set') {
      if (!/^\d{4}$/.test(text)) { await bot.sendMessage(chatId, '❌ Must be 4 digits:'); return; }
      updateUser(chatId, { pinHash: hashPin(text), state: null });
      await bot.sendMessage(chatId, `✅ All set! Bot auto-locks after 30min.\n\nUse the buttons below to trade.`, { reply_markup: MAIN_KB });
      syncToBackend(getUser(chatId)); return;
    }

    if (state === 'awaiting_unlock_pin') {
      if (!/^\d{4}$/.test(text)) { await bot.sendMessage(chatId, '❌ Enter 4-digit PIN:'); return; }
      if (hashPin(text) === user.pinHash) {
        unlockUser(chatId); updateUser(chatId, { state: null, failAttempts: 0, cooldownUntil: 0 });
        await bot.sendMessage(chatId, '🔓 Unlocked!', { reply_markup: MAIN_KB });
      } else {
        const fails = (user.failAttempts || 0) + 1;
        if (fails >= MAX_FAILS) { updateUser(chatId, { failAttempts: 0, cooldownUntil: Date.now() + COOLDOWN_MS }); await bot.sendMessage(chatId, '❌ Too many attempts. Locked 5min.'); }
        else { updateUser(chatId, { failAttempts: fails }); await bot.sendMessage(chatId, `❌ Wrong PIN. ${MAX_FAILS - fails} attempts left.`); }
      }
      return;
    }

    if (state === 'awaiting_export_pin') {
      if (!/^\d{4}$/.test(text)) { await bot.sendMessage(chatId, '❌ Enter 4-digit PIN:'); return; }
      if (hashPin(text) !== user.pinHash) { await bot.sendMessage(chatId, '❌ Wrong PIN.'); return; }
      updateUser(chatId, { state: null });
      try {
        const pk = decryptPrivKey(user.encryptedKey);
        const m  = await bot.sendMessage(chatId, `🔑 *Your Private Key:*\n\`${pk}\`\n\n⚠️ Save this offline. Delete this message after copying.`, { parse_mode: 'Markdown' });
        // Auto-delete after 60 seconds for security
        setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => {}), 60_000);
      } catch (e) { await bot.sendMessage(chatId, `❌ Could not export key: ${e.message}`); }
      return;
    }

    if (state === 'awaiting_snipe_amount') {
      const amt = parseFloat(text);
      if (isNaN(amt) || amt <= 0) { await bot.sendMessage(chatId, '❌ Invalid amount.'); return; }
      const pd = user.pendingData || {};
      user.snipeWatches = user.snipeWatches || [];
      user.snipeWatches.push({ coinType: pd.snipeToken, buyAmount: amt, mode: pd.snipeMode || 'any', triggered: false, addedAt: Date.now() });
      updateUser(chatId, { state: null, pendingData: {}, snipeWatches: user.snipeWatches });
      await bot.sendMessage(chatId, `⚡ *Snipe set!*\n\nToken: \`${truncAddr(pd.snipeToken)}\`\nBuy: ${amt} SUI\nWatching...`, { parse_mode: 'Markdown' }); return;
    }

    if (state === 'awaiting_copytrader_wallet') {
      if (!text.startsWith('0x')) { await bot.sendMessage(chatId, '❌ Invalid wallet address.'); return; }
      user.copyTraders = user.copyTraders || [];
      if (user.copyTraders.length >= 3) { await bot.sendMessage(chatId, '❌ Max 3 copy traders.'); updateUser(chatId, { state: null }); return; }
      user.copyTraders.push({ wallet: text, amount: user.settings.copyAmount, maxPositions: 5, blacklist: [] });
      updateUser(chatId, { state: null, copyTraders: user.copyTraders });
      await bot.sendMessage(chatId, `✅ Tracking \`${truncAddr(text)}\``, { parse_mode: 'Markdown' }); return;
    }

    // Raw CA paste
    if (text.startsWith('0x') && text.length > 40) {
      updateUser(chatId, { pendingData: { coinType: text } });
      await bot.sendMessage(chatId, `📋 Contract detected:\n\`${truncAddr(text)}\`\n\nWhat do you want to do?`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '💰 Buy', callback_data: 'bfs' }, { text: '💸 Sell', callback_data: 'sfs' }], [{ text: '🔍 Scan Token', callback_data: 'sct' }, { text: '❌ Cancel', callback_data: 'ca' }]] },
      }); return;
    }
  }
});

// ─────────────────────────────────────────────
// 25. SLASH COMMAND HANDLERS
// These call the same named functions as keyboard buttons.
// ─────────────────────────────────────────────

bot.onText(/\/buy(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const args   = sanitize(match[1] || '');
  await requireUnlocked(chatId, async (user) => {
    if (!args) { updateUser(chatId, { state: 'awaiting_buy_ca' }); await bot.sendMessage(chatId, `Send the token CA or $TICKER:`); return; }
    const parts = args.split(/\s+/);
    let ct = parts[0].startsWith('0x') ? parts[0] : (await resolveSymbol(parts[0]));
    if (!ct) { await bot.sendMessage(chatId, '❌ Token not found.'); return; }
    if (parts[1]) { const a = parseFloat(parts[1]); if (!isNaN(a) && a > 0) { updateUser(chatId, { pendingData: { coinType: ct } }); await showBuyConfirm(chatId, ct, a, null); return; } }
    await startBuyFlow(chatId, ct);
  });
});

bot.onText(/\/sell(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const args   = sanitize(match[1] || '');
  await requireUnlocked(chatId, async (user) => {
    if (!args) { await handleSellButton(chatId, user); return; }
    const parts = args.split(/\s+/);
    let ct = parts[0].startsWith('0x') ? parts[0] : (await resolveSymbol(parts[0]));
    if (!ct) { await bot.sendMessage(chatId, '❌ Token not found.'); return; }
    const meta = await getCoinMeta(ct) || {};
    if (parts[1]) { const p = parts[1].toLowerCase().replace('%',''); const pct = p === 'all' ? 100 : parseFloat(p); if (!isNaN(pct)) { updateUser(chatId, { pendingData: { coinType: ct, symbol: meta.symbol } }); await showSellConfirm(chatId, ct, pct, null); return; } }
    await startSellFlow(chatId, ct, meta.symbol || truncAddr(ct));
  });
});

bot.onText(/\/scan(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const arg    = sanitize(match[1] || '');
  if (!arg) { updateUser(chatId, { state: 'awaiting_scan_ca' }); await bot.sendMessage(chatId, `Send the token contract address:`); return; }
  const ct = arg.startsWith('0x') ? arg : (await resolveSymbol(arg));
  if (!ct) { await bot.sendMessage(chatId, '❌ Token not found.'); return; }
  const m = await bot.sendMessage(chatId, '🔍 Scanning...');
  try { await bot.editMessageText(formatScanReport(await scanToken(ct)), { chat_id: chatId, message_id: m.message_id, parse_mode: 'Markdown' }); }
  catch (e) { await bot.editMessageText(`❌ ${e.message?.slice(0, 100)}`, { chat_id: chatId, message_id: m.message_id }); }
});

bot.onText(/\/balance/, async (msg) => { await requireUnlocked(msg.chat.id, async () => { await cmdBalance(msg.chat.id); }); });
bot.onText(/\/positions/, async (msg) => { await requireUnlocked(msg.chat.id, async () => { await cmdPositions(msg.chat.id); }); });
bot.onText(/\/snipe(?:\s+(.+))?/, async (msg, match) => { await requireUnlocked(msg.chat.id, async () => { await cmdSnipe(msg.chat.id, sanitize(match[1] || '')); }); });
bot.onText(/\/copytrader(?:\s+(.+))?/, async (msg, match) => { await requireUnlocked(msg.chat.id, async () => { await cmdCopyTrader(msg.chat.id, sanitize(match[1] || '')); }); });
bot.onText(/\/settings/, async (msg) => { await requireUnlocked(msg.chat.id, async () => { await cmdSettings(msg.chat.id); }); });
bot.onText(/\/referral/, async (msg) => { await cmdReferral(msg.chat.id); });
bot.onText(/\/help/, async (msg) => { await cmdHelp(msg.chat.id); });

// ─────────────────────────────────────────────
// 26. ERROR & STARTUP
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
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  AGENT TRADING BOT v4 — Starting');
  console.log(`  Users: ${Object.keys(usersDB).length} | RPC: ${RPC_URL}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await sdk7k().then(() => console.log('✅ 7K Aggregator')).catch(e => console.warn('⚠️ 7K:', e.message));
  await sdkCetus().then(() => console.log('✅ Cetus SDK')).catch(e => console.warn('⚠️ Cetus:', e.message));
  await sdkTurbos().then(() => console.log('✅ Turbos SDK')).catch(e => console.warn('⚠️ Turbos:', e.message));

  setInterval(checkInactivity, 60_000);
  positionMonitor().catch(e => console.error('Position monitor crashed:', e));
  sniperEngine().catch(e => console.error('Sniper crashed:', e));
  copyTraderEngine().catch(e => console.error('Copy trader crashed:', e));

  console.log('  Bot is live!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (ADMIN_CHAT_ID) bot.sendMessage(ADMIN_CHAT_ID, '🟢 AGENT TRADING BOT v4 online.').catch(() => {});
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
