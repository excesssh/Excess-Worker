import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { parseReleaseManifest, verifyMinisign } from '../../packages/protocol/dist/release.js';
import { assertPublicBytes, scanHistory } from './privacy.mjs';
import { packagePayloadFingerprint, verifyExecutionEvidence } from './execution-gates.mjs';
import { requiresLinuxGpuSandbox } from './linux-gpu-package.mjs';

// Sign reproducible local artifacts. Publication follows exact-package and HTTPS verification.
const [firstArg, secondArg, outArg] = process.argv.slice(2);
if (!firstArg || !secondArg || !outArg) throw Error('Usage: release.mjs <build-a/packages> <build-b/packages> <candidate-out>');
const first = resolve(firstArg), second = resolve(secondArg), out = resolve(outArg);
for(const directory of [first,second,out])assertPublicBytes(Buffer.from(directory));
const status = execFileSync('git', ['-c','safe.directory='+process.cwd().replaceAll('\\','/'),'status','--porcelain=v1','--untracked-files=all'], {encoding:'utf8'});
if(status.trim())throw Error('RELEASE_SOURCE_TREE_DIRTY');
const key = process.env.EXCESS_WORKER_MINISIGN_KEY;
if (!key) throw Error('EXCESS_WORKER_MINISIGN_KEY must be injected from secure project credential storage');
const tool = process.env.EXCESS_MINISIGN ?? 'minisign';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
scanHistory();
const sourceCommit = execFileSync('git', ['-c','safe.directory='+process.cwd().replaceAll('\\','/'),'rev-parse','HEAD'], {encoding:'utf8'}).trim();
const controllerSource=await readFile('native/windows/ExcessController.cs');assertPublicBytes(controllerSource);
const controllerSourceSha256=hash(controllerSource);
const files = [], comparisons = [], isolation = {}; let version, sequence, releasedAt, releaseReady;
await mkdir(out,{recursive:true});
for (const [platform,suffix,extension] of [['win32-x64','win-x64','.zip'],['linux-x64','linux-x64','.tar.gz']]) {
  const workerVersion = JSON.parse(await readFile('apps/worker/package.json','utf8')).version;
  const folder = 'excess-worker-'+workerVersion+'-'+suffix;
  const [left,right] = await Promise.all([readFile(join(first,folder+extension)),readFile(join(second,folder+extension))]);
  assertPublicBytes(left); assertPublicBytes(right);
  if(!left.equals(right))throw Error('ARTIFACT_NOT_REPRODUCIBLE '+platform);
  const manifest = JSON.parse(await readFile(join(first,folder,'manifest.json'),'utf8'));
  const otherManifest = JSON.parse(await readFile(join(second,folder,'manifest.json'),'utf8'));
  if(manifest.sourceCommit!==sourceCommit||!manifest.licensesIncluded||typeof manifest.publicDistributionReady!=='boolean')throw Error('CANDIDATE_IDENTITY_INVALID');
  const ready=manifest.publicDistributionReady;
  if(releaseReady!==undefined&&ready!==releaseReady)throw Error('CANDIDATE_READINESS_MISMATCH');
  releaseReady=ready;
  const expectedProfile=platform==='win32-x64'?'windows-appcontainer-v1':'linux-landlock-v1';
  const helperFile=platform==='win32-x64'?'ExcessSandbox.exe':'excess-sandbox';
  const expectedFile='app/node_modules/@excess/adapters/native/'+helperFile;
  const requireGpu=platform==='linux-x64'&&requiresLinuxGpuSandbox(workerVersion);
  if(manifest.native?.profile!==expectedProfile||manifest.native.file!==expectedFile||manifest.execution?.profile!==expectedProfile||
    JSON.stringify(manifest)!==JSON.stringify(otherManifest))throw Error('CANDIDATE_NATIVE_BOUNDARY_INVALID');
  if(ready){
    const evidence=await readFile('releases/execution-evidence.json');assertPublicBytes(evidence);
    const committed=execFileSync('git',['show','HEAD:releases/execution-evidence.json']);
    if(!evidence.equals(committed))throw Error('EXECUTION_EVIDENCE_NOT_COMMITTED');
    const verified=verifyExecutionEvidence(evidence,platform,await packagePayloadFingerprint(join(first,folder)),manifest.releaseSequence);
    execFileSync('git',['merge-base','--is-ancestor',verified.testedSourceCommit,sourceCommit],{stdio:'ignore'});
    if(JSON.stringify(verified)!==JSON.stringify(manifest.verification)||manifest.execution.cpuVerified!==true||
      manifest.execution.gpuVerified!==verified.gpuVerified||manifest.controller?.verified!==true||
      manifest.releaseGate!=='verified-execution'||manifest.releaseSigning!=='anonymous-minisign'||manifest.codeSigned!==false||
      platform==='win32-x64'&&manifest.windowsPublisher!=='no-trusted-authenticode-signature')throw Error('CANDIDATE_EXECUTION_EVIDENCE_INVALID');
    const gpuClaim=requireGpu?(verified.gpuVerified
      ?' + linux-cuda-device-budget-v1 verified only for the recorded configuration'
      :' + linux-cuda-device-budget-v1 candidate/unverified'):'';
    isolation[platform]=(platform==='linux-x64'?'linux-controller-namespaces-v1 and '+expectedProfile:'windows-appcontainer-controller-v1 and '+expectedProfile)+
      (verified.gpuVerified&&platform==='win32-x64'?' + windows-cuda-budget-v1':'')+gpuClaim+': '+verified.configuration;
  }else{
    if(manifest.execution.cpuVerified!==false||manifest.execution.gpuVerified!==false||manifest.controller?.verified!==false||manifest.verification!==undefined)
      throw Error('CANDIDATE_NATIVE_BOUNDARY_INVALID');
    const gpuClaim=requireGpu?' + linux-cuda-device-budget-v1 candidate/unverified':'';
    isolation[platform]=(platform==='linux-x64'?'linux-controller-namespaces-v1 and '+expectedProfile:'windows-appcontainer-controller-v1 and '+expectedProfile)+
      gpuClaim+': local candidate; packaged execution gates incomplete';
  }
  const [helperA,helperB]=await Promise.all([readFile(join(first,folder,expectedFile)),readFile(join(second,folder,expectedFile))]);
  assertPublicBytes(helperA);assertPublicBytes(helperB);
  if(!helperA.equals(helperB)||manifest.native.sha256!==hash(helperA))throw Error('CANDIDATE_NATIVE_BOUNDARY_INVALID');
  if(platform==='linux-x64') {
    const expected=[['excess-controller','integrity-controller.json','linux-controller-namespaces-v1'],['excess-egress-peer','integrity-egress-peer.json','linux-af-unix-peercred-v1']];
    if(manifest.controller?.profile!=='linux-controller-namespaces-v1'||manifest.controller.verified!==ready||manifest.controller.files?.length!==expected.length)throw Error('CANDIDATE_CONTROLLER_BOUNDARY_INVALID');
    for(const [file,pin,profile] of expected) {
      const path='app/node_modules/@excess/adapters/native/'+file;
      const declared=manifest.controller.files.find(item=>item.file===path);
      const [left,right,pinBytes]=await Promise.all([readFile(join(first,folder,path)),readFile(join(second,folder,path)),readFile(join(first,folder,'app/node_modules/@excess/adapters/native/'+pin))]);
      assertPublicBytes(left);assertPublicBytes(right);assertPublicBytes(pinBytes);
      const integrity=JSON.parse(pinBytes);
      if(!declared||declared.profile!==profile||declared.sha256!==hash(left)||!left.equals(right)||Object.keys(integrity).sort().join(',')!=='profile,sha256'||integrity.profile!==profile||integrity.sha256!==hash(left))throw Error('CANDIDATE_CONTROLLER_BOUNDARY_INVALID');
    }
    if(requireGpu) {
      const helperPath='app/node_modules/@excess/adapters/native/excess-gpu-sandbox';
      const pinPath='app/node_modules/@excess/adapters/native/integrity-gpu.json';
      const gpu=manifest.gpu;
      const [gpuA,gpuB,pinA,pinB]=await Promise.all([readFile(join(first,folder,helperPath)),readFile(join(second,folder,helperPath)),
        readFile(join(first,folder,pinPath)),readFile(join(second,folder,pinPath))]);
      for(const bytes of [gpuA,gpuB,pinA,pinB])assertPublicBytes(bytes);
      const integrity=JSON.parse(pinA.toString('utf8'));
      const expectedStatus=ready&&manifest.execution.gpuVerified===true?'verified-configuration-only':'candidate-unverified';
      if(!gpu||Object.keys(gpu).sort().join(',')!=='file,integrityFile,profile,sha256,status'||gpu.file!==helperPath||gpu.integrityFile!==pinPath||
        gpu.profile!=='linux-cuda-device-budget-v1'||gpu.sha256!==hash(gpuA)||gpu.status!==expectedStatus||!gpuA.equals(gpuB)||!pinA.equals(pinB)||
        Object.keys(integrity).sort().join(',')!=='profile,sha256'||integrity.profile!==gpu.profile||integrity.sha256!==gpu.sha256)
        throw Error('CANDIDATE_GPU_BOUNDARY_INVALID');
    } else if(manifest.gpu!==undefined) throw Error('CANDIDATE_GPU_BOUNDARY_INVALID');
  } else {
    const relative='app/node_modules/@excess/adapters/native/ExcessController.exe';
    const pinRelative='app/node_modules/@excess/adapters/native/integrity-controller-win32.json';
    if(manifest.controller?.profile!=='windows-appcontainer-controller-v1'||manifest.controller.verified!==ready||manifest.controller.files?.length!==1)throw Error('CANDIDATE_CONTROLLER_BOUNDARY_INVALID');
    const declared=manifest.controller.files[0];
    const [controllerA,controllerB,pinA,pinB]=await Promise.all([readFile(join(first,folder,relative)),readFile(join(second,folder,relative)),readFile(join(first,folder,pinRelative)),readFile(join(second,folder,pinRelative))]);
    for(const bytes of [controllerA,controllerB,pinA,pinB])assertPublicBytes(bytes);
    const integrity=JSON.parse(pinA.toString('utf8'));
    const keys=['compiler','debugSymbols','deterministic','profile','references','sha256','sourceSha256','toolchainInventorySha256'];
    if(!controllerA.equals(controllerB)||!pinA.equals(pinB)||declared.file!==relative||declared.profile!=='windows-appcontainer-controller-v1'||
      declared.sha256!==hash(controllerA)||Object.keys(integrity).sort().join(',')!==keys.sort().join(',')||
      integrity.profile!=='windows-appcontainer-controller-v1'||integrity.sha256!==hash(controllerA)||
      integrity.sourceSha256!==controllerSourceSha256||
      integrity.compiler!=='Microsoft.Net.Compilers.Toolset 4.14.0'||integrity.references!=='Microsoft.NETFramework.ReferenceAssemblies.net48 1.0.3'||
      integrity.toolchainInventorySha256!=='051d04fab3d3756d47d766b01e009fab3000445134d4db909bc0a034e71ac3bd'||
      integrity.deterministic!==true||integrity.debugSymbols!==false||!/^[0-9a-f]{64}$/.test(integrity.sourceSha256))throw Error('CANDIDATE_CONTROLLER_BOUNDARY_INVALID');
  }
  if(version&&(manifest.version!==version||manifest.releaseSequence!==sequence||manifest.builtAt!==releasedAt))throw Error('CANDIDATE_METADATA_MISMATCH');
  version=manifest.version;sequence=manifest.releaseSequence;releasedAt=manifest.builtAt;
  const file='excess-worker-'+version+'-'+sourceCommit.slice(0,12)+'-'+suffix+extension;
  await copyFile(join(first,folder+extension),join(out,file));
  files.push({platform,file,bytes:left.length,sha256:hash(left),reproducible:true});
  comparisons.push({platform,sha256:hash(left),bytes:left.length,result:'byte-identical clean-directory builds'});
}
const manifest = {format:1,product:'Excess Worker',version,sequence,sourceCommit,repository:'https://github.com/excesssh/Excess-Worker',releasedAt,files,
  isolation,
  permissions:{filesystem:'Verified runtime files and selected model files are read-only; private scratch is writable. Unsupported profiles refuse execution.',
  network:'Linux controller has a private network namespace and fixed-origin, bounded HTTPS coordinator broker; the model runtime cannot open outbound TCP, UDP or Unix sockets. Windows controller and model runtime run in zero-network AppContainers; the controller uses a bounded typed host broker for the paired HTTPS origin.',
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
  execFileSync(tool,['-S','-s',privateKey,'-m',target,'-t','Excess Worker '+(releaseReady?'release ':'candidate ')+version+' sequence '+sequence,'-c','Excess Worker release manifest'],{stdio:['ignore','ignore','pipe']});
  const publicKey=await readFile('releases/minisign.pub','utf8'),signature=await readFile(target+'.minisig','utf8');
  verifyMinisign(bytes,signature,publicKey);
  execFileSync(tool,['-V','-H','-q','-p',resolve('releases/minisign.pub'),'-m',target],{stdio:['ignore','ignore','pipe']});
  await copyFile('releases/minisign.pub',join(out,'minisign.pub'));
} finally {
  if(dirname(privateDir)!==out||!privateDir.startsWith(join(out,'.signing-')))throw Error('SIGNING_CLEANUP_BOUNDARY_INVALID');
  await rm(privateDir,{recursive:true,force:true});
}
await writeFile(join(out,releaseReady?'RELEASE.txt':'CANDIDATE.txt'),releaseReady
  ?'LOCAL VERIFIED RELEASE ARTIFACTS — NOT YET PUBLISHED\nExecution evidence is bound to unchanged payload bytes. Verify the exact signed installation and HTTPS update journey before publication.\nAnonymous Minisign verifies integrity, not publisher identity or hardware attestation. Windows has no trusted Authenticode publisher signature.\n'
  :'LOCAL CANDIDATE — NOT PUBLISHED\nOS-enforced CPU/GPU model workloads have not passed the release gates.\nThe signature verifies source and artifact metadata; it does not certify hardware execution.\n');
await writeFile(join(out,'reproducibility.json'),JSON.stringify({sourceCommit,node:process.version,comparisons,signature:'verified by bundled verifier and Minisign 0.12',publication:releaseReady?'exact final installation and HTTPS verification pending':'blocked by isolated hardware execution'},null,2)+'\n');
console.log(JSON.stringify({sourceCommit,files,signature:'verified',publication:releaseReady?'not attempted; final package and HTTPS gates pending':'not attempted; hardware gates pending'}));
