# Standalone binaries — how `pnpm package:*` works and why

The packaged artifact is a single executable per target:

| Target    | Artifact                                  | Built from |
| --------- | ----------------------------------------- | ---------- |
| linux-x64 | `dist/bin/moleculer-sidecar-next-linux-x64` | any host |
| win-x64   | `dist/bin/moleculer-sidecar-next-win-x64.exe` | any host |

No Node, no `node_modules`, no sidecar files: copy the file and run it.

```
pnpm package:linux     # build UI + CLI, stage, package linux-x64
pnpm package:win       # ... win-x64
pnpm package:all       # both
```

The tool is `@yao-pkg/pkg` in **enhanced SEA mode** (`pkg . --sea`): stock Node
(the base binary is downloaded per target, `node<host-major>-<os>-<arch>`), the
app is injected as a SEA blob, and pkg's virtual filesystem serves `node_modules`
at runtime. `scripts/pack.mjs` does all of it.

## Why a staging tree, and how the module system is kept simple

`scripts/pack.mjs` never packages the repository in place. For each target it
builds `build/pack/<target>/`:

```
build/pack/linux-x64/
├── package.json            generated manifest (prod deps only + pkg config)
├── pnpm-workspace.yaml     makes the stage its own workspace, denies native builds
├── pnpm-lock.yaml          copied from the repo so resolutions stay locked
├── dist/cli.mjs            the whole CLI (esbuild bundle of src/index.ts)
├── dist/moleculer.config.mjs
├── ui/dist/**              the SPA, served from inside the binary
└── node_modules            hoisted, symlink-free production install
```

Two constraints drove this shape. Both were measured, not assumed — see the
probe results below.

1. **pkg's virtual filesystem cannot load modules through pnpm's symlinked
   `node_modules`.** With the repository's own tree, every bare specifier failed
   at runtime (`Cannot find module 'sqlite3'`, `Cannot find package 'moleculer'`)
   even though the archive contained the files. With a hoisted (real directory)
   tree, `require()`/`import()` of `moleculer`, `sqlite3` and `cbor-x` all work.
   Hence `pnpm install --node-linker=hoisted --prod --no-optional` in the stage.
2. **Node's CommonJS named-export detection fails for dependency files inside the
   archive.** `import { ServiceBroker } from 'moleculer'` works, but
   `import { Errors } from 'moleculer'` throws *"Named export 'Errors' not
   found"* — the lexer only sees the **first** entry of a dependency's
   `module.exports` object (the VFS file itself is intact: 1468 bytes, all 25
   requires present).

The second constraint is handled **without giving up ES modules**, by two rules
in our own sources:

- A named export of a CommonJS dependency is reached through
  `src/runtime/cjs-interop.ts` — that module default-imports the package and
  destructures at runtime, so `import { Errors, is, Service } from
  '../runtime/cjs-interop.js'` is a plain import of *our* ES module. It also
  re-declares the type meaning of the classes (`ServiceBroker`) and documents the
  one name it cannot carry (`Errors` is a namespace, so `src/errors.ts` and
  `src/server.ts` add `import type { Errors as ErrorsType } from 'moleculer'`).
- A dependency **whose ES module reads `fs/promises` itself** must be evaluated
  *after* the fs shim is installed, so it cannot be a static import in the
  bundle. `@moleculer/lab` is the one such dependency; `src/services/lab.service.ts`
  loads it through a runtime specifier (`await import(LAB_PACKAGE)`), which the
  bundler cannot hoist. See "Imports, evaluation order and the fs shim" below.

`cbor-extract` is dropped from the staged manifest (`EXCLUDED_DEPENDENCIES`): it
is an optional accelerator that `cbor-x` loads inside a `try/catch`
("native module is optional"), so the pure-JS codec is used instead of shipping a
second foreign native binary. `--no-optional` also keeps `cbor-x`'s per-platform
prebuild packages out of the tree.

The native `sqlite3` binding is **not** built: both native build scripts are
denied in the staged workspace (`allowBuilds: false`) and
`prebuild-install -r napi --platform <p> --arch <a>` fetches the target's
prebuild into `node_modules/sqlite3/build/Release/node_sqlite3.node`. A build
fails loudly if any other `.node` file appears in the tree.

## What the virtual filesystem does and does not support

Probed on the packaged linux-x64 binary (`build/probe/*`, run in a clean
`ubuntu:24.04` container with no Node):

| Operation | Works | Notes |
| --------- | ----- | ----- |
| `readFileSync`, `statSync`, `lstatSync`, `existsSync`, `readdirSync` | yes | assets and module files |
| `fs.readFile`, `fs.promises.readFile`, `fs.promises.stat` | yes | path strings only, see below |
| `fs.stat` (callback) | yes | what `send`/serve-static uses |
| `createReadStream` (incl. `start`/`end`) | yes | SPA and lab assets are streamed from the binary |
| dynamic `import()` of an assets-only file | yes | e.g. the service modules and the config |
| `require()`/`import()` of `node_modules` | yes | hoisted tree only |
| any of the above with a `file:` **URL** | only with the shim | the VFS matches path strings; `src/runtime/vfs-fs.ts` normalises the argument |
| **`fs.openSync`, `fs.open`, `fs.promises.open`** | **no** | the VFS does not intercept them; reads through a file descriptor hit the real filesystem and fail with `ENOENT` |

## Imports, evaluation order and the fs shim

