import type { APIEvent } from "@solidjs/start"
import { waitUntil } from "@queryai/console-resource"
import type { DownloadPlatform } from "../types"

const prodAssetNames: Record<string, string> = {
  "darwin-aarch64-dmg": "queryai-desktop-mac-arm64.dmg",
  "darwin-x64-dmg": "queryai-desktop-mac-x64.dmg",
  "windows-x64-nsis": "queryai-desktop-win-x64.exe",
  "linux-x64-deb": "queryai-desktop-linux-amd64.deb",
  "linux-x64-appimage": "queryai-desktop-linux-x86_64.AppImage",
  "linux-x64-rpm": "queryai-desktop-linux-x86_64.rpm",
} satisfies Record<DownloadPlatform, string>

const betaAssetNames: Record<string, string> = {
  "darwin-aarch64-dmg": "queryai-desktop-mac-arm64.dmg",
  "darwin-x64-dmg": "queryai-desktop-mac-x64.dmg",
  "windows-x64-nsis": "queryai-desktop-win-x64.exe",
  "linux-x64-deb": "queryai-desktop-linux-amd64.deb",
  "linux-x64-appimage": "queryai-desktop-linux-x86_64.AppImage",
  "linux-x64-rpm": "queryai-desktop-linux-x86_64.rpm",
} satisfies Record<DownloadPlatform, string>

// Doing this on the server lets us preserve the original name for platforms we don't care to rename for
const downloadNames: Record<string, string> = {
  "darwin-aarch64-dmg": "QueryAI Desktop.dmg",
  "darwin-x64-dmg": "QueryAI Desktop.dmg",
  "windows-x64-nsis": "QueryAI Desktop Installer.exe",
} satisfies { [K in DownloadPlatform]?: string }

export async function GET({ params: { platform, channel } }: APIEvent) {
  const assetName = channel === "stable" ? prodAssetNames[platform] : betaAssetNames[platform]
  if (!assetName) return new Response(null, { status: 404 })

  const latest = await fetch(
    `https://github.com/anomalyco/${channel === "stable" ? "queryai" : "queryai-beta"}/releases/latest/download/${assetName}`,
    { redirect: "manual" },
  )
  const location = latest.headers.get("location")
  if (!location) return new Response(null, { status: 502 })

  const key = new Request(location)
  const cache = (caches as CacheStorage & { default: Cache }).default
  const cached = await cache.match(key)
  if (cached) return download(cached, platform, "HIT")

  const resp = await fetch(location)
  if (!resp.ok) return resp

  const headers = new Headers(resp.headers)
  headers.set("cache-control", "public, max-age=31536000, immutable")
  headers.delete("set-cookie")
  const result = new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers })
  waitUntil(cache.put(key, result.clone()))
  return download(result, platform, "MISS")
}

function download(resp: Response, platform: string, cache: "HIT" | "MISS") {
  const downloadName = downloadNames[platform]
  const headers = new Headers(resp.headers)
  if (downloadName) headers.set("content-disposition", `attachment; filename="${downloadName}"`)
  headers.set("x-queryai-cache", cache)

  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers })
}
