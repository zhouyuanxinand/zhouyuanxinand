#!/usr/bin/env node
/**
 * 每日活跃保持：检查今天（北京时间）是否有 GitHub 贡献；
 * 没有则向本仓库追加一行日志并提交一个占位 commit，让贡献日历不断更。
 *
 * 由 .github/workflows/streak.yml 定时调用：
 *   GITHUB_TOKEN=<token> node scripts/daily-streak.js [--check] [--force] [--no-push]
 *
 * 注意：占位 commit 的作者邮箱必须已绑定 GitHub 账号，否则不计入贡献。
 */
'use strict';

const fs = require('fs');
const { execSync } = require('child_process');

const AUTHOR_NAME = '奔跑的鑫';
const AUTHOR_EMAIL = '3089729486@qq.com'; // 已验证并绑定账号的邮箱（决定贡献归属）
const LOG_FILE = 'streak.log';

async function fetchCalendar(user, token) {
  const query = `query($l:String!){user(login:$l){contributionsCollection{contributionCalendar{`
    + `totalContributions weeks{contributionDays{date contributionCount}}}}}}`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'daily-streak',
    },
    body: JSON.stringify({ query, variables: { l: user } }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0] ? json.errors[0].message : 'GraphQL error');
  const cal = json.data && json.data.user && json.data.user.contributionsCollection
    && json.data.user.contributionsCollection.contributionCalendar;
  if (!cal) throw new Error('日历数据为空');
  return cal.weeks.flatMap(w => w.contributionDays);
}

async function main() {
  const force = process.argv.includes('--force');
  const checkOnly = process.argv.includes('--check');
  const noPush = process.argv.includes('--no-push');
  const user = process.env.GITHUB_USER || 'zhouyuanxinand';
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 北京日期

  if (!force) {
    const days = await fetchCalendar(user, process.env.GITHUB_TOKEN);
    const day = days.find(d => d.date === today);
    const count = day ? day.contributionCount : 0;
    if (count > 0) {
      console.log(`今天（${today}）已有 ${count} 次贡献，无需占位。`);
      return;
    }
    console.log(`今天（${today}）还没有贡献。`);
    if (checkOnly) return;
    console.log('提交占位 commit …');
  } else {
    console.log('(--force) 跳过检查，直接提交占位 commit。');
  }

  fs.appendFileSync(LOG_FILE, `${today}\n`);
  execSync(`git config user.name "${AUTHOR_NAME}"`);
  execSync(`git config user.email "${AUTHOR_EMAIL}"`);
  execSync(`git add ${LOG_FILE}`);
  if (execSync('git status --porcelain').toString().trim() === '') {
    console.log('日志无变化（今天已有占位），跳过提交。');
    return;
  }
  execSync(`git commit -m "chore: daily activity placeholder (${today})"`);
  if (!noPush) {
    execSync('git push');
    console.log(`✓ 已提交并推送占位 commit（${today}）`);
  } else {
    console.log(`✓ 已提交占位 commit（${today}，--no-push 未推送）`);
  }
}

main().catch(e => {
  console.error(e.stack || e);
  process.exit(1);
});
