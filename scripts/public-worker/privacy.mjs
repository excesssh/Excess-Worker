import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const identifier = Buffer.from([97, 97, 114, 111, 110]);
const wide = Buffer.from([...identifier].flatMap(byte => [byte, 0]));
const patterns = [
  /[a-z]:[\\/]Users[\\/][^\s/\\]+/i,
  /\/mnt\/[a-z]\/Users\/[^\s/]+/i,
  /\/(?:home|Users)\/(?!excess(?:\/|\b)|iojs(?:\/|\b))[^\s/]+/,
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})(?![A-Za-z0-9_])/,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/i,
];
export function assertIdentifierFree(bytes) {
  const lower = Buffer.from(bytes.toString('latin1').toLowerCase(), 'latin1');
  if (lower.includes(identifier) || lower.includes(wide)) throw Error('PRIVACY_IDENTIFIER_BLOCKED');
}
export function assertPublicBytes(bytes) {
  assertIdentifierFree(bytes);
  assertNoPersonalPathsOrCredentials(bytes);
}
// Pinned upstream artefacts may contain vocabulary or required attribution.
// Their specialised verifier checks provenance before using this narrower check.
// Source, history, package and identity checks continue to use assertPublicBytes.
export function assertNoPersonalPathsOrCredentials(bytes) {
  const text = bytes.toString('utf8');
  if (patterns.some(pattern => pattern.test(text))) throw Error('PRIVACY_CONTENT_BLOCKED');
}

/** Scan reachable objects and all ref names; errors never echo sensitive matches. */
export function scanHistory(root = process.cwd()) {
  const git = args => execFileSync('git', ['-c', 'safe.directory=' + resolve(root).replaceAll('\\', '/'), ...args], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  const refs = git(['for-each-ref', '--format=%(refname)']); assertPublicBytes(refs);
  const commits = git(['rev-list', '--all']).toString().trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    const metadata = git(['show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%B', commit]).toString();
    assertPublicBytes(Buffer.from(metadata));
    const [author, email, committer, committerEmail, ...message] = metadata.split('\n');
    if (author !== 'Excess' || committer !== author || email !== '329266024+excesssh@users.noreply.github.com' || committerEmail !== email)
      throw Error('CONTRIBUTOR_IDENTITY_BLOCKED');
    if (/co-authored-by|generated (?:with|by)|\b(?:claude|chatgpt|codex)\b/i.test(message.join('\n'))) throw Error('ATTRIBUTION_BLOCKED');
    assertPublicBytes(git(['ls-tree', '-r', '--name-only', commit]));
  }
  const objects = git(['rev-list', '--objects', '--all']).toString().trim().split('\n').map(line => line.split(' ')[0]);
  const ids = [...new Set(objects)];
  const batch = execFileSync('git', ['-c', 'safe.directory=' + resolve(root).replaceAll('\\', '/'), 'cat-file', '--batch'], {
    cwd: root, input: ids.join('\n') + '\n', maxBuffer: 256 * 1024 * 1024 });
  let offset = 0;
  for (const id of ids) {
    const end = batch.indexOf(10, offset); if (end < 0) throw Error('OBJECT_SCAN_FAILED');
    const [sha, kind, sizeText] = batch.subarray(offset, end).toString().split(' '); const size = Number(sizeText);
    if (sha !== id || !Number.isSafeInteger(size) || size < 0) throw Error('OBJECT_SCAN_FAILED');
    const bytes = batch.subarray(end + 1, end + 1 + size);
    if (bytes.length !== size) throw Error('OBJECT_SCAN_FAILED');
    if (kind === 'blob' || kind === 'tag') assertPublicBytes(bytes);
    offset = end + 2 + size;
  }
  return { commits: commits.length, objects: new Set(objects).size, privacy: 'passed', contributorIdentity: 'passed' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--history')) console.log(JSON.stringify(scanHistory()));
    else {
      const git = args => execFileSync('git', ['-c', 'safe.directory=' + process.cwd().replaceAll('\\', '/'), ...args]);
      if (process.argv.includes('--identity')) for (const who of ['GIT_AUTHOR_IDENT','GIT_COMMITTER_IDENT']) {
        const identity = git(['var',who]).toString(); assertPublicBytes(Buffer.from(identity));
        if (!identity.startsWith('Excess <329266024+excesssh@users.noreply.github.com> ')) throw Error('CONTRIBUTOR_IDENTITY_BLOCKED');
      }
      const staged=process.argv.includes('--staged');
      const paths = git(['ls-files', '-z']).toString().split('\0').filter(Boolean);
      for (const path of paths) { assertPublicBytes(Buffer.from(path)); assertPublicBytes(staged ? git(['show', ':'+path]) : await readFile(path)); }
      console.log(JSON.stringify({ files: paths.length, privacy: 'passed' }));
    }
  } catch { console.error('PUBLIC_PRIVACY_CHECK_FAILED (sensitive details suppressed)'); process.exitCode = 1; }
}
