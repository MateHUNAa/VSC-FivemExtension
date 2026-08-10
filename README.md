# Perfect FiveM

Resource-aware VS Code tooling for FiveM/Cfx.re Lua development: automatic client/server/shared
detection from `fxmanifest.lua`, context-scoped native IntelliSense, Explorer badges, and
exports/event IntelliSense across resources in the workspace.

## Features

- **Resource root detection** — every folder containing `fxmanifest.lua` (or the legacy
  `__resource.lua`) is indexed as a resource, kept up to date via file watchers.
- **Script context extraction** — `client_script(s)`, `server_script(s)`, `shared_script(s)`
  are parsed (globs, nested paths, comments, multi-line tables all handled) into a concrete
  file → `client` / `server` / `shared` map. A file listed under both client and server is
  treated as `shared`.
- **Context-aware native IntelliSense** — completion, hover and signature help for ~6,300 named
  FiveM/GTA natives, filtered to what's actually callable from the file you're editing.
- **Explorer decorations** — Lua files get a `C` / `S` / `SH` badge in the file tree, read
  straight from the precomputed index (no re-parsing on every repaint).
- **Exports & event IntelliSense** — `exports['resource']:method()` and `exports.resource:method()`
  both resolve to real completions sourced from that resource's `exports(...)` declarations
  anywhere in the workspace; event name completion inside `TriggerEvent`/`RegisterNetEvent`/etc.
- **Lightweight OOP completion** — `Table:Method()` / `Table.Method()` completion from
  `function Table:Method(...)` declarations elsewhere in the same resource (see below for how
  this relates to installing a real Lua language server, which is still the complete solution).
- **Diagnostics** — warns when a native, or a one-sided CitizenFX runtime event function
  (`TriggerClientEvent`, `TriggerServerEvent`, ...), is used on the wrong side.
- **RCON restart-on-save** — connect to your FiveM server's RCON and every file save
  automatically runs `refresh; ensure <resource>` for the *exact* resource that owns the saved
  file, using a native implementation of FiveM's RCON wire protocol (see below).

## 1. High-level architecture

```
ResourceScanner  --(roots, manifest/file-change events)-->  ContextIndex  --(file->context map)-->  FileDecorationProvider
      |                                                            |                                        Completion/Hover/SignatureHelp
      |                                                            +--> NativeContextDiagnostics
      +--(roots)--> ExportsIndexer --(exports/events per resource)--> ExportsCompletionProvider / EventNameCompletionProvider

NativesDatabase (loads data/natives.json once) --> shared by all native-facing providers
```

- `ResourceScanner` only answers "which folders are resources, and what changed" (manifest
  text vs. a `.lua` file being added/removed). It owns the `FileSystemWatcher`s.
- `ContextIndex` is the single source of truth: it parses each manifest, resolves script
  patterns to concrete files via `vscode.workspace.findFiles`, and maintains the flattened
  `file → {context, resource}` map every other feature reads from. It never re-parses on a
  read — only on the scanner's change events, and only for the affected resource.
- `NativesDatabase` loads the bundled, pre-normalized native list once at activation and
  answers by exact PascalCase Lua name or prefix — no per-keystroke I/O.
- `ExportsIndexer` scans each resource's `.lua` files for `exports(...)` declarations and
  event registrations, keyed by resource name, so `exports['other_resource']:` resolves even
  if `other_resource` was never opened in the editor.

## 2. Key data structures ([src/core/types.ts](src/core/types.ts))

```ts
type ScriptContext = 'client' | 'server' | 'shared';

interface ResourceRoot { uri, name, manifestUri, manifestKind }
interface ParsedManifest { resourceName, clientPatterns, serverPatterns, sharedPatterns, imports, malformed, errors }
interface FileContextEntry { context: ScriptContext, resource: ResourceRoot }
interface ExportEntry { name, params, resourceName, fileUri, line }
interface EventEntry  { name, resourceName, fileUri, line, kind }
```

`ContextIndex` keeps `Map<resourceFolderFsPath, {root, manifest, fileContexts}>` plus a
flattened `Map<fileFsPath, FileContextEntry>` for O(1) lookups from every consumer.

## 3. Implementation plan / critical pieces

