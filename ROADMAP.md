# Kunlun Engine Core Roadmap

Status date: 2026-10-06

This roadmap covers the `kunlunengine/core` repository. Version numbers describe repository-wide
development lines and capability gates, not calendar promises; individual `@kunlun-js` packages
may version independently while the public contracts are still pre-1.0.

The CLI planning sequence is **v0.1 → v0.2 → v0.3 → v0.4 → v0.5 → v1.0**. The v0.5 and v1.0
sections are proposed scope added to complete the runtime discussion “更新 CLI 版本目标与规划”;
they are not previously approved runtime release gates or claims of implemented functionality.
The [detailed CLI plan](./docs/plans/cli-v0.5-v1.0.md) records the workflow baseline, delivery
slices, ownership, and release evidence. CLI/Core versions and runtime M0–M6 remain separate tracks.

## Starting point

The v0.1 release established explicit application, route, service, and capability definitions; a
bundler-neutral `BuildEngine` contract; first-party Nasti, Vite, Webpack, and Rspack adapters; a
Fetch-based runtime contract and Node.js reference runtime; and a thin `kunlun` CLI.

Three rules continue through v1.0:

1. Conventions compile into inspectable core contracts instead of creating a second application
   model.
2. Build engines and runtimes report real capabilities; Kunlun does not claim false parity.
3. Capability declarations describe requested authority, not a complete security sandbox.

## v0.2 — Runnable full-stack foundation (in progress)

**Goal:** turn the `@kunlun-js/next` design preview into the smallest complete, testable full-stack
application path.

### Planned outcomes

- Discover and validate `app/` pages, nested layouts, dynamic segments, and Fetch route handlers.
- Compile filesystem conventions into `@kunlun-js/core` services, routes, manifests, and
  client/server build targets.
- Define the first React renderer contract, including server rendering and an explicit,
  serializable client hydration boundary.
- Prevent server-only modules and capability-bearing code from entering browser output, with
  actionable build diagnostics when a boundary is crossed.
- Run `new -> dev -> build -> start` through the existing CLI and Node.js reference runtime,
  with Nasti as the reference engine and capability-aware behavior for other adapters.
- Ship one end-to-end example and test it from packed workspace artifacts rather than unpublished
  source aliases.
- Publish contribution, governance, security-reporting, and release-process basics so new
  maintainers can participate without private context.

### Exit gate

A newly generated application with a layout, a dynamic page, a hydrated client component, and a
Fetch route handler passes development, production-build, startup, and capability-boundary tests.
The generated server bundle runs on `runtime-node`, and every supported builder either passes the
declared contract or reports a precise unsupported capability.

### Not in v0.2

- Drop-in Next.js application, plugin, or deployment compatibility.
- A broad caching, mutation, or React Server Components compatibility surface.
- A production security claim for untrusted third-party code.

## v0.3 — Coherent daily development workflow (planned)

**Goal:** make the full-stack path productive enough for sustained application development and
third-party contribution.

The work is divided into capability slices rather than package-version increments. The detailed
[v0.3 delivery plan](./docs/plans/v0.3-slices.md) defines their order, dependencies, acceptance
criteria, and explicit deferrals. Planning can proceed during v0.2, but implementation may only
rely on full-stack behavior that has passed the v0.2 exit gate.

### Planned outcomes

- Replace the fixed `kunlun new` writer with a versioned generator protocol and first-party
  templates; retain `new` as a compatibility alias for `create`.
- Complete a coherent `create`, `install`, `dev`, `check`, `test`, `build`, `start`, and `doctor`
  command surface while continuing to delegate package resolution to pnpm.
- Add machine-readable plans and diagnostics (`--dry-run` and `--json`) for generators, builds,
  runtime selection, and CI.
- Make route, layout, error, loading, metadata, and server/client invalidation behavior explicit
  and covered by development/production conformance fixtures.
- Improve fast-refresh or full-reload behavior across build adapters according to each engine's
  advertised HMR, transform, and SSR-module capabilities.
- Document supported extension points for generators, route compilation, rendering, and build
  adapters, with compatibility tests for each public hook.
- Establish performance budgets for cold start, incremental rebuild, route discovery, and the
  generated client payload; publish measurements instead of marketing-only claims.

### Exit gate

The same reference application can be created, checked, tested, developed, built, and started from
one CLI; source edits produce deterministic refresh or a clear fallback; and all public extension
hooks have fixtures, lifecycle documentation, and failure diagnostics.

## v0.4 — Portable server artifacts and runtime integration (planned)

**Goal:** make a built Kunlun application portable across the Node.js reference runtime and the
native JavaScriptCore runtime without changing application source.

### Planned outcomes

- Define `kunlun.runtime-manifest/v1` with the server entry, assets, source maps, compatibility
  flags, capability declarations, integrity hashes, and build/runtime ABI metadata.
- Standardize the executable server-entry contract around
  `export default { fetch(request, env, executionContext) }`.
- Extend build adapters to emit deterministic `consumer: 'server'` artifacts and the runtime
  manifest alongside browser assets.
- Share routing, streaming, error, CORS, cancellation, and graceful-shutdown conformance fixtures
  between `runtime-node` and the native runtime.
- Add CLI runtime discovery, version/ABI negotiation, verified installation handoff, selection,
  diagnostics, and an explicit Node.js fallback.
- Add deployment-plan inspection and capability-policy validation before a built artifact starts.
- Prototype provider-neutral remote-workspace metadata on top of `devcontainer.json`; provider
  APIs, hosted infrastructure, and remote execution are not v0.4 compatibility promises.

