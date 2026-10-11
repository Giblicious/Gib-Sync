# Durable synchronization foundation (0.8.61)

## Authority and invariants

The SQLite accepted snapshot is authoritative for coordination. Content hashes,
immutable manifests, and encrypted history remain in the existing Seafile sidecar.
The readable Seafile tree is a bidirectional, asynchronously materialized copy,
not proof that a device downloaded or applied a snapshot.

Every device acknowledges its exact applied snapshot after verification. Older
devices without a new acknowledgment are displayed as unconfirmed, not assumed
current. This does not revoke their token or raise the minimum supported version.

File identity and revision provenance are additive manifest fields. Unique stable
identity, exact content identity, recorded Obsidian rename events, and recorded
Seafile commit renames can establish move ancestry. Similar names and sizes may
inform a safeguard assessment but never fabricate a three-way merge base.

## Durable operations

Local replacement stages and verifies incoming bytes before replacing a file.
Per-operation journals record planning, verified staging, backup, copy-in-progress,
rollback, and verified completion boundaries.
The previous original remains under `.gib-sync/local-recovery/`; the plugin offers
a read-only inventory and bounded text preview. Recovery never deletes a note
merely because its filename resembles an old conflict artifact.

Server projection jobs have durable SQLite leases, retries, and ownership fencing.
Timers wake those jobs; restarting the process does not discard them. Incoming
Seafile revisions are captured before and after projection mutations, including
historical directory contents around a recursive folder removal. Unknown content
is retained in encrypted history before another projection can finish. A unique
encrypted operation fence must appear in immutable repository history before a
mutation's journal can be considered captured; a delayed history listing cannot
silently retire that recovery obligation. These small fences remain recoverable
in the hidden sidecar. Only the
latest outstanding historical version of each path participates in the next
reconciliation; earlier versions remain recoverable instead of being replayed as
simultaneous edits.

Seafile does not provide an HTTP compare-and-swap file write. Its immutable
repository history is therefore a required recovery dependency for readable
mutations. History disabled, an unavailable revision, a retention gap, or an
exhausted traversal budget defers projection rather than claiming success.
Local promotion and rollback use Obsidian's documented no-overwrite copy API,
never a check-then-rename over a public destination. A creation racing with the
copy is retained. Native copies need not have atomic visibility: an interrupted
copy with uncertain destination bytes is held without publication, and explicit
accepted-state repair retains both original and uncertain bytes. Run one
synchronization engine per vault.

## Performance and configuration

Unchanged checks do not repeatedly hash every note. Event journals, authenticated
snapshot deltas, and a bounded metadata cache limit ordinary work. Full startup
and periodic integrity audits still inspect the included vault. Hidden enabled
configuration files are tracked separately using a yielding stat inventory; no
private Obsidian raw-event hook is required.

Supported native resource URLs and `appendBinary` permit streamed hashing and
large incoming staging. Hashing and appending use bounded chunks and cooperative
yields. Upgraded HTTPS servers advertise resumable large outgoing transfers:
256 KiB chunks have independent hashes and durable receipts, and the complete
source is rehashed even when resuming an acknowledged prefix. The server streams
the verified source into the existing AES-GCM-v1 envelope before registering it.
Finalization is asynchronous and single-owner: the device polls actual processing
state rather than keeping a long HTTP request open. Cancellation targets its exact
processing attempt, and shutdown drains it before closing the database.
Unaccepted server staging uses private, UUID-owned files with a seven-day expiry;
temporary clear bytes are restricted to the server's private staging directory.
Accepted blobs and snapshots are not subject to that expiry.

Small files and older servers retain the encrypted upload endpoint. Resource
streaming depends on the native adapter/WebView: a large outgoing file that
cannot be streamed is retained locally with an actionable error rather than
silently allocating an unbounded buffer. HTTP development servers retain the
encrypted legacy path, never the new clear-chunk transport. This is not a
universal fixed-memory guarantee for every backend operation and does not add
block-level deduplication.

Actual vault configuration directories are respected for scope and safety, but
different configuration-root names on separate devices are not automatically
remapped to one canonical path. Gib Sync's own credentials,
workspaces, and generated caches remain device-local. Ordinary settings use shared
three-way JSON logic; unique-ID collections merge by identity, while native
bookmarks use unique creation-time/type identity, including nested groups.
Unknown or ambiguous arrays remain whole values instead of inventing identity.
Plugin code/package selection and bootstrap protections remain compatible.

## Automatic migration and rollout

No re-pairing, credential reset, vault-key rotation, history rewrite, or manual
settings conversion is required. New settings preserve existing values and defaults.
New SQLite tables and columns are additive and migrated in a transaction.
Old clients retain the existing protocol and endpoints; optional deltas, revision
metadata, explicit acknowledgments, resumable uploads, and server-managed
projection are additive.

Before a version upgrade, the service makes a consistent SQLite online backup,
including its WAL, reopens it, runs integrity and foreign-key checks, verifies
accepted-head references, and records a checksum. Daily backup due time persists
across restarts. Database backups do not replace backing up the existing Seafile
blobs: both are required for complete disaster recovery. No automatic backup,
snapshot, or original-file retention deletion is introduced.

`rehearseMigration` migrates an isolated consistent copy without network workers.
It fingerprints every original table and column, including routing, keys, device
credentials, safeguard preferences, quarantine state, and immutable manifests.
Production rollout must pass this drill, deploy a tested immutable image digest,
and verify compatibility and accepted-head preservation. Keep the old container
recoverable. Never restore an older database over writes accepted after rollout.
The supplied container uses Node 24; direct server installations require Node
22.16 or later for the [SQLite online backup API](https://nodejs.org/api/sqlite.html#sqlitebackupsourcedb-path-options).
The embedded SQLite must also include the
[WAL-reset fix](https://www.sqlite.org/wal.html#the_wal_reset_bug): version 3.51.3
or later, or official backports 3.50.7 / 3.44.6. A Node major-version check alone
does not establish this. Run `node scripts/verify-server-runtime.mjs` before a
manual server start or migration. CI, release jobs, and both Docker build/runtime
layers enforce this requirement without gating local plugin development.

BRAT owns installation and activation of the published plugin. Publication or
server deployment never overwrites real vaults or their installed `data.json`.

## Validation limits

Automated tests cover transfer integrity, interrupted apply phases, cancellation,
editor races, custom configuration roots, move identity, plugin settings bootstrap,
onboarding choices, hidden config tracking, native-stream simulation, projection
restart/race recovery, auth/rate limits, portable path collisions, and migration.
Synthetic mobile DOM and adapter tests are not a physical iPhone smoke test.
The service cannot guarantee the absence of every future backend or filesystem
failure; recovery history and truthful status are part of the safety model.