- [src/core/manifestParser.ts](src/core/manifestParser.ts) — comment-stripping (quote-aware,
  handles `--`, `--[[ ]]`, `--[=[ ]=]`) plus a balanced-brace scanner that extracts every quoted
  string out of `key 'value'`, `key "value"` or `key { ... }` forms, regardless of newlines or
  trailing commas. Strings starting with `@` are routed to `imports` instead of file patterns.
- [src/core/glob.ts](src/core/glob.ts) — normalizes Cfx's glob dialect (notably bare `**.lua`)
  into a pattern VS Code's own glob engine accepts, so pattern matching reuses
  `vscode.workspace.findFiles` instead of a hand-rolled filesystem walker.
- [src/core/contextIndex.ts](src/core/contextIndex.ts) — `rebuildResource()` re-reads one
  manifest, resolves its three pattern lists in parallel, and diffs the previous file set
  against the new one before firing `onDidChangeContext` with only the changed URIs.
- [src/natives/nativesDatabase.ts](src/natives/nativesDatabase.ts) — converts native
  `SNAKE_CASE` names to the PascalCase Lua calling convention (`GET_ENTITY_COORDS` →
  `GetEntityCoords`) and indexes by that name.

## 4. How decorations and language features are wired together

All of it is glued in [src/extension.ts](src/extension.ts)'s `activate()`:

1. `ResourceScanner.initialScan()` finds every manifest, then `ContextIndex.initialBuild()` and
   `ExportsIndexer.initialBuild()` populate their maps (shown behind a window progress toast).
2. `ContextFileDecorationProvider` is registered via
   `vscode.window.registerFileDecorationProvider` and re-fires
   `onDidChangeFileDecorations` whenever `ContextIndex.onDidChangeContext` fires — it never
   touches disk itself.
3. `NativeCompletionProvider` / `NativeHoverProvider` / `NativeSignatureHelpProvider` are
   registered for the `lua` language selector. Completion looks up the active document's
   context via `ContextIndex.getFileContext(uri)` and filters `NativesDatabase` results with
   `isAllowedInContext()` — client/server files only ever see their own side (plus shared
   natives); shared files see everything, tagged with an `[apiset]` badge.
2. `ExportsCompletionProvider` triggers on `.`/`:` and matches `exports['x']:` or
   `exports.x:`/`exports.x.` in the line prefix; `EventNameCompletionProvider` triggers on
   quote characters inside `TriggerEvent(...)`-style calls. Both read from `ExportsIndexer`.
3. `NativeContextDiagnostics.refresh()` runs debounced (300 ms) on document open/edit and on
   `ContextIndex.onDidChangeContext` (a manifest edit can change what's "wrong" for a file
   without the file itself changing).

## 5. package.json contribution points

- `contributes.configuration` — `perfectFivem.*` settings (see below).
- `contributes.commands` — `perfectFivem.rescanWorkspace`, `perfectFivem.refreshNativesDatabase`,
  `perfectFivem.showResourceInfo`, and the `perfectFivem.rcon.*` commands below.
- File decorations and language providers (`CompletionItemProvider`, `HoverProvider`,
  `SignatureHelpProvider`) are registered **programmatically** in `activate()`, not declared in
  `package.json` — VS Code has no static contribution point for them.

## OOP / metatable completion (`Table:Method()`)

**Perfect FiveM does not do general Lua static analysis** — it has no parser, no scope
resolution, no type inference. Everything it knows about comes from pattern matching
(fxmanifest scripts, `exports(...)` calls, native names). That's a deliberate scope boundary,
not an oversight: real understanding of your own code's tables, metatables, and OOP-style
modules (`local Rpc = {}`, `function Rpc:Register(...)`) is what a full **Lua language server**
is for, and reimplementing one is a different project entirely.

