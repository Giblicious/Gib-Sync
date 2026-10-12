# Durable synchronization v2 (0.8.69 candidate)

## Authority and identities

SQLite stores the accepted operation ledger, its materialized file/folder tree,
immutable snapshots, exact batch receipts and device acknowledgments. The readable
Seafile tree is a bidirectional asynchronous projection, not proof that a device
has downloaded or applied accepted state. Encrypted content-addressed history and
immutable manifests remain in the existing Seafile sidecar.

An operation addresses a stable entity and exact base revision, not merely a path.
Creates, edits, deletes, recreations and file/folder moves are distinct operations.
Folder moves fence descendant revisions. Delete-and-recreate gets a new identity
even when bytes match. Temporary move paths exist only inside an atomic accepted
batch, never as an intermediate accepted snapshot.

The shared deterministic policy drives plugin and server reconciliation. Content
equality, known identity, durable editor intents and proven Seafile rename events
can establish ancestry. Filename similarity, timestamps and device display names
never invent a merge base. Unknown historical ancestry retains differing complete
originals instead of guessing which version may be discarded.

The compatibility snapshot endpoint passes through the same authority. Accepted
snapshot, operations, materialized state and receipt commit in one SQLite
transaction. Repeating an exact batch returns its original receipt; reusing its ID
with different content fails. Immutable prior-state evidence supports replay
audits without inferring a historical baseline from the current tree.

## Durable client application

The plugin persists editor intents and exact proposals before publication.
Vault/device-scoped journals retain receipts across lost responses, suspension and
restart. A checkpoint advances only after accepted content and folder topology are
verified. Changes during a download reconcile against actual prior content.

Local writes stage and verify incoming bytes before promotion. Original and
uncertain bytes remain under `.gib-sync/local-recovery/`. Recovery never deletes a
note because its name resembles a conflict copy. Mutations recheck editor revision
and content preconditions.

Plugin packages have a separate complete-package journal. Managed code/settings
are verified together; excluded caches stay local and move natively without
buffering. Supported adapters retain the old directory and switch the verified
staged directory into place. This is recoverable, not a universal atomic or
gap-free filesystem guarantee. Unsupported behavior, late writes, collisions or
uncertain phases hold that component and retain originals while notes continue.

Running managed plugins are suspended without rewriting synchronized enablement.
Unload-time settings saves drain before filesystem preconditions are checked.
Stale runtime and premature default saves are preserved privately, not written
over incoming settings. Complete packages and platform-filtered enablement apply
before runtime activation; nonempty settings require a fresh read. Arbitrary
third-party direct filesystem writes cannot be sandboxed by Gib Sync; detected
bypasses are preserved and held rather than silently counted as convergence.

## Inventory and responsiveness

Persistent stat/hash inventory avoids hashing every unchanged note on every
check. Events dirty affected paths and persist create/move/delete intent. Yielding
periodic metadata listings catch external changes; startup and rolling content
verification catch timestamp-preserving changes. Stat values are hints, not
permanent content proof.

Traversal, hashing, planning and application yield cooperatively. Foreground sync
preempts background verification. Transfers use cancellation, durable receipts
and bounded caches. This limits Gib Sync's work; it cannot promise that every
adapter or third-party plugin will never block Obsidian.

Physical diagnostics separately measure idle frames, generated native IO, real
sync frames and background/return events without exporting paths or credentials.
Synthetic tests and a small native probe do not certify full-scale performance
or replace a physical iPhone test.

## Bounded server content paths

Production upload/download, readable import/projection, integrity verification
and historical capture are file-backed and streaming. Private clear staging uses
UUID-owned files, restricted permissions, size limits, disk reserve, cancellation
and cleanup. AES-GCM-v1 authentication, clear SHA-256 and size verify before use.
The encryption format and vault keys do not change. Accepted content/history
never expire under staging cleanup.

Large HTTPS client uploads use 256 KiB independently hashed resumable chunks.
Finalization is asynchronous, single-owner and drains safely on shutdown. Older
clients retain the encrypted endpoint; large bodies there also stage on disk.
Ambiguous historical blob-size rows remain unchanged; new independently verified
clear/cipher-size records establish integrity proof.

Repair of missing/corrupt current blobs requires matching accepted readable
content. Backend outages, cancellation and resource failures do not authorize
repair or extra uploads. Large local files require a native resource stream;
unsupported adapters retain files with an actionable component error rather than
silently allocating unbounded buffers.

