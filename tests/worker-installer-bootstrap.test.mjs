import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifyMinisign } from "../packages/protocol/dist/release.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const commit = "0123456789abcdef0123456789abcdef01234567";

function createSigner() {
  const keys = generateKeyPairSync("ed25519"), keyId = Buffer.from("1020304050607080", "hex");
  const rawKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const publicKey = "untrusted comment: temporary test key\n" + Buffer.concat([Buffer.from("Ed"), keyId, rawKey]).toString("base64") + "\n";
  return { publicKey, sign(bytes) {
    const payload = sign(null, createHash("blake2b512").update(bytes).digest(), keys.privateKey), trusted = "sequence:2 fixture";
    const signature = "untrusted comment: temporary test signature\n" + Buffer.concat([Buffer.from("ED"), keyId, payload]).toString("base64") +
      "\ntrusted comment: " + trusted + "\n" + sign(null, Buffer.concat([payload, Buffer.from(trusted)]), keys.privateKey).toString("base64") + "\n";
    verifyMinisign(bytes, signature, publicKey);
    return signature;
  } };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipArchive(entries) {
  const locals = [], centralParts = []; let offset = 0;
  for (const [name, dataInput] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name), data = Buffer.from(dataInput), crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length + data.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); nameBytes.copy(local, 30); data.copy(local, 30 + nameBytes.length);
    locals.push(local);
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(0x81a40000, 38); central.writeUInt32LE(offset, 42); nameBytes.copy(central, 46);
    centralParts.push(central); offset += local.length;
  }
  const central = Buffer.concat(centralParts), body = Buffer.concat(locals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centralParts.length, 8); end.writeUInt16LE(centralParts.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, central, end]);
}

function releaseFor(archive, version = "1.1.0", sourceCommit = commit, sequence = 2) {
  return Buffer.from(JSON.stringify({
    format: 1, product: "Excess Worker", version, sequence, sourceCommit,
    repository: "https://github.com/excesssh/Excess-Worker", releasedAt: "2026-10-05T12:00:00Z",
    files: [{ platform: "win32-x64", file: `excess-worker-${version}-${sourceCommit.slice(0, 12)}-win-x64.zip`, bytes: archive.length, sha256: digest(archive), reproducible: true }],
    isolation: { "win32-x64": "fixture-only" },
    permissions: { filesystem: "fixture", network: "fixture", credentials: "fixture" },
  }));
}

