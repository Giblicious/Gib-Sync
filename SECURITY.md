# Security

Gib Sync encrypts vault file contents in the Obsidian plugin before upload. The server and Seafile receive AES-256-GCM ciphertext; the plaintext SHA-256 hash is used as the immutable object identifier and authenticated encryption associated data.

Device access uses independent 256-bit bearer tokens. The server stores only token hashes. The vault key is wrapped at rest with `GIBSYNC_SERVER_SECRET`. Mobile pairing links expire after five minutes, are single-use, and encrypt the returned credentials with a key derived from the QR secret using HKDF-SHA-256.

`GIBSYNC_SETUP_TOKEN` can enroll only the first device. Once the first vault exists, the bootstrap endpoint permanently rejects further setup-token enrollment and requires QR pairing.

Keep `.env`, the setup token, the server secret, and Seafile credentials out of Git. Terminate public traffic with TLS. Back up `/data`; losing both `/data` and the server secret invalidates enrolled device metadata even though encrypted Seafile objects remain.

Report vulnerabilities privately to the repository owner rather than opening a public issue.
