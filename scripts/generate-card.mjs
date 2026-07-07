#!/usr/bin/env node
// Generates vibe-usage-card.svg — a full 7-day dashboard replica of vibecafe.ai/usage.
// Data: GET /api/usage?days=14 (last 7 days + previous 7 for deltas).
// API key: env VIBE_USAGE_API_KEY, or local ~/.vibe-usage/config.json.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TZ_OFFSET_H = 8; // UTC+8 for day/hour grouping

function getApiKey() {
  if (process.env.VIBE_USAGE_API_KEY) return process.env.VIBE_USAGE_API_KEY;
  const p = join(homedir(), '.vibe-usage', 'config.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).apiKey;
  throw new Error('No API key: set VIBE_USAGE_API_KEY or run vibe-usage init');
}

const res = await fetch('https://vibecafe.ai/api/usage?days=14', {
  headers: { Authorization: `Bearer ${getApiKey()}` },
});
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const { buckets = [], sessions = [] } = await res.json();

// ---- split into current 7 days vs previous 7 days (UTC+8 calendar days) ----
const DAY = 86400_000;
const nowLocal = Date.now() + TZ_OFFSET_H * 3600_000;
const todayStart = Math.floor(nowLocal / DAY) * DAY; // start of today, local
const curFrom = todayStart - 6 * DAY;                // 7-day window incl. today
const prevFrom = curFrom - 7 * DAY;

const localMs = (iso) => new Date(iso).getTime() + TZ_OFFSET_H * 3600_000;

function stats(bs, ss) {
  const s = { cost: 0, total: 0, input: 0, output: 0, cached: 0,
              active: 0, duration: 0, sessions: ss.length, msgs: 0, userMsgs: 0 };
  for (const b of bs) {
    s.cost += +b.estimatedCost || 0;
    // Dashboard's 总 Token includes cached input tokens
    s.total += (+b.totalTokens || 0) + (+b.cachedInputTokens || 0);
    s.input += +b.inputTokens || 0;
    s.output += +b.outputTokens || 0;
    s.cached += +b.cachedInputTokens || 0;
  }
  for (const x of ss) {
    s.active += +x.activeSeconds || 0;
    s.duration += +x.durationSeconds || 0;
    s.msgs += +x.messageCount || 0;
    s.userMsgs += +x.userMessageCount || 0;
  }
  return s;
}

const inWin = (t, from) => t >= from && t < from + 7 * DAY;
const curB = buckets.filter(b => inWin(localMs(b.bucketStart), curFrom));
const prevB = buckets.filter(b => inWin(localMs(b.bucketStart), prevFrom));
const curS = sessions.filter(s => inWin(localMs(s.firstMessageAt), curFrom));
const prevS = sessions.filter(s => inWin(localMs(s.firstMessageAt), prevFrom));
const cur = stats(curB, curS);
const prev = stats(prevB, prevS);

// ---- daily trend: output/input/cached tokens per local day ----
const days = [];
for (let i = 0; i < 7; i++) {
  const from = curFrom + i * DAY;
  const d = new Date(from);
  days.push({ label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, output: 0, input: 0, cached: 0, total: 0 });
}
for (const b of curB) {
  const i = Math.floor((localMs(b.bucketStart) - curFrom) / DAY);
  if (i >= 0 && i < 7) {
    days[i].output += +b.outputTokens || 0;
    days[i].input += +b.inputTokens || 0;
    days[i].cached += +b.cachedInputTokens || 0;
    days[i].total += (+b.totalTokens || 0) + (+b.cachedInputTokens || 0);
  }
}

// ---- heatmap: weekday x hour from userPromptHours (arrays are UTC hours) ----
const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
for (const s of curS) {
  const t = new Date(s.firstMessageAt);
  const arr = Array.isArray(s.userPromptHours) ? s.userPromptHours : [];
  for (let hUtc = 0; hUtc < 24; hUtc++) {
    const v = +arr[hUtc] || 0;
    if (!v) continue;
    const shifted = hUtc + TZ_OFFSET_H;
    const hLocal = shifted % 24;
    const dow = (t.getUTCDay() + (shifted >= 24 ? 1 : 0)) % 7; // 0=Sun
    heat[dow][hLocal] += v;
  }
}
const heatMax = Math.max(1, ...heat.flat());

// ---- formatting ----
const fmtTok = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n));
const fmtHrs = (sec) => `${Math.floor(sec / 3600)}h ${Math.round(sec % 3600 / 60)}m`;
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const delta = (c, p) => {
  if (!p) return '';
  const d = (c - p) / p * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- SVG layout (1024 wide, mirrors vibecafe.ai/usage) ----
const W = 1024, PAD = 16, GAP = 13;
const CARD_W = (W - PAD * 2 - GAP * 4) / 5, CARD_H = 86;
const row1Y = 54, row2Y = row1Y + CARD_H + GAP;
const panelY = row2Y + CARD_H + GAP, panelH = 286;
const PANEL_W = (W - PAD * 2 - GAP) / 2;
const H = panelY + panelH + PAD;

const cardsRow1 = [
  { label: '预估费用', value: '$' + cur.cost.toFixed(2), d: delta(cur.cost, prev.cost), color: '#4ade80' },
  { label: '总 Token', value: fmtTok(cur.total), d: delta(cur.total, prev.total), color: '#fafafa' },
  { label: '输入 Token', value: fmtTok(cur.input), d: delta(cur.input, prev.input), color: '#fafafa' },
  { label: '输出 Token', value: fmtTok(cur.output), d: delta(cur.output, prev.output), color: '#fafafa' },
  { label: '缓存 Token', value: fmtTok(cur.cached), d: delta(cur.cached, prev.cached), color: '#52525b' },
];
const cardsRow2 = [
  { label: '活跃时长', value: fmtHrs(cur.active), d: delta(cur.active, prev.active), color: '#60a5fa' },
  { label: '总时长', value: fmtHrs(cur.duration), d: delta(cur.duration, prev.duration), color: '#fafafa' },
  { label: '会话数', value: fmtInt(cur.sessions), d: delta(cur.sessions, prev.sessions), color: '#fafafa' },
  { label: '总消息数', value: fmtInt(cur.msgs), d: delta(cur.msgs, prev.msgs), color: '#fafafa' },
  { label: '用户消息数', value: fmtInt(cur.userMsgs), d: delta(cur.userMsgs, prev.userMsgs), color: '#fafafa' },
];

function cardSvg(c, x, y) {
  const big = c.value.length > 9 ? 20 : 24;
  return `
  <g>
    <rect x="${x}" y="${y}" width="${CARD_W}" height="${CARD_H}" rx="10" fill="#111113" stroke="#232326"/>
    <text x="${x + 16}" y="${y + 27}" font-size="12" fill="#a1a1aa">${esc(c.label)}</text>
    <text x="${x + CARD_W - 14}" y="${y + 27}" font-size="11" fill="#71717a" text-anchor="end">${esc(c.d)}</text>
    <text x="${x + 16}" y="${y + 64}" font-size="${big}" font-weight="700" fill="${c.color}">${esc(c.value)}</text>
  </g>`;
}

let cardsSvg = '';
cardsRow1.forEach((c, i) => { cardsSvg += cardSvg(c, PAD + i * (CARD_W + GAP), row1Y); });
cardsRow2.forEach((c, i) => { cardsSvg += cardSvg(c, PAD + i * (CARD_W + GAP), row2Y); });

// ---- top filter bar (static pills) ----
function pillRow() {
  const items = ['今天', '24H', '7D', '30D', '90D', '自定义'];
  let x = PAD, out = '';
  out += `<rect x="${x}" y="14" width="248" height="26" rx="13" fill="#111113" stroke="#232326"/>`;
  for (const it of items) {
    const w = it.length * 12 + 16;
    const active = it === '7D';
    if (active) out += `<rect x="${x + 5}" y="17" width="${w}" height="20" rx="10" fill="#fafafa"/>`;
    out += `<text x="${x + 5 + w / 2}" y="31" font-size="11" text-anchor="middle" fill="${active ? '#09090b' : '#a1a1aa'}">${it}</text>`;
    x += w + 4;
  }
  x = PAD + 258;
  for (const f of ['工具 全部', '模型 全部', '项目 全部', '终端 全部']) {
    const w = f.length * 11 + 30;
    out += `<rect x="${x}" y="14" width="${w}" height="26" rx="13" fill="#111113" stroke="#232326"/>
      <text x="${x + w / 2}" y="31" font-size="11" text-anchor="middle" fill="#a1a1aa">${f} ▾</text>`;
    x += w + 8;
  }
  return out;
}

// ---- daily trend panel ----
function trendPanel(x, y) {
  const w = PANEL_W, h = panelH;
  const chartX = x + 52, chartY = y + 64, chartW = w - 72, chartH = h - 110;
  const maxV = Math.max(1, ...days.map(d => d.total));
  const barW = Math.min(46, chartW / 7 * 0.62);
  let bars = '', labels = '';
  days.forEach((d, i) => {
    const cx = chartX + chartW / 7 * (i + 0.5);
    const bh = Math.max(2, d.total / maxV * chartH);
    bars += `<rect x="${cx - barW / 2}" y="${chartY + chartH - bh}" width="${barW}" height="${bh}" rx="4" fill="url(#barGrad)"/>`;
    labels += `<text x="${cx}" y="${y + h - 18}" font-size="11" fill="#71717a" text-anchor="middle">${d.label}</text>`;
  });
  return `
  <g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="#0d0d0f" stroke="#232326"/>
    <text x="${x + 18}" y="${y + 30}" font-size="13" fill="#e4e4e7">📈 每日趋势</text>
    <g font-size="10" fill="#71717a">
      <circle cx="${x + w - 218}" cy="${y + 26}" r="4" fill="#fafafa"/><text x="${x + w - 210}" y="${y + 30}">输出</text>
      <circle cx="${x + w - 178}" cy="${y + 26}" r="4" fill="#52525b"/><text x="${x + w - 170}" y="${y + 30}">输入</text>
      <circle cx="${x + w - 138}" cy="${y + 26}" r="4" fill="#3f3f46"/><text x="${x + w - 130}" y="${y + 30}">缓存</text>
    </g>
    <rect x="${x + w - 100}" y="${y + 15}" width="84" height="22" rx="11" fill="#111113" stroke="#232326"/>
    <rect x="${x + w - 98}" y="${y + 17}" width="34" height="18" rx="9" fill="#fafafa"/>
    <text x="${x + w - 81}" y="${y + 30}" font-size="10" text-anchor="middle" fill="#09090b">Token</text>
    <text x="${x + w - 48}" y="${y + 30}" font-size="10" text-anchor="middle" fill="#71717a">费用</text>
    <text x="${x + 40}" y="${chartY + 8}" font-size="10" fill="#52525b" text-anchor="end">${fmtTok(maxV)}</text>
    <text x="${x + 40}" y="${chartY + chartH}" font-size="10" fill="#52525b" text-anchor="end">0</text>
    <line x1="${chartX}" y1="${chartY + chartH + 0.5}" x2="${chartX + chartW}" y2="${chartY + chartH + 0.5}" stroke="#232326"/>
    ${bars}
    ${labels}
  </g>`;
}

// ---- hourly heatmap panel ----
function heatPanel(x, y) {
  const w = PANEL_W, h = panelH;
  const gridX = x + 52, gridY = y + 58;
  const cols = 24, rows = 7;
  const cell = Math.min((w - 78) / cols, (h - 130) / rows) - 2.5;
  const step = cell + 3;
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const shades = ['#161618', '#2a2a2e', '#4b4b52', '#75757e', '#a8a8b0', '#e8e8ec'];
  let cells = '', rowLabels = '', colLabels = '';
  for (let r = 0; r < rows; r++) {
    rowLabels += `<text x="${gridX - 10}" y="${gridY + r * step + cell * 0.75}" font-size="10" fill="#71717a" text-anchor="end">${dayNames[r]}</text>`;
    for (let c = 0; c < cols; c++) {
      const v = heat[r][c];
      const lvl = v === 0 ? 0 : Math.min(5, 1 + Math.floor(v / heatMax * 4.999));
      cells += `<rect x="${gridX + c * step}" y="${gridY + r * step}" width="${cell}" height="${cell}" rx="2.5" fill="${shades[lvl]}"/>`;
    }
  }
  for (let c = 0; c < cols; c += 3) {
    colLabels += `<text x="${gridX + c * step + cell / 2}" y="${gridY + rows * step + 16}" font-size="10" fill="#71717a" text-anchor="middle">${String(c).padStart(2, '0')}</text>`;
  }
  let legend = `<text x="${x + w - 130}" y="${y + h - 16}" font-size="10" fill="#71717a">少</text>`;
  shades.forEach((s, i) => {
    legend += `<rect x="${x + w - 116 + i * 14}" y="${y + h - 25}" width="11" height="11" rx="2.5" fill="${s}"/>`;
  });
  legend += `<text x="${x + w - 116 + shades.length * 14 + 4}" y="${y + h - 16}" font-size="10" fill="#71717a">多</text>`;
  return `
  <g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="#0d0d0f" stroke="#232326"/>
    <text x="${x + 18}" y="${y + 30}" font-size="13" fill="#e4e4e7">🗓 分时活跃</text>
    <rect x="${x + w - 100}" y="${y + 15}" width="84" height="22" rx="11" fill="#111113" stroke="#232326"/>
    <rect x="${x + w - 98}" y="${y + 17}" width="34" height="18" rx="9" fill="#fafafa"/>
    <text x="${x + w - 81}" y="${y + 30}" font-size="10" text-anchor="middle" fill="#09090b">Token</text>
    <text x="${x + w - 48}" y="${y + 30}" font-size="10" text-anchor="middle" fill="#71717a">费用</text>
    ${rowLabels}${cells}${colLabels}${legend}
  </g>`;
}

const now = new Date(Date.now() + TZ_OFFSET_H * 3600_000);
const stamp = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(now.getUTCDate()).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Vibe Usage 7-day dashboard: ${esc(fmtTok(cur.total))} tokens, $${cur.cost.toFixed(2)}, ${esc(fmtHrs(cur.active))} active">
  <defs>
    <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#d4d4d8"/>
      <stop offset="100%" stop-color="#52525b"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="14" fill="#09090b"/>
  <g font-family="'JetBrains Mono','SF Mono','PingFang SC','Menlo',monospace" text-rendering="geometricPrecision">
    ${pillRow()}
    ${cardsSvg}
    ${trendPanel(PAD, panelY)}
    ${heatPanel(PAD + PANEL_W + GAP, panelY)}
    <text x="${W - PAD - 4}" y="${H - 6}" font-size="9" fill="#3f3f46" text-anchor="end">更新于 ${stamp} UTC+8 · vibecafe.ai/usage</text>
  </g>
</svg>
`;

writeFileSync(new URL('../vibe-usage-card.svg', import.meta.url), svg);
console.log(`Generated: $${cur.cost.toFixed(2)} · ${fmtTok(cur.total)} · ${fmtHrs(cur.active)} · ${cur.sessions} sessions`);
