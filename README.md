# Gib Sync

Gib Sync is a self-hosted, versioned Obsidian synchronization system for desktop and mobile. It combines an Obsidian plugin, a small HTTPS coordination service, and user-selected Seafile storage.

## What it provides

- A complete, readable 1:1 recovery copy of the synchronized vault in Seafile.
- Encrypted content-addressed history, immutable snapshots, and point-in-time restore in a hidden `.gib-sync` sidecar.
- Compare-and-swap commits, three-way text merging, and binary conflict-copy preservation.
- Per-vault Seafile routing: every person chooses an account, library, and folder while sharing one Gib Sync service.
- Manual multi-device setup plus short-lived, one-time quick codes that are easy to type between devices.
- Live phases, progress, timestamps, errors, remote inventory, mirror health, device counts, activity history, and secret-free diagnostics.

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

The readable tree is bidirectional. Downloading it produces an ordinary Obsidian vault without requiring Gib Sync, its database, or a vault encryption key. Direct changes from Seafile's web editor, WebDAV, desktop sync client, or another external source are detected, committed into Gib Sync history, and pushed to connected Obsidian devices. Simultaneous edits use three-way text merging; overlapping text edits receive conflict markers and binary versions are both preserved.

The mirror is crash-recoverable: the server records the hash of each successfully written readable file and the snapshot represented by the mirror. An interrupted operation is repaired on the next sync. A mirror is marked current only after every snapshot entry has been verified and obsolete files have been removed.

`.obsidian` is excluded by default because workspace state is often device-specific. Enable **Sync Obsidian configuration** if it should be part of the synchronized and readable recovery tree. Explicit exclusions are omitted from both representations.

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
