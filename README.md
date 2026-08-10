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
  treated as `shared`. Files not listed at all are followed one more hop: `require(...)` calls
  in declared scripts are resolved (dotted or slashed module paths, same-resource only) so
  transitively-loaded modules inherit a context too, converging to `shared` the same way if
  reachable from both sides.
- **Context-aware native IntelliSense** — completion, hover and signature help for ~6,300 named
  FiveM/GTA natives, filtered to what's actually callable from the file you're editing.
- **Explorer decorations** — Lua files get a `C` / `S` / `SH` badge in the file tree, read
  straight from the precomputed index (no re-parsing on every repaint).
- **Required-file detection** — files never listed in `fxmanifest.lua` but pulled in
  transitively via `require(...)` from a declared script get an `R` badge instead, with their
  client/server/shared context still resolved (inherited from whichever script(s) require them)
  so native diagnostics keep working on them too.
- **Exports & event IntelliSense** — `exports['resource']:method()` and `exports.resource:method()`
  both resolve to real completions sourced from that resource's `exports(...)` declarations
  anywhere in the workspace; event name completion inside `TriggerEvent`/`RegisterNetEvent`/etc.
- **Go-to-definition & hover for exports/events** — F12 (or Ctrl+click) on an
  `exports['resource']:method()` call jumps straight to its `exports(...)` declaration. Events work
  in **both directions**: on an event-name string inside `TriggerEvent`/`TriggerServerEvent`/
  `TriggerClientEvent`/etc. it jumps to every `RegisterNetEvent`/`AddEventHandler` that handles it;
  standing on the `RegisterNetEvent`/`AddEventHandler` itself instead jumps to every call site that
  triggers it. Either direction can resolve to more than one location (e.g. a client and a server
  handler for the same event name), in which case VS Code shows its normal multi-location peek
  list. Hovering either side shows the same info inline without jumping.
- **"N triggers" / "N handlers" CodeLens** — every `RegisterNetEvent`/`AddEventHandler` line gets a
  clickable CodeLens counting how many `TriggerEvent`-family call sites fire it (and the matching
  `TriggerEvent`/`TriggerServerEvent`/etc. line gets one counting its handlers), so the list is
  visible without first knowing to invoke go-to-definition. Clicking it opens VS Code's built-in
  references peek view with every location one click away. A line with zero matches on the other
  side gets no lens at all, rather than a misleading "0" (this is a regex-based index, not a
  guarantee nothing calls it). Toggle with `perfectFivem.imports.enableEventCodeLens`.
- **Workspace symbol search** — every indexed export and event shows up in "Go to Symbol in
  Workspace…" (Ctrl+T), so you can jump to one by name without knowing which resource declares it.
- **Rename exports & events** — F2 on an export's declaration or any `exports[...]:name()` call
  site renames it everywhere in the workspace in one edit (the declaration plus every call site,
  even across resources). F2 on an event-name string renames that literal everywhere it's used,
  across every `RegisterNetEvent`/`AddEventHandler`/`TriggerEvent`/`TriggerServerEvent`/
  `TriggerClientEvent`/`TriggerLatent*Event` call in the workspace.
- **Lightweight OOP completion** — `Table:Method()` / `Table.Method()` completion from
  `function Table:Method(...)` declarations elsewhere in the same resource (see below for how
  this relates to installing a real Lua language server, which is still the complete solution).
- **Diagnostics** — warns when a native, or a one-sided CitizenFX runtime event function
  (`TriggerClientEvent`, `TriggerServerEvent`, ...), is used on the wrong side.
- **Quick fixes** — a wrong-side `TriggerServerEvent`/`TriggerClientEvent`/`TriggerLatent*Event`
  warning offers a one-click fix to swap it for the correct counterpart; any of this extension's
  diagnostics can also be suppressed on just that line (adds a trailing
  `-- perfectfivem-ignore` comment, which the diagnostics pass itself respects).
- **RCON restart-on-save** — connect to your FiveM server's RCON and every file save
  automatically runs `refresh; ensure <resource>` for the *exact* resource that owns the saved
  file, using a native implementation of FiveM's RCON wire protocol (see below).

