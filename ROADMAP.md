# Kunlun Engine Core Roadmap

Status date: 2026-08-27

This roadmap covers the `kunlunengine/core` repository. Version numbers describe repository-wide
development lines and capability gates, not calendar promises; individual `@kunlun-js` packages
may version independently while the public contracts are still pre-1.0.

## Starting point

The v0.1 release established explicit application, route, service, and capability definitions; a
bundler-neutral `BuildEngine` contract; first-party Nasti, Vite, Webpack, and Rspack adapters; a
Fetch-based runtime contract and Node.js reference runtime; and a thin `kunlun` CLI.

Three rules continue through v0.4:

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

## Deliberately unassigned beyond v0.4

The following work needs separate threat models or product validation before it receives a Core
release number:

- hostile multi-tenant extension execution and operating-system isolation;
- a hosted remote-workspace control plane, billing, or provider-specific infrastructure;
- a broad Next.js compatibility layer;
- distributed task execution and shared remote caches; and
- a 1.0 compatibility and long-term-support policy.

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
