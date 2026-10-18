Stable client-only hotfix based on **v0.8.62**, with the portable Windows vault-location fix backported separately from unfinished v2 work.

- The same flash-drive vault remains trusted when Windows assigns another drive letter. A different drive, folder or vault name still requires review.
- Credentials and pending sync state are preserved. If the letter changed before upgrading, verify the intended vault and use **Trust this vault location** once to establish the portable binding.
- Versions v0.8.63 through v0.8.82 were already used for experimental tags. This version jump does not include those experimental changes.

Update the regular **Giblicious/Gib-Sync** installation through BRAT. No server update is required. This release publishes no container image and does not deploy or change a server.
