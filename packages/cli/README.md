# @kunlun-js/cli

The `kunlun` command creates projects and orchestrates build engines and runtimes. pnpm owns
dependency resolution, workspace linking, lockfiles, and package scripts.

> Status: the repository default branch declares v0.2.0 as an unreleased source preview. The
> versioned generator and the `install`, `check`, and `test` commands belong to the v0.3 plan and do
> not exist in the current CLI.

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

`new` is an alias for `create`. Select another first-party adapter with `--builder vite`,
`--builder webpack`, or `--builder rspack`.

## Current commands

| Command | Behavior |
| --- | --- |
| `create <directory>` | Write the current fixed project scaffold. The destination must be empty. |
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

## Current creation boundary

The v0.2 source preview still writes a fixed client-and-Fetch-service scaffold. It prints `pnpm
install` as the next step but does not run it. Previewable versioned generator plans, collision-safe
plan execution, `--dry-run`, and `--json` are v0.3 work and must not be assumed from this README.

This package is part of [Kunlun Engine](https://github.com/kunlunengine/core), a project of Zixiao
Laboratories.
