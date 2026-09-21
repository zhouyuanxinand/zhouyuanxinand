#!/usr/bin/env node
/**
 * 贪吃蛇贡献图动画生成器 —— 动效仿照 https://github.com/Platane/snk
 *
 * 抓取 GitHub 贡献日历，生成一条蛇穿行贡献网格、路过即“吃掉”彩色格子的
 * 动画 SVG（纯 CSS 动画，零依赖），输出浅色 / 深色两个版本：
 *   github-snake.svg / github-snake-dark.svg
 * 动效与 snk 对齐：每格 100ms，横向长滑行 + 短纵向折返的织行路线，
 * 底部日期进度条随蛇推进，吃完回到左下休息位，循环重启时整图恢复重吃。
 *
 * 用法：
 *   GITHUB_TOKEN=<token> node scripts/generate-snake.js --user <login> [--out dist]
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

const STEP_MS = 100;         // 蛇每爬一格的耗时（与 snk 一致）
const REST_MS = 800;         // 吃完后在休息位的停留（与 snk 观感一致）
const MAX_LOOP_MS = 150000;  // 单圈时长上限
const FLASH_PCT = 0.02;      // 格子被吃掉的渐变时长（占单圈百分比）

const PALETTES = {
  light: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
  dark:  ['#161b22', '#01311f', '#034525', '#0f6d31', '#00c647'],
};
// 进度条“轨道色”：无贡献日期段的淡淡底色（深色模式用稍亮的暗色，否则看不见）
const TRACK = { light: '#ebedf0', dark: '#21262d' };
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
// 蛇的巡游路线（仿 snk 的动效：目标点 + 横向滑行）
// ---------------------------------------------------------------------------
/**
 * 仿照 snk 的路线：只把「有贡献的格子」当作必经目标（按日期大致从左到右
 * 贪心就近连接），相邻目标之间走「先水平后垂直」的 L 形路径，途中路过的
 * 目标顺路吃掉 —— 于是呈现出「长横向滑行 + 短纵向折返 + 偶尔回折」的织行
 * 动效，而不是逐格全覆盖的慢速蛇形。吃完后沿当前行滑回第 4 列附近原地
 * 休息到本轮结束，循环重启时跳变很小。
 */
