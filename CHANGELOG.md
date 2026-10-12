# Changelog

## 0.8.69 candidate

- Fix the device-agnostic incremental retry loop after per-device plugin enablement is projected: refresh the one small local enablement file rather than treating its shared snapshot hash as physical bytes. New notes can publish without repeatedly forcing full-vault scans.
- Keep pending edits visibly pending through preflight and merge checks; replace ambiguous clocks with a sending indicator, keep verified routine checks on the subtle green check, and preserve the last proven checkpoint through a transient incoming-watch reconnect.
- Continue exposing real divergence, exhausted/repeated connection failures, package holds and safeguards. Folder creation and sync-scope changes invalidate the old check; excluded paths are not counted as unsent vault changes.
- Add automated desktop/mobile, custom-config-root, repeated incremental receipt/restart, and controller/status regression coverage. These checks do not substitute for final iOS-native acceptance.

This candidate is distributed only through Gib-Sync-Canary; production and user vault installations are not changed by publication.

## 0.8.68 candidate

- Keep Gib Sync and BRAT as device-local operational dependencies; never synchronize their files, replace their enabled state from another device, or suspend them during package work.
- Retain unrelated local installations and settings during first plugin setup and server-first onboarding instead of interpreting absence from an inventory as a deletion. Excluded executable/manifest paths keep the whole package local; excluded settings survive compatible code updates.
- Restore a previously retired installer only from one scope-owned, hash-verified complete original into a vacant directory using qualified no-overwrite native activation. Reinstalled packages and ambiguous/changed originals remain untouched.
- Read adopted bytes from their actual source, propagate real read/transport failures, inspect held component subtrees during incremental sync, and distinguish verified package retirement from interrupted activation.
- Include plugin identifiers, exact held-package reasons and retry information in opt-in diagnostics, without copying saved settings, original contents or connection secrets.

This candidate is distributed only through Gib-Sync-Canary. Production promotion remains blocked on actual preserving migration and physical-device acceptance.

## 0.8.67 candidate

- Give QR setup a separate, single-use 256-bit invitation valid for ten minutes, still requiring explicit receiving-vault/server review and trusted-device approval.
- Keep the optional five-digit typed code at sixty seconds. QR remains stable while that code rolls; expired codes cannot regain validity on rollback, and older clients/servers retain their compatible setup path.
- Preserve a valid QR across temporary code-refresh failures, retire it at its own exact expiry, and keep invitation query values out of application request logs.

This candidate is distributed only through Gib-Sync-Canary; production and user installations are not changed by publication.

## 0.8.66 candidate

- Add optional locally generated rolling setup QR codes and a mobile HTTPS-to-Obsidian handoff, so the native Camera app can fill the server address and temporary code without in-WebView camera permissions.
- Require explicit receiving-vault/server review and the existing trusted-device confirmation; QR links contain no vault key, password or device token. Expired invites, interrupted claims and already-connected vaults are protected, and manual quick-code setup remains available.

This candidate is distributed only through Gib-Sync-Canary until fresh live and physical acceptance. Existing production users remain unchanged.

## 0.8.65 candidate

- Complete the shared operation authority, stable file/folder generations, causal moves/recreation and exact crash-retry receipts, including compatible snapshot clients.
- Persist a yielding content inventory and editor intents; preempt background audits and verify timestamp-preserving changes without repeated full hashing.
- Map configuration roots automatically, preserve existing preferences/credentials, and apply verified complete plugin packages with protected runtime settings saves and component-specific recovery.
- Add a durable conflict inbox with original versions, practical comparisons, conditional decisions/undo and namespace-collision handling.
- Stream backend uploads, downloads, projection, imports and history capture through verified private files without changing encryption keys or envelope format.
- Require trusted-device approval for new quick-code claims; existing paired clients remain compatible.
- Preserve immutable history and accepted writes during automatic migration, rollback and re-upgrade; gate production v2 activation on signed isolated canary and real iPhone evidence.
- Separate BRAT candidate distribution from production updates and publish exactly the tested asset/image bytes through owned workflows.
- Prove historical file absence from complete immutable Seafile directory evidence instead of treating backend download errors as missing content; reuse authenticated recovery fences and bounded historical-tree proofs to avoid retry amplification and quadratic large-folder capture.

This candidate does not update existing BRAT installations or production. Physical acceptance and stable publication remain separate release gates.

## 0.8.64 candidate (canary only; not accepted for production)

- Source CI, exact asset verification and isolated deployment passed. Live testing exposed Seafile's 500 response for files absent from valid historical commits and recovery fence retry amplification. Production publication was withheld; the isolated failed fixture and its history were retained.

## 0.8.63 candidate (not published)

- The candidate workflow stopped at a test fixture with inconsistent real/fake clocks; no release assets or image were published. The source tag is retained unchanged. The next candidate uses a coherent fake clock and retains the same content/identity assertions.

## 0.8.62

- Add staged, hash-verified local application with durable phase journals and retained original recovery copies.
- Persist server projection jobs, leases, retry ownership, and external revision recovery across restart.
- Use stable file identity and recorded rename provenance instead of name/size guesses for merge ancestry.
- Share bounded text and JSON merging between client and server; merge native bookmarks by their creation identity.
- Preserve custom configuration roots and existing credentials/settings automatically; watch enabled hidden settings without repeated whole-vault scans.
- Stream supported native incoming transfers and file hashing, resume large outgoing HTTPS uploads using verified bounded chunks, bound caches, and avoid redundant client mirror transfers on upgraded servers.
- Distinguish this device, accepted server state, other device acknowledgments, and readable Seafile catch-up; retain stable, touch-friendly status controls.
- Add explicit new-device onboarding choices and a read-only local recovery browser.
- Harden authentication-before-parsing, quick-code budgets, portable path collision validation, and overlapping storage-root registration.
- Add transactional migrations, verified pre-upgrade/daily SQLite backups, and an isolated migration preservation drill.
- Upgrade test dependencies, audit dependencies, and validate version surfaces and assets in release CI.

Existing protocol-7 clients remain compatible; no re-pairing or manual settings migration is required. See [architecture and migration](docs/architecture-and-migration.md) for invariants and platform limitations.
