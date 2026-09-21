#!/usr/bin/env node
/**
 * 贪吃蛇贡献图动画生成器 —— 视觉灵感来自 https://github.com/Platane/snk
 *
 * 抓取 GitHub 贡献日历，生成一条蛇巡游整个贡献网格、路过即“吃掉”彩色格子的
 * 动画 SVG（纯 CSS 动画，零依赖），输出浅色 / 深色两个版本：
 *   github-snake.svg / github-snake-dark.svg
 *
 * 用法：
 *   GITHUB_TOKEN=<token> node scripts/generate-snake.js --user <login> [--out dist] [--seed N]
 *
 * 数据源：优先 GitHub GraphQL API（需要 token），失败时回退抓取公开贡献页 HTML。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// 视觉参数（与 snk 的输出观感保持一致）
// ---------------------------------------------------------------------------
const CELL = 12;         // 格子边长
const PITCH = 16;        // 格间距（中心到中心）
const OX = 2, OY = 2;    // 首格左上角坐标
const ROWS = 7;          // 一周 7 天
const BAR_Y = 144;       // 底部时间进度条的 y
const BAR_H = 12;
const VIEW_TOP = -32;    // viewBox 上缘（给入场的蛇留空间）

const SEGMENTS = [       // 蛇 = 1 个头 + 3 节尾巴，方块逐渐变小
  { o: 0.8, w: 14.4, rx: 4.5 },
  { o: 1.8, w: 12.3, rx: 4.1 },
  { o: 2.6, w: 10.8, rx: 3.6 },
  { o: 3.0, w: 9.9, rx: 3.3 },
];

const STEP_MS = 110;         // 蛇每爬一格的耗时
const REST_MS = 2500;        // 全部吃完后的收尾停留
const MAX_LOOP_MS = 150000;  // 单圈时长上限
const FLASH_PCT = 0.02;      // 格子被吃掉的渐变时长（占单圈百分比）

const PALETTES = {
  light: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
  dark:  ['#161b22', '#01311f', '#034525', '#0f6d31', '#00c647'],
};
const SNAKE_COLOR = 'purple';
const BORDER_COLOR = '#1b1f230a';

// ---------------------------------------------------------------------------
// 贡献日历抓取
// ---------------------------------------------------------------------------
async function fetchCalendar(user, token) {
  if (token) {
    try {
      return await fetchViaGraphql(user, token);
    } catch (e) {
      console.warn(`GraphQL 拉取失败（${e.message}），回退 HTML 抓取`);
    }
  }
  return fetchViaHtml(user);
}

async function fetchViaGraphql(user, token) {
  const query = `query($l:String!){user(login:$l){contributionsCollection{contributionCalendar{`
    + `totalContributions weeks{contributionDays{date contributionCount}}}}}}`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'snake-svg-generator',
    },
    body: JSON.stringify({ query, variables: { l: user } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0] ? json.errors[0].message : 'GraphQL error');
  const cal = json.data && json.data.user && json.data.user.contributionsCollection
    && json.data.user.contributionsCollection.contributionCalendar;
  if (!cal) throw new Error('日历数据为空（用户不存在？）');
  const days = [];
  for (const w of cal.weeks) for (const d of w.contributionDays) {
    days.push({ date: d.date, count: d.contributionCount });
  }
  if (days.length < 300) throw new Error(`日历天数异常：${days.length}`);
  return { days, total: cal.totalContributions, source: 'graphql' };
}

async function fetchViaHtml(user) {
  const res = await fetch(`https://github.com/users/${encodeURIComponent(user)}/contributions`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; snake-svg-generator)' },
  });
  if (!res.ok) throw new Error(`贡献页 HTTP ${res.status}`);
  const html = await res.text();
  const days = [];
  // 新版页面：日历数据内嵌在 JSON 中（两种键序都尝试）
  for (const m of html.matchAll(/"contributionCount":(\d+),"date":"(\d{4}-\d{2}-\d{2})"/g)) {
    days.push({ date: m[2], count: +m[1] });
  }
  if (days.length < 300) {
    days.length = 0;
    for (const m of html.matchAll(/"date":"(\d{4}-\d{2}-\d{2})","contributionCount":(\d+)/g)) {
      days.push({ date: m[1], count: +m[2] });
    }
  }
  if (days.length < 300) { // 旧版页面：rect 元素
    days.length = 0;
    for (const m of html.matchAll(/<rect\b[^>]*ContributionCalendar-day[^>]*>/g)) {
      const tag = m[0];
      const date = (tag.match(/data-date="(\d{4}-\d{2}-\d{2})"/) || [])[1];
      const count = (tag.match(/data-count="(\d+)"/) || [])[1];
      if (date) days.push({ date, count: +(count || 0) });
    }
  }
  if (days.length < 300) throw new Error('无法从 HTML 解析贡献日历');
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  const total = days.reduce((s, d) => s + d.count, 0);
  return { days, total, source: 'html' };
}

// ---------------------------------------------------------------------------
// 网格与等级
// ---------------------------------------------------------------------------
function buildGrid(days) {
  const firstRow = new Date(days[0].date + 'T00:00:00Z').getUTCDay();
  const cells = Array.from({ length: ROWS }, () => []); // cells[行][列] = 天 | 空洞
  let r = firstRow, c = 0;
  for (const d of days) {
    cells[r][c] = d;
    if (++r === ROWS) { r = 0; c++; }
  }
  return { cells, COLS: c + 1 };
}

// GitHub 风格的等级划分：按非零天贡献数的四分位
function computeLevels(days) {
  const nz = days.map(d => d.count).filter(n => n > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const pick = p => nz[Math.min(nz.length - 1, Math.floor(p * (nz.length - 1)))];
  const t1 = pick(0.25), t2 = pick(0.5), t3 = pick(0.75);
  return count => (count === 0 ? 0 : count <= t1 ? 1 : count <= t2 ? 2 : count <= t3 ? 3 : 4);
}

// ---------------------------------------------------------------------------
// 蛇的巡游路线
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]]; // 下、右、上、左

function weightedPick(items, weights, rand) {
  const sum = weights.reduce((a, b) => a + b, 0);
  let x = rand() * sum;
  for (let i = 0; i < items.length; i++) {
    x -= weights[i];
    if (x <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * 深度优先巡游：直行优先、适度右转、偏好更早的日期（靠左的列），
 * 走到死路就原路折返 —— 得到一条覆盖全部格子的有机蛇行路径。
 * 返回 route（[列, 行] 序列，含场外入场/离场段）和每格首次到访的下标。
 */
