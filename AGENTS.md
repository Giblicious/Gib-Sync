# Gib Sync agent policy

These instructions apply to every automated or AI-assisted change in this repository.

## Obsidian plugin deployment

- Gib Sync installations managed by BRAT must be installed and updated only through BRAT from the public GitHub release.
- Never copy, replace, patch, or delete `main.js`, `manifest.json`, `styles.css`, `versions.json`, or any other plugin artifact inside a user's Obsidian vault.
- Never treat a successful local build as permission to deploy its output into a real vault.
- Publishing a plugin version ends after the tested commit, tag, GitHub release, and release assets are available. Report that BRAT can now update; do not perform BRAT's client-side installation step on the user's behalf.
- If BRAT cannot update or a release artifact is unavailable, stop and report the problem. Do not fall back to a manual installation.
- A manual install is allowed only when the user explicitly requests a manual install in that same turn and confirms the exact target vault. Prior permission to develop, release, deploy the server, or "one-shot" a fix does not authorize it.
- Do not restart Obsidian, reload the app, or toggle plugins without explicit permission in the current turn.

## User-owned runtime state

- Every real vault and its `.obsidian` directory are user-owned runtime state, not deployment targets or working directories.
- Treat Gib Sync's installed `data.json` as read-only diagnostic input unless the user explicitly requests a settings change. Never overwrite, recreate, copy, or normalize it during deployment.
- Never print, commit, log, or expose device tokens, vault keys, server credentials, private server addresses, personal paths, or other values read from runtime settings.
- Read-only inspection of an installed version or sanitized health state is permitted when needed to diagnose or verify a user-reported issue.
- Test installation behavior only in disposable test vaults created specifically for testing, never in a user's real vault.

## Release and server boundaries

- Plugin release flow: build and test, commit intentionally, push, create the version tag, wait for CI/release success, and verify the public release assets. Client installation remains BRAT's responsibility.
- Server deployment is separate from plugin deployment. Authorization to update the Gib Sync server does not authorize changes to any Obsidian installation.
- Before any deployment, state which boundary is being changed: repository, GitHub release, server container, or user device. Do not silently cross boundaries.
- Preserve Git and server snapshot history during repairs. Prefer recoverable, narrowly scoped operations and verify the resulting accepted head, mirror state, quarantines, and health alerts.

## Required handoff

- State exactly what was published or deployed and where.
- When a BRAT update is required, say that the release is ready for BRAT and leave the installed vault untouched.
- Never claim a client plugin is updated merely because release files were built or published.
