import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const shell = await readFile(new URL("../scripts/worker-install/install.sh", import.meta.url), "utf8");
const powershell = await readFile(new URL("../scripts/worker-install/install.ps1", import.meta.url), "utf8");

test("standalone installers authenticate the fixed-key local release and bound its input", () => {
  for (const source of [shell, powershell]) {
    assert.match(source, /RWR\+7mSkyUyE\/lT2keiagt8zF\/uOTShJBH0GJTylEvj\+QQLBaRnm4l6C/);
    assert.match(source, /minisign\s+-Vm/i);
    assert.match(source, /64 KiB|64KB/);
    assert.match(source, /256 MiB|256MB/);
    assert.match(source, /sourceCommit/);
    assert.match(source, /sha256|SHA256/);
    assert.match(source, /release sequence rollback/i);
    assert.match(source, /release-high-water\.json/);
    assert.doesNotMatch(source, /(?:curl|Invoke-WebRequest|irm)[^\n]*\|\s*(?:sh|iex)|\biex\b|Invoke-Expression/i);
  }
});

test("standalone extraction rejects unsafe archive entries and validates package readiness before install", () => {
  assert.match(shell, /issym\(\)|islnk\(\)|isdev\(\)|isfifo\(\)/);
  assert.match(shell, /path is unsafe/);
  assert.match(shell, /publicDistributionReady.*is not True/);
  assert.match(shell, /staged package rehash failed/);
  assert.match(shell, /os\.replace\(temp_launcher,launcher\)/);
  assert.match(shell, /MAX_TOTAL = 1024 \* 1024 \* 1024/);
  assert.match(shell, /MAX_ENTRY = 128 \* 1024 \* 1024/);

  assert.match(powershell, /ExternalAttributes/);
  assert.match(powershell, /archive links and special entries are not allowed/);
  assert.match(powershell, /publicDistributionReady -ne \$true/);
  assert.match(powershell, /staged package rehash failed/);
  assert.match(powershell, /\[IO\.File\]::Replace/);
  assert.match(powershell, /maximumTotal = 1GB/);
  assert.match(powershell, /maximumEntry = 128MB/);
  assert.match(powershell, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
});

test("bootstrap scripts are local-only and cannot install the current closed candidate", () => {
  for (const source of [shell, powershell]) {
    assert.match(source, /local/);
    assert.match(source, /publicDistributionReady/);
    assert.match(source, /distribution gate is closed/);
    assert.doesNotMatch(source, /latest-(?:win|linux)-x64/);
  }
  assert.match(shell, /prefix=\$\{EXCESS_INSTALL_ROOT/);
  assert.match(shell, /EXCESS WORKER MANAGED LAUNCHER/);
  assert.match(powershell, /EXCESS_WORKER_INSTALL_ROOT/);
  assert.match(powershell, /EXCESS WORKER MANAGED LAUNCHER/);
});
