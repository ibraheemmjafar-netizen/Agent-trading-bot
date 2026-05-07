// RaidenX-style PnL flex card generator
// Uses bundled Inter font so text renders on slim Linux containers (Railway, etc).
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

// Register Inter once. Variable font supplies all weights.
const _here = dirname(fileURLToPath(import.meta.url));
const _fontPath = join(_here, 'fonts', 'Inter-Regular.ttf');
if (existsSync(_fontPath) && !GlobalFonts.has('Inter')) {
  try { GlobalFonts.registerFromPath(_fontPath, 'Inter'); } catch {}
}
const FAM = GlobalFonts.has('Inter') ? 'Inter' : 'sans-serif';

const W = 900, H = 900;

function fmtMoney(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v/1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v/1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v/1e3).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}
function fmtSui(v) {
  if (v == null || !isFinite(v)) return '—';
  return `${v.toFixed(4)} SUI`;
}

function drawStars(ctx, count, seed) {
  let s = seed;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < count; i++) {
    const x = rnd() * W, y = rnd() * H * 0.7, r = rnd() * 1.6 + 0.3;
    ctx.globalAlpha = 0.3 + rnd() * 0.6;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawPlanet(ctx, x, y, r, color, glow) {
  // soft glow
  const g = ctx.createRadialGradient(x, y, r*0.4, x, y, r*1.8);
  g.addColorStop(0, glow); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r*1.8, 0, Math.PI*2); ctx.fill();
  // body
  const body = ctx.createRadialGradient(x - r*0.4, y - r*0.4, r*0.1, x, y, r);
  body.addColorStop(0, '#ffffff'); body.addColorStop(0.4, color); body.addColorStop(1, '#000');
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
}

function drawHills(ctx) {
  // bottom dark hills
  ctx.fillStyle = '#0a1410';
  ctx.beginPath();
  ctx.moveTo(0, H);
  ctx.lineTo(0, H - 120);
  for (let x = 0; x <= W; x += 30) {
    const y = H - 120 - Math.sin(x * 0.012) * 25 - Math.cos(x * 0.04) * 10;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(W, H);
  ctx.closePath(); ctx.fill();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y,   x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x,   y+h, r);
  ctx.arcTo(x,   y+h, x,   y,   r);
  ctx.arcTo(x,   y,   x+w, y,   r);
  ctx.closePath();
}

export function renderPnlCard(opts) {
  const {
    sym = 'TOKEN',
    pct = 0,
    entryLabel = 'Entry MC',
    entryValue = '—',
    currentLabel = 'Current MC',
    currentValue = '—',
    ts = new Date(),
    botHandle = '@mytestwalidbot',
    botName = 'AGENT TRADING BOT',
  } = opts;

  const positive = pct >= 0;
  const accent   = positive ? '#5cffb1' : '#ff6b8a';
  const accentDim= positive ? '#1a3d2a' : '#3d1a23';
  const bgTop    = positive ? '#0a2018' : '#200a14';
  const bgBot    = '#020608';

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, bgTop); bg.addColorStop(0.6, '#020a10'); bg.addColorStop(1, bgBot);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  drawStars(ctx, 110, 31);
  drawPlanet(ctx, 95,  205, 38, '#7aa3a3', 'rgba(120,200,200,0.25)');
  drawPlanet(ctx, 805, 110, 52, '#3fd8c8', 'rgba(63,216,200,0.30)');
  drawPlanet(ctx, 820, 510, 22, '#79e8d4', 'rgba(120,232,212,0.22)');
  drawPlanet(ctx, 70,  820, 62, '#28a08e', 'rgba(40,160,142,0.28)');

  // central card
  const cx = 80, cy = 90, cw = W - 160, ch = 540;
  const cardGrad = ctx.createLinearGradient(cx, cy, cx, cy+ch);
  cardGrad.addColorStop(0, 'rgba(20,46,38,0.95)'); cardGrad.addColorStop(1, 'rgba(8,18,16,0.95)');
  ctx.fillStyle = cardGrad;
  roundRect(ctx, cx, cy, cw, ch, 28); ctx.fill();
  // subtle border
  ctx.strokeStyle = 'rgba(92,255,177,0.18)'; ctx.lineWidth = 1.5;
  roundRect(ctx, cx, cy, cw, ch, 28); ctx.stroke();

  // glowing radial behind percentage
  const halo = ctx.createRadialGradient(W/2, 320, 30, W/2, 320, 280);
  halo.addColorStop(0, positive ? 'rgba(92,255,177,0.18)' : 'rgba(255,107,138,0.18)');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(W/2, 320, 280, 0, Math.PI*2); ctx.fill();

  // bot title (top of card)
  ctx.fillStyle = '#cfeee0';
  ctx.font = `600 28px ${FAM}`;
  ctx.textAlign = 'center';
  ctx.fillText(botName, W/2, cy + 52);

  // symbol
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 46px ${FAM}`;
  ctx.fillText(`$${sym.toUpperCase()}`, W/2, cy + 130);

  // BIG percentage
  const pctStr = `${positive?'+':''}${pct.toFixed(2)}%`;
  ctx.fillStyle = accent;
  ctx.font = `800 130px ${FAM}`;
  ctx.fillText(pctStr, W/2, cy + 280);

  // Entry / Current panel
  const px = cx + 50, py = cy + 340, pw = cw - 100, ph = 150;
  ctx.fillStyle = 'rgba(8,22,18,0.85)';
  roundRect(ctx, px, py, pw, ph, 18); ctx.fill();
  ctx.strokeStyle = 'rgba(92,255,177,0.10)'; ctx.lineWidth = 1;
  roundRect(ctx, px, py, pw, ph, 18); ctx.stroke();

  // row 1
  ctx.textAlign = 'left';
  ctx.fillStyle = '#9ec0b3'; ctx.font = `500 26px ${FAM}`;
  ctx.fillText(entryLabel, px + 28, py + 50);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff'; ctx.font = `700 28px ${FAM}`;
  ctx.fillText(String(entryValue), px + pw - 28, py + 50);
  // divider
  ctx.strokeStyle = 'rgba(92,255,177,0.12)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px + 24, py + 78); ctx.lineTo(px + pw - 24, py + 78); ctx.stroke();
  // row 2
  ctx.textAlign = 'left';
  ctx.fillStyle = '#9ec0b3'; ctx.font = `500 26px ${FAM}`;
  ctx.fillText(currentLabel, px + 28, py + 118);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffffff'; ctx.font = `700 28px ${FAM}`;
  ctx.fillText(String(currentValue), px + pw - 28, py + 118);

  drawHills(ctx);

  // footer: bot handle + timestamp
  ctx.textAlign = 'center';
  ctx.fillStyle = '#7d9a8e';
  ctx.font = `500 22px ${FAM}`;
  const tsStr = ts.toISOString().slice(0,19).replace('T',' ') + ' (UTC)';
  ctx.fillText(`${botHandle}  ·  ${tsStr}`, W/2, H - 30);

  return canvas.toBuffer('image/png');
}

// Convenience helpers used by the bot
export { fmtMoney, fmtSui };