test("Windows standalone installer stages signed fixtures and rejects altered or closed-gate inputs", {
  skip: process.platform !== "win32",
}, async t => {
  const base = await mkdtemp(resolve(".cache/worker-installer-bootstrap-"));
  try {
    const tools = join(base, "tools"); await mkdir(tools);
    await writeFile(join(tools, "verify.mjs"), [
      'import { readFile } from "node:fs/promises";',
      'import { verifyMinisign } from "../../../packages/protocol/dist/release.js";',
      'const args=process.argv.slice(2), value=(key)=>args[args.indexOf(key)+1];',
      'try { verifyMinisign(await readFile(value("-Vm")), await readFile(value("-x"),"utf8"), await readFile(value("-p"),"utf8")); } catch { process.exit(1); }',
    ].join("\n"));
    await writeFile(join(tools, "minisign.cmd"), '@echo off\r\nnode "%~dp0verify.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n');

    const folder = "excess-worker-1.1.0-win-x64", root = `${folder}/`;
    const packageManifest = Buffer.from(JSON.stringify({ product: "EXCESS", package: "worker", publicDistributionReady: false,
      releaseSequence: 2, version: "1.1.0", sourceCommit: commit, platform: "win32-x64" }));
    const archive = zipArchive({ [root + "manifest.json"]: packageManifest, [root + "excess-worker.cmd"]: "@echo off\r\n", [root + "node/node.exe"]: "fixture runtime" });
    const signer = createSigner(), manifestBytes = releaseFor(archive), signed = { publicKey: signer.publicKey, signature: signer.sign(manifestBytes) };
    const manifestPath = join(base, "release.json"), signaturePath = join(base, "release.json.minisig");
    const archivePath = join(base, `excess-worker-1.1.0-${commit.slice(0, 12)}-win-x64.zip`);
    await writeFile(manifestPath, manifestBytes); await writeFile(signaturePath, signed.signature); await writeFile(archivePath, archive);
    const source = await readFile(new URL("../scripts/worker-install/install.ps1", import.meta.url), "utf8");
    const pinnedKey = "untrusted comment: Excess Worker release signing key\nRWR+7mSkyUyE/lT2keiagt8zF/uOTShJBH0GJTylEvj+QQLBaRnm4l6C";
    assert.ok(source.includes(pinnedKey), "production script keeps its fixed public key");
    const testScript = join(base, "install-test.ps1");
    const fixtureScript = source.replace(pinnedKey, signed.publicKey.trimEnd())
      .replace("$message='verification or installation failed safely.'", "$message='ERRORTYPE_' + $_.Exception.GetType().Name + '_LINE_' + $_.InvocationInfo.ScriptLineNumber + '_HRES_' + $_.Exception.HResult");
    await writeFile(testScript, fixtureScript);
    const quote = value => "'" + value.replaceAll("'", "''") + "'";

    async function runFixture(archiveBytes, manifestBytesForRun, signatureForRun, expectedFailure) {
      await writeFile(manifestPath, manifestBytesForRun); await writeFile(signaturePath, signatureForRun); await writeFile(archivePath, archiveBytes);
      const installRoot = join(base, "install-" + expectedFailure.replaceAll(/[^a-z0-9]/gi, ""));
      const command = `$env:PATH=${quote(tools)}+';'+$env:PATH; $source=Get-Content -LiteralPath ${quote(testScript)} -Raw; try { & ([scriptblock]::Create($source)) ${quote(manifestPath)} ${quote(signaturePath)} ${quote(archivePath)} -InstallRoot ${quote(installRoot)} 2>$null; exit 0 } catch { if($_.Exception.Message -like ${quote("*" + expectedFailure + "*")}){exit 17}; exit 1 }`;
      const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", cwd: process.cwd() });
      assert.equal(result.status, 17, "installer refused the fixture for the expected reason");
      let installed = false; try { await access(installRoot); installed = true; } catch {}
      assert.equal(installed, false, "rejected fixture leaves install root absent");
    }

    async function prepareSuccessfulFixture(archiveBytes, manifestBytesForRun, signatureForRun, installRoot, label, candidate = false) {
      const localDir = join(base, label); await mkdir(localDir);
      const localManifest = join(localDir, "release.json"), localSignature = join(localDir, "release.json.minisig");
      await writeFile(localManifest, manifestBytesForRun); await writeFile(localSignature, signatureForRun);
      const release = JSON.parse(manifestBytesForRun.toString("utf8"));
      const releaseArchive = join(localDir, release.files[0].file); await writeFile(releaseArchive, archiveBytes);
      return `$env:PATH=${quote(tools)}+';'+$env:PATH; $source=Get-Content -LiteralPath ${quote(testScript)} -Raw; try { & ([scriptblock]::Create($source)) ${quote(localManifest)} ${quote(localSignature)} ${quote(releaseArchive)} -InstallRoot ${quote(installRoot)} ${candidate ? '-VerificationCandidate' : ''} *> $null; exit 0 } catch { $m=$_.Exception.Message -replace '^EXCESS worker install: ',''; Write-Output ('FIXTURE_REASON_' + ($m -replace '[^A-Za-z0-9]+','_')); exit 1 }`;
    }

    async function runSuccessfulFixture(archiveBytes, manifestBytesForRun, signatureForRun, installRoot, label = "success") {
      const command = await prepareSuccessfulFixture(archiveBytes, manifestBytesForRun, signatureForRun, installRoot, label);
      const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", cwd: process.cwd() });
      assert.equal(result.status, 0, "valid signed fixture installs successfully " + result.stdout.trim());
    }

    function startPowerShell(command) {
      const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; child.stdout.setEncoding("utf8").on("data", value => { stdout += value; });
      child.stderr.on("data", () => {});
      const done = new Promise(resolve => child.on("close", status => resolve({ status, stdout })));
      return { child, done };
    }

    const token = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); [Console]::Write($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"], { encoding: "utf8" });
    assert.equal(token.status, 0, "the test identifies its actual Windows token");
    assert.ok(["True", "False"].includes(token.stdout.trim()));
    if(token.stdout.trim() === "True") {
      await runFixture(archive, manifestBytes, signed.signature, "run as the installing user, not as Administrator");
      t.diagnostic("elevated-token refusal and absent install root verified");
      t.skip("normal-user installation fixtures require a non-elevated host");
      return;
    }
    await runFixture(archive, manifestBytes, signed.signature, "distribution gate is closed");
    const changedArchive = Buffer.from(archive); changedArchive[changedArchive.length - 5] ^= 1;
    await runFixture(changedArchive, manifestBytes, signed.signature, "archive size or SHA-256");
    const alteredManifest = Buffer.from(manifestBytes); alteredManifest[alteredManifest.indexOf(Buffer.from("1.1.0"))] = 0x32;
    await runFixture(archive, alteredManifest, signed.signature, "Minisign signature verification failed");

    const candidatePackage = Buffer.from(JSON.stringify({product:'EXCESS',package:'worker',publicDistributionReady:false,
      releaseGate:'isolated-hardware-execution-pending',licensesIncluded:true,
      releaseSequence:2,version:'1.1.0',sourceCommit:commit,platform:'win32-x64'}));
    const candidateArchive=zipArchive({[root+'manifest.json']:candidatePackage,[root+'excess-worker.cmd']:'@echo off\r\n',[root+'node/node.exe']:'fixture runtime'});
    const candidateManifest=releaseFor(candidateArchive), candidateSignature=signer.sign(candidateManifest);
    await runFixture(candidateArchive,candidateManifest,candidateSignature,'distribution gate is closed');
    const candidateRoot=join(base,'candidate-install');
    const candidateCommand=await prepareSuccessfulFixture(candidateArchive,candidateManifest,candidateSignature,candidateRoot,'candidate-verification',true);
    const candidateResult=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',candidateCommand],{encoding:'utf8',cwd:process.cwd()});
    assert.equal(candidateResult.status,0,'explicit signed candidate installation succeeds');
    const installedCandidate=JSON.parse(await readFile(join(candidateRoot,'app',`1.1.0-${commit.slice(0,12)}`,'manifest.json'),'utf8'));
    assert.equal(installedCandidate.publicDistributionReady,false,'verification installation cannot promote readiness');
    const candidateStateBefore=await readFile(join(candidateRoot,'state','release-high-water.json'));
    const invalidCommand=await prepareSuccessfulFixture(candidateArchive,alteredManifest,candidateSignature,candidateRoot,'candidate-tampered',true);
    const invalidResult=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',invalidCommand],{encoding:'utf8',cwd:process.cwd()});
    assert.notEqual(invalidResult.status,0,'candidate mode retains signature checks');
    assert.deepEqual(await readFile(join(candidateRoot,'state','release-high-water.json')),candidateStateBefore);

    const installRoot = join(base, "successful-install");
    const readyPackage = value => Buffer.from(JSON.stringify({ product: "EXCESS", package: "worker", publicDistributionReady: true,
      releaseSequence: value.sequence, version: value.version, sourceCommit: value.commit, platform: "win32-x64" }));
    const makeReady = (version, source, sequence) => {
      const folderName = `excess-worker-${version}-win-x64`, files = {
        [`${folderName}/manifest.json`]: readyPackage({ version, commit: source, sequence }),
        [`${folderName}/excess-worker.cmd`]: "@echo off\r\n", [`${folderName}/node/node.exe`]: "fixture runtime",
        [`${folderName}/@fixture/package`]: "scoped archive path",
      };
      const bytes = zipArchive(files), json = releaseFor(bytes, version, source, sequence), signature = signer.sign(json);
      return { bytes, json, signature };
    };
    const first = makeReady("1.1.0", commit, 2);
    await runSuccessfulFixture(first.bytes, first.json, first.signature, installRoot, "first-install");
    const firstApp = join(installRoot, "app", `1.1.0-${commit.slice(0, 12)}`);
    assert.ok((await readFile(join(firstApp, "manifest.json"), "utf8")).includes('"publicDistributionReady":true'));
    const secondCommit = "abcdef0123456789abcdef0123456789abcdef01", second = makeReady("1.2.0", secondCommit, 3);
    await runSuccessfulFixture(second.bytes, second.json, second.signature, installRoot, "second-install");
    const launcher = await readFile(join(installRoot, "bin", "excess-worker.cmd"), "utf8");
    const state = JSON.parse(await readFile(join(installRoot, "state", "release-high-water.json"), "utf8"));
    assert.ok((await (await import("node:fs/promises")).lstat(join(installRoot, "state", "install.lock"))).isFile());
    assert.ok(launcher.includes(`1.2.0-${secondCommit.slice(0, 12)}`));
    assert.equal(state.sequence, 3);
    assert.ok((await readFile(join(firstApp, "manifest.json"), "utf8")).includes(commit), "upgrade preserves prior version");

    const thirdCommit = "1111111123456789abcdef0123456789abcdef01";
    const fourthCommit = "2222222234567890abcdef0123456789abcdef01";
    const third = makeReady("1.3.0", thirdCommit, 4), fourth = makeReady("1.4.0", fourthCommit, 5);
    const thirdCommand = await prepareSuccessfulFixture(third.bytes, third.json, third.signature, installRoot, "concurrent-older");
    const fourthCommand = await prepareSuccessfulFixture(fourth.bytes, fourth.json, fourth.signature, installRoot, "concurrent-newer");
    const readyPath = join(base, "lock-ready"), releasePath = join(base, "release-lock");
    const holder = startPowerShell(`$f=[IO.File]::Open(${quote(join(installRoot, "state", "install.lock"))},[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); [IO.File]::WriteAllText(${quote(readyPath)},'ready'); while(-not (Test-Path -LiteralPath ${quote(releasePath)})){Start-Sleep -Milliseconds 25}; $f.Dispose(); exit 0`);
    let older, newer;
    try {
      const lockDeadline = Date.now() + 10000;
      while(Date.now() < lockDeadline){try{await access(readyPath);break;}catch{await new Promise(resolve => setTimeout(resolve,25));}}
      await access(readyPath);
      older = startPowerShell(thirdCommand); newer = startPowerShell(fourthCommand);
      const stageDeadline = Date.now() + 15000;
      let stageCount = 0;
      while(Date.now() < stageDeadline){stageCount=(await (await import("node:fs/promises")).readdir(installRoot)).filter(name=>name.startsWith(".excess-worker-stage-")).length;if(stageCount>=2)break;await new Promise(resolve=>setTimeout(resolve,25));}
      assert.ok(stageCount >= 2, "both installers stage while serialized by the state lock");
      await new Promise(resolve => setTimeout(resolve,150));
      const lockedState = JSON.parse(await readFile(join(installRoot, "state", "release-high-water.json"), "utf8"));
      const lockedLauncher = await readFile(join(installRoot, "bin", "excess-worker.cmd"), "utf8");
      assert.equal(lockedState.sequence, 3, "neither concurrent installer changes state while the exclusive lock is held");
      assert.ok(lockedLauncher.includes(`1.2.0-${secondCommit.slice(0, 12)}`));
    } finally {
      await writeFile(releasePath, "release");
      await Promise.all([holder.done, older?.done ?? Promise.resolve(), newer?.done ?? Promise.resolve()]);
    }
    const [olderResult, newerResult] = await Promise.all([older.done, newer.done]);
    assert.equal(newerResult.status, 0, "higher sequence installs after lock release " + newerResult.stdout.trim());
    assert.ok(olderResult.status === 0 || /FIXTURE_REASON_release_sequence_rollback_rejected/.test(olderResult.stdout), "older sequence either precedes the newer install or is rejected afterward");
    const concurrentState = JSON.parse(await readFile(join(installRoot, "state", "release-high-water.json"), "utf8"));
    const concurrentLauncher = await readFile(join(installRoot, "bin", "excess-worker.cmd"), "utf8");
    assert.equal(concurrentState.sequence, 5);
    assert.ok(concurrentLauncher.includes(`1.4.0-${fourthCommit.slice(0, 12)}`));
  } finally { await rm(base, { recursive: true, force: true }); }
});
