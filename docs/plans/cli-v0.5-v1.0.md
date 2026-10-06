# CLI v0.5–v1.0 delivery plan

Status: proposed on 2026-10-06. This is planning, not an implemented API or a release announcement.

## Origin and scope

The runtime planning discussion “更新 CLI 版本目标与规划” requested the six CLI/Core labels
**v0.1 → v0.2 → v0.3 → v0.4 → v0.5 → v1.0**, the released Vite+ 1.0 workflow baseline, and
recognition that Nasti and Lightning are already indexed by Context7. That discussion mirrored
Core's v0.1–v0.4 roadmap and left the last two scopes awaiting a Core decision. This proposal
supplies those missing scopes for review; it does not describe them as previously approved.

The [Core roadmap](../../ROADMAP.md) owns the release scope. This document owns its v0.5/v1.0
delivery detail, and the [CLI README](../../packages/cli/README.md) owns current command behavior.
The default branch remains an unreleased v0.2 source preview; this plan changes no package version.

| CLI/Core line | Capability checkpoint | Runtime relationship |
| --- | --- | --- |
| v0.1 | Explicit application/build/runtime contracts and thin CLI | Node reference runtime |
| v0.2 | Runnable packed full-stack app with rendering, hydration, Fetch handlers, and client/server boundaries | Node workflow; native host not required |
| v0.3 | Versioned generator, closed daily lifecycle, dry-run/JSON, deterministic feedback, conventions, extension/performance fixtures | No native prerequisite; pnpm owns resolution and scripts |
| v0.4 | Portable server artifacts, integrity/ABI checks, runtime discovery, verified handoff, selection, diagnostics, Node fallback | Native application path depends on runtime M3 conformance |
| v0.5 (proposed) | Migration, library packaging, expanded checks, workspace tasks/local cache, verified toolchain management, CI | Native inspection additionally depends on M4; native providers remain independent |
| v1.0 (proposed) | Tested stable contracts, supported-platform matrix, upgrade/deprecation policy, release and support evidence | Retains the preceding M3 application gate; stable native distribution additionally requires M6, which does not automatically qualify CLI stability |

These are repository-wide capability lines, not requirements that all packages share a version.
Planning and isolated protocol work can proceed in parallel, but end-to-end qualification may not
substitute stubs for an earlier exit gate. The [v0.3 slices](./v0.3-slices.md) remain unchanged, and
their plan-before-write generator is still the first implementation packet.

## Workflow baseline and boundaries

