# Gib Sync

Gib Sync is a self-hosted, versioned Obsidian synchronization system designed for desktop and mobile. It combines an Obsidian plugin, a small HTTPS service, and a dedicated Seafile library.

## What it provides

- End-to-end encrypted file contents using AES-256-GCM.
- Content-addressed storage, so identical file versions are uploaded once.
- Immutable full-vault snapshot manifests and point-in-time restore.
- Compare-and-swap commits that prevent silent concurrent overwrites.
- Three-way, line-aware text merging.
- Binary conflict preservation: both versions survive under distinct names.
- Tombstones through snapshot absence, atomic head changes, integrity verification, retry-safe uploads, and interrupted-sync recovery.
- One-scan mobile enrollment. The desktop plugin displays a short-lived, single-use QR code; the mobile plugin scans it and securely receives the server, vault key, and device credential.
- Seafile HTTP API storage rather than direct access to Seafile's internal data directory.

## Architecture

```text
Obsidian desktop/mobile
  ├─ scan, merge, encrypt, verify
  └─ HTTPS + per-device token
             ↓
Gib Sync service
  ├─ SQLite: devices, snapshot index, atomic head
  └─ Seafile API
             ↓
Dedicated “Gib Sync” Seafile library
  ├─ encrypted content-addressed blobs
  └─ immutable snapshot manifests
```

File contents are encrypted before leaving Obsidian. Paths, sizes, modification times, plaintext content hashes, device names, and snapshot messages are visible to the Gib Sync service. This metadata is necessary for synchronization and deduplication.

## Deploy the service

1. Copy `.env.example` to `.env` and replace every secret.
2. Set `PUBLIC_URL` to the TLS endpoint that proxies to port `8787`.
3. Use a dedicated Seafile account or a trusted account with access to the dedicated library.
4. Run `docker compose up -d --build`.
5. Verify `https://your-sync-host/healthz` returns `{"ok":true,...}`.

The service creates the Seafile library automatically if it does not exist. Persist `/data` and include it in server backups.

## Install the Obsidian plugin

Build with `npm ci && npm run build`. Copy these files into `<vault>/.obsidian/plugins/gib-sync/`:

- `plugin/main.js`
- `plugin/manifest.json`
- `plugin/styles.css`

Reload Obsidian, enable **Gib Sync** in Community plugins, then run **Gib Sync: Set up first device**. Enter the public service URL and `GIBSYNC_SETUP_TOKEN`. The token enrolls the desktop and is not saved by the plugin.

For mobile, install and enable the plugin, open its settings, choose **Scan setup QR**, and scan the code shown by **Gib Sync: Show mobile setup QR** on the configured desktop. Each QR code expires after five minutes and works once.

## Synchronization behavior

Gib Sync synchronizes ordinary vault files and attachments. `.obsidian` is excluded by default because workspace/layout state often differs by device; it can be enabled in settings. The plugin's own directory, `.git`, and `.trash` remain excluded.

Overlapping text edits receive standard conflict markers. For binary conflicts, the remote version retains the original path and the local version is saved beside it with a timestamped conflict suffix. Every successful change creates a new snapshot; restoring history creates another snapshot rather than erasing later history.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The project targets Node.js 24 for the service and uses only mobile-compatible browser APIs in the plugin. It is licensed under MIT.
