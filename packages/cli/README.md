# @kunlun-js/cli

The `kunlun` command creates projects and orchestrates build engines and runtimes. pnpm owns
dependency resolution, workspace linking, lockfiles, and package scripts.

> Status: the repository default branch declares v0.2.0 as an unreleased source preview. The
> [v0.3 Slice A foundation](../../docs/plans/v0.3-slices.md#slice-a--inspectable-creation) is in
> progress: versioned creation wraps the existing client-and-Fetch-service scaffold, not the
> full-stack v0.2 reference app. The v0.2 entry gate remains incomplete. `install`, `check`, and
> `test` remain planned commands.

## Run the source preview

```bash
corepack pnpm install
corepack pnpm build
node packages/cli/dist/cli.js --version
node packages/cli/dist/cli.js engines
```

Create a project with the default Nasti builder:

```bash
node packages/cli/dist/cli.js create ../hello-kunlun
cd ../hello-kunlun
pnpm install
pnpm dev
```

`new` is an exact compatibility alias for `create`. Select another first-party adapter with `--builder vite`,
`--builder webpack`, or `--builder rspack`.

Preview the files and next commands without creating the destination:

```bash
node packages/cli/dist/cli.js create ../hello-kunlun --builder vite --dry-run --json
```

## Current commands

| Command | Behavior |
| --- | --- |
| `create <directory> [--builder nasti\|vite\|webpack\|rspack] [--dry-run] [--json]` | Plan or write the first-party client-and-Fetch-service scaffold. |
| `new <directory>` | Compatibility alias for `create`. |
| `dev` | Start every selected build target and the application runtime; stop on SIGINT or SIGTERM. |
| `build` | Build selected targets and write `.kunlun/application-manifest.json`. |
| `start` | Start only the configured application runtime in production mode. |
| `doctor` | Validate Node.js, config loading, selected builder/runtime, and build targets. |
| `engines` | Print the capabilities advertised by each first-party build adapter. |
| `version`, `--version`, `-v` | Print the CLI version. |
| `help`, `--help`, `-h` | Print command help. |

Current options are command-specific:

- `--builder <name>` selects `nasti`, `vite`, `webpack`, or `rspack` during project creation.
- `--dry-run` validates creation inputs and produces a plan without mkdir, writes, process launches,
  network calls, or listeners.
- `--json` selects creation-only machine output; it does not add machine-readable operations to
  other commands.
- `--root <directory>` sets the project root for project commands.
- `--config <file>` loads an explicit config relative to the project root.
- `--target <name>` limits `dev` or `build` to one configured target.
- `--port <number>` sets the first build-target port in `dev` or the runtime port in `start`.
- `--runtime-port <number>` sets the application runtime port in `dev`.

Both `--name value` and `--name=value` forms are accepted by the current option parser. Ports range
from 0 through 65535; port 0 asks the operating system to select an available port.

## Configuration discovery

Unless `--config` is present, the CLI looks for `kunlun.config.mjs` and then
`kunlun.config.js` in the project root. The module must have a default export accepted by
`defineConfig()` from `@kunlun-js/core`.

`dev` uses the configured runtime or the Node.js reference runtime. Its runtime port defaults to
one port after the configured build targets, and development CORS defaults to enabled. `start`
defaults to port 3000. Both commands keep running until a shutdown signal arrives.

## Creation foundation contract (in progress)

The first-party template is `@kunlun-js/client-fetch` version `1.0.0`, using protocol
`kunlun.generator/v1`. This identifies the existing scaffold, not a published template package or
the full-stack reference app. Protocol types and plans are preview contracts; remote templates
and a custom generator API are not available yet.

Builder-specific dependency edits include the selected adapter's development peers, including
`webpack-dev-middleware` or `@rspack/dev-middleware` when those builders are selected.

Successful `--json` creation prints exactly one `kunlun.generator-plan/v1` JSON object: `schema`,
generator identity/protocol/version, absolute destination, project name/builder/packageManager,
sorted planned files (`path`, `contents`), dependency edits (`dependencies.dependencies` and
`dependencies.devDependencies`), and `nextCommands`
(`cwd`, `command`, `args`). Real creation writes the same plan and prints it only after successful
completion. `create` never runs pnpm; installation and the listed next commands are explicit user
steps.

Plans have no timestamps or generated IDs. To compare equivalent plans on different machines,
replace only `destination` and each `nextCommands[].cwd` with a fixture token. The package name is
derived from the destination basename, so use the same basename for an equivalent invocation.
Boolean flags accept `--dry-run` and `--json`, not `--dry-run=true` or `--json=true`.

Creation errors with `--json` print one `kunlun.generator-diagnostic/v1` object containing
`schema`, `code`, `message`, and `remediation`, with exit status 1 and no prose mixed into stdout.
Human errors carry the same code and remediation.

| Diagnostic code | Meaning |
| --- | --- |
| `KUNLUN_CREATE_ARGUMENT_INVALID` | Missing/extra destination or malformed/unknown creation option. |
| `KUNLUN_CREATE_BUILDER_UNKNOWN` | Builder is not one of the four first-party choices. |
| `KUNLUN_CREATE_DESTINATION_INVALID` | Invalid path/package name, file/symlink destination, or unusable ancestor. |
| `KUNLUN_CREATE_DESTINATION_NOT_EMPTY` | Existing project content would collide with creation. |
| `KUNLUN_CREATE_TEMPLATE_INVALID` | A first-party template contains an unsafe or colliding file path. |
| `KUNLUN_CREATE_WRITE_FAILED` | Execution failed; inspect permissions and any partial output before retrying. |

Non-empty directories, files, symlink destinations, and invalid ancestors fail before writing.
Normal symlinked parent paths are allowed; this is not a sandbox. The executor revalidates the
destination and creates files exclusively, but is not transactional: interrupted or I/O-failed
writes may leave partial output. Neither rollback nor atomic race protection is promised.

`planProjectCreation({ destination, builder?, cwd? })` is also exported from `@kunlun-js/cli`.
It returns the same read-only plan without writing; library callers receive `GeneratorError`
with a `diagnostic` property rather than a process exit. There is no public arbitrary-plan executor
or template loader in this slice.

Foundation validation covers the packed CLI's planning, creation, and diagnostics, not the
full-stack application's `dev -> build -> start` lifecycle or completion of Slice A.

Run `pnpm test:cli:packages` from the repository root to build, pack, and test the installed CLI
in a fresh consumer. Its preload guard rejects writes during previews and rejects process,
network, or listener startup during all creation tests. Separate smoke tests install the generated
Webpack/Rspack legacy scaffolds and open/close development sessions to verify middleware peers;
they do not exercise the full-stack reference-app lifecycle.

## Planned delivery

The [repository roadmap](../../ROADMAP.md) tracks v0.1 through v1.0 independently of native
runtime M0–M6. The [v0.3 slices](../../docs/plans/v0.3-slices.md) add the versioned generator,
pinned pnpm lifecycle orchestration, and dry-run/JSON contracts. v0.4 adds portable artifacts and
runtime negotiation. The proposed [v0.5–v1.0 plan](../../docs/plans/cli-v0.5-v1.0.md) then adds
migration, library packaging, expanded checks, workspace tasks/local cache, verified toolchain
management, and stable compatibility/support gates.

Those documents are future scope, not additional current commands. `migrate`, `pack`, `run`,
`toolchain`, and `inspect` must not be inferred to exist from the planning command names.

This package is part of [Kunlun Engine](https://github.com/kunlunengine/core), a project of Zixiao
Laboratories.
