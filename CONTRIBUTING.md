<img src="docs/assets/excess-mark.png" alt="Excess logo" width="48" />

# Contributing

This repository contains the public source for Excess Worker, including the published 0.1.0 release. Keep changes within the worker, adapter, protocol and their focused tests unless maintainers explicitly expand the scope.

Agent-assisted work uses **one lead agent only**. Do not delegate implementation or review to subagents. The lead owns the changes and verification; see [AGENTS.md](AGENTS.md).

## Development setup

Use the pinned Node 24.11.1, npm 11.7.0 and committed lockfile. Use `npm.cmd` in Windows PowerShell.

    npm ci --ignore-scripts
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

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/excesssh/Excess-Worker/security/advisories/new), following [the security policy](SECURITY.md#reporting). Use public issues for non-sensitive bugs and feature discussions, and pull requests for proposed source changes.
