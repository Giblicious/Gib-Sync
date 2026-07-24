# Security

Gib Sync stores two complementary representations:

- The visible recovery tree contains ordinary readable vault files. Seafile, the Gib Sync service, the Seafile account owner, and administrators with sufficient access can read these files.
- The hidden `.gib-sync` sidecar keeps AES-256-GCM encrypted content-addressed history used for synchronization, conflict handling, and snapshot restoration.

The readable representation deliberately favors recoverability over protection from the server. Losing every device, the Gib Sync database, and the server secret does not make the latest mirrored vault unreadable: it can be downloaded directly from Seafile. Use Seafile permissions, HTTPS, host security, and encrypted disks/backups to protect it.

Device access uses independent 256-bit bearer tokens; the server stores only hashes. Vault keys and Seafile API tokens are encrypted at rest with `GIBSYNC_SERVER_SECRET`. Setup passwords are sent only over TLS to exchange them for Seafile API tokens and are not stored. `SEAFILE_ALLOWED_HOSTS` limits storage setup to approved hosts.

Temporary quick codes contain five random decimal digits, expire and roll every 60 seconds, work once, and permit at most five failed guesses per client per 60-second window. Returned credentials are encrypted using a key derived from the code. Manual enrollment requires valid credentials for the same Seafile identity and selected vault.

Keep `.env`, the server secret, and legacy Seafile credentials out of Git. Back up `/data`, but also back up the readable Seafile tree independently. Report vulnerabilities privately to the repository owner rather than opening a public issue.
