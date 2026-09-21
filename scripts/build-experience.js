#!/usr/bin/env node
/**
 * 生成工作经历面板 assets/experience.svg（深色终端风，与 banner 同一套视觉）
 * 公司 logo 以 base64 内嵌（SVG 在 <img> 上下文中只允许 data: 资源）。
 * 数据取自个人网站 zhouyuanxinand.github.io 的经历区。
 * 用法：node scripts/build-experience.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..');

const ENTRIES = [
  { logo: 'digitalchina.png', company: '神州数码集团', role: 'Agent 开发工程师', date: '2026.06 — 至今' },
  { logo: 'shidai.png', company: '时代共赢私募基金', role: '量化开发工程师', date: '2026.03 — 2026.06' },
  { logo: 'AIA', company: 'AIA · 友邦保险集团全球技术创新中心', role: 'AI 应用开发实习生 · RD 部门', date: '2025.12 — 2026.03' },
  { logo: 'meituan.png', company: '美团', role: '测试开发实习生 · 支付质量组', date: '2024.08 — 2025.09' },
  { logo: 'baicizhan.png', company: '百词斩', role: '后端开发实习生 · 业务平台组', date: '2024.05 — 2024.08' },
];

const W = 1280;
const WIN = { x: 32, y: 24, w: 1216, h: 422, rx: 18 };
const ROW_H = 66;
const HEADER_H = 44;
const MONO = "Cascadia Code,'JetBrains Mono',Consolas,'Courier New',monospace";
const SANS = "'PingFang SC','Microsoft YaHei UI','Microsoft YaHei',sans-serif";

const b64 = file => fs.readFileSync(path.join(BASE, 'assets', 'logos', file)).toString('base64');

// logo 瓦片：浅底圆角方块 + 居中 logo（保持宽高比，最大 40x40）
function logoTile(x, y, entry) {
  if (entry.logo === 'AIA') {
    return `<rect x="${x}" y="${y}" width="48" height="48" rx="9" fill="#f6f8fa"/>`
      + `<rect x="${x + 5}" y="${y + 13}" width="38" height="22" rx="5" fill="#d31145"/>`
      + `<text x="${x + 24}" y="${y + 29}" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="700" fill="#ffffff">AIA</text>`;
  }
  const sizeOf = { 'digitalchina.png': [128, 128], 'shidai.png': [96, 90], 'meituan.png': [48, 48], 'baicizhan.png': [64, 64] };
  const [lw, lh] = sizeOf[entry.logo] || [48, 48];
  const s = Math.min(40 / lw, 40 / lh);
  const w = Math.round(lw * s), h = Math.round(lh * s);
  const ix = x + (48 - w) / 2, iy = y + (48 - h) / 2;
  return `<rect x="${x}" y="${y}" width="48" height="48" rx="9" fill="#f6f8fa"/>`
    + `<image x="${ix}" y="${iy}" width="${w}" height="${h}" `
    + `href="data:image/png;base64,${b64(entry.logo)}"/>`;
}

let rows = '';
ENTRIES.forEach((e, i) => {
  const top = WIN.y + HEADER_H + i * ROW_H;
  rows += logoTile(WIN.x + 16, top + 9, e)
    + `<text x="${WIN.x + 84}" y="${top + 32}" font-family="${SANS}" font-size="20" font-weight="700" fill="#e6edf3">${e.company}</text>`
    + `<text x="${WIN.x + 84}" y="${top + 52}" font-family="${SANS}" font-size="14" fill="#8b949e">${e.role}</text>`
    + `<text x="${WIN.x + WIN.w - 16}" y="${top + 38}" text-anchor="end" font-family="${MONO}" font-size="14" fill="#8b949e">${e.date}</text>`;
  if (i < ENTRIES.length - 1) {
    rows += `<line x1="${WIN.x + 16}" y1="${top + ROW_H}" x2="${WIN.x + WIN.w - 16}" y2="${top + ROW_H}" stroke="#21262d" stroke-width="1"/>`;
  }
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="470" viewBox="0 0 ${W} 470" role="img" aria-labelledby="etitle edesc">
  <title id="etitle">工作经历</title>
  <desc id="edesc">神州数码、时代共赢、AIA、美团、百词斩</desc>
  <rect x="${WIN.x}" y="${WIN.y}" width="${WIN.w}" height="${WIN.h}" rx="${WIN.rx}" fill="#0d1117" stroke="#30363d" stroke-width="1.5"/>
  <path d="M ${WIN.x} ${WIN.y + WIN.rx} A ${WIN.rx} ${WIN.rx} 0 0 1 ${WIN.x + WIN.rx} ${WIN.y} H ${WIN.x + WIN.w - WIN.rx} A ${WIN.rx} ${WIN.rx} 0 0 1 ${WIN.x + WIN.w} ${WIN.y + WIN.rx} V ${WIN.y + HEADER_H} H ${WIN.x} Z" fill="#161b22"/>
  <circle cx="${WIN.x + 36}" cy="${WIN.y + 22}" r="6" fill="#ff5f56"/>
  <circle cx="${WIN.x + 60}" cy="${WIN.y + 22}" r="6" fill="#ffbd2e"/>
  <circle cx="${WIN.x + 84}" cy="${WIN.y + 22}" r="6" fill="#27c93f"/>
  <text x="${WIN.x + WIN.w / 2}" y="${WIN.y + 27}" text-anchor="middle" font-family="${MONO}" font-size="14" fill="#8b949e">experience.log · 工作经历</text>
  <line x1="${WIN.x + 1}" y1="${WIN.y + HEADER_H}" x2="${WIN.x + WIN.w - 1}" y2="${WIN.y + HEADER_H}" stroke="#21262d" stroke-width="1"/>
  ${rows}
</svg>`;

const out = path.join(BASE, 'assets', 'experience.svg');
fs.writeFileSync(out, svg);
console.log(`✓ ${out}（${(svg.length / 1024).toFixed(1)} KB，${ENTRIES.length} 段经历）`);