The VFS accepts **path strings, not `file:` URLs**: `readFileSync(new URL(...))`
fails with ENOENT even though the same file is readable by path. pglite builds
its paths as URLs (`new URL('./postgres.wasm', import.meta.url)`) and then hands
them to `readFile`, so `src/runtime/vfs-fs.ts` wraps the path-taking entry points
of the CommonJS `fs` and `fs/promises` objects and converts a `URL` argument to a
path before the packaged implementation sees it. It uses `createRequire` because
an ES module namespace is immutable, while the packaged runtime patches the same
CommonJS objects (verified: `await import('fs/promises')` and
`require('node:fs/promises')` share `readFile`).

The wrapper has to be installed **before the module that reads through it is
evaluated**, which is not the same as "before it is used": ES module namespaces
are a snapshot taken when the importing module is instantiated, and a
destructured `import { readFile } from 'fs/promises'` therefore captures
whatever the helper was at that moment. Two consequences shaped the sources:

- The shim is installed in the body of `src/index.ts`, which runs after all
  hoisted imports of the bundle — so no dependency that reads `fs/promises` may
  be a static import there. `@moleculer/lab` is loaded lazily for exactly this
  reason (see above).
- The failure mode when that order is wrong is subtle: the call reaches the
  *unpatched* helper, which converts the URL to a path itself and then fails with
  `ENOENT` naming the `/snapshot/...` path — i.e. it looks like a missing asset
  rather than a missing shim. `build/probe/pack-fs.mjs` prints the behaviour of
  every entry point before and after the shim, which is how this was measured.

## Runtime facts

- `DATA_DIR` (env) selects the data directory. Without it, a packaged binary uses
  the OS location (`%ProgramData%\moleculer-sidecar`,
  `~/Library/Application Support/moleculer-sidecar`, `$XDG_DATA_HOME/moleculer-sidecar`);
  a source checkout keeps using `./.data`. The SQLite files (`auth.sqlite`,
  `publication.sqlite`), lab's own state (`<data>/lab`) and the extracted native
  addon live there.
- `PKG_NATIVE_CACHE_PATH` overrides where pkg extracts `.node` files (defaults to
  the XDG cache / `%LOCALAPPDATA%`). Set it in the service environment so a
  service account without a writable profile cache still works.
- The default broker config is the one compiled into the binary
  (`dist/moleculer.config.mjs`); `--config`/`MOLECULER_CONFIG` still load an
  external `.js`/`.mjs`/`.cjs` file. TypeScript configs remain a source-checkout
  feature (tsx), not a binary one.
- `--version` reads the manifest of the packaged project; `--help` is unchanged.
- Stopping: the CLI handles `SIGINT`/`SIGTERM` (and `SIGBREAK` on Windows), stops
  the broker and exits 0, with a 15s budget before a forced exit. This is what
  makes `nssm stop` / `Stop-Service` graceful.
- Known pre-existing behaviour (not packaging related): `broker.stop()` logs
  `SQLITE_MISUSE: Database handle is closed` while stopping `$sidecar`; the exit
  code is still 0. Reproduced with `tsx src/index.ts` on the unmodified sources.

## `--lab` runs on the embedded PostgreSQL

Lab 1.0's store is the embedded PostgreSQL **pglite**, which loads
`postgres.wasm`/`postgres.data` with `(await import('fs/promises')).readFile(new
URL('./postgres.data', import.meta.url))`. With the URL shim in place that works
from inside the binary — no external database and no `LAB_PG_URL`:

```
$ moleculer-sidecar-next-linux-x64 --lab
… Laboratory store initialized (backend: pglite)
… Server listening on http://0.0.0.0:5103

GET /lab          -> 307 /lab/
GET /lab/         -> 200 text/html
GET /lab/assets/index-DoXsBGJd.js -> 200 text/javascript
GET /lab/api/registry -> 200
```

(Measured in a clean `ubuntu:24.04` container with only the binary copied in;
`build/smoke-lab-embedded.sh` is the script. Two earlier obstacles had to be
cleared first: the missing URL support above, and the evaluation order of the
shim — before that, pglite died on
`ENOENT … /snapshot/.../@electric-sql/pglite/dist/postgres.data`.)

An external PostgreSQL is still supported and still enough for a production
deployment: `LAB_PG_URL` is passed to lab as `settings.store.connectionString`,
lab then uses `pg.Pool` and never touches pglite (verified against
`postgres:16`: `backend: postgres`, `/lab` → 307, dashboard and assets 200).

Everything else — core services, `/sidecar`, `--ui` with the SPA — works with no
external dependency either. The dashboard also keeps working the old way:
`pnpm start --lab` from a source checkout, or the container image.

A read-only archive path still cannot be *opened* (`fs.open*`, table above);
nothing in the shipped feature set needs a file descriptor for a file inside the
binary. If that changes, the next step is a small `open`/fd shim over the VFS
(`readFileSync` + a synthetic descriptor table), not a different tool.

## Verifying a build

`build/smoke-linux.sh`, `build/smoke-lab-embedded.sh` and
`build/smoke-lab-pg.sh` run the binary in a clean container: CLI output, core
services, graceful SIGINT (exit 0), the UI SPA with correct MIME types, the
session/CSRF-protected token round trip (create → list → revoke → list), lab on
its embedded PostgreSQL (and, separately, against an external one), the data
directory contents, and where the native addon gets extracted. The scripts only
need the binary copied in.

Cross-check the artifact itself:

```
file dist/bin/moleculer-sidecar-next-win-x64.exe      # PE32+ executable (console) x86-64
ldd  dist/bin/moleculer-sidecar-next-linux-x64        # no node dependency
```