[Vite+ 1.0](https://voidzero.dev/posts/announcing-vite-plus-1-0), released on 2026-09-28, supplies a
workflow baseline, not Kunlun's internal architecture. Keep Nasti as the reference build engine,
Lightning as the first-party test choice, and honest capability reporting for Vite, Webpack, and
Rspack. Do not replace bundler-neutral contracts with a Vite+ dependency or normalize native plugins.

| Released Vite+ workflow | Kunlun checkpoint and required evidence |
| --- | --- |
| Create and migrate | v0.3 versioned app generator; v0.5 library/workspace templates and explicit migration fixtures |
| Install and runtime/toolchain management | v0.3 project-pinned pnpm orchestration; v0.4 runtime handoff; v0.5 verified selection/acquisition, rollback, and offline diagnostics |
| Dev, check, test, build | v0.2/v0.3 app lifecycle; v0.5 declared format/lint/type-check tools and selected Lightning Node workflows |
| Library packaging | v0.5 `pack`, validated in real package consumers, separate from app `build` |
| Workspace tasks and caching | v0.5 dependency graph, filters, parallelism, and opt-in local cache with invalidation evidence |
| Consistent local/CI setup and upgrades | v0.5 packed workflow jobs; v1.0 released-artifact upgrade, compatibility, and support gates |

Vite+ 1.0's comparison baseline is local task caching. Reusing a cache directory through a CI cache
service is not a distributed task runner or a shared remote-cache protocol; neither is required by
this plan. Git hooks, staged-only checks, remote templates, and hosted services are not implied by
the phrase “Vite+-class”.

Two approaches were considered: bundle the native PM/build/test rewrites into the next CLI release,
or first complete a coherent workflow over the existing providers. Choose the latter. It preserves
the tested Node/pnpm path, bounds the release gate, and lets native components qualify through their
own conformance/security evidence rather than their presence on a command menu.

pnpm continues to own dependency resolution, lockfile mutation, workspace linking, and lifecycle
scripts. A future `PackageManagerProvider/v1` or native `kunlun-pm` remains a separate decision in
the runtime [toolchain draft](https://github.com/kunlunengine/runtime/blob/main/docs/cli-toolchain-plan.md).
Toolchain acquisition here means acquiring verified tool binaries, not installing application
dependencies with a new resolver.

## v0.5 delivery slices

Entry gate: the v0.3 packed daily workflow and v0.4 artifact/Node–JSC conformance have passed.
Node-only tooling slices can be implemented earlier, but they do not close that aggregate gate.
This preserves the existing v0.4 exit gate, so aggregate v0.5/v1.0 qualification still depends on
runtime M3 application conformance. It does not depend on M6 or a native PM/build/test rewrite.

Every new operation extends v0.3's operation-plan, event, diagnostic, and exit-status rules.
Dry runs perform no writes, process launches, network calls, or listener startup. Human and JSON
output render the same underlying results, and JSON stdout never mixes in prose or child output.

| Slice | User-visible outcome | Depends on | Delivery / sign-off responsibility |
| --- | --- | --- | --- |
| A. Inspectable migration and templates | Safely adopt the workflow in a supported project; create an app, library, or workspace | v0.3 generator and operation plans | Core CLI/templates; builder maintainers sign off advertised template cells |
| B. Checks and library packaging | Check declared tools and consume real library exports/types | A and build-adapter capability fixtures | Core CLI/build API + Nasti/Lightning; each selected tool/provider maintainer signs off its contract |
| C. Workspace execution and local cache | Run selected tasks predictably and explain cache hits/misses | v0.3 events/cleanup; A workspace fixture | Core CLI/workspace maintainers own execution, cache correctness, and cleanup |
| D. Toolchain and runtime diagnostics | Reproduce selected tools, recover failed updates, inspect only supported runtimes | v0.4 negotiation/handoff; runtime M4 for native Inspector | Core CLI/toolchain owns selection/acquisition; runtime signs off native artifact metadata and Inspector cells |
| E. Local/CI qualification | Demonstrate all supported workflows and measured costs from packed packages | A–D | Core release owner gathers evidence and the affected provider maintainers sign off the matrix |

These are repository responsibilities, not claims that individual maintainers have accepted work.
Each implementation issue must name a delivery owner and required reviewers before its slice can
close; unowned or unreviewed matrix cells remain unsupported.

### A — Inspectable migration and templates

Scope:

- Add versioned library and workspace templates alongside the reference app, with every published
  builder/template combination tested or explicitly unsupported.
- Declare supported migration source/target versions. Start with the existing first-party scaffold
  and documented build-adapter configuration; do not promise arbitrary Next.js/Vite+ migration.
- Produce deterministic file-level edits for config, dependency metadata, and scripts, plus required
  manual changes. Preserve native engine options. Plan any lockfile update as a separate pinned
  pnpm subprocess, with its arguments and possible network/write effects explicit.
- Dry-run never invokes that subprocess or predicts resolution-dependent lockfile contents. Mark
  the lockfile delta as pending; execution validates it against the approved dependency changes and
  records the actual delta before completing the migration.
- Require explicit application of the reviewed plan; reject stale inputs and collisions before
  writes. Unlike creation, migration intentionally targets existing files and needs its own tested
  recovery policy, not an implicit `create --force`.

Acceptance: packed fixtures cover app/library/workspace creation, migration, no-op reruns, unknown
source versions, conflicting edits, and interrupted application. Unsupported migrations leave the
project unchanged, and recovery tests restore the pre-migration state, including the original
lockfile after pnpm failure or an invalid delta. Dry-run and JSON describe the same Kunlun-owned
edits and planned subprocesses as execution, without claiming an exact lockfile preview.

### B — Checks and library packaging

Scope:

- Extend the existing project-invariant `check` with explicitly declared format, lint, and
  type-check tools, initially Oxfmt, Oxlint, and the supported TypeScript checker. Report skipped,
  unsupported, and failed stages distinctly; missing tools never mean a successful check.
- Keep check-only behavior non-mutating and avoid production builds/listeners. Any fix mode is
  explicit, planned, and separately tested.
- Exercise the project-pinned Lightning Node provider and declared unit/DOM/browser tasks where
  supported. Browser engines and coverage remain opt-in dependencies; no command implies a JSC pool.
- Add `pack` for library targets using an advertised packaging capability. Nasti/tsdown integration
  is the reference path; other adapters must pass fixtures or report unsupported packaging.
- Validate exports, emitted runtime imports, declaration entry points, formats, and source maps
  through separate packed ESM/CJS/TypeScript consumers for each advertised output format.

Acceptance: broken formatting, lint, types, tests, exports, declarations, and maps fail with stable
diagnostic codes and preserved underlying status. Valid consumers run without workspace source
aliases. A single `pack` result is not evidence of equivalent library support across all adapters,
and standalone-binary packaging is outside this gate.

### C — Workspace execution and local cache

Scope:

- Discover the pnpm workspace/package graph without a second resolver. Model task dependencies,
  selection filters, cycle errors, bounded parallelism, and fail-fast/continue behavior explicitly.
- Execute declared tasks through the pinned script runner; preserve child exit status and clean up
  child process trees on cancellation or partial startup failure.
- Cache only explicitly eligible finite tasks. Dev servers, network-dependent tests, migrations,
  deploys, installs, and tasks with undeclared side effects are not cacheable by default.
- Eligibility requires a deterministic, complete input/output contract and declared environment.
  Time, randomness, home-directory config, undeclared files/env, and external state make a task
  ineligible unless captured in that model. Ordinary package scripts remain uncached by default.
- v0.5 caching is explicit, user-asserted opt-in, not automatic input tracing or a sandbox. Reports
  disclose that a cacheable task's author must account for every read; arbitrary scripts do not
  receive an unconditional equivalence guarantee.
- Fingerprint declared files, dependency results, lockfile, config, task arguments, relevant
  environment, tool versions, platform/architecture, and declared capability/policy inputs.
  Explain the key and miss reason.
- Restore declared outputs and replay task status/diagnostics on a hit. Do not persist secrets or
  raw environment values in reports; reject corrupt entries and use a scoped, disposable cache.

Acceptance: reference tasks with a complete declared input model produce the same output bytes/status
on a local hit as a miss. Each fingerprint input has an invalidation fixture; known undeclared or
nondeterministic inputs keep fixture tasks uncached with a reason. Corrupt/missing outputs cause a miss;
cycles, failed dependencies, filters, concurrency limits, and cancellation have fixtures. No cache
entry crosses an incompatible platform, tool version, or capability/policy boundary.

### D — Toolchain and runtime diagnostics

Scope:

- Define project pin → explicit user selection → documented global default precedence. Incompatible
  overrides fail clearly rather than silently replacing project requirements.
- Plan `toolchain install/list/use/update/doctor` and runtime selection using v0.4's negotiated
  versions, artifact integrity, platform, and ABI metadata. Report the actual selected binary,
  version, source, and fallback reason in machine-readable output.
- Authenticate expected digests and allowed download origins through signed release metadata
  verified with CLI-maintained trust roots, or an explicit user/admin trust policy stored outside
  the checkout. A digest from the download source alone is not proof of authenticity.
- Project pins may select only tool identities/versions within that trusted catalog. Repository
  config cannot add trust keys/origins, authorize redirected downloads, or grant execution trust;
  custom providers require a separate user/admin approval outside project configuration.
- Make verified acquisition atomic; reject tampering before activation, retain the prior working
  version on interrupted updates, and provide rollback and offline doctor for acquired providers.
- Do not silently download on ordinary `dev`, `start`, or offline diagnostics. Missing tools
  produce a remediation plan and require an explicit acquisition operation.
- Add `inspect` only for runtimes advertising a supported debugging protocol. Native Inspector
  needs runtime M4 fixtures; unsupported inspection fails explicitly without blocking Node tasks.

Acceptance: pins/overrides/defaults, incompatible ABI, tampered downloads, interrupted activation,
untrusted metadata/signatures, unauthorized origins/redirects, attempted repository trust overrides,
rollback, offline checks, and explicit Node fallback have fixtures. Supported inspection covers
attach/detach, source-map locations, and cleanup; unavailable native inspection is reported as such.
This extends v0.4's handoff, not its historical release requirements.

### E — Local/CI qualification

Scope:

- Run the generated app, library, workspace, and supported migration paths from packed packages,
  using pinned tools and frozen dependency installation on each advertised platform.
- Cover human/JSON output, no-side-effect dry runs, unsupported-provider failures, process cleanup,
  offline tool diagnostics, and warm/cold task-cache behavior.
- Publish cold start, incremental rebuild/reload, check/test/pack time, client payload, and cache
  hit/miss costs with hardware, OS, tool, template, and artifact versions.
- Set regression budgets from measured baselines before closing the gate; use the same task
  definitions locally and in CI, not a second CI-only command contract.

Acceptance: all advertised matrix cells have passing fixtures, failure-path evidence, and measured
budgets. Provider versions and capability gaps are visible. This is not a benchmark claim against
Vite+ without comparable fixtures and environment metadata.

## v1.0 release gate

Entry gate: v0.2–v0.5 have passed, including the existing v0.4 Node/JSC application gate. Runtime M6
is not required for a Node-backed stable CLI, but this does not bypass the earlier M3 prerequisite.
Freeze only contracts backed by fixtures, not every experimental option or upstream plugin API.

| Gate | Evidence required before release | Ownership |
| --- | --- | --- |
| Public compatibility | Versioning/semver and schema rules for commands, config, generators, adapters, artifacts/ABI, diagnostics, JSON events, and supported extension hooks; positive and negative out-of-tree fixtures | Core + affected adapter maintainers |
| Upgrade and deprecation | Upgrade/migration fixtures from every declared supported prior line; documented removals, deprecation window, recovery, and intentionally unsupported versions | Core CLI + templates |
| Platform and support policy | Exact Node, pnpm, builder/test-provider, OS/architecture, and native-runtime matrix; published maintenance and security-support durations, owners, and reporting process | Core release owners; runtime owns native policy |
| Releasable artifacts | Clean-room released/packed consumers, verified install/update/rollback, published integrity/provenance, dependency inventory/SBOM, and reproducibility evidence | Core packages/toolchain distribution; runtime owns JSC/native artifacts |
| Conformance and resources | Application/library/workspace/migration suites, advertised Node/JSC parity, malformed manifests, capability denial, cancellation, shutdown, task/cache isolation, and resource-leak tests | Core + runtime + provider owners |
| Performance | Reproducible cold/warm budgets and regression gates with version/platform metadata, rather than unqualified speed claims | Core + build/test providers |
| Documentation | Versioned API/command reference, examples, migration/support guides, and retrieved snippets executed against the release fixtures | Core + Nasti + Lightning docs owners |

A release must publish the matrix, evidence, and support policy together. “LTS” is not a label until
its duration and owners are specified. Package versions can advance independently, but incompatible
generator/manifest/ABI/schema changes require explicit negotiation and migration rules.

CLI and native-runtime stability are different claims. Runtime M3 qualifies portable application
execution, M4 qualifies native debugging, M5 owns hostile-extension isolation experiments, and M6
owns stable native distribution/security-support evidence. After the preceding application gates,
a Node-backed CLI can reach v1.0 without waiting for M6 or claiming stable native distribution.
Any native feature still missing its own gate must remain preview/unsupported and visibly outside
the stable support commitment.

## Documentation and Context7

Initial indexing is complete:

| Provider | Existing Context7 entry / library ID |
| --- | --- |
| Nasti | [Nasti](https://context7.com/zixiao-labs/nasti), `/zixiao-labs/nasti` |
| Lightning | [Lightning](https://context7.com/zixiao-labs/lightning), `/zixiao-labs/lightning` |

Future work is to refresh implemented-contract documentation, retrieve representative configuration,
build, and test examples, record their source URLs and provider/template/runtime versions, and run
them against the packed/released fixtures. Catalog presence is not proof that a particular snippet
is current, nor evidence of Rust Nasti, native PM, or a Lightning JSC executor.

## Independent work and handoff

Native `kunlun-pm` P0–P4, Nasti B0–B4, and Lightning T0–T4 retain the separate gates in the runtime
toolchain draft. They may later replace providers only after explicit compatibility/security review.
This plan neither removes those targets nor assigns their complete delivery to v0.5/v1.0.

Shared remote caches, distributed execution, hosted workspaces, provider infrastructure, remote
templates/marketplaces, broad Next.js compatibility, and hostile multi-tenant isolation remain
outside these CLI gates. A JavaScript realm or capability declaration is not an OS security boundary.

After the preceding gates, the first v0.5 packet is Slice A's migration source/target matrix and
no-side-effect plan fixture. Reuse the generator/operation-plan machinery before adding writers,
task runners, installers, or untested command aliases. A v1.0 release issue must link each gate to
evidence and an owner; a merged planning PR alone closes none of the implementation gates.

## Sources

- [Core roadmap](../../ROADMAP.md) and [v0.3 delivery slices](./v0.3-slices.md)
- [Runtime roadmap and independent M0–M6 gates](https://github.com/kunlunengine/runtime/blob/main/ROADMAP.md)
- [Runtime CLI target contract](https://github.com/kunlunengine/runtime/blob/main/docs/kunlun-cli.md)
- [Runtime toolchain decision draft](https://github.com/kunlunengine/runtime/blob/main/docs/cli-toolchain-plan.md)
- [Vite+ 1.0 announcement and released/future feature boundary](https://voidzero.dev/posts/announcing-vite-plus-1-0)
- [Vite+ task workflow](https://viteplus.dev/guide/run) and [CI cache reuse](https://viteplus.dev/guide/github-actions-cache)
