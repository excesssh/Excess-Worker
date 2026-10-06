# Pinned model download and import

The default model is Qwen3-4B Q4_K_M from `Qwen/Qwen3-4B-GGUF`, revision `bc640142c66e1fdd12af0bd68f40445458f3869b`. Its GGUF is 2,497,280,256 bytes with SHA-256 `7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`. The Apache-2.0 licence is independently pinned: 11,544 bytes, SHA-256 `5de36594c10839788a8c589443a8ef9d8b8d17c65a1b5807206ae037fc36c6bd`. See the catalog in `packages/adapters/src/manifest.ts` for exact download URLs and other entries. Do not edit tokenizer or licence bytes to satisfy a raw text scan; that changes the approved model and can break required attribution.

After a source build, the specialised route can verify an existing file without copying it:

```sh
node scripts/public-worker/model-route.mjs verify qwen3-4b ./Qwen3-4B-Q4_K_M.gguf
```

For a neutral local verification store, explicitly accept licences when importing:

```powershell
node scripts/public-worker/model-route.mjs import qwen3-4b C:/ExcessBuilds/model-verification/ai ./Qwen3-4B-Q4_K_M.gguf --accept-licenses
```

For a fresh download into that store:

```powershell
node scripts/public-worker/model-route.mjs download qwen3-4b C:/ExcessBuilds/model-verification/ai --accept-download --accept-licenses
```

The route uses the existing bounded HTTPS downloader, approved hosts, revision-pinned URLs, resumable cache and whole-file size/hash checks. Before import it verifies exact catalog provenance and inspects human-readable GGUF metadata and tensor names for personal identifiers, paths and credentials. Only immutable tokenizer token/merge arrays receive the upstream-vocabulary classification. Licence texts retain required upstream attribution verbatim and must match their exact catalog pins; paths and credentials still fail. Reports include counts and approved pins, never matching token values or personal source paths. The stricter source, Git history, identity and package scanner is unchanged. This classification is not an exception for prompts, outputs, local metadata or arbitrary model files.

The ordinary worker commands also require explicit consent:

```sh
excess-worker model-plan qwen3-4b
excess-worker import qwen3-4b ./Qwen3-4B-Q4_K_M.gguf --accept-licenses
excess-worker install-model qwen3-4b --accept-download --accept-licenses
```

Import verifies bytes, hard-links on the same volume when possible and otherwise copies. Only the pinned licence texts are downloaded during import. The model runtime is installed separately. A verified model download/import does not establish GPU support, positive worker installation or a real buyer job.