**For real OOP/metatable completion, hover, and go-to-definition, install the actual language
server:** [`overextended.cfxlua-vscode`](vendor/cfxlua-vscode) from the VS Code Marketplace
(search "CfxLua IntelliSense"). It declares [`sumneko.lua`](https://marketplace.visualstudio.com/items?itemName=sumneko.lua)
(the LuaLS engine — see [vendor/lua-language-server](vendor/lua-language-server)) as an
extension dependency, so installing it pulls in the real language server automatically and
configures it for the Cfx Lua runtime. Install it in your normal VS Code (not inside the
Extension Development Host) — the dev host inherits your normally-installed extensions unless
launched with `--disable-extensions`, so it'll be picked up on the next `F5`. It runs
side by side with Perfect FiveM without conflict: cfxlua-vscode/LuaLS owns general Lua
understanding (including your `Table:Method()` completions with full accuracy), Perfect FiveM
layers FiveM-specific context (native filtering by client/server/shared, resource-aware exports,
restart-on-save, ...) on top. Both register completion providers for the same `lua` language
and VS Code just merges their suggestions.

**Perfect FiveM also ships a small, honestly-scoped complement to this**, useful even with the
real language server installed since it's aware of resource boundaries in a way a generic LSP
isn't: [src/oop/tableMethodIndexer.ts](src/oop/tableMethodIndexer.ts) scans a resource's Lua
files for `function Table:Method(...)` / `function Table.Method(...)` declarations (the same
regex-over-text approach as the exports indexer) and offers completion after `Table:` / `Table.`
anywhere else in that resource. There's no type inference — a table name match is all it takes,
so it can over-suggest if two unrelated tables in the same resource happen to share a name.
Toggle with `perfectFivem.oop.enable`.

## RCON restart-on-save

FiveM's RCON is *not* the Valve/Source-engine TCP RCON protocol — it's the older Quake3/GoldSrc
"out-of-band" UDP protocol: every packet is `\xFF\xFF\xFF\xFF` + a command name + a space-joined
payload + a trailing NUL byte, with the password sent inline on every request (no separate auth
handshake, no request/response IDs). [src/rcon/protocol.ts](src/rcon/protocol.ts) implements this
directly on top of Node's built-in `dgram` module — no third-party RCON dependency. The exact wire
format was cross-checked against [icecon](vendor/icecon) (a known-working native FiveM RCON
client) and its `go-q3net` dependency, and confirmed against a real running server during
development.

[src/rcon/rconManager.ts](src/rcon/rconManager.ts) resolves which resource to restart with
`ResourceScanner.getResourceForFile()` — the same manifest-driven detection used everywhere else
in this extension — so a save always restarts the one resource that actually owns the file, even
in a monorepo with dozens of resources. Multiple saves to the same resource within
`restartDelayMs` are coalesced into a single restart, and every restart *waits* for the server's
response (or logs a clear "no response" warning if none arrives within the timeout) instead of
firing and forgetting — UDP gives no other delivery guarantee, so this is what actually surfaces
a wrong password, wrong port, or unreachable server instead of failing silently.

The RCON password is stored in `vscode.SecretStorage` (OS keychain-backed), never in settings or
workspace state.

Commands: `perfectFivem.rcon.connect` (uses configured host/port, prompts for password once and
remembers it), `perfectFivem.rcon.connectCustom` (prompts for host:port + password), `.disconnect`,
`.toggleConnection` (bound to the status bar item), `.restartCurrentResource` (manual trigger for
the active file's resource), `.forgetPassword`.

Note that `connect()` itself is optimistic — UDP has no handshake to wait on, so the status bar
turning "Connected" only means the local socket opened, not that the password was verified. The
first actual restart is what proves the round trip works; check the "Perfect FiveM" Output
channel after saving a file if you're unsure.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `perfectFivem.resourceDetection.excludeGlobs` | `["**/node_modules/**", "**/.git/**", "**/vendor/**"]` | Folders skipped when scanning for manifests. |
| `perfectFivem.decorations.enable` | `true` | Explorer client/server/shared badges. |
| `perfectFivem.natives.enable` | `true` | Native completion/hover/signature help. |
| `perfectFivem.natives.databasePath` | `""` | Absolute path to a custom normalized `natives.json`; empty uses the bundled one. |
| `perfectFivem.natives.enableDiagnostics` | `true` | Wrong-side native warnings. |
| `perfectFivem.natives.deprecatedOverrides` | `[]` | Extra native names to flag as deprecated. |
| `perfectFivem.imports.enable` | `true` | Exports/event IntelliSense. |
| `perfectFivem.oop.enable` | `true` | Lightweight `Table:Method()` / `Table.Method()` completion from same-resource declarations. |
| `perfectFivem.rcon.enable` | `true` | RCON status bar item, commands, and restart-on-save. |
| `perfectFivem.rcon.host` | `"127.0.0.1"` | FiveM server RCON host. |
| `perfectFivem.rcon.port` | `30120` | FiveM server RCON port. |
| `perfectFivem.rcon.autoRestartOnSave` | `true` | Restart the saved file's owning resource automatically. |
| `perfectFivem.rcon.restartDelayMs` | `300` | Debounce window before sending the restart. |

## The natives database

`data/natives.json` is a normalized merge of the two official Cfx.re sources:

- `https://runtime.fivem.net/doc/natives.json` — the ~6.4k base GTA V/RAGE natives. This file
  does **not** carry official client/server tagging, so they default to `apiset: "client"`,
  which is correct for the large majority (they operate on the game world, which only exists
  client-side). This is a documented heuristic, not a guarantee — treat diagnostics against
  these as advisory.
- `https://runtime.fivem.net/doc/natives_cfx.json` — the ~940 Cfx-specific natives (exports,
  events, convars, state bags, entity creation, …), which **do** carry an authoritative
  `client` / `server` / `shared` tag. These are trusted as-is.

Run `npm run update-natives` to re-fetch and regenerate `data/natives.json`.

## Known limitations

- Diagnostics flag *known* natives used on the wrong side; they do not flag unknown/undefined
  identifiers, since that requires full static resolution of locals/requires and would produce
  false positives on ordinary user-defined functions.
- Dynamically-generated APIs (e.g. `ox_lib`'s `lib` global, built via a runtime metatable
  rather than a static `exports` table) are not introspected — only resources that use the
  standard `exports('name', fn)` / `exports.name = fn` pattern get automatic export
  completions today.
- FiveM's RCON protocol is unauthenticated-transport UDP with no encryption (same as Source
  engine RCON) — only point it at `127.0.0.1` or a server reachable over a trusted/VPN network,
  never over the open internet.
- The base natives' `client`-only default (see above) is a heuristic, not sourced data.

## Development

```
npm install
npm run compile   # or `npm run watch`
```

Press `F5` (or run the "Run Perfect FiveM Extension" launch config) to open an Extension
Development Host with the extension loaded.

## Testing

There's no automated test suite yet (see below) — testing today is manual, via the Extension
Development Host:

1. `npm install && npm run compile`
2. Press `F5`. A second VS Code window ("Extension Development Host") opens with the extension
   built from this repo active.
3. In that window, `File > Open Folder…` → [sample-workspace](sample-workspace) (bundled in this
   repo). It contains two fake resources (`test_resource`, `test_lib`) wired to exercise every
   feature:
   - **Resource detection & decorations** — the Explorer should badge `client/main.lua` `C`,
     `server/main.lua` `S`, `shared/config.lua` and `test_lib/init.lua` `SH`.
   - **Native completion/hover** — open `client/main.lua`, place the cursor after a partial
     native name (e.g. retype `GetEntityCoords`) to see completion; hover any native for docs.
   - **Wrong-side diagnostics** — both `client/main.lua` (`DropPlayer`, server-only) and
     `server/main.lua` (`DrawRect`, client-only) contain an intentional misuse; both should show
     a warning squiggle.
   - **Exports IntelliSense** — in `client/main.lua`, retype `exports['test_lib']:` to see `add`
     and `multiply` completions sourced from `test_lib/init.lua`.
   - **Event completion** — retype the string argument in `TriggerServerEvent('test:ping')` to
     see event-name completion.
   - **`Perfect FiveM: Show Resource Info for Current File`** (Command Palette) — sanity-checks
     context/manifest/import detection for whichever file is active.
   - **RCON** — needs a real FiveM server (see the "RCON restart-on-save" section above); point
     `perfectFivem.rcon.host`/`port` at it, run `Perfect FiveM: RCON Connect`, then edit+save any
     file in `test_resource` and confirm the server console shows it being refreshed/ensured.
4. Check the "Perfect FiveM" Output channel (`View > Output`) for scan/load logs and warnings.

Adding real automated tests (`@vscode/test-electron` + a runner) is a reasonable next step but
isn't set up yet.
