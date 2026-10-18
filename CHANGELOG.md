# Changelog

## 0.8.83 stable hotfix

- Built from stable 0.8.62 with only the portable Windows vault-location fix. Versions 0.8.63 through 0.8.82 are already reserved by experimental tags; this release does not include that v2 work.
- Keep the same flash-drive vault trusted when Windows changes its drive letter; retain checks for a different storage volume, folder or vault name.
- Preserve credentials and pending sync state. If the drive letter already changed before upgrading, verify the intended vault and trust its current location once. Later letter changes use the saved native binding.
- Publish plugin assets only. Existing servers remain on their current version; no container image or latest-image update is part of this hotfix.

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