## 1. High-level architecture

```
ResourceScanner  --(roots, manifest/file-change events)-->  ContextIndex  --(file->context map)-->  FileDecorationProvider
      |                                                            |                                        Completion/Hover/SignatureHelp
      |                                                            +--> NativeContextDiagnostics --> NativeQuickFixProvider
      +--(roots)--> ExportsIndexer --(exports/events per resource)--> ExportsCompletionProvider / EventNameCompletionProvider
                                                                   +--> ExportsEventsDefinitionProvider / ExportsEventsHoverProvider
                                                                   +--> ImportsWorkspaceSymbolProvider
                                                                   +--> ImportsEventCodeLensProvider
                                                                   +--> ImportsRenameProvider (also scans the whole workspace directly)

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

## 2. Key data structures (`src/core/types.ts`)

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

- `src/core/manifestParser.ts` — comment-stripping (quote-aware,
  handles `--`, `--[[ ]]`, `--[=[ ]=]`) plus a balanced-brace scanner that extracts every quoted
  string out of `key 'value'`, `key "value"` or `key { ... }` forms, regardless of newlines or
  trailing commas. Strings starting with `@` are routed to `imports` instead of file patterns.
- `src/core/glob.ts` — normalizes Cfx's glob dialect (notably bare `**.lua`)
  into a pattern VS Code's own glob engine accepts, so pattern matching reuses
  `vscode.workspace.findFiles` instead of a hand-rolled filesystem walker.
- `src/core/contextIndex.ts` — `rebuildResource()` re-reads one
  manifest, resolves its three pattern lists in parallel, and diffs the previous file set
  against the new one before firing `onDidChangeContext` with only the changed URIs.
- `src/natives/nativesDatabase.ts` — converts native
  `SNAKE_CASE` names to the PascalCase Lua calling convention (`GET_ENTITY_COORDS` →
  `GetEntityCoords`) and indexes by that name.

## 4. How decorations and language features are wired together

All of it is glued in `src/extension.ts`'s `activate()`:

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
  `SignatureHelpProvider`, `DefinitionProvider`, `WorkspaceSymbolProvider`, `RenameProvider`,
  `CodeActionProvider`) are registered **programmatically** in `activate()`, not declared in
  `package.json` — VS Code has no static contribution point for them.

## OOP / metatable completion (`Table:Method()`)

**Perfect FiveM does not do general Lua static analysis** — it has no parser, no scope
resolution, no type inference. Everything it knows about comes from pattern matching
(fxmanifest scripts, `exports(...)` calls, native names). That's a deliberate scope boundary,
not an oversight: real understanding of your own code's tables, metatables, and OOP-style
modules (`local Rpc = {}`, `function Rpc:Register(...)`) is what a full **Lua language server**
is for, and reimplementing one is a different project entirely.

**For real OOP/metatable completion, hover, and go-to-definition, install the actual language
server:** `overextended.cfxlua-vscode` from the VS Code Marketplace
(search "CfxLua IntelliSense"). It declares [`sumneko.lua`](https://marketplace.visualstudio.com/items?itemName=sumneko.lua)
(the LuaLS engine — see `vendor/lua-language-server`) as an
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
isn't: `src/oop/tableMethodIndexer.ts` scans a resource's Lua
files for `function Table:Method(...)` / `function Table.Method(...)` declarations (the same
regex-over-text approach as the exports indexer) and offers completion after `Table:` / `Table.`
anywhere else in that resource. There's no type inference — a table name match is all it takes,
so it can over-suggest if two unrelated tables in the same resource happen to share a name.
Toggle with `perfectFivem.oop.enable`.

**Cross-resource "proxy global" completion.** Some core frameworks hand consuming resources a
single global (e.g. `LS`, `qbx`, `lib`) via a file loaded with
`shared_script '@core_resource/init.lua'`, where the table's methods
(`function LS:RegisterModule(...)`) are declared *inside that imported file*, not in the resource
you're actually editing — so the same-resource-only scan above finds nothing. When a resource's
manifest declares an `@resource/path` import, `TableMethodCompletionProvider` now also checks the
imported resource for a matching `function <TableName>:...` declaration. If one is found (which
confirms the global really does live there, avoiding blind cross-resource guessing), it also
merges in that resource's `exports(...)` entries from `ExportsIndexer` — since these proxy
globals typically forward any unrecognized call straight to their own exports (this is exactly
how `ls_core`'s `LS` object works: `LS:SomeExport(...)` falls through its `__index`/`__call`
metatable to `exports.ls_core.SomeExport(...)`). Purely dynamic members — properties assigned at
runtime (`LS.PlayerData = ...`) or modules loaded through a runtime registry rather than a static
`function Table:Method()` declaration — are still outside this pattern-based approach; that part
of the "known limitations" below still applies.

As a last-resort discovery aid for exactly that dynamic case, once an imported table source is
confirmed, `TableMethodCompletionProvider` also lists subfolders of that resource's `modules/`
directory that aren't already covered by a real method/export match — plain names with no
signature, sorted after the real completions, clearly labeled "not yet loaded/typed" — so a
module that's never been used anywhere yet (and therefore has zero static footprint for either
this extension or a real language server to find) still shows up as *something exists here*. The
real, permanent fix for that class of module is EmmyLua type annotations in the framework itself
(a `---@class` per module, referenced from a stub next to the proxy global) — that's what gives a
real language server full hover/signature/type info; this extension's own discovery aid is only a
fallback for what isn't annotated (yet).

## Exports & events: definition, hover, workspace symbols, CodeLens, rename

All five features build on the same two building blocks already used by completion:
`ExportsIndexer`'s per-resource declaration lists, and three small position-aware detectors added
to `src/imports/importParser.ts` (`findExportsCallAt`, `findExportDeclarationAt`,
`findEventLiteralAt`) that, given a line of text and a cursor offset, report whether the cursor
sits inside an export call/declaration or an event-name string literal — and the exact offset
range of just that name, not the whole call.

`EventEntry.kind` is `'register'` for `RegisterNetEvent`/`AddEventHandler` and `'trigger'` for the
`TriggerEvent` family - `ExportsIndexer` indexes both per resource (previously only registrations
were indexed, since only completion needed them). `findEventLiteralAt` also reports which kind the
cursor is on, so `ExportsEventsDefinitionProvider`/`ExportsEventsHoverProvider`
(`src/imports/importDefinitionHoverProvider.ts`) can look up the *opposite* kind and work
symmetrically: standing on a trigger call resolves to its handler(s), standing on a handler
resolves to its trigger call site(s). `ImportsEventCodeLensProvider`
(`src/imports/importEventCodeLensProvider.ts`) surfaces the same opposite-kind lookup as an
always-visible "N triggers"/"N handlers" CodeLens (skipped entirely at zero, rather than showing a
possibly-misleading "0"), wired to VS Code's built-in `editor.action.showReferences` peek command
so clicking it opens the same multi-location list `provideDefinition` would. `ImportsWorkspaceSymbolProvider`
(`src/imports/importWorkspaceSymbolProvider.ts`) only surfaces `'register'`-kind entries as
symbols — a symbol per trigger call site would just be noise, and those are already one click away
via go-to-definition/CodeLens. All of the above are thin reads over the existing index — no new
scanning.

`ImportsRenameProvider` (`src/imports/importRenameProvider.ts`) is the one exception: a rename can
touch call sites in resources `ExportsIndexer` never associates with each other, so
`provideRenameEdits` does its own `vscode.workspace.findFiles('**/*.lua', ...)` scan (honoring
`perfectFivem.resourceDetection.excludeGlobs`) independent of the index, builds a single
`WorkspaceEdit` covering every file, and lets VS Code apply it atomically:

- **Export rename** — the declaration (`exports('name', ...)` / `exports.name = function`) is
  only searched for inside the owning resource's own files; call sites
  (`exports['resource']:name(...)` / `exports.resource:name(...)` / `exports.resource.name(...)`)
  are searched for across the whole workspace, since any resource can call into any other. The new
  name must be a valid Lua identifier.
- **Event rename** — FiveM events aren't namespaced by resource (they're just string keys), so
  every `RegisterNetEvent`/`AddEventHandler`/`TriggerEvent`/`TriggerServerEvent`/
  `TriggerClientEvent`/`TriggerLatent*Event` call anywhere in the workspace whose string argument
  matches gets updated, regardless of which resource it's in. The new name just can't be empty or
  contain a quote character (colons, e.g. `esx:playerLoaded`, are normal and allowed).

Like the rest of the extension, this is regex-over-text, not a real parser — a rename can't tell a
genuine call from a coincidentally identical string sitting in a comment or an unrelated context.

## RCON restart-on-save

FiveM's RCON is *not* the Valve/Source-engine TCP RCON protocol — it's the older Quake3/GoldSrc
"out-of-band" UDP protocol: every packet is `\xFF\xFF\xFF\xFF` + a command name + a space-joined
payload + a trailing NUL byte, with the password sent inline on every request (no separate auth
handshake, no request/response IDs). `src/rcon/protocol.ts` implements this
directly on top of Node's built-in `dgram` module — no third-party RCON dependency. The exact wire
format was cross-checked against `icecon` (a known-working native FiveM RCON
client) and its `go-q3net` dependency, and confirmed against a real running server during
development.

`src/rcon/rconManager.ts` resolves which resource to restart with
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
| `perfectFivem.decorations.enable` | `true` | Explorer client/server/shared/required badges. |
| `perfectFivem.natives.enable` | `true` | Native completion/hover/signature help. |
| `perfectFivem.natives.databasePath` | `""` | Absolute path to a custom normalized `natives.json`; empty uses the bundled one. |
| `perfectFivem.natives.enableDiagnostics` | `true` | Wrong-side native warnings. |
| `perfectFivem.natives.deprecatedOverrides` | `[]` | Extra native names to flag as deprecated. |
| `perfectFivem.imports.enable` | `true` | Exports/event IntelliSense, go-to-definition/hover, workspace symbols, rename. |
| `perfectFivem.imports.enableEventCodeLens` | `true` | "N triggers"/"N handlers" CodeLens above event calls. |
| `perfectFivem.oop.enable` | `true` | Lightweight `Table:Method()` / `Table.Method()` completion from same-resource declarations. |
| `perfectFivem.rcon.enable` | `true` | RCON status bar item, commands, and restart-on-save. |
| `perfectFivem.rcon.host` | `"127.0.0.1"` | FiveM server RCON host. |
| `perfectFivem.rcon.port` | `30120` | FiveM server RCON port. |
| `perfectFivem.rcon.autoRestartOnSave` | `true` | Restart the saved file's owning resource automatically. |
| `perfectFivem.rcon.restartDelayMs` | `300` | Debounce window before sending the restart. |

Badge colors (client/server/shared/required) are theme colors, not settings — customize them via
`workbench.colorCustomizations` in `settings.json`, or run **Preferences: Customize Colors**
from the Command Palette for a live color picker:

```json
"workbench.colorCustomizations": {
  "perfectFivem.decorations.clientColor": "#3794FF",
  "perfectFivem.decorations.serverColor": "#E78AFF",
  "perfectFivem.decorations.sharedColor": "#B180D7",
  "perfectFivem.decorations.requiredColor": "#CC9944"
}
```

The server badge defaults to pink/magenta (`#E78AFF`); the required badge defaults to orange
(theme `charts.orange`).

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
- `require(...)` resolution only follows same-resource module paths (`require('a.b.c')` →
  `<resource>/a/b/c.lua`); `require('@other_resource/...')` cross-resource requires aren't
  resolved, so those files won't get the `R` badge or an inherited context.