Projection jobs have durable leases, retries and ownership fencing. Readable
generations are captured before and after mutation, including historical content
around folder deletion. Preserved bytes are verified, not assumed from a registry
row. Seafile lacks HTTP file-write CAS, so immutable repository history is
required. Missing/disabled history or retention/traversal gaps defer projection.
Historical absence requires a valid exact commit and complete typed ancestor
listings; a failed download or unavailable directory is never absence proof.
Validated historical trees mint storage-scoped file proofs for their original
entries, avoiding repeated large-directory traversal while retaining exact commit,
path, object identity and downloaded-size checks. Recovery reuses authenticated
operation fences instead of adding another repository commit on every retry.
Proven commit events distinguish delete/recreate even with identical bytes; the
event vocabulary follows Seafile's
[official commit-diff API](https://github.com/haiwen/seahub/blob/master/seahub/api2/endpoints/repo_commit.py).

## Settings, pairing and conflicts

Actual Obsidian configuration roots map automatically to a canonical namespace.
Legacy collisions retain originals. Credentials, Gib Sync's own files,
workspaces, generated caches and existing include/exclude preferences remain
local. New mobile defaults do not replace established rich settings.

Portable JSON settings use bounded three-way key/identity merging; ambiguous
arrays remain whole values. Plugin code/assets are complete packages, with settings
independently mergeable. Desktop-only enablement remains intact on desktop when
mobile filters it from its local runtime.

Conflict originals and provenance are durable. The inbox supports bounded
comparisons, keep/combine/keep-both and conditional undo. Newer edits invalidate old
resolutions. Automatic system-file choices are informational recovery records,
not deep user-facing conflict forks or mandatory manual settings resolution.

Five-digit codes remain optional. A claim alone never releases vault credentials:
the trusted originating device must approve a matching verification number.
Opaque claim tickets, expiry, single-use delivery and rate budgets apply. Older
unsafe pairing flows cannot create codes; paired protocol-7 clients keep syncing.

Optional setup QR codes are generated locally from a separate 256-bit invitation
valid for ten minutes; the numeric code retains its independent sixty-second
expiry. A nullable `qr_expires_at` column leaves legacy `expires_at` semantics
unchanged, including rollback. Only hashes are stored. Both alternatives consume
the same pairing atomically and still require trusted-device approval. The QR
remains stable across numeric refreshes and temporary refresh failures, then
retires at its own expiry. The phone's native Camera opens a no-store HTTPS page,
then an explicit Obsidian protocol handoff fills the server and private invitation.
Receiving vault/server review and trusted-device confirmation remain mandatory;
already-connected vaults cannot be redirected. No vault key, password, device token
or camera access inside Obsidian's webview is involved. See the official
[iPhone QR scanning instructions](https://support.apple.com/en-us/102680) and
[Obsidian protocol API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts).

## Automatic migration and staged rollout

Migration is additive and transactional: no credential reset, key rotation,
routing/preference changes or historical manifest rewrite. Legacy endpoints remain.
New capability flags are explicit and the compatibility bridge stays authoritative
during shadow rollout.

Shadow observations compare policy with an independently implemented causal
witness. Explained identity-safe differences retain evidence; unexplained
divergence holds v2 promotion without resetting counts. Real users are not
canaries. An isolated candidate enforces its exact disposable Seafile account and
library before authentication, registration and worker startup.

Production activation requires signed operator-reviewed evidence binding the exact
release/image to generated sequences, disposable operation receipts, preserving
migration rehearsal and physical iPhone checks. Import writes only global release
validation, never canary users/content. Eligible healthy vaults activate
automatically after distinct matching observations; old clients retain the bridge.

Before deployment, verify a consistent SQLite online backup including WAL and
rehearse migration in an isolated copy without workers. The drill fingerprints
every original table/column, routing, key, token, preference, quarantine, snapshot
and blob reference. Daily backup due time persists. Database backups do not replace
Seafile content/history backups; no automatic original/history/backup deletion is
introduced.

Node 24 runtime checks the actual SQLite WAL-reset fix: SQLite 3.51.3+ or official
3.50.7/3.44.6 backports. See the
[SQLite advisory](https://www.sqlite.org/wal.html#the_wal_reset_bug) and
[Node backup API](https://nodejs.org/api/sqlite.html#sqlitebackupsourcedb-path-options).

## Publication and rollback boundaries

The owned source workflow publishes a numeric candidate tag, Actions artifact
bundle, versioned image and SHA-256 artifact manifest. Its guards refuse to
overwrite existing release/image tags; they are not registry/GitHub-wide access
controls. It creates no candidate release in the production distribution repo.
BRAT includes prereleases when selecting updates, as documented in its
[developer guide](https://github.com/TfTHacker/obsidian42-brat/blob/main/BRAT-DEVELOPER-GUIDE.md).
Physical BRAT candidates therefore require an isolated distribution repository.

After acceptance, the publication workflow copies the exact isolated candidate
assets into an owned draft, independently reads back all six assets, and only
then makes the complete release visible to BRAT. Interrupted staging resumes
missing assets only; existing bytes are never overwritten. The versioned and
pinned image digests are verified before publication. The same image is retagged
after successful live asset verification, without rebuilding or moving Git tags. Docker's
[carbon-copy manifest behavior](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/)
is used and the promoted digest verified. Production deploys that digest after
backup/rehearsal; the old pinned runtime remains recoverable.

Rollback changes the runtime, never restores an old DB over newly accepted writes.
Re-upgrade must verify compatibility snapshot and operation authority agree before
v2 writes resume.

BRAT owns client installation/activation. Publication or server deployment never
overwrites installed plugins, real vaults or their settings. Physical and automated
evidence remain separate in the [acceptance checklist](v2-acceptance.md); an
unperformed check is never passed.
