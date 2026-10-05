import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { parseReleaseManifest, verifyMinisign } from '../../packages/protocol/dist/release.js';
import { assertPublicBytes, scanHistory } from './privacy.mjs';

// Prepare a signed local candidate. Publication requires separate completed hardware gates.
const [firstArg, secondArg, outArg] = process.argv.slice(2);
if (!firstArg || !secondArg || !outArg) throw Error('Usage: release.mjs <build-a/packages> <build-b/packages> <candidate-out>');
const first = resolve(firstArg), second = resolve(secondArg), out = resolve(outArg);
const key = process.env.EXCESS_WORKER_MINISIGN_KEY;
if (!key) throw Error('EXCESS_WORKER_MINISIGN_KEY must be injected from secure project credential storage');
const tool = process.env.EXCESS_MINISIGN ?? 'minisign';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
scanHistory();
const sourceCommit = execFileSync('git', ['-c','safe.directory='+process.cwd().replaceAll('\\','/'),'rev-parse','HEAD'], {encoding:'utf8'}).trim();
const files = [], comparisons = []; let version, sequence, releasedAt;
await mkdir(out,{recursive:true});
for (const [platform,suffix,extension] of [['win32-x64','win-x64','.zip'],['linux-x64','linux-x64','.tar.gz']]) {
  const workerVersion = JSON.parse(await readFile('apps/worker/package.json','utf8')).version;
  const folder = 'excess-worker-'+workerVersion+'-'+suffix;
  const [left,right] = await Promise.all([readFile(join(first,folder+extension)),readFile(join(second,folder+extension))]);
  assertPublicBytes(left); assertPublicBytes(right);
  if(!left.equals(right))throw Error('ARTIFACT_NOT_REPRODUCIBLE '+platform);
  const manifest = JSON.parse(await readFile(join(first,folder,'manifest.json'),'utf8'));
  if(manifest.sourceCommit!==sourceCommit||!manifest.licensesIncluded||manifest.publicDistributionReady!==false)throw Error('CANDIDATE_IDENTITY_INVALID');
  if(version&&(manifest.version!==version||manifest.releaseSequence!==sequence||manifest.builtAt!==releasedAt))throw Error('CANDIDATE_METADATA_MISMATCH');
  version=manifest.version;sequence=manifest.releaseSequence;releasedAt=manifest.builtAt;
  const file='excess-worker-'+version+'-'+sourceCommit.slice(0,12)+'-'+suffix+extension;
  await copyFile(join(first,folder+extension),join(out,file));
  files.push({platform,file,bytes:left.length,sha256:hash(left),reproducible:true});
  comparisons.push({platform,sha256:hash(left),bytes:left.length,result:'byte-identical clean-directory builds'});
}
const manifest = {format:1,product:'Excess Worker',version,sequence,sourceCommit,repository:'https://github.com/excesssh/Excess-Worker',releasedAt,files,
  isolation:{'win32-x64':'unavailable: AppContainer loopback integration pending','linux-x64':'linux-landlock-v1: kernel fixture verified; real hardware execution pending'},
  permissions:{filesystem:'Runtime and selected model directories read-only; private scratch writable. Unsupported isolation profiles refuse execution.',
    network:'Worker contacts the paired HTTPS coordinator. Linux model runtime binds one local TCP port and cannot open outbound TCP, UDP or Unix sockets.',
    credentials:'Revocable device Ed25519 machine key stays outside the model runtime and cannot authorize wallet spending or withdrawals.'}};
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');parseReleaseManifest(bytes);assertPublicBytes(bytes);
const target=join(out,'release.json');await writeFile(target,bytes);
// Temporary key material is user-only and removed even when Minisign fails. Never log it.
const privateDir=await mkdtemp(join(out,'.signing-'));
try {
  if(process.platform==='win32') {
    const sid=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{encoding:'utf8'}).trim();
    execFileSync('icacls',[privateDir,'/inheritance:r','/grant:r','*'+sid+':(OI)(CI)F'],{stdio:'ignore'});
  }
  const privateKey=join(privateDir,'release.key');assertPublicBytes(Buffer.from(key));await writeFile(privateKey,key,{mode:0o600});
  execFileSync(tool,['-S','-s',privateKey,'-m',target,'-t','Excess Worker candidate '+version+' sequence '+sequence,'-c','Excess Worker release manifest'],{stdio:['ignore','ignore','pipe']});
  const publicKey=await readFile('releases/minisign.pub','utf8'),signature=await readFile(target+'.minisig','utf8');
  verifyMinisign(bytes,signature,publicKey);
  execFileSync(tool,['-V','-H','-q','-p',resolve('releases/minisign.pub'),'-m',target],{stdio:['ignore','ignore','pipe']});
  await copyFile('releases/minisign.pub',join(out,'minisign.pub'));
} finally {
  if(dirname(privateDir)!==out||!privateDir.startsWith(join(out,'.signing-')))throw Error('SIGNING_CLEANUP_BOUNDARY_INVALID');
  await rm(privateDir,{recursive:true,force:true});
}
await writeFile(join(out,'CANDIDATE.txt'),'LOCAL CANDIDATE — NOT PUBLISHED\nOS-enforced CPU/GPU model workloads have not passed the release gates.\nThe signature verifies source and artifact metadata; it does not certify hardware execution.\n');
await writeFile(join(out,'reproducibility.json'),JSON.stringify({sourceCommit,node:process.version,comparisons,signature:'verified by bundled verifier and Minisign 0.12',publication:'blocked by isolated hardware execution'},null,2)+'\n');
console.log(JSON.stringify({sourceCommit,files,signature:'verified',publication:'not attempted; hardware gates pending'}));
