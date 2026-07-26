# Gib Sync

Gib Sync is a self-hosted, versioned Obsidian synchronization system for desktop and mobile. It combines an Obsidian plugin, a small HTTPS coordination service, and user-selected Seafile storage.

## What it provides

- A complete, readable 1:1 recovery copy of the synchronized vault in Seafile.
- Encrypted content-addressed history, immutable snapshots, and point-in-time restore in a hidden `.gib-sync` sidecar.
- Compare-and-swap commits with word-aware merging and lossless conflict-note preservation.
- Per-vault Seafile routing: every person chooses an account, library, and folder while sharing one Gib Sync service.
- Manual multi-device setup plus short-lived, one-time quick codes that are easy to type between devices.
- Live phases, progress, timestamps, errors, remote inventory, mirror health, device counts, activity history, and secret-free diagnostics.
- Server-enforced mass-change safeguards for both Obsidian devices and direct Seafile/WebDAV edits.

## Safety center

Gib Sync evaluates every proposed snapshot before it becomes the shared vault head. Suspicious changes are held in quarantine without modifying the accepted snapshot or the readable recovery tree. Connected devices are notified immediately and can inspect every affected path before choosing **Approve once**, **Approve and trust for 15 minutes**, or **Reject and restore accepted snapshot**.

The built-in balanced and strict presets cover mass deletions, unusually broad changes, destructive folder operations, unexpected file growth, extension churn, high-entropy/ransomware-like content, protected-path deletion, and unexpectedly empty vaults. Every threshold and protected path can also be customized. Repeated copies of the same proposal reuse one quarantine item instead of creating alert spam.

Additional recovery controls include:

- A remote write lock that freezes device commits and direct Seafile imports while leaving downloads available.
- First-sync protection that prevents a newly paired device with unrelated local files from replacing or merging into an existing shared vault.
- Vault-location identity checks that pause sync if the configured vault name or filesystem location changes.
- Safe previews before exclusion or `.obsidian` settings would remove files from the shared vault.
- Device inventory, clock-skew and stale-device warnings, and immediate device revocation.
- Preview-and-confirm restore with an expiring confirmation token.
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
    └── snapshots/              # immutable manifests
```

The readable tree is bidirectional. Downloading it produces an ordinary Obsidian vault without requiring Gib Sync, its database, or a vault encryption key. Direct changes from Seafile's web editor, WebDAV, desktop sync client, or another external source are detected, committed into Gib Sync history, and pushed to connected Obsidian devices.

Simultaneous edits use a lossless three-way policy:

- Changes that do not overlap are all merged, including separate word edits on the same line.
- Small overlaps affecting at most 20 words across at most two lines use the most recently saved whole-word change only in the overlap.
- Larger rewrites and independently created same-path notes keep the newest version at the intended path and create device-and-time-stamped alternatives. Markdown versions receive reciprocal warning callouts and Obsidian links.
- Edit-versus-delete conflicts retain the edited note with a warning so a deletion never silently destroys concurrent work.
- Binary conflicts preserve both files.

The mirror is crash-recoverable: the server records the hash of each successfully written readable file and the snapshot represented by the mirror. An interrupted operation is repaired on the next sync. A mirror is marked current only after every snapshot entry has been verified and obsolete files have been removed.

`.obsidian` is excluded by default because workspace state is often device-specific. **Sync Obsidian configuration** includes themes, snippets, hotkeys, and other settings. **Sync installed plugins** independently includes community plugin folders and `community-plugins.json`, while always excluding Gib Sync's own directory so the running synchronizer cannot overwrite itself. Plugin `data.json` files can contain API keys and are copied to the readable Seafile tree when plugin sync is enabled. Explicit exclusions are omitted from both representations.

**Excluded path prefixes** is the device-local ignore list. A prefix ignores that file or complete directory subtree on that device while preserving the accepted remote version and the copies used by other devices.

On mobile, Gib Sync uses Obsidian's mobile-safe request and vault-adapter APIs, browser WebCrypto, numeric quick-code keyboards, touch-sized responsive controls, and foreground-resume reconciliation. It does not require Node.js, Electron, camera access, or filesystem paths. Mobile devices can omit plugin synchronization without deleting plugins used by desktop devices; Obsidian itself ignores any synchronized plugin marked desktop-only.

Status indicators are independently configurable. Desktop can show an icon, a short state word, both, or neither. Mobile can show a tappable icon in the right-sidebar status area, a compact dot immediately before the view-mode control, or both. Every surface opens the same live status panel with progress, recent activity, attention counts, Sync now, and pause/resume actions. Long-pressing a mobile indicator requests an immediate sync.

Notifications are operation-level and rate-limited. A quarantined mass change or remote write lock places automatic file-change, foreground, and periodic sync triggers on a quiet hold until the safeguard is resolved. The live status panel retains the detailed error while mobile receives only one actionable notice instead of a notice for every changed file.

Gib Sync continuously checks whether the Obsidian Sync core plugin is enabled. If it is, Gib Sync stops its timers and incoming watch and refuses new sync runs until Obsidian Sync is disabled. This mutual-exclusion safeguard prevents two synchronization engines from concurrently changing the same vault. `.obsidian/core-plugins.json` is always device-local so configuration sync cannot re-enable Obsidian Sync elsewhere.

## Deployment

1. Copy `.env.example` to `.env` and replace every secret.
2. Set `PUBLIC_URL` to the TLS endpoint proxying port `8787`.
3. Keep the legacy `SEAFILE_*` values for migrating pre-0.2 vaults.
4. Set `SEAFILE_ALLOWED_HOSTS` to the public Seafile hostnames users may select.
5. Run `docker compose up -d --build`.
6. Verify `/healthz` reports `readableMirrors: true`.

Persist and back up `/data`. Existing encrypted vaults migrate without moving their sidecar objects. Their readable recovery path is created automatically under `Obsidian/<vault name>` and materialized by the first v0.3 sync.

## Install and connect

Build with `npm ci && npm run build`. Copy `plugin/main.js`, `plugin/manifest.json`, `plugin/styles.css`, and `plugin/versions.json` into `<vault>/.obsidian/plugins/gib-sync/`.

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
