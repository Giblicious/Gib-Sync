# v2 completion and release gate

This checklist tracks the remaining work after 0.8.62. A checked item requires
executable coverage and integration, not only a helper or design document.

- [x] Authoritative operation ledger, materialized tree, explicit base revisions,
      idempotent batch/operation receipts, and legacy snapshot bridge.
- [x] Stable file and folder identities, explicit moves/deletes/recreation,
      identity-safe folder moves with concurrent descendant edits.
- [x] One shared deterministic reconciliation planner drives client and backend.
- [x] Persistent yielding stat/hash inventory and event-intent journal;
      rolling verification catches metadata-preserving external changes.
- [x] Automatic configuration-root mapping, preserving credentials, caches,
      settings, and existing include/exclude preferences.
- [x] Verified disk-backed bounded-memory content paths, including backend
      projection/import/history capture and legacy upload/download endpoints.
- [x] Trusted-device approval before a short-code claimant receives credentials.
- [x] Whole-package staged application, recoverable directory switch, settings
      preconditions, and enablement after verified package completion.
- [x] Durable conflict inbox with provenance, bounded comparisons, keep/combine/
      keep-both, conditional resolution, and conditional undo.
- [x] Generated multi-device sequences, persistence-boundary failure injection,
      storage/editor races, restart replay, and mobile lifecycle budgets.
- [ ] Read-only shadow comparisons and isolated canary; preserve every original
      production table/column, credential, setting, snapshot, and blob reference.
- [ ] Physical disposable-vault iPhone checks and diagnostic measurements.
- [ ] Workflow-owned candidate publication, exact asset checks, immutable image
      rehearsal/backup, final BRAT publication and safe server rollout.

Existing clients retain protocol 7 and the existing minimum version. New APIs and
metadata are additive. Migration never rewrites immutable historical manifests or
changes vault keys, tokens, routing, or user preferences. Client installation is
BRAT-only; no real vault is a development or deployment target.

Physical-device results must be recorded separately from automated simulations.
Missing access or an unperformed check is reported, never marked passed.

## Automated candidate evidence

The integrated candidate passes 284 server tests and 441 client tests, workspace
type checking, production builds and dependency audit (no vulnerabilities).
Native Windows directory-switch/settings races and finite plugin-lifecycle waits
are covered; simulated lifecycle results are not physical iPhone evidence.
A rehearsal on a private verified production backup preserves the original
snapshots and protected records, with integrity verified using patched SQLite
3.53.3. Public source inspection found no personal server endpoints or paths.
The remaining live canary, physical-device and stable publication/production
rollout gates are deliberately unchecked. This is not a production acceptance.