function buildRoute(cells, COLS, rand) {
  const visited = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  let realCells = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (cells[r][c]) realCells++;

  // 入场：蛇趴在网格上方第一行（虚拟位置 (-i, -1)），滑到 (0,-1) 后向下钻进网格
  const route = [[0, -1]];
  let startR = 0;
  while (startR < ROWS && !cells[startR][0]) startR++;
  if (startR === ROWS) throw new Error('空网格');

  const stack = [];
  let cur = [0, startR];
  let dir = [0, 1];
  const push = pos => { route.push(pos); dir = [pos[0] - cur[0], pos[1] - cur[1]]; cur = pos; };
  push(cur);
  visited[startR][0] = true;
  stack.push([0, startR]);
  let remaining = realCells - 1;

  while (stack.length && remaining > 0) {
    const [cc, cr] = cur;
    const cands = DIRS.filter(([dc, dr]) => {
      const nc = cc + dc, nr = cr + dr;
      return nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS
        && cells[nr][nc] && !visited[nr][nc];
    });
    if (cands.length) {
      const weights = cands.map(([dc, dr]) => {
        let w;
        if (dc === dir[0] && dr === dir[1]) w = 8;            // 直行
        else if (dc === -dir[0] && dr === -dir[1]) w = 0.4;   // 掉头
        else w = dir[0] * dr - dir[1] * dc > 0 ? 4.5 : 3.5;   // 右转略优于左转
        return w * (1.6 - 0.6 * (cc + dc) / COLS);            // 日期越早权重越高
      });
      const pick = weightedPick(cands, weights, rand);
      const next = [cc + pick[0], cr + pick[1]];
      visited[next[1]][next[0]] = true;
      stack.push(next);
      push(next);
      remaining--;
    } else {
      stack.pop(); // 折返：退回一步继续找路
      if (stack.length) push(stack[stack.length - 1]);
    }
  }

  // 离场：沿当前行向左滑出画面（第 -2 列起完全出界，循环重启时跳变不可见）
  for (let c = cur[0] - 1; c >= -6; c--) route.push([c, cur[1]]);

  // 每个真实格子的首次到访下标（= 被吃掉的时刻）
  const firstVisit = new Map();
  route.forEach((p, i) => {
    if (p[1] >= 0 && p[1] < ROWS && p[0] >= 0 && p[0] < COLS && cells[p[1]][p[0]]) {
      const k = p[0] + ',' + p[1];
      if (!firstVisit.has(k)) firstVisit.set(k, i);
    }
  });
  if (firstVisit.size !== realCells) {
    throw new Error(`路径未覆盖全部格子：${firstVisit.size}/${realCells}`);
  }
  return { route, firstVisit };
}

