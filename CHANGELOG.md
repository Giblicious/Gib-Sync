# Changelog

## 0.8.80 candidate

- Add opt-in automatic server diagnostic logging so phone testing no longer requires transferring clipboard logs. Authenticated reports include sync state, bounded activity codes, plugin repair codes and native device-test results; notes, paths, raw errors, keys and credentials stay excluded.
- Keep reporting separate from sync, retain transient repair observations, retry network failures with stable report identities, and clear queued reports on opt-out, scope changes or unload. Older servers remain supported without diagnostic requests.
- Bound server reports to 32 KiB, 30 reports per device and seven days, with strict field validation, per-device request limits, idempotent retries and vault isolation. Candidate distribution remains isolated from stable users.

## 0.8.79 candidate

- Give foreground mobile rendering a frame opportunity during sustained hashing and verification. The physical A10e's 32 MB hash benchmark went from repeated 100 ms frame gaps to no gaps above 50 ms while retaining the exact content hash.
- Keep the existing background-safe scheduler, settle immediately on visibility changes, and bound missing-frame waits. Add frame, background, fallback and cleanup regressions.
- Candidate distribution remains isolated; the extra foreground yielding trades some hashing throughput for responsive interaction.

## 0.8.78 candidate

- Retry interrupted durable inventory loading instead of caching a rejected load forever. Pausing during cache initialization or changing sync scope can now resume while still revalidating saved content and retaining dirty-file evidence.
- Correct the native Obsidian Sync conflict dialog's Core plugins settings destination, verified on the physical Android test device.
- Add a cancellation/retry regression covering saved edits made during the pause. Distribution remains confined to the isolated Canary channel.

## 0.8.77 candidate

- Extend verified private settings checkpoints to plugin runtime activation. Incoming settings with inconsistent native size hints no longer produce empty recovery copies and unnecessary activation holds.
- Preserve exact incoming hashes and actual content lengths before enabling plugins; concurrent saved settings still block activation safely. Public-path restoration retains native no-overwrite semantics and both recoverable versions.
- Add zero-size native metadata, broken-copy, startup bypass restoration and concurrent-settings regressions. Candidate-only distribution remains isolated from current users.

## 0.8.76 candidate

- Fix a physical Android reproduction where newly saved notes retain a zero-byte native size hint and repeatedly retry instead of publishing. Corroborate inconsistent small-file length with independent native bytes and unchanged stamps; retain complete hash and length checks and bounded memory use.
- Keep verified content length separate from its metadata hint in the durable inventory. Existing cache records remain compatible; dirty files and process restarts still require content verification.
- Protect originals with verified copies. If a native size hint is inconsistent, prepare the new recovery copy through bounded streaming rather than the native copy path that returned an empty successful copy during testing. Existing protected destinations are never overwritten.
- Add truncated-reader, changing-content, bounded-memory, protected-copy, persistent-inventory and 16-note creation regressions. This is still an isolated candidate, not approval to update current users.

## 0.8.75 candidate

- Persist accepted-checkpoint repair intent and its exact target before changing the readable mirror. After a server restart, resume that same repair automatically without importing its own partial writes as independent file creations.
- Keep new commits and manual unlocks held until the complete readable generation is verified. Preserve pre-existing manual locks and atomically advance repair intent when approved redundant-copy cleanup creates a new accepted head.
- Recover reserved markers from older interrupted repairs; isolate unverifiable repair intent to the affected vault while other vaults remain available.
- Add actual SQLite reopen, interrupted projection, authority-drift, manual-lock, empty-vault and multi-vault isolation regressions. This remains an isolated candidate, not current-user release approval.

## 0.8.74 candidate

- Close legacy Gib Sync windows using the verified mobile native header control as well as the desktop close button, newest first. The physical Android hot-update test exposed the platform-specific selector missing from 0.8.73.
- Preserve the per-instance dialog ownership and normal native close callbacks; do not remove arbitrary application or other-plugin UI.
- Add a mobile-header/newest-first regression. This is still an isolated candidate, not production acceptance.

## 0.8.73 candidate

- Tie all Gib Sync dialogs to their loaded plugin instance. Unloading closes status subscriptions, diagnostic observers, setup timers and pending prompts; closed windows are not retained, and legacy marked windows close through Obsidian's normal UI during an update.
- Verify already-correct readable files during accepted-checkpoint repair instead of needlessly rewriting every note and plugin. Complete content hashing and final generation/backend-identity verification remain required.
- Hold new device head commits during a checkpoint rebuild, including commits whose immutable upload began before the repair. Only the internal repair transaction has an opaque permit; previously accepted operation receipts remain replayable.
- Treat known repair-in-progress responses as quiet waiting with automatic retry, not a failure notification. Saved edits remain on the device and publish after the repair boundary clears.
- Add native-window lifecycle, delayed acceptance, repair/read-back and quiet-resume regressions. The full candidate suite contains 1,014 tests; physical and preserving server validation remain independent gates.

This candidate is distributed only through Gib-Sync-Canary. Current-user publication and production deployment remain blocked until acceptance.

## 0.8.72 candidate

- Preserve the original file identity when a newer accepted head interrupts a partial readable projection. Require path/commit-scoped immutable capture, a backend write acknowledgement, an authenticated fence, and the exact accepted file identity; matching bytes or timing alone are insufficient.
- Record the pre-write visible hash separately so genuinely independent same-byte creations are not mistaken for server output. Explicit delete/recreate and unrelated commits remain distinct generations.
- Prevent background imports from racing the active projection writer, and recover durable unfinished captures before importing subsequent readable changes.
- Share portable, Unicode-safe conflict-copy naming between device and server, bounding generated filenames while preserving complete originals and deterministic collision handling.
- Add an executable superseded-head/forced-scan race, preserving restart and negative identity-proof regressions. These fixes address a failure caught in the isolated physical Android stress test; they do not certify production readiness.

This candidate remains isolated in Gib-Sync-Canary. Current-user publication and production deployment remain blocked pending physical and server acceptance.

## 0.8.71 candidate

- Move live-console follow scrolling after a paint boundary instead of forcing a synchronous layout immediately after log-row mutations. User scrolling wins over a queued follow operation.
- Coalesce scrolling bursts and cancel both queued animation frames when settings close or change tabs; detached consoles are never touched.
- Add executable paint-boundary, manual-scroll, cancellation, and restart regressions. The unchanged-row and timestamp-cache improvements from 0.8.70 remain.
- Explain same-content independent external creations only when exact accepted local identity and trusted remote-creation proof both verify. Missing, forged, foreign, or device-only claims still hold rollout. Preserve identity-difference context for independent review without resetting prior observations.

This candidate remains isolated in Gib-Sync-Canary; no stable release or production image promotion is authorized before acceptance.

## 0.8.70 candidate

- Reduce measured mobile Diagnostics-console hitches: retain unchanged row objects and cached timestamp formatting, group repeated messages in latest-occurrence order, and avoid unnecessary DOM rewrites, row reordering, and scroll-layout work.
- Preserve warning/error distinctions and the full detailed export. The live view remains bounded, handles coalesced timestamps and cleared logs correctly, and uses text-only rendering.
- Add regression coverage for unchanged status ticks, repeat aggregation, chronology, retention, and malformed timing/count inputs. Candidate publication does not certify physical responsiveness or server migration; those require independent isolated validation of these exact bytes.

This candidate is distributed only through Gib-Sync-Canary. Stable releases, the production image, and existing users remain unchanged.

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
