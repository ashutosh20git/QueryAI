/**
 * QueryAI share server.
 *
 * A single Cloudflare Worker backed by one R2 bucket. It implements exactly the
 * four endpoints the CLI's share client calls, and nothing else - no accounts,
 * no database, no third party. Deploy it to your own Cloudflare account and set
 * `share.url` in your config; a free `*.workers.dev` subdomain is enough, so
 * this costs nothing and needs no domain.
 *
 *   POST   /api/share            {sessionID}            -> {id, url, secret}
 *   POST   /api/share/:id/sync   {secret, data: [...]}  -> {ok: true}
 *   DELETE /api/share/:id        {secret}               -> {ok: true}
 *   GET    /api/share/:id/data                          -> [...]
 *   GET    /share/:id                                   -> a readable HTML page
 *
 * The share id is the capability: anyone who has it can read the conversation,
 * which is what sharing means. The secret is what proves the right to write, and
 * only its hash is stored, so a dump of the bucket cannot be used to forge
 * updates to someone's share.
 */

export interface Env {
  BUCKET: R2Bucket
  /** Optional. Set it when the worker is served from your own domain. */
  PUBLIC_URL?: string
}

type Entry = { type: string; data: Record<string, unknown> }

type Meta = {
  sessionID: string
  /** SHA-256 of the write secret, hex. Never the secret itself. */
  secret: string
  created: number
}

const JSON_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,x-org-id",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })

const fail = (status: number, message: string) => json({ error: message }, status)

/** URL-safe, unguessable, and short enough to paste. 128 bits of randomness. */
function token(bytes = 16) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function hash(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** Constant-time compare, so a wrong secret leaks nothing through timing. */
function same(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * The storage key for one entry, mirroring the client's own keying so a resent
 * message or part overwrites its previous version instead of duplicating it.
 */
function entryKey(item: Entry): string | undefined {
  const data = item.data ?? {}
  switch (item.type) {
    case "session":
      return "session"
    case "session_diff":
      return "session_diff"
    case "model":
      return "model"
    case "message":
      return typeof data["id"] === "string" ? `message/${data["id"]}` : undefined
    case "part":
      return typeof data["id"] === "string" && typeof data["messageID"] === "string"
        ? `part/${data["messageID"]}/${data["id"]}`
        : undefined
    default:
      return undefined
  }
}

/** Ordered so a reader gets the session, then each message with its parts after it. */
const RANK: Record<string, number> = { session: 0, model: 1, session_diff: 2, message: 3, part: 4 }

async function readMeta(env: Env, id: string) {
  const object = await env.BUCKET.get(`share/${id}/meta.json`)
  if (!object) return undefined
  return (await object.json()) as Meta
}

async function authorize(env: Env, id: string, request: Request) {
  const body = await request.json<{ secret?: string }>().catch(() => ({}) as { secret?: string })
  const meta = await readMeta(env, id)
  if (!meta) return { error: fail(404, "No such share") } as const
  if (!body.secret || !same(await hash(body.secret), meta.secret)) {
    return { error: fail(403, "Wrong or missing secret") } as const
  }
  return { meta, body } as const
}

async function listData(env: Env, id: string) {
  const prefix = `share/${id}/data/`
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 })
    for (const object of page.objects) keys.push(object.key)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  const entries = await Promise.all(
    keys.map(async (key) => {
      const object = await env.BUCKET.get(key)
      return object ? ((await object.json()) as Entry) : undefined
    }),
  )
  return entries
    .filter((entry): entry is Entry => entry !== undefined)
    .sort((a, b) => (RANK[a.type] ?? 9) - (RANK[b.type] ?? 9))
}

