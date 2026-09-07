#!/usr/bin/env bun

// Publishes the built CLI to npm: one package per platform binary, plus a
// wrapper package whose postinstall picks the right one for the machine it
// lands on.
//
// Deliberately separate from script/publish.ts, which in the same pass pushes
// Docker images to the upstream project's registry and writes AUR and Homebrew
// recipes pinned to the upstream project's release URLs. None of that applies
// here, and running it would either fail or publish under someone else's name.
//
// Expects ./dist to already hold a build (packages/queryai/script/build.ts).

import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@queryai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

// The wrapper is what people type: `npm i -g queryai`. It has to match
// Release.npm in src/installation/index.ts, or `queryai upgrade` would look up a
// package this script never publishes.
const WRAPPER = process.env["QUERYAI_NPM_PACKAGE"] || pkg.name

// Where users are sent from the npm page. The source repo is private, so every
// public-facing link has to point at the distribution repo instead.
const DIST_REPO = process.env["DIST_REPO"] || "ashutosh20git/QueryAI-dist"

// A release is what `npm install` gets with no tag, so it goes to `latest`.
// Anything else is a preview and is tagged with its branch, where it can only be
// installed on purpose.
const TAG = process.env["QUERYAI_NPM_TAG"] || (Script.release && !Script.preview ? "latest" : Script.channel)

// Lets the packaging be verified without pushing anything to the registry -
// npm publish has no undo, so there has to be a way to look at what would go.
const dryRun = process.argv.includes("--dry-run")

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(from: string, name: string, version: string) {
  // GitHub artifact downloads drop the executable bit, and npm preserves
  // whatever mode it packs - a binary published without +x cannot be run.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(from)
  if (dryRun) {
    console.log(`[dry-run] would publish ${name}@${version} (${TAG}) from ${from}`)
    return
  }
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(from)
  await $`npm publish *.tgz --access public --tag ${TAG}`.cwd(from)
  console.log(`published ${name}@${version} (${TAG})`)
}

// Scan before the wrapper directory is created, so it is not mistaken for one of
// the platform packages.
const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const found = await Bun.file(`./dist/${filepath}`).json()
  binaries[found.name] = found.version
}
if (Object.keys(binaries).length === 0) throw new Error("no built binaries in ./dist - run script/build.ts first")

const version = Object.values(binaries)[0]
console.log("binaries", binaries)
console.log(`publishing ${WRAPPER}@${version} to npm tag "${TAG}"`)

await $`mkdir -p ./dist/${WRAPPER}/bin`
await $`cp ./script/postinstall.mjs ./dist/${WRAPPER}/postinstall.mjs`
// MIT requires the notice to travel with every copy, and for most users the npm
// tarball is the only artifact they ever receive.
await Bun.file(`./dist/${WRAPPER}/LICENSE`).write(await Bun.file("../../LICENSE").text())

// Stand-in for the real binary. It only ever runs when the postinstall did not,
// so it explains that rather than failing as a corrupt executable.
await Bun.file(`./dist/${WRAPPER}/bin/queryai.exe`).write(
  [
    `echo "Error: ${WRAPPER}'s postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This happens with --ignore-scripts, or with a package manager that does" >&2',
    'echo "not run postinstall scripts by default." >&2',
    'echo "" >&2',
    'echo "Run it manually:" >&2',
    `echo "  cd node_modules/${WRAPPER} && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall ${WRAPPER} without --ignore-scripts." >&2`,
    "exit 1",
    "",
  ].join("\n"),
)

await Bun.file(`./dist/${WRAPPER}/package.json`).write(
  JSON.stringify(
    {
      name: WRAPPER,
      description: "An AI coding agent for the terminal that runs on free models and remembers you between sessions.",
      bin: { queryai: "./bin/queryai.exe" },
      scripts: { postinstall: "node ./postinstall.mjs" },
      version,
      license: pkg.license,
      // Point at the public distribution repo, not the source: npm renders these
      // as links, and a link into a private repository 404s for every visitor.
      repository: { type: "git", url: `git+https://github.com/${DIST_REPO}.git` },
      homepage: `https://github.com/${DIST_REPO}#readme`,
      bugs: { url: `https://github.com/${DIST_REPO}/issues` },
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      // The wrapper carries no binary of its own; npm installs whichever of
      // these matches, and the postinstall copies it into place.
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

// Platform packages first: the wrapper's optionalDependencies point at them, so
// a wrapper published ahead of them would be briefly uninstallable.
for (const name of Object.keys(binaries)) {
  await publish(`./dist/${name}`, name, binaries[name])
}
await publish(`./dist/${WRAPPER}`, WRAPPER, version)

console.log(`\ndone: npm i -g ${WRAPPER}`)
