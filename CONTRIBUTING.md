# Contributing

This repository is a standalone worker source candidate. Keep changes within the worker, adapter, protocol, and their focused tests unless the maintainers explicitly expand the scope.

## Development setup

The workspace pins its runtime and package-manager ranges in package.json. Use a compatible Node release and npm 11, and keep package-lock.json in sync with workspace manifests.

    npm ci
    npm run build

Run the focused test file for the boundary you changed, then run:

    npm test

Do not report a fixture result as a real job, a local probe as production execution, or a detected GPU as verified GPU execution. Record the exact platform, filesystem, isolation mode, and test method for any execution evidence.

## Changes and review

- Keep model downloads opt-in and preserve license acceptance checks.
- Preserve protocol size bounds, durable delivery behavior, and safe shutdown behavior.
- Do not put credentials, private keys, personal paths, service secrets, logs, or screenshots with private traces in source, fixtures, or commit metadata.
- Do not add a production in-memory coordinator fallback or combine worker execution with settlement signing.
- Do not describe an unpublished artifact as a released product, production-ready, or hardware-verified. State whether a local signature was generated and what verification was performed.
- Update the relevant documentation when commands, platform blockers, or data handling change.

Before opening a change, check the actual files and Git identity for private paths, credentials, and other private project traces.
