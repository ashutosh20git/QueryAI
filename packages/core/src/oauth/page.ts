// Branded HTML pages for local OAuth callback servers.
//
// These are served by the loopback HTTP servers that finish an OAuth exchange
// (MCP, Codex/ChatGPT, xAI, Snowflake, DigitalOcean, ...). The functions return
// a fully self-contained HTML string with no external assets, so they work
// offline and drop into any transport (`res.end(...)`, Effect `response.end`,
// etc.).
//
// The visual language mirrors the QueryAI app: the design tokens are a curated
// subset of the OC-2 semantic tokens in `packages/ui/src/styles/theme.css`, and
// the wordmark is the same geometry as `packages/ui/src/components/logo.tsx`.
// Keep this file in sync with those sources when the brand changes.

export interface CallbackPageOptions {
  /** Friendly integration name shown as a subtitle, e.g. "xAI", "Snowflake", "MCP". */
  provider?: string
  /** Attempt to close the window shortly after success. Defaults to true. */
  autoClose?: boolean
}

export function success(options?: CallbackPageOptions) {
  const provider = options?.provider
  return renderDocument({
    title: "Authorization successful",
    body: renderCard({
      status: "success",
      headline: "Authorization successful",
      message: provider ? `QueryAI is now connected to ${escapeHtml(provider)}.` : "QueryAI is now authorized.",
      footnote: "You can close this window.",
    }),
    script: options?.autoClose === false ? undefined : AUTO_CLOSE_SCRIPT,
  })
}

export function error(detail: string, options?: CallbackPageOptions) {
  const provider = options?.provider
  return renderDocument({
    title: "Authorization failed",
    body: renderCard({
      status: "error",
      headline: "Authorization failed",
      message: provider
        ? `QueryAI couldn't finish connecting to ${escapeHtml(provider)}.`
        : "QueryAI couldn't complete authorization.",
      detail,
      footnote: "Close this window and try again from QueryAI.",
    }),
  })
}

export interface BootstrapOptions {
  /** Same-origin path the in-browser script POSTs the parsed callback to. */
  tokenPath: string
  provider?: string
}

// For flows where the credential arrives in the URL fragment (implicit grant),
// the browser must relay it back to the loopback server. This renders a pending
// page whose script reads the fragment, POSTs it to `tokenPath`, then resolves
// to the success or error state in place.
export function bootstrap(options: BootstrapOptions) {
  return renderDocument({
    title: "Finishing sign-in",
    body: renderCard({
      status: "pending",
      headline: "Finishing sign-in",
      message: options.provider
        ? `Completing your ${escapeHtml(options.provider)} authorization.`
        : "Completing authorization.",
      footnote: "You can close this window once sign-in finishes.",
    }),
    script: bootstrapScript(options),
  })
}

export * as OauthCallbackPage from "./page"

type Status = "pending" | "success" | "error"

function renderCard(input: { status: Status; headline: string; message: string; detail?: string; footnote: string }) {
  const detail = input.detail?.trim()
  return `<main class="card" id="oc-card" data-status="${input.status}" role="status" aria-live="polite">
      <div class="brand">${WORDMARK}</div>
      <div class="status" aria-hidden="true">
        <span class="icon icon-pending">${ICON_SPINNER}</span>
        <span class="icon icon-success">${ICON_CHECK}</span>
        <span class="icon icon-error">${ICON_CROSS}</span>
      </div>
      <h1 class="headline" id="oc-headline">${escapeHtml(input.headline)}</h1>
      <p class="message" id="oc-message">${input.message}</p>
      <pre class="detail" id="oc-detail"${detail ? "" : " hidden"}>${detail ? escapeHtml(detail) : ""}</pre>
      <p class="footnote" id="oc-footnote">${escapeHtml(input.footnote)}</p>
    </main>`
}

function renderDocument(input: { title: string; body: string; script?: string }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(input.title)} · QueryAI</title>
    <style>${STYLES}</style>
  </head>
  <body>
    ${input.body}${input.script ? `\n    <script>${input.script}</script>` : ""}
  </body>
</html>`
}

const AUTO_CLOSE_SCRIPT = `setTimeout(function(){try{window.close()}catch(e){}},2500)`

function bootstrapScript(options: BootstrapOptions) {
  return `var PROVIDER=${scriptString(options.provider ?? "")};
