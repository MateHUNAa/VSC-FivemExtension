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
- **Context-aware native IntelliSense** — completion, hover and signature help for ~7,300
  FiveM/GTA natives, filtered to what's actually callable from the file you're editing.
- **Explorer decorations** — Lua files get a `C` / `S` / `SH` badge in the file tree, read
  straight from the precomputed index (no re-parsing on every repaint).
- **Exports & event IntelliSense** — `exports['resource']:method()` and `exports.resource:method()`
  both resolve to real completions sourced from that resource's `exports(...)` declarations
  anywhere in the workspace; event name completion inside `TriggerEvent`/`RegisterNetEvent`/etc.
- **Diagnostics** — warns when a native is used on the wrong side (e.g. a server-only native
  called from a client script).
- **RCON restart-on-save** — connect to your FiveM server's RCON and every file save
  automatically runs `refresh; ensure <resource>` for the *exact* resource that owns the saved
  file (ports and improves on [vendor/fivem-devbridge](vendor/fivem-devbridge)'s approach — see
  below).

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

## RCON restart-on-save

[vendor/fivem-devbridge](vendor/fivem-devbridge) connects to the server's RCON (via the `rcon`
npm package in UDP mode, matching FiveM's RCON dialect — `{ tcp: false, challenge: false }`) and
on every save sends `refresh; ensure <resource>`, but it has to guess which resource that is: either
every top-level workspace folder, or one folder you set manually via a command. `src/rcon/` ports
the same RCON mechanics but resolves the resource with `ResourceScanner.getResourceForFile()` —
the same manifest-driven detection used everywhere else in this extension — so a save always
restarts the one resource that actually owns the file, even in a monorepo with dozens of
resources. Multiple saves to the same resource within `restartDelayMs` are coalesced into a
single restart.

Other differences from the vendor extension: the RCON password is stored in
`vscode.SecretStorage` (OS keychain-backed) instead of plain `workspaceState`, and the status
bar item uses a built-in codicon instead of a bundled icon font.

Commands: `perfectFivem.rcon.connect` (uses configured host/port, prompts for password once and
remembers it), `perfectFivem.rcon.connectCustom` (prompts for host:port + password), `.disconnect`,
`.toggleConnection` (bound to the status bar item), `.restartCurrentResource` (manual trigger for
the active file's resource), `.forgetPassword`.

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