- The require graph is re-resolved on file save (and file add/delete), not on every keystroke -
  edit a `require(...)` call and save to see the badge update.
- Dynamically-generated APIs (e.g. `ox_lib`'s `lib` global, built via a runtime metatable
  rather than a static `exports` table) are not introspected — only resources that use the
  standard `exports('name', fn)` / `exports.name = fn` pattern get automatic export
  completions today.
- FiveM's RCON protocol is unauthenticated-transport UDP with no encryption (same as Source
  engine RCON) — only point it at `127.0.0.1` or a server reachable over a trusted/VPN network,
  never over the open internet.
- The base natives' `client`-only default (see above) is a heuristic, not sourced data.
- Rename (F2) and the "Ignore this warning" quick fix are regex-over-text like everything else
  here: a rename can't distinguish a genuine call from the same text appearing in a comment or
  string, and event rename in particular touches the whole workspace since FiveM events aren't
  resource-scoped. Review the proposed edit set (VS Code shows a diff preview before applying)
  rather than trusting it blindly on a large workspace.

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
3. In that window, `File > Open Folder…` → `sample-workspace` (bundled in this
   repo). It contains two fake resources (`test_resource`, `test_lib`) wired to exercise every
   feature:
   - **Resource detection & decorations** — the Explorer should badge `client/main.lua` `C`,
     `server/main.lua` `S`, `shared/config.lua` and `test_lib/init.lua` `SH`.
   - **Required-file detection** — `server/modules/kick_reason.lua` isn't listed in
     `fxmanifest.lua` (only `server/*.lua` is, which doesn't match nested paths); it's only
     reachable via the `require('server.modules.kick_reason')` call in `server/main.lua`, so it
     should badge `R` instead of `S`.
   - **Native completion/hover** — open `client/main.lua`, place the cursor after a partial
     native name (e.g. retype `GetEntityCoords`) to see completion; hover any native for docs.
   - **Wrong-side diagnostics** — both `client/main.lua` (`DropPlayer`, server-only) and
     `server/main.lua` (`DrawRect`, client-only) contain an intentional misuse; both should show
     a warning squiggle.
   - **Exports IntelliSense** — in `client/main.lua`, retype `exports['test_lib']:` to see `add`
     and `multiply` completions sourced from `test_lib/init.lua`.
   - **Event completion** — retype the string argument in `TriggerServerEvent('test:ping')` to
     see event-name completion.
   - **Go-to-definition & hover** — in `client/main.lua`, F12 (or hover) on `add`/`multiply` in
     `exports['test_lib']:add(...)` jumps to (or previews) the matching `exports(...)` in
     `test_lib/init.lua`; F12 on `'test:ping'` inside `TriggerServerEvent` jumps to its
     `RegisterNetEvent('test:ping')` handler in `server/main.lua` — and, the other direction, F12 on
     `'test:ping'` inside that `RegisterNetEvent` jumps back to the `TriggerServerEvent` call site.
   - **Event CodeLens** — confirm `RegisterNetEvent('test:ping')` in `server/main.lua` shows a
     "1 trigger" CodeLens above it, and `TriggerServerEvent('test:ping')` in `client/main.lua` shows
     a "1 handler" CodeLens; click either to open the references peek list and jump across.
   - **Workspace symbols** — Ctrl+T, type `add` or `test:ping`, confirm the export/event shows up
     with `test_lib`/`test_resource` as its container.
   - **Rename** — F2 on `add` in `test_lib/init.lua`'s `exports('add', ...)` declaration, rename
     to something else, and confirm the `exports['test_lib']:add(...)` call site in
     `client/main.lua` updates too, in the same edit.
   - **Quick fixes** — swap `TriggerServerEvent`/`TriggerClientEvent` for the wrong side in one of
     the sample files to trigger the wrong-side warning, then use the lightbulb / Ctrl+. menu to
     confirm both the "Change to '...'" swap fix and the "Ignore this warning on this line" fix
     are offered and work.
   - **`Perfect FiveM: Show Resource Info for Current File`** (Command Palette) — sanity-checks
     context/manifest/import detection for whichever file is active.
   - **RCON** — needs a real FiveM server (see the "RCON restart-on-save" section above); point
     `perfectFivem.rcon.host`/`port` at it, run `Perfect FiveM: RCON Connect`, then edit+save any
     file in `test_resource` and confirm the server console shows it being refreshed/ensured.
4. Check the "Perfect FiveM" Output channel (`View > Output`) for scan/load logs and warnings.

Adding real automated tests (`@vscode/test-electron` + a runner) is a reasonable next step but
isn't set up yet.
