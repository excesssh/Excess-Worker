import { execFileSync } from 'node:child_process';
const git = args => execFileSync('git', ['-c', 'safe.directory=' + process.cwd().replaceAll('\\', '/'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let existing = '';
try { existing = git(['config', '--get', 'core.hooksPath']); } catch {}
if (existing && existing !== '.githooks') throw Error('Existing identity hooks must be preserved; integrate the privacy checks with them before changing project setup.');
git(['config', 'user.name', 'Excess']);
git(['config', 'user.email', '329266024+excesssh@users.noreply.github.com']);
git(['config', 'user.useConfigOnly', 'true']);
git(['config', 'core.hooksPath', '.githooks']);
console.log('Project identity and privacy hooks configured.');