The native host, JavaScriptCore distribution, isolation, and debugger implementation remain owned
by [`kunlunengine/runtime`](https://github.com/kunlunengine/runtime). Core owns the artifact,
adapter, CLI, and cross-runtime conformance contracts. Native execution in v0.4 therefore depends
on the runtime repository completing its application-compatibility milestone.

### Exit gate

One integrity-addressed server artifact passes the shared application conformance suite on Node.js
and a compatible native runtime. `kunlun doctor` explains compatibility before launch, tampered
artifacts are rejected, and switching runtimes requires no application-source changes.

## v0.5 — Integrated toolchain and workspace workflow (proposed)

**Goal:** extend the v0.3 daily workflow and v0.4 portable artifacts into a coherent application,
library, and workspace toolchain, using the released Vite+ 1.0 workflow as the comparison baseline.

### Planned outcomes

- Add inspectable, explicitly supported migrations with file-level diagnostics and no silent
  replacement of native builder configuration.
- Add a library template and `kunlun pack` with consumer-tested exports, declarations, formats,
  and source maps; keep application `build` and library packaging distinct.
- Extend `check` with explicit format, lint, and type-check providers, and exercise the
  project-selected Lightning Node workflow without implying a JSC test pool.
- Add `kunlun run` with workspace discovery, task dependencies, filters, bounded parallelism,
  cancellation, and opt-in local result caching with explainable invalidation.
- Add project-pinned toolchain selection and verified acquisition, version reporting, rollback,
  and offline diagnostics; retain pnpm as the dependency resolver and script runner.
- Integrate capability-aware runtime inspection where supported; native Inspector support depends
  on runtime M4 and remains separate from v0.4 application conformance.
- Test the same packed application, library, and workspace workflows locally and in CI, including
  machine-readable output, cleanup, failure paths, and reproducible performance measurements.

### Exit gate

A declared migration fixture and generated application, library, and workspace pass their complete
documented workflows from packed packages. Library consumers validate emitted exports and types;
reference tasks with a complete declared input model have identical results on a cache miss and hit,
and every declared input change invalidates the cache. Arbitrary scripts are uncached by default;
opt-in caching relies on the task author's complete input declaration, not a sandbox guarantee.
Toolchain selection is reproducible and rejects tampered, untrusted, or incompatible downloads.
Unsupported providers are diagnosed rather than reported as passing.

The [v0.5 slices](./docs/plans/cli-v0.5-v1.0.md#v05-delivery-slices) define the order and evidence.
This does not expand v0.3/v0.4 retrospectively or require a native package manager, Rust Nasti,
Lightning JSC executor, shared remote cache, or hosted workspace service.

## v1.0 — Stable contracts and supported releases (proposed)

**Goal:** turn the proven v0.2–v0.5 workflow into a bounded, documented compatibility and support
commitment, not a declaration that every long-term native or cloud feature is finished.

### Planned outcomes

- Publish the supported command, configuration, generator, adapter, manifest/ABI, diagnostic,
  event-schema, and extension-hook compatibility matrix.
- Define semver, deprecation and migration rules, supported platforms/toolchains, maintenance and
  security-support windows, and ownership before declaring a stable release.
- Run clean-room install, upgrade, migration, application, library, workspace, and failure-path
  conformance from release artifacts on every advertised platform.
- Publish integrity, provenance, dependency/SBOM, reproducibility, and performance evidence for
  the release artifacts and validate verified toolchain installation and recovery.
- Keep API references, runnable examples, and Context7 retrieval aligned with released versions.
  Nasti and Lightning are already indexed; indexing alone is not execution or native qualification.

### Exit gate

Every advertised stable capability has packed/released-artifact fixtures, an owner, compatibility
documentation, and a support policy. Upgrade and deprecation fixtures pass, release evidence is
published, and the same CLI plans and diagnostic codes work locally and in CI.

Runtime M6 is required for a **stable native-runtime distribution claim**, not proof that CLI
v1.0 is complete. A Node-backed CLI release can qualify without M6 after the preceding Core gates,
including v0.4's Node/JSC application conformance; it does not bypass runtime M3. Native features
whose own gates remain incomplete must be labeled preview or unsupported in its support matrix.
The [v1.0 release gate](./docs/plans/cli-v0.5-v1.0.md#v10-release-gate) defines the evidence.

## Deliberately unassigned beyond this plan

The following work needs separate threat models or product validation before it receives a Core
release number:

- replacing pnpm with native `kunlun-pm`, porting Nasti, or qualifying a Lightning JSC executor;
- hostile multi-tenant extension execution and operating-system isolation;
- a hosted remote-workspace control plane, billing, or provider-specific infrastructure;
- a broad Next.js compatibility layer;
- remote templates and a template marketplace; and
- distributed task execution and shared remote caches.

## Workstreams looking for owners

| Workstream | Near-term ownership | Useful experience |
| --- | --- | --- |
| Application conventions | route compiler, layouts, renderer and client boundary | TypeScript, React, SSR, compilers |
| Build engines | adapter capabilities, HMR and conformance fixtures | Nasti/Rolldown, Vite, Webpack, Rspack |
| Runtime contracts | manifests, Fetch behavior and capability diagnostics | web runtimes, security APIs, Node.js |
| CLI and generators | command lifecycle, templates and machine-readable plans | Node.js CLIs, pnpm, monorepos |
| Quality and community | examples, docs, releases, triage and contributor onboarding | technical writing, testing, OSS maintenance |

People interested in owning one of these areas can respond to the
[maintainer recruitment issue](https://github.com/kunlunengine/core/issues) once it is published.
