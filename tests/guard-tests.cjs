// block-main-commit-push.cjs 회귀 테스트. 명령 텍스트를 파일에 두는 이유: 라이브 PreToolUse 훅이
// 테스트 하네스의 Bash 명령 자체(문자열 안의 git 커밋 명령)를 차단하기 때문.
'use strict';
const { spawnSync } = require('node:child_process');
const HOOK = process.argv[2];
const REPO = 'C:/Users/sungk/Documents/claude-code-setting'; // main 브랜치, 커밋 0개
const G = 'git';
const cases = [
  ['commit on main', REPO, `${G} add -A && ${G} commit -m 'x'`, 'deny'],
  ['push origin main', 'C:/tmp', `${G} push origin main`, 'deny'],
  ['push HEAD:master', 'C:/tmp', `${G} push -u origin HEAD:master`, 'deny'],
  ['push --delete DEPLOY', 'C:/tmp', `${G} push origin --delete DEPLOY-260612`, 'deny'],
  ['push origin feat/x', 'C:/tmp', `${G} push -u origin feat/x`, 'allow'],
  ['switch main && commit', 'C:/tmp', `${G} switch main && ${G} commit -m x`, 'deny'],
  ['switch -c feat && commit', REPO, `${G} switch -c feat/y && ${G} commit -m x`, 'allow'],
  ['git -C msys path commit on main', 'C:/tmp', `${G} -C /c/Users/sungk/Documents/claude-code-setting commit -m x`, 'deny'],
  ['grep "git push" README', 'C:/tmp', `grep -rn "${G} push" README.md | head -3 && echo done`, 'allow'],
  ['echo git commit', 'C:/tmp', `echo "run ${G} commit later"`, 'allow'],
  ['cat file mentioning git push', 'C:/tmp', `cat docs/${G}-push.md`, 'allow'],
  ['node -e execSync git push', 'C:/tmp', `node -e "require('child_process').execSync('${G} push origin main')"`, 'deny'],
  ['python -c git commit', 'C:/tmp', `python -c "import os; os.system('${G} commit -m x')"`, 'deny'],
  ['bash -c git push', 'C:/tmp', `bash -c "${G} push origin feat"`, 'deny'],
  ['powershell -Command git push', 'C:/tmp', `powershell -Command "${G} push origin feat"`, 'deny'],
  ['git status', 'C:/tmp', `${G} status`, 'allow'],
  ['garbage', null, null, 'allow'],
];
let fail = 0;
for (const [name, cwd, cmd, expect] of cases) {
  const input = cmd === null ? 'not json' : JSON.stringify({ session_id: 't', cwd, tool_input: { command: cmd } });
  const r = spawnSync('node', [HOOK], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_HOOK_LOG: 'off', CLAUDE_GIT_GUARD: '' } });
  const m = (r.stdout || '').match(/"permissionDecision":"([a-z]+)"/);
  const got = m ? m[1] : 'allow';
  const ok = got === expect;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${name}] expected ${expect}, got ${got}${r.status !== 0 ? ` (exit ${r.status})` : ''}`);
}
console.log(fail ? `${fail} FAILED` : 'ALL PASS');
process.exit(fail ? 1 : 0);