function buildRoute(cells, COLS) {
  const targets = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (cells[r][c] && cells[r][c].count > 0) targets.push([c, r]);
    }
  }
  if (!targets.length) throw new Error('过去一年没有任何贡献，无法生成路线');

  // 入场：蛇趴在网格上方第一行（虚拟位置 (-i, -1)），滑到 (0,-1) 后向下钻进网格
  const route = [[0, -1], [0, 0]];
  const pending = new Set(targets.map(t => t.join(',')));
  let cur = [0, 0];
  let remaining = pending.size;

  while (remaining > 0) {
    // 贪心选下一个目标：横向距离为主，向左折返加罚
    let best = null, bestCost = Infinity;
    for (const key of pending) {
      const [tc, tr] = key.split(',').map(Number);
      const dc = tc - cur[0], dr = tr - cur[1];
      const cost = Math.abs(dc) + Math.abs(dr) * 1.4 + (dc < 0 ? 2.5 : 0);
      if (cost < bestCost) { bestCost = cost; best = [tc, tr]; }
    }
    pending.delete(best.join(','));
    // 先水平后垂直的 L 形连接；途中经过的目标顺路吃掉
    const step = pos => {
      route.push(pos);
      const k = pos.join(',');
      if (pending.has(k)) { pending.delete(k); remaining--; }
    };
    while (cur[0] !== best[0]) { cur = [cur[0] + Math.sign(best[0] - cur[0]), cur[1]]; step(cur); }
    while (cur[1] !== best[1]) { cur = [cur[0], cur[1] + Math.sign(best[1] - cur[1])]; step(cur); }
    remaining--;
  }
  if (pending.size) throw new Error(`有 ${pending.size} 个目标未被吃掉`);

  // 收尾：沿当前行滑回左下休息位（第 4 列），原地休息到本轮结束
  while (cur[0] > 4) { cur = [cur[0] - 1, cur[1]]; route.push(cur); }

  // 每个真实格子的首次到访下标（= 被吃掉的时刻）
  const firstVisit = new Map();
  route.forEach((p, i) => {
    if (p[1] >= 0 && p[1] < ROWS && p[0] >= 0 && p[0] < COLS && cells[p[1]][p[0]]) {
      const k = p[0] + ',' + p[1];
      if (!firstVisit.has(k)) firstVisit.set(k, i);
    }
  });
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
    const name = 'u' + ri.toString(36);
    const x0 = xOf(run.j0);
    const x1 = xEnd(run.j1);
    const w = x1 - x0;
    // 空白期也渲染为淡淡的轨道色段：进度条全程从左到右可见地推进
    const fill = run.level === 0 ? 'var(--tr)' : `var(--c${run.level})`;
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
    barCss.push(`.u.${name}{fill:${fill};animation-name:${name};`
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

  const rootVars = `--cb:${BORDER_COLOR};--cs:${SNAKE_COLOR};--ce:${pal[0]};--tr:${TRACK[theme]};`
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
// 仓库概况（用于统计卡）
// ---------------------------------------------------------------------------
async function fetchRepos(user, token) {
  if (!token) return null;
  try {
    const res = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&sort=pushed`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'snake-svg-generator' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn(`仓库列表拉取失败（${e.message}），跳过统计卡生成`);
    return null;
  }
}

// 统计卡：440x176 圆角卡片，深色终端配色（与 banner 同一套）
// 经历数字来自个人网站 zhouyuanxinand.github.io（4 段实习 / 2 次创业 / 14 章教材）
function renderStatsSvg(s) {
  const cell = (x, n, label) =>
    `<text x="${x}" y="108" text-anchor="middle" font-family="Cascadia Code,'JetBrains Mono',Consolas,'Courier New',monospace" font-size="30" fill="#e6edf3" font-weight="700">${n}</text>`
    + `<text x="${x}" y="132" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei UI','Microsoft YaHei',sans-serif" font-size="12" fill="#8b949e">${label}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="176" viewBox="0 0 440 176" role="img" aria-labelledby="stitle">`
    + `<title id="stitle">实习、创业与写作经历</title>`
    + `<rect width="440" height="176" rx="14" fill="#0d1117"/>`
    + `<rect x="1" y="1" width="438" height="174" rx="13" fill="none" stroke="#30363d"/>`
    + `<rect x="0" y="0" width="6" height="176" rx="3" fill="#3fb950"/>`
    + `<text x="24" y="34" font-family="Cascadia Code,'JetBrains Mono',Consolas,'Courier New',monospace" font-size="11" letter-spacing="2" fill="#3fb950" font-weight="600">EXPERIENCE</text>`
    + `<text x="24" y="58" font-family="'PingFang SC','Microsoft YaHei UI','Microsoft YaHei',sans-serif" font-size="16" fill="#e6edf3" font-weight="600">实习、创业与写作</text>`
    + cell(55, s.internships, '段实习')
    + cell(165, s.startups, '次创业')
    + cell(275, s.chapters, '章教材')
    + cell(385, s.originals, '开源仓库')
    + `</svg>`;
}

// 语言分布卡：按原创仓库体积占比
function renderLangsSvg(langs) {
  const barColors = ['#3fb950', '#8957e5', '#d29922'];
  let rows = '';
  langs.slice(0, 3).forEach((l, i) => {
    const y = 94 + i * 32;
    const w = Math.max(6, Math.round(392 * l.pct / 100));
    rows += `<text x="24" y="${y}" font-family="'PingFang SC','Microsoft YaHei UI','Microsoft YaHei',sans-serif" font-size="13" fill="#e6edf3">${l.name}</text>`
      + `<text x="416" y="${y}" text-anchor="end" font-family="Cascadia Code,'JetBrains Mono',Consolas,monospace" font-size="13" fill="#8b949e">${l.pct.toFixed(0)}%</text>`
      + `<rect x="24" y="${y + 6}" width="392" height="8" rx="4" fill="#21262d"/>`
      + `<rect x="24" y="${y + 6}" width="${w}" height="8" rx="4" fill="${barColors[i]}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="176" viewBox="0 0 440 176" role="img" aria-labelledby="ltitle">`
    + `<title id="ltitle">原创仓库语言分布</title>`
    + `<rect width="440" height="176" rx="14" fill="#0d1117"/>`
    + `<rect x="1" y="1" width="438" height="174" rx="13" fill="none" stroke="#30363d"/>`
    + `<text x="24" y="34" font-family="Cascadia Code,'JetBrains Mono',Consolas,'Courier New',monospace" font-size="11" letter-spacing="2" fill="#3fb950" font-weight="600">ORIGINAL REPOS</text>`
    + `<text x="24" y="58" font-family="'PingFang SC','Microsoft YaHei UI','Microsoft YaHei',sans-serif" font-size="16" fill="#e6edf3" font-weight="600">仓库语言分布</text>`
    + rows + `</svg>`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { user: process.env.GITHUB_USER, out: 'dist' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--user') opts.user = argv[++i];
    else if (argv[i] === '--out') opts.out = argv[++i];
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

  const { route, firstVisit } = buildRoute(cells, COLS);

  const N = route.length;
  const stepMs = Math.min(STEP_MS, Math.max(40, (MAX_LOOP_MS - REST_MS) / (N - 1)));
  const totalMs = Math.round(stepMs * (N - 1) + REST_MS);

  // 每天的“被吃时刻”：路线只经过有贡献的格子，其余天沿用前一个已吃天
  // 的时刻（向前填充），保证进度条单调推进、最终填满
  const firstRow = new Date(days[0].date + 'T00:00:00Z').getUTCDay();
  const eatMs = days.map((d, j) => {
    const c = Math.floor((firstRow + j) / 7), r = (firstRow + j) % 7;
    const v = firstVisit.get(c + ',' + r);
    return v === undefined ? null : v * stepMs;
  });
  let fill = eatMs.find(t => t !== null) ?? 0;
  for (let j = 0; j < eatMs.length; j++) {
    if (eatMs[j] === null) eatMs[j] = fill;
    else fill = eatMs[j];
  }

  // 进度条分段：贡献等级相同的连续日期合为一段
  const timeline = [];
  for (let j = 0; j < days.length; j++) {
    const level = levels(days[j].count);
    const cell = eatMs[j];
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

  // 统计卡：经历数字（来自个人网站）+ GitHub 原创仓库数（动态）
  const repos = await fetchRepos(opts.user, process.env.GITHUB_TOKEN);
  if (repos) {
    const own = repos.filter(r => !r.fork);
    const stats = {
      internships: 4, // 段实习：神州数码 / 时代共赢 / AIA / 美团 / 百词斩
      startups: 2,    // 次创业：胖鱼智能 / 湖南英途维
      chapters: 14,   // 章技术教材
      originals: own.length,
    };
    fs.writeFileSync(path.join(outDir, 'stats.svg'), renderStatsSvg(stats));
    console.log(`✓ ${path.join(outDir, 'stats.svg')}（实习 ${stats.internships} / 创业 ${stats.startups} / 教材 ${stats.chapters} / 仓库 ${stats.originals}）`);

    const byLang = new Map();
    for (const r of own) {
      if (!r.language) continue;
      byLang.set(r.language, (byLang.get(r.language) || 0) + r.size);
    }
    const totalSize = [...byLang.values()].reduce((a, b) => a + b, 0) || 1;
    const langs = [...byLang.entries()]
      .map(([name, size]) => ({ name, pct: (size * 100) / totalSize }))
      .filter(l => l.pct >= 1)
      .sort((a, b) => b.pct - a.pct);
    fs.writeFileSync(path.join(outDir, 'langs.svg'), renderLangsSvg(langs));
    console.log(`✓ ${path.join(outDir, 'langs.svg')}（${langs.map(l => l.name + ' ' + l.pct.toFixed(0) + '%').join(' / ')}）`);
  }

  console.log(`用户 ${opts.user} | 贡献 ${total} 次 | 数据源 ${source}`);
  console.log(`网格 ${COLS}×7=${COLS * 7} 格 | 路径 ${N} 步 | 单圈 ${(totalMs / 1000).toFixed(1)}s`);
}

main().catch(e => {
  console.error(e.stack || e);
  process.exit(1);
});