var TOKEN_URL=new URL(${scriptString(options.tokenPath)},window.location.origin).href;
(function(){
  var card=document.getElementById("oc-card"),headline=document.getElementById("oc-headline"),message=document.getElementById("oc-message"),detail=document.getElementById("oc-detail"),footnote=document.getElementById("oc-footnote");
  function fail(text){card.dataset.status="error";headline.textContent="Authorization failed";message.textContent=PROVIDER?("QueryAI couldn't finish connecting to "+PROVIDER+"."):"QueryAI couldn't complete authorization.";if(text){detail.textContent=text;detail.hidden=false}footnote.textContent="Close this window and try again from QueryAI."}
  function ok(){card.dataset.status="success";headline.textContent="Authorization successful";message.textContent=PROVIDER?("QueryAI is now connected to "+PROVIDER+"."):"QueryAI is now authorized.";detail.hidden=true;footnote.textContent="You can close this window.";setTimeout(function(){try{window.close()}catch(e){}},2500)}
  try{
    var hash=new URLSearchParams((window.location.hash||"").slice(1));
    var search=new URLSearchParams(window.location.search||"");
    var err=hash.get("error")||search.get("error");
    var errDescription=hash.get("error_description")||search.get("error_description");
    var body=err?{error:err,error_description:errDescription||""}:{access_token:hash.get("access_token")||"",expires_in:hash.get("expires_in")||"0",state:hash.get("state")||""};
    fetch(TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(res){
      if(!res.ok)return res.text().catch(function(){return""}).then(function(t){throw new Error(t||("callback failed ("+res.status+")"))});
      if(err){fail(errDescription||err);return}
      ok();
    }).catch(function(e){fail(String(e&&e.message?e.message:e))});
  }catch(e){fail(String(e&&e.message?e.message:e))}
})()`
}

function scriptString(value: string) {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

// Curated subset of OC-2 tokens (packages/ui/src/styles/theme.css). Default is
// light; dark applies via prefers-color-scheme. The [data-theme] selectors let a
// host force a scheme without changing the default.
const LIGHT_VARS = `
    --oc-bg: #f8f8f8;
    --oc-card: #fcfcfc;
    --oc-text-strong: #171717;
    --oc-text-base: #6f6f6f;
    --oc-text-weak: #8f8f8f;
    --oc-border-weak: #e5e5e5;
    --oc-icon-strong: #171717;
    --oc-icon-base: #8f8f8f;
    --oc-icon-weak: #dbdbdb;
    --oc-success: #2dba26;
    --oc-error: #ed4831;
    --oc-detail-bg: #fff8f6;
    --oc-detail-border: #fdc3b7;
    --oc-shadow: 0 16px 48px -6px rgba(0,0,0,.10), 0 6px 12px -2px rgba(0,0,0,.05), 0 1px 2px rgba(0,0,0,.06);`

const DARK_VARS = `
    --oc-bg: #101010;
    --oc-card: #161616;
    --oc-text-strong: rgba(255,255,255,.936);
    --oc-text-base: rgba(255,255,255,.618);
    --oc-text-weak: rgba(255,255,255,.422);
    --oc-border-weak: #282828;
    --oc-icon-strong: #ededed;
    --oc-icon-base: #7e7e7e;
    --oc-icon-weak: #343434;
    --oc-success: #12c905;
    --oc-error: #fc533a;
    --oc-detail-bg: #28110c;
    --oc-detail-border: #6a1206;
    --oc-shadow: 0 16px 48px -6px rgba(0,0,0,.55), 0 6px 12px -2px rgba(0,0,0,.35), 0 1px 2px rgba(0,0,0,.4);`

const STYLES = `
  :root { color-scheme: light dark;${LIGHT_VARS}
    --oc-font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --oc-font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DARK_VARS} } }
  :root[data-theme="dark"] {${DARK_VARS} }
  :root[data-theme="light"] {${LIGHT_VARS} }

  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--oc-bg);
    color: var(--oc-text-base);
    font-family: var(--oc-font-sans);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  .card {
    width: min(100%, 28rem);
    padding: 2.25rem 2rem 1.75rem;
    background: var(--oc-card);
    border: 1px solid var(--oc-border-weak);
    border-radius: 14px;
    box-shadow: var(--oc-shadow);
    text-align: center;
  }
  .brand { display: flex; justify-content: center; margin-bottom: 1.75rem; }
  .brand svg { height: 19px; width: auto; }
  .status { display: flex; justify-content: center; margin-bottom: 1.125rem; }
  .icon { display: none; line-height: 0; }
  .icon svg { display: block; }
  .card[data-status="pending"] .icon-pending,
  .card[data-status="success"] .icon-success,
  .card[data-status="error"] .icon-error { display: block; }
  .icon-success { color: var(--oc-success); }
  .icon-error { color: var(--oc-error); }
  .icon-pending { color: var(--oc-text-weak); }
  .headline { margin: 0; font-size: 1.1875rem; font-weight: 500; line-height: 1.3; letter-spacing: -0.012em; color: var(--oc-text-strong); }
  .message { margin: 0.5rem 0 0; font-size: 0.9375rem; color: var(--oc-text-base); }
  .detail {
    margin: 1.25rem 0 0;
    padding: 0.75rem 0.875rem;
    text-align: left;
    font-family: var(--oc-font-mono);
    font-size: 0.8125rem;
    line-height: 1.55;
    color: var(--oc-text-strong);
    background: var(--oc-detail-bg);
    border: 1px solid var(--oc-detail-border);
    border-radius: 8px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 9.5rem;
    overflow: auto;
  }
  .detail[hidden] { display: none; }
  .footnote { margin: 1.5rem 0 0; font-size: 0.8125rem; color: var(--oc-text-weak); }
  .spinner { animation: oc-spin 0.8s linear infinite; transform-origin: center; }
  @keyframes oc-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`

// QueryAI wordmark — same path geometry as packages/ui/src/components/logo.tsx (Logo).
const WORDMARK = `<svg class="wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 204 42" fill="none" aria-label="QueryAI" role="img">
        <path d="M6 18H18V24H6V18ZM6 24H18V30H6V24Z" fill="var(--oc-icon-weak)" />
        <path d="M0 6H24V12H0V6ZM0 12H6V18H0V12ZM18 12H24V18H18V12ZM0 18H6V24H0V18ZM18 18H24V24H18V18ZM0 24H6V30H0V24ZM18 24H24V30H18V24ZM0 30H24V36H0V30ZM18 36H24V42H18V36Z" fill="var(--oc-icon-base)" />
        <path d="M36 18H48V24H36V18ZM36 24H48V30H36V24Z" fill="var(--oc-icon-weak)" />
        <path d="M30 6H36V12H30V6ZM48 6H54V12H48V6ZM30 12H36V18H30V12ZM48 12H54V18H48V12ZM30 18H36V24H30V18ZM48 18H54V24H48V18ZM30 24H36V30H30V24ZM48 24H54V30H48V24ZM30 30H54V36H30V30Z" fill="var(--oc-icon-base)" />
        <path d="M78 18H84V24H78V18ZM66 24H84V30H66V24Z" fill="var(--oc-icon-weak)" />
        <path d="M60 6H84V12H60V6ZM60 12H66V18H60V12ZM60 18H78V24H60V18ZM60 24H66V30H60V24ZM60 30H84V36H60V30Z" fill="var(--oc-icon-base)" />
        <path d="M96 24H102V30H96V24ZM108 24H114V30H108V24ZM96 30H108V36H96V30Z" fill="var(--oc-icon-weak)" />
        <path d="M90 6H114V12H90V6ZM90 12H96V18H90V12ZM108 12H114V18H108V12ZM90 18H114V24H90V18ZM90 24H96V30H90V24ZM102 24H108V30H102V24ZM90 30H96V36H90V30ZM108 30H114V36H108V30Z" fill="var(--oc-icon-base)" />
        <path d="M120 6H126V12H120V6ZM138 6H144V12H138V6ZM120 12H126V18H120V12ZM138 12H144V18H138V12ZM126 18H138V24H126V18ZM126 24H138V30H126V24ZM126 30H138V36H126V30Z" fill="var(--oc-icon-base)" />
        <path d="M156 24H168V30H156V24ZM156 30H168V36H156V30Z" fill="var(--oc-icon-weak)" />
        <path d="M150 6H174V12H150V6ZM150 12H156V18H150V12ZM168 12H174V18H168V12ZM150 18H174V24H150V18ZM150 24H156V30H150V24ZM168 24H174V30H168V24ZM150 30H156V36H150V30ZM168 30H174V36H168V30Z" fill="var(--oc-icon-strong)" />
        <path d="M180 6H204V12H180V6ZM186 12H198V18H186V12ZM186 18H198V24H186V18ZM186 24H198V30H186V24ZM180 30H204V36H180V30Z" fill="var(--oc-icon-strong)" />
      </svg>`

const ICON_CHECK = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.4 2.4 4.6-5.4" /></svg>`

const ICON_CROSS = `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg>`

const ICON_SPINNER = `<svg class="spinner" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9" opacity="0.2" /><path d="M21 12a9 9 0 0 0-9-9" /></svg>`
