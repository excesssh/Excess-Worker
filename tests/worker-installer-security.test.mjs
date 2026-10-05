import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const shell = await readFile(new URL("../scripts/worker-install/install.sh", import.meta.url), "utf8");
const powershell = await readFile(new URL("../scripts/worker-install/install.ps1", import.meta.url), "utf8");

test("standalone worker installers verify the pinned signed local manifest and exact archive digest", () => {
  for (const source of [shell, powershell]) {
    assert.match(source, /RWR\+7mSkyUyE\/lT2keiagt8zF\/uOTShJBH0GJTylEvj\+QQLBaRnm4l6C/);
    assert.match(source, /minisign/i);
    assert.match(source, /64 KiB|64KB/);
    assert.match(source, /256 MiB|256MB/);
    assert.match(source, /sourceCommit/);
    assert.match(source, /sha256|SHA256/);
    assert.match(source, /source-bound/i);
    assert.match(source, /no files were extracted or changed/);
    assert.doesNotMatch(source, /latest-(?:win|linux)-x64|curl[^\n]*\|\s*sh|\biex\b|Invoke-Expression/i);
  }
});

test("standalone installers stop before extraction or launch while the bootstrap gate is closed", () => {
  assert.match(shell, /installation is intentionally unavailable/i);
  assert.match(powershell, /installation is intentionally unavailable/i);
  assert.doesNotMatch(shell, /\btar\s+-x/);
  assert.doesNotMatch(powershell, /Expand-Archive|Move-Item/);
});
