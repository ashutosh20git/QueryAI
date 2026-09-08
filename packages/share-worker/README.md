# QueryAI share server

The server behind `queryai share`. One Cloudflare Worker, one R2 bucket, no
database and no accounts. Run it in your own Cloudflare account and shared
sessions never touch anyone else's infrastructure.

Until you deploy this and point the CLI at it, sharing is **off** — the CLI
refuses to upload rather than defaulting to a third-party host.

## Deploy

You need a free Cloudflare account. No domain is required; a `*.workers.dev`
subdomain works.

```bash
cd packages/share-worker
bun install
bunx wrangler login
bunx wrangler r2 bucket create queryai-share
bunx wrangler deploy
```

`deploy` prints the worker URL, e.g. `https://queryai-share.<you>.workers.dev`.
Put it in your config:

```json title="~/.config/queryai/queryai.json"
{
  "share": { "url": "https://queryai-share.your-subdomain.workers.dev" }
}
```

Or set `QUERYAI_SHARE_URL` in the environment. Then `queryai share` in a session,
and the link it prints is served entirely by you.

### Your own domain

Optional. Add to `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "share.example.com", "custom_domain": true }],
"vars": { "PUBLIC_URL": "https://share.example.com" }
```

`PUBLIC_URL` only changes the link handed back to the CLI; without it the worker
uses the origin the request arrived on.

## What it costs

Cloudflare's free tier covers 100,000 worker requests/day and 10 GB of R2 with
1M class-A operations/month. A shared session is a few hundred small writes. In
practice this is free unless you are running it for an organisation.

## The API

Four endpoints, which is the whole contract the CLI's share client expects.

| Method   | Path                  | Body                    | Returns              |
| -------- | --------------------- | ----------------------- | -------------------- |
| `POST`   | `/api/share`          | `{sessionID}`           | `{id, url, secret}`  |
| `POST`   | `/api/share/:id/sync` | `{secret, data: [...]}` | `{ok, written}`      |
| `DELETE` | `/api/share/:id`      | `{secret}`              | `{ok}`               |
| `GET`    | `/api/share/:id/data` | —                       | `[...]` flat array   |
| `GET`    | `/share/:id`          | —                       | a readable HTML page |

## Security model

Worth being explicit, because sharing means publishing.

- **The id is the read capability.** Anyone with the link can read the session —
  that is what sharing is. Ids are 128 random bits, so they cannot be guessed or
  enumerated, but they are not secret from whoever you send the link to.
- **The secret is the write capability**, generated server-side, returned once,
  and stored only as a SHA-256 hash. Someone who dumps the bucket cannot forge
  updates to a share. Comparison is constant-time.
- **Deleting is real.** `queryai unshare` removes every object under the share's
  prefix. There is no soft delete and no backup, so a deleted share is gone.
- **There is no auth on reads by design.** If you need shares to be private to an
  organisation, put Cloudflare Access in front of the worker — this deliberately
  does not grow its own account system.

## Layout in R2

```
share/<id>/meta.json                     {sessionID, secret: <sha256>, created}
share/<id>/data/session.json
share/<id>/data/message/<messageID>.json
share/<id>/data/part/<messageID>/<partID>.json
```

Entries are keyed the same way the CLI keys them, so re-syncing a message
overwrites it instead of appending a duplicate.
