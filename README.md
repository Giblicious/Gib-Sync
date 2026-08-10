# Gib Sync

Gib Sync is a self-hosted, versioned Obsidian synchronization system for desktop and mobile. It combines an Obsidian plugin, a small HTTPS coordination service, and user-selected Seafile storage.

## What it provides

- A complete, readable 1:1 recovery copy of the synchronized vault in Seafile.
- Encrypted content-addressed history, immutable snapshots, and point-in-time restore in a hidden `.gib-sync` sidecar.
- Compare-and-swap commits with word-aware merging and lossless conflict-note preservation.
- Per-vault Seafile routing: every person chooses an account, library, and folder while sharing one Gib Sync service.
- Manual multi-device setup plus short-lived, one-time quick codes that are easy to type between devices.
- Live phases, progress, timestamps, path-aware merge decisions, errors, remote inventory, mirror health, device counts, compact activity history, and both detailed and privacy-safe diagnostics.
- Server-enforced mass-change safeguards for both Obsidian devices and direct Seafile/WebDAV edits.
- Optional Obsidian bookmark synchronization, enabled by default without requiring full `.obsidian` configuration sync.

## Safety center

Gib Sync evaluates every proposed snapshot before it becomes the shared vault head. Suspicious changes are held in quarantine without modifying the accepted snapshot or the readable recovery tree. Connected devices are notified immediately and can inspect every affected path before choosing **Approve once**, device-scoped maintenance for a non-external batch, or **Reject and restore accepted snapshot**. Seafile deletion batches always require one-time approval; neither prior approval nor a maintenance window can approve a later destructive batch.

The built-in balanced and strict presets focus on data-loss signals: mass deletion, files being mostly emptied, destructive folder impact, unexpected file growth, extension churn, high-entropy/ransomware-like content, protected-path deletion, and unexpectedly empty vaults. Large additions, edits, and recognized moves proceed normally. Every threshold and protected path can also be customized. Repeated copies of the same proposal reuse one quarantine item instead of creating alert spam.

Additional recovery controls include:

- A remote write lock that freezes device commits and direct Seafile imports while leaving downloads available.
- First-sync protection that prevents a newly paired device with unrelated local files from replacing or merging into an existing shared vault.
- Vault-location identity checks that pause sync if the configured vault name or filesystem location changes.
- Safe previews before exclusion or `.obsidian` settings would remove files from the shared vault.
- Device inventory, clock-skew and stale-device warnings, and immediate device revocation.
- Preview-and-confirm full or selected-file restore with an expiring confirmation token.
- Named known-good snapshot bookmarks retained in immutable history.

## Storage layout

```text
Selected Seafile library and folder
├── Notes/
│   └── Example.md              # ordinary readable file
├── Attachments/
│   └── image.png               # ordinary readable file
└── .gib-sync/
    ├── blobs/                  # encrypted synchronization history
    ├── snapshots/              # immutable manifests
    └── readable-generation.gib # signed completed-mirror marker
```

The readable tree is bidirectional. Downloading it produces an ordinary Obsidian vault without requiring Gib Sync, its database, or a vault encryption key. Direct changes from Seafile's web editor, WebDAV, desktop sync client, or another external source are detected, committed into Gib Sync history, and pushed to connected Obsidian devices.

Simultaneous edits use a lossless three-way policy:

- Changes that do not overlap are all merged, including separate word edits on the same line.
- Small overlaps affecting at most 20 words across at most two lines use the most recently saved whole-word change only in the overlap.
- Larger rewrites and independently created same-path notes keep the newest version at the intended path and create device-and-time-stamped alternatives. Markdown versions receive reciprocal warning callouts and Obsidian links.
- Edit-versus-delete conflicts retain the edited note with a warning so a deletion never silently destroys concurrent work.
- Binary conflicts preserve both files.
- Automatic three-way merging is bounded for mobile stability. Oversized, unusually complex, or failed text comparisons preserve both complete versions with linked warnings instead of stopping synchronization.
- If a mobile settings write finishes out of order and its saved checkpoint temporarily lags, Gib Sync recognizes an uninterrupted chain of that same device's own snapshots and rebases only explicitly journaled local changes. Cross-device ancestry or unjournaled full-scan differences still use the normal lossless conflict policy.

When a newly paired device already contains a vault, Gib Sync compares content hashes before writing anything. If at least 90% of the included files match the server exactly, it treats the vaults as copies: it downloads and verifies the current server head, keeps files unique to either side, and preserves both versions of every differing same-path file before publishing the union. Lower-overlap vaults remain blocked as likely mismatches.

The mirror is crash-recoverable: the server records each successfully written readable file and writes a signed completed-generation marker only after every expected path is visible and obsolete paths are gone. An interrupted operation resumes from the files that actually exist, even if the canonical vault advances again before completion. A missing readable file counts as a deletion only when it belonged to that committed generation and remains absent across repeated observations; partial-generation absence is never imported as deletion.

