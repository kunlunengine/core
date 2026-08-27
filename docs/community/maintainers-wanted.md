<!-- Issue title: Maintainers wanted: help build Kunlun Engine Core from v0.2 to v0.4 -->

Kunlun Engine is looking for a small group of maintainers to help turn its working v0.1 foundation
into a practical TypeScript application platform.

This is not a request to implement a closed backlog for us. Maintainers will help decide the APIs,
sequence the work, review tradeoffs, and own parts of the public roadmap.

## What exists today

Kunlun already has:

- explicit application, service, route, and capability APIs;
- a bundler-neutral build contract with Nasti, Vite, Webpack, and Rspack adapters;
- a Fetch-based runtime contract and Node.js reference runtime;
- a `kunlun` CLI for creating, developing, building, diagnosing, and starting projects; and
- real-build contract tests across all four build engines.

The next three development lines are described in the
[v0.2-v0.4 roadmap](https://github.com/kunlunengine/core/blob/main/ROADMAP.md): a runnable
full-stack application layer, a coherent daily workflow, and portable server artifacts that can
cross the Node.js/native-runtime boundary.

## Where we need ownership

You do not need to cover the whole stack. We especially want people who would enjoy owning one of
these areas:

1. **Application conventions and rendering** — filesystem routes, nested layouts, React SSR,
   server/client boundaries, and actionable diagnostics.
2. **Build-engine adapters** — Nasti/Rolldown, Vite, Webpack, or Rspack integration, HMR behavior,
   server bundles, and conformance fixtures.
3. **Runtime contracts and capabilities** — Fetch behavior, portable manifests, Node/native
   conformance, capability policy, and security documentation.
4. **CLI and generators** — project templates, command lifecycle, pnpm delegation, diagnostics,
   and local/CI developer experience.
5. **Quality and community** — tests, examples, releases, issue triage, documentation, and making
   the project easier for the next contributor to enter.

Possible first ownership slices include a route-discovery test matrix, a server/client-boundary
diagnostic, an HMR capability investigation for Webpack or Rspack, extraction of the versioned
generator protocol, shared Node/native conformance fixtures, or an end-to-end example. We will turn
each selected slice into a scoped issue with acceptance criteria before implementation starts.

## Who this may fit

You may be a good fit if you:

- have hands-on experience with TypeScript frameworks, build tooling, CLIs, web runtimes, testing,
  or developer documentation;
- enjoy making architectural tradeoffs explicit and explaining them in public;
- can sustain a small, reliable contribution or review cadence and communicate when life gets
  busy; and
- want to shape an early project rather than only maintain an already-fixed API.

Previous maintainer experience is welcome but not required. A focused specialist is more useful
than someone claiming familiarity with every package.

## How maintainership will work

- Design, roadmap, and review decisions happen asynchronously in public issues and pull requests.
- There is no minimum weekly-hours quota. We value clear ownership, review quality, and reliable
  communication over raw commit count.
- Contributors can grow from a scoped ownership area to triage, repository write, and release
  responsibilities through sustained work and mutual review. Sensitive access is granted
  gradually; nobody needs npm or repository write access on day one.
- Public contracts require tests and documentation. Security-sensitive capability or runtime
  changes also require an explicit threat-model discussion.
- Release milestones are capability gates, not deadline pressure, and there is no expectation of
  unpaid emergency support.

Kunlun Engine is MIT-licensed and developed in the open by Zixiao Laboratories.

## Interested?

Reply to this issue with:

1. the workstream you care about;
2. relevant experience or links, including non-code work if applicable;
3. one roadmap item you would like to own, change, or challenge; and
4. your approximate availability and time zone.

If maintainership feels too large right now, say which small slice you would like to try first. We
will help turn it into a reviewable starting issue.

To verify the current source locally:

```bash
git clone https://github.com/kunlunengine/core.git
cd core
corepack pnpm install
corepack pnpm check
corepack pnpm test
```

Questions and respectful disagreement are welcome. The point of recruiting maintainers this early
is to make the roadmap better, not merely faster.