// route 中方向发生改变的顶点（相邻三点不共线），加上首尾 —— CSS 关键帧只需采样这些点
function compressRoute(route) {
  const keep = [0];
  for (let i = 1; i < route.length - 1; i++) {
    const a = route[i - 1], b = route[i], c = route[i + 1];
    if (b[0] - a[0] !== c[0] - b[0] || b[1] - a[1] !== c[1] - b[1]) keep.push(i);
  }
  keep.push(route.length - 1);
  return keep;
}

// ---------------------------------------------------------------------------
// SVG 渲染
// ---------------------------------------------------------------------------
const num1 = n => (+n.toFixed(1)).toString();
const num3 = n => n.toFixed(3);

function renderSvg(theme, ctx) {
  const { cells, COLS, days, levels, route, firstVisit, stepMs, totalMs, timeline } = ctx;
  const pal = PALETTES[theme];
  const routeOf = i => (i >= 0 ? route[i] : [-i, -1]);
  const pct = t => (t <= 0 ? '0' : (t * 100 / totalMs).toFixed(2));

  const W = PITCH * COLS + 32;
  const H = (BAR_Y + BAR_H + 4) - VIEW_TOP;

  // -- 贡献格子 -------------------------------------------------------------
  const cellRects = [];
  const cellCss = [];
  let id = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const day = cells[r][c];
      if (!day) continue;
      const x = OX + PITCH * c, y = OY + PITCH * r;
      const level = levels(day.count);
      if (level === 0) {
        cellRects.push(`<rect class="c" x="${x}" y="${y}" rx="2" ry="2"/>`);
      } else {
        const name = 'c' + id.toString(36);
        id++;
        cellRects.push(`<rect class="c ${name}" x="${x}" y="${y}" rx="2" ry="2"/>`);
        const p1 = (firstVisit.get(c + ',' + r) * stepMs * 100) / totalMs;
        const p2 = Math.min(p1 + FLASH_PCT, 100);
        cellCss.push(`@keyframes ${name}{${pct(p1 * totalMs / 100)}%{fill:var(--c${level})}`
          + `${p2.toFixed(2)}%,100%{fill:var(--ce)}}`);
        cellCss.push(`.c.${name}{fill:var(--c${level});animation-name:${name}}`);
      }
    }
  }

  // -- 底部时间进度条（横轴 = 日期，颜色 = 贡献等级，随蛇的进度展开）---------
  const barW = OX + PITCH * (COLS - 1) + CELL;
  const total = days.length;
  const xOf = j => (j / total) * barW;      // 段起点：第 j 天切片的左缘
  const xEnd = j => ((j + 1) / total) * barW;
  const flashMs = (FLASH_PCT / 100) * totalMs; // 关键帧保持一小段后过渡（仿 snk）
  const barRects = [];
  const barCss = [];
  timeline.forEach((run, ri) => {
    if (run.level === 0) return; // 空白期留白
    const name = 'u' + ri.toString(36);
    const x0 = xOf(run.j0);
    const x1 = xEnd(run.j1);
    const w = x1 - x0;
    barRects.push(`<rect class="u ${name}" height="${BAR_H}" width="${num1(w)}" `
      + `x="${num1(x0)}" y="${BAR_Y}"/>`);
    // 按蛇吃掉各天的时刻展开（时间升序）；进度条只前进不回退（取运行最大值）
    const byTime = [...run.steps].sort((a, b) => a.t - b.t || a.j - b.j);
    const seq = []; // [时刻, scale]
    let prev = -1;
    for (const { j, t } of byTime) {
      const s = (xEnd(j) - x0) / w;
      if (s > prev + 1e-9) {
        if (seq.length && seq[seq.length - 1][0] === t) seq[seq.length - 1][1] = s;
        else seq.push([t, s]);
        prev = s;
      }
    }
    // 首帧显式为 0，避免浏览器合成 0% 帧导致提前渐变；
    // 若首帧 scale 非 0，则拆成 0 值帧 + 错开一个 flash 的原值帧
    if (seq.length && seq[0][1] > 1e-9) {
      const [t0, s0] = seq[0];
      seq[0] = [t0, 0];
      seq.splice(1, 0, [t0 + flashMs, s0]);
    } else if (!seq.length) {
      seq.push([byTime[0].t, 0]);
    }
    // 收尾补到满格
    if (prev < 1 - 1e-9) {
      const lastT = Math.max(run.lastEatMs,
        seq[seq.length - 1][0] + flashMs);
      seq.push([lastT, 1]);
    }
    const frames = seq.map(([t, s]) =>
      `${pct(t)}%,${pct(t + flashMs)}%{transform:scale(${num3(s)},1)}`);
    if (frames.length > 1 || seq[seq.length - 1][1] < 1) {
      const [t, s] = seq[seq.length - 1];
      frames[frames.length - 1] = `${pct(t)}%,100%{transform:scale(${num3(s)},1)}`;
    }
    barCss.push(`@keyframes ${name}{${frames.join('')}}`);
    barCss.push(`.u.${name}{fill:var(--c${run.level});animation-name:${name};`
      + `transform-origin:${num1(x0)}px 0}`);
  });

  // -- 蛇（头 + 3 节尾巴；第 k 节的位置 = 头在 t-k*step 时的位置）------------
  const vertices = compressRoute(route);
  const N = route.length;
  const snakeRects = SEGMENTS.map((s, k) =>
    `<rect class="s s${k}" x="${s.o}" y="${s.o}" width="${s.w}" height="${s.w}" `
    + `rx="${s.rx}" ry="${s.rx}"/>`).join('');
  const snakeCss = SEGMENTS.map((s, k) => {
    const idx = [...new Set([-k, ...vertices])].sort((a, b) => a - b).filter(i => i <= N - 1);
    const frames = idx.map(i => {
      const p = routeOf(i);
      return `${pct((i + k) * stepMs)}%{transform:translate(${p[0] * PITCH}px,${p[1] * PITCH}px)}`;
    });
    return `@keyframes s${k}{${frames.join('')}}`;
  });
  const snakeRules = SEGMENTS.map((s, k) =>
    `.s.s${k}{transform:translate(${k * PITCH}px,-${PITCH}px);animation-name:s${k}}`).join('');

  const rootVars = `--cb:${BORDER_COLOR};--cs:${SNAKE_COLOR};--ce:${pal[0]};`
    + pal.map((c, i) => `--c${i}:${c}`).join(';');

  const style = [
    `:root{${rootVars}}`,
    `.c{shape-rendering:geometricPrecision;fill:var(--ce);stroke-width:1px;`
      + `stroke:var(--cb);animation:none ${totalMs}ms linear infinite;`
      + `width:${CELL}px;height:${CELL}px}`,
    ...cellCss,
    `.u{transform-origin:0 0;transform:scale(0,1);animation:none linear ${totalMs}ms infinite}`,
    ...barCss,
    `.s{shape-rendering:geometricPrecision;fill:var(--cs);animation:none linear ${totalMs}ms infinite}`,
    ...snakeRules,
    ...snakeCss,
  ].join('');

  return `<svg viewBox="${-16} ${VIEW_TOP} ${W} ${H}" width="${W}" height="${H}" `
    + `xmlns="http://www.w3.org/2000/svg">`
    + `<desc>Generated by https://github.com/zhouyuanxinand/zhouyuanxinand `
    + `(inspired by https://github.com/Platane/snk)</desc>`
    + `<style>${style}</style>`
    + `${cellRects.join('')}${barRects.join('')}${snakeRects}</svg>`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { user: process.env.GITHUB_USER, out: 'dist', seed: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--user') opts.user = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--seed') opts.seed = argv[++i];
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.user) throw new Error('缺少 --user 或环境变量 GITHUB_USER');

  const { days, total, source } = await fetchCalendar(opts.user, process.env.GITHUB_TOKEN);
  const { cells, COLS } = buildGrid(days);
  const levels = computeLevels(days);

  // 随机种子默认取当天日期，每天生成一条略不相同的巡游路线
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = mulberry32(opts.seed === null ? +today : +opts.seed);
  const { route, firstVisit } = buildRoute(cells, COLS, rand);

  const N = route.length;
  const stepMs = Math.min(STEP_MS, Math.max(40, (MAX_LOOP_MS - REST_MS) / (N - 1)));
  const totalMs = Math.round(stepMs * (N - 1) + REST_MS);

  // 进度条分段：贡献等级相同的连续日期合为一段
  const timeline = [];
  for (let j = 0; j < days.length; j++) {
    const level = levels(days[j].count);
    const cell = (() => {
      const firstRow = new Date(days[0].date + 'T00:00:00Z').getUTCDay();
      const c = Math.floor((firstRow + j) / 7), r = (firstRow + j) % 7;
      return firstVisit.get(c + ',' + r) * stepMs;
    })();
    const last = timeline[timeline.length - 1];
    if (last && last.level === level) {
      last.j1 = j;
      last.steps.push({ j, t: cell });
      last.lastEatMs = Math.max(last.lastEatMs, cell);
    } else {
      timeline.push({ j0: j, j1: j, level, steps: [{ j, t: cell }], lastEatMs: cell });
    }
  }

  const ctx = { cells, COLS, days, levels, route, firstVisit, stepMs, totalMs, timeline };
  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  for (const theme of ['light', 'dark']) {
    const svg = renderSvg(theme, ctx);
    const file = path.join(outDir, theme === 'light' ? 'github-snake.svg' : 'github-snake-dark.svg');
    fs.writeFileSync(file, svg);
    console.log(`✓ ${file}（${(svg.length / 1024).toFixed(1)} KB）`);
  }

  console.log(`用户 ${opts.user} | 贡献 ${total} 次 | 数据源 ${source}`);
  console.log(`网格 ${COLS}×7=${COLS * 7} 格 | 路径 ${N} 步 | 单圈 ${(totalMs / 1000).toFixed(1)}s`);
}

main().catch(e => {
  console.error(e.stack || e);
  process.exit(1);
});
