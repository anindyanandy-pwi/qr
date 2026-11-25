# Jhatpat drop box (Cloudflare Worker)

Holds end-to-end encrypted files for a desk/shop while its devices are offline,
and sends a Web Push "files waiting" notification. Files are encrypted on the
sender's phone with the desk's public key; the server cannot read names or contents.
Everything is deleted after download, or after 24 hours.

Deploy: `npx wrangler deploy` (needs D1 database `jhatpat` and the secret
`VAPID_PRIVATE_JWK` set with `npx wrangler secret put VAPID_PRIVATE_JWK`).
