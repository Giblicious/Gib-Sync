# Portable Windows vault locations

Windows can assign a different drive letter when the same portable vault is
reconnected. Once trusted, Gib Sync binds a desktop Windows vault to its volume
identifier, directory identifier, path within the volume and vault name. A letter
change alone is accepted. A different volume, directory, folder path or name still
requires an explicit location review.

The metadata comes from native filesystem stats. Node documents `stats.dev` as
the device identifier and `stats.ino` as the filesystem inode number; libuv's
Windows implementation obtains them from the volume serial and directory file
identity. See [Node filesystem stats](https://nodejs.org/api/fs.html#class-fsstats)
and [libuv Windows filesystem implementation](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c).
BigInt reads retain the full file identifier. The native Windows regression uses
a temporary unused drive alias for the same disposable directory and removes the
owned alias afterward.

The binding stays in Gib Sync's device-local settings and is excluded from vault
sync and automatic server diagnostics. Existing `vaultIdentity`, credentials,
pending edits and durable journal scope are retained during automatic migration.

Legacy settings have no saved volume identity. They can be anchored automatically
only while the original trusted name and full path still match. If the drive
letter already changed before upgrading, verify the intended vault and choose
**Trust this vault location** once to establish the new binding. Later letter
changes can then use that binding without repeated approval.

Mobile and non-Windows locations retain their previous path-based check. Native
metadata is never loaded on mobile. If a previously saved Windows binding is
invalid or its volume metadata cannot be read, sync remains blocked rather than
silently reverting to path-only trust. Manually trusting the intended location
retains the existing explicit review behavior.