async function removeAll(env: Env, id: string) {
  const prefix = `share/${id}/`
  let cursor: string | undefined
  do {
    const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 })
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((object) => object.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS })

    const url = new URL(request.url)
    const base = env.PUBLIC_URL?.replace(/\/+$/, "") ?? url.origin
    const path = url.pathname

    if (path === "/api/share" && request.method === "POST") {
      const body = await request.json<{ sessionID?: string }>().catch(() => ({}) as { sessionID?: string })
      if (!body.sessionID) return fail(400, "sessionID is required")

      const id = token()
      const secret = token(24)
      const meta: Meta = { sessionID: body.sessionID, secret: await hash(secret), created: Date.now() }
      await env.BUCKET.put(`share/${id}/meta.json`, JSON.stringify(meta), {
        httpMetadata: { contentType: "application/json" },
      })
      // The secret is returned exactly once and never stored in the clear.
      return json({ id, url: `${base}/share/${id}`, secret })
    }

    const match = /^\/api\/share\/([A-Za-z0-9_-]+)(\/sync|\/data)?$/.exec(path)
    if (match) {
      const [, id, suffix] = match

      if (suffix === "/data" && request.method === "GET") {
        if (!(await readMeta(env, id))) return fail(404, "No such share")
        return json(await listData(env, id))
      }

      if (suffix === "/sync" && request.method === "POST") {
        const auth = await authorize(env, id, request)
        if ("error" in auth) return auth.error
        const items = Array.isArray((auth.body as { data?: unknown }).data)
          ? ((auth.body as { data: Entry[] }).data ?? [])
          : []
        await Promise.all(
          items.map(async (item) => {
            const key = entryKey(item)
            if (!key) return
            await env.BUCKET.put(`share/${id}/data/${key}.json`, JSON.stringify(item), {
              httpMetadata: { contentType: "application/json" },
            })
          }),
        )
        return json({ ok: true, written: items.length })
      }

      if (!suffix && request.method === "DELETE") {
        const auth = await authorize(env, id, request)
        if ("error" in auth) return auth.error
        await removeAll(env, id)
        return json({ ok: true })
      }
    }

    const page = /^\/share\/([A-Za-z0-9_-]+)$/.exec(path)
    if (page && request.method === "GET") {
      if (!(await readMeta(env, page[1]))) return new Response("No such share", { status: 404 })
      return new Response(viewer(page[1]), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      })
    }

    if (path === "/") return new Response("QueryAI share server", { status: 200 })
    return fail(404, "Not found")
  },
} satisfies ExportedHandler<Env>

/**
 * A self-contained reader. Inlined rather than pulled from a CDN so a shared
 * link keeps working with no other host involved - which is the entire point of
 * running this yourself.
 */
function viewer(id: string) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shared session</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfaf8; --fg:#1a1a1a; --muted:#6b6b6b; --line:#e5e2dc; --card:#fff; --accent:#3b5bdb }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16161a; --fg:#e8e6e3; --muted:#9a9a9a; --line:#2c2c32; --card:#1d1d22; --accent:#8ba4ff }
  }
  * { box-sizing: border-box }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif }
  main { max-width: 780px; margin: 0 auto; padding: 32px 20px 96px }
  h1 { font-size: 19px; margin: 0 0 4px }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 28px }
  .turn { border:1px solid var(--line); background:var(--card); border-radius:10px; padding:14px 16px; margin:0 0 14px }
  .who { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:8px }
  .turn.user { border-left:3px solid var(--accent) }
  pre { background:rgba(127,127,127,.10); padding:12px; border-radius:8px; overflow-x:auto; font-size:13px }
  code { font-family: ui-monospace,SFMono-Regular,Menlo,monospace }
  .tool { font-size:13px; color:var(--muted); font-family:ui-monospace,monospace; padding:6px 0 }
  .text { white-space: pre-wrap; word-wrap: break-word }
  .empty { color: var(--muted) }
</style>
</head><body><main>
<h1>Shared session</h1>
<div class="sub" id="sub">Loading&hellip;</div>
<div id="out"></div>
</main>
<script type="module">
const id = ${JSON.stringify(id)}
const out = document.getElementById("out")
const sub = document.getElementById("sub")
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
try {
  const rows = await fetch("/api/share/" + id + "/data").then((r) => r.json())
  const session = rows.find((r) => r.type === "session")
  document.title = session?.data?.title ?? "Shared session"
  sub.textContent = session?.data?.title ?? "Untitled session"

  const messages = rows.filter((r) => r.type === "message").map((r) => r.data)
  const parts = rows.filter((r) => r.type === "part").map((r) => r.data)
  const byMessage = new Map()
  for (const part of parts) {
    if (!byMessage.has(part.messageID)) byMessage.set(part.messageID, [])
    byMessage.get(part.messageID).push(part)
  }
  messages.sort((a, b) => String(a.id).localeCompare(String(b.id)))

  if (!messages.length) out.innerHTML = '<p class="empty">This share has no messages yet.</p>'
  for (const message of messages) {
    const own = (byMessage.get(message.id) ?? []).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const body = own
      .map((part) => {
        if (part.type === "text" && part.text) return '<div class="text">' + esc(part.text) + "</div>"
        if (part.type === "tool") return '<div class="tool">\\u2699 ' + esc(part.tool ?? "tool") + "</div>"
        return ""
      })
      .join("")
    if (!body) continue
    const who = message.role === "user" ? "You" : (message.modelID ?? "Assistant")
    out.insertAdjacentHTML(
      "beforeend",
      '<div class="turn ' + esc(message.role) + '"><div class="who">' + esc(who) + "</div>" + body + "</div>",
    )
  }
} catch (err) {
  sub.textContent = "Could not load this share."
}
</script>
</body></html>`
}