This follows the same proven safety model used by database-backed two-way synchronizers: compare both sides to the last successfully synchronized state, recognize moves before delete/create pairs, and commit synchronization metadata only after the data operation succeeds. FreeFileSync documents these principles in its [two-way synchronization and move-detection model](https://freefilesync.org/manual.php?topic=synchronization-settings). Gib Sync implements the concepts independently for immutable snapshots, Seafile, and mobile Obsidian; it does not copy FreeFileSync source code.

Folder structure follows synchronized file paths. After an accepted move or deletion, Gib Sync removes the retired source branch only when it is empty and has not been recreated since that change. Non-empty, excluded, newly recreated, and Obsidian framework folders are preserved. Intentionally empty folders without synchronized files are device-local.

`.obsidian` is excluded by default because workspace state is often device-specific. **Sync Obsidian configuration** includes portable themes, snippets, hotkeys, and other settings, but workspace layout files always remain device-local. Concurrent JSON settings changes merge recursively by key; overlapping scalar or array values use the newer side, and non-JSON system files use the newer whole file. `.obsidian` system files never create user-facing conflict copies.

**Sync installed plugins** treats each plugin's code and assets as an atomic package. A complete package beats an incomplete copy, a higher manifest version wins, and equal versions use the later package modification. `data.json` remains independently mergeable settings. Generated cache folders—including caches, indexes, embeddings, logs, and temporary data—remain device-local and are removed from future server snapshots. The enabled-plugin list is applied after package files and entries lacking a complete `manifest.json` plus `main.js` are disabled automatically, while Gib Sync always preserves its own enablement. Plugin `data.json` files can contain API keys and are copied to readable Seafile when plugin sync is enabled.

**Excluded path prefixes** is the device-local ignore list. A prefix ignores that file or complete directory subtree on that device while preserving the accepted remote version and the copies used by other devices.

On mobile, Gib Sync uses Obsidian's mobile-safe request and vault-adapter APIs, browser WebCrypto, numeric quick-code keyboards, touch-sized responsive controls, and foreground-resume reconciliation. It does not require Node.js, Electron, camera access, or filesystem paths. Mobile devices can omit plugin synchronization without deleting plugins used by desktop devices; Obsidian itself ignores any synchronized plugin marked desktop-only.

Status indicators are independently configurable. Desktop can show an icon, a short state word, both, or neither. Mobile can show a tappable icon in the right-sidebar status area, a compact dot immediately before the view-mode control, or both. Every surface opens the same live status panel with progress, recent activity, attention counts, Sync now, and pause/resume actions. Long-pressing a mobile indicator requests an immediate sync.

**Repair vault health** provides a convergent recovery path when a vault is stuck. After explicit confirmation, the accepted server snapshot becomes the repair checkpoint, pending quarantined proposals are dismissed, the readable Seafile mirror is rebuilt and integrity-checked from encrypted history, obsolete mirror files and legacy `.obsidian` conflict artifacts are removed, and ordinary synchronization resumes. Normal notes and version history are preserved.

Notifications are operation-level and rate-limited. A quarantined mass change or remote write lock places automatic file-change, foreground, and periodic sync triggers on a quiet hold until the safeguard is resolved. The live status panel retains the detailed error while mobile receives only one actionable notice instead of a notice for every changed file.

The live activity panel identifies each three-way merge path, version sizes, chosen resolution, fallback reason, and retry backoff. **Copy detailed log** includes those vault-relative file names but excludes credentials, keys, tokens, and server addresses; **Copy safe log** removes activity text and file names for public sharing.

Gib Sync continuously checks whether the Obsidian Sync core plugin is enabled. If it is, Gib Sync stops its timers and incoming watch and refuses new sync runs until Obsidian Sync is disabled. This mutual-exclusion safeguard prevents two synchronization engines from concurrently changing the same vault. `.obsidian/core-plugins.json` is always device-local so configuration sync cannot re-enable Obsidian Sync elsewhere.

## Deployment

1. Copy `.env.example` to `.env` and replace every secret.
2. Set `PUBLIC_URL` to the TLS endpoint proxying port `8787`.
3. Keep the legacy `SEAFILE_*` values for migrating pre-0.2 vaults.
4. Set `SEAFILE_ALLOWED_HOSTS` to the public Seafile hostnames users may select.
5. Set `GIBSYNC_MIN_CLIENT_VERSION` to the oldest plugin release allowed to sync and `GIBSYNC_RECOMMENDED_CLIENT_VERSION` to the current release. Incompatible clients are blocked before vault access and remain able to read compatibility status.
6. Run `docker compose up -d --build`.
7. Verify `/healthz` reports the expected `serverVersion`, protocol, safety capabilities, `readableMirrors: true`, and client-version policy. The plugin refuses setup or synchronization when the server is too old or omits required safety capabilities.

Persist and back up `/data`. Existing encrypted vaults migrate without moving their sidecar objects. Their readable recovery path is created automatically under `Obsidian/<vault name>` and materialized by the first v0.3 sync.

## Install and connect

Install and update Gib Sync through BRAT from the public `Giblicious/Gib-Sync` repository. Published releases include `main.js`, `manifest.json`, `styles.css`, and `versions.json`; do not replace BRAT-managed plugin files manually.

Open Gib Sync settings and choose **Manual setup**. Enter the Gib Sync and Seafile addresses, authenticate, load accessible libraries, and select a library and folder. The Seafile password is exchanged for an API token and is not saved by the plugin or service.

In plugin settings, **Periodic sync** controls timer-based remote checks independently from **Sync when files change**. File-change sync waits two seconds after a vault file is created, saved, renamed, or deleted, coalesces rapid edits into one run, and ignores excluded paths.

Another device can repeat manual setup and select the discovered existing vault. Alternatively, choose **Show quick code** on a connected device, then choose **Enter quick code** on the new device. The five-digit numeric code changes every 60 seconds and works once. QR scanning and camera access are not used.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The service targets Node.js 24 and the plugin uses mobile-compatible browser APIs. Gib Sync is licensed under MIT.
