# Gib Sync

Gib Sync is a self-hosted, versioned Obsidian synchronization system for desktop and mobile. It combines an Obsidian plugin, a small HTTPS coordination service, and user-selected Seafile storage.

## What it provides

- End-to-end encrypted file contents using AES-256-GCM.
- Content-addressed storage, immutable full-vault snapshots, and point-in-time restore.
- Compare-and-swap commits that prevent silent concurrent overwrites.
- Three-way, line-aware text merging and binary conflict-copy preservation.
- Per-vault Seafile routing: each person chooses a Seafile account, library, and folder while sharing one Gib Sync service.
- Two ways to add another device: repeat the Seafile setup manually or use an optional short-lived QR/setup link.
- A live status dashboard with phases, progress, timestamps, errors, remote inventory, device counts, activity history, and secret-free diagnostics.

## Architecture

```text
Obsidian desktop/mobile
  ├─ scan, merge, encrypt, verify
  └─ HTTPS + per-device token
             ↓
Gib Sync service
  ├─ SQLite: vault/device routes, snapshot index, atomic heads
  └─ encrypted per-vault Seafile API token
             ↓
User-selected Seafile account / library / folder
  └─ .gib-sync: encrypted blobs and immutable snapshot manifests
```

File contents are encrypted before leaving Obsidian. Paths, sizes, modification times, plaintext content hashes, device names, and snapshot messages are visible to the Gib Sync service because synchronization and deduplication require that metadata.

## Deploy the service

1. Copy `.env.example` to `.env` and replace every secret.
2. Set `PUBLIC_URL` to the TLS endpoint that proxies to port `8787`.
3. Keep the legacy `SEAFILE_*` values for migrating any pre-0.2 vault.
4. Set `SEAFILE_ALLOWED_HOSTS` to the public Seafile hostnames users may select, comma-separated and including ports when nonstandard.
5. Run `docker compose up -d --build`.
6. Verify `https://your-sync-host/healthz` returns `{"ok":true,...}`.

Persist `/data` and include it in server backups. Version 0.2 automatically records the old global Seafile library as the storage route for existing vaults, so their objects do not move.

## Install and connect the Obsidian plugin

Build with `npm ci && npm run build`. Copy these files into `<vault>/.obsidian/plugins/gib-sync/`:

- `plugin/main.js`
- `plugin/manifest.json`
- `plugin/styles.css`

Reload Obsidian, enable **Gib Sync**, then open its settings and choose **Manual setup**. Enter the Gib Sync URL plus the Seafile URL, account, and password; load accessible libraries; then choose a library and folder. Gib Sync stores encrypted data below `<folder>/.gib-sync`. The password is discarded after Seafile issues an API token.

To add mobile or another desktop, either repeat manual setup with the same Seafile account/library/folder, or show the optional QR/setup link on an existing device. Each quick-connect link expires after five minutes and works once. QR scanning is never required.

The settings status panel updates live during scans, downloads, merges, uploads, and commits. **Copy diagnostics** exports status and identifiers but excludes passwords, vault keys, API tokens, and device bearer tokens.

## Synchronization behavior

Gib Sync synchronizes ordinary vault files and attachments. `.obsidian` is excluded by default because workspace/layout state often differs by device; it can be enabled in settings. The plugin's own directory, `.git`, and `.trash` remain excluded.

Overlapping text edits receive standard conflict markers. For binary conflicts, the remote version retains the original path and the local version is saved beside it with a timestamped conflict suffix. Every successful change creates a snapshot; restoring history creates another snapshot rather than erasing later history.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The service targets Node.js 24 and the plugin uses mobile-compatible browser APIs. Gib Sync is licensed under MIT.
