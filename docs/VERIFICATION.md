# Verify a release

No release has been published. These instructions apply to a local signed candidate and future release files. A signature authenticates the release metadata, not the honesty of jobs, the trust of device keys, or hardware execution.

Obtain `release.json`, `release.json.minisig`, and the exact archive named in the manifest. The release public key is [minisign.pub](../releases/minisign.pub). Establish that key independently from a trusted source checkout; downloading a new key beside an untrusted archive provides no independent trust.

With [Minisign](https://jedisct1.github.io/minisign/) installed:

```sh
minisign -Vm release.json -x release.json.minisig -p releases/minisign.pub
```

After that succeeds, compare the archive basename, byte count and SHA-256 with the authenticated entry in `release.json`. The manifest binds version, monotonically increasing sequence, full source commit, exact filenames, sizes and hashes. It also records declared isolation, permissions and per-artifact reproducibility.

The reviewed local scripts perform signature and archive checks without extraction:

```sh
sh scripts/worker-install/install.sh release.json release.json.minisig <exact-linux-archive>
```

```powershell
powershell -NoProfile -File scripts/worker-install/install.ps1 release.json release.json.minisig <exact-windows-archive>
```

They return a nonzero status after successful verification because installation is intentionally unavailable. They never execute a downloaded script. The first-install bootstrap remains a release blocker.

The website's local file checker compares an archive with the selected manifest's exact filename, size and SHA-256. It reads files locally and does not verify Minisign in the browser. Job-receipt checking is a separate feature and proves only the explicitly signed receipt fields for the supplied device key.

Packaged production updates verify the pinned Minisign key before parsing metadata, bound downloads and extraction, reject archive links and identity mismatches, and record a sequence/version/source high-water mark. Rollback and same-sequence equivocation are rejected. Source builds and closed-gate candidates cannot self-update. A fresh installation still needs a trusted minimum sequence; deleting local state removes its remembered high-water protection.
