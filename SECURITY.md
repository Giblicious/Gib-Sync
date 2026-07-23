# Security

Gib Sync encrypts vault file contents in the Obsidian plugin before upload. The server and Seafile receive AES-256-GCM ciphertext; the plaintext SHA-256 hash is used as the immutable object identifier and authenticated encryption associated data.

Device access uses independent 256-bit bearer tokens. The server stores only token hashes. Vault keys and per-vault Seafile API tokens are encrypted at rest with `GIBSYNC_SERVER_SECRET`. The setup password is sent only over TLS to exchange it for a Seafile API token; it is not stored by the plugin or service. `SEAFILE_ALLOWED_HOSTS` prevents the setup API from becoming an arbitrary server-side request proxy.

Another device can authenticate to the same Seafile account, library, and folder to join its personal vault. As an optional convenience, one-time pairing links expire after five minutes, are single-use, and encrypt returned credentials with a key derived from the pairing secret using HKDF-SHA-256. A storage location owned by one Seafile identity cannot be claimed by a different identity.

Keep `.env`, the server secret, and legacy Seafile credentials out of Git. Terminate public traffic with TLS. Back up `/data`; losing both `/data` and the server secret invalidates enrolled device metadata even though encrypted Seafile objects remain.

Report vulnerabilities privately to the repository owner rather than opening a public issue.
