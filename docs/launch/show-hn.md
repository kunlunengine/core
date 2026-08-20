# Show HN: Kunlun Engine – A bundler-neutral TypeScript application core

Hi HN,

We are building Kunlun Engine, an MIT-licensed TypeScript application platform from Zixiao
Laboratories.

The problem we are exploring is that application frameworks often make build-tool decisions part
of the framework architecture. That is convenient at first, but it makes migration harder and can
force a team to adopt a bundler before it has adopted the framework itself.

Kunlun separates those layers. Applications declare services, routes, required capabilities, and
build targets. A small Build Engine protocol then connects those targets to one of four first-party
adapters: Nasti, Vite, Webpack, or Rspack.

Nasti is our own Rolldown/Oxc-based toolchain, and it is the recommended default. We still did not
want Kunlun to depend on it. A new tool should earn adoption on its merits, and users with mature
Webpack, Rspack, or Vite setups need a credible exit path. The same real fixture is therefore built
with all four engines in our contract test suite.

The v0.1 source preview includes:

- explicit applications, services, routes, path parameters, and capability requirements;
- a portable Fetch API request handler and serializable runtime manifest;
- production builds and development middleware for all four engines;
- native HMR and server module loading through the Nasti and Vite adapters;
- a `kunlun` CLI for project creation, development, builds, diagnostics, and engine inspection.

We expose an engine capability matrix instead of claiming fake parity. The first Webpack and Rspack
adapters provide builds and development middleware; their HMR and module-runner integrations are
still upcoming.

Longer term, we are prototyping a Rust + JavaScriptCore runtime. Its focus is fast startup and
capabilities scoped to an extension, tenant, request, operation, and resource—not just process-wide
permission switches. We also plan remote development around the existing Dev Container
Specification rather than another proprietary environment format.

This is deliberately early. The npm scope is registered, but this launch is a source preview while
we harden the APIs before publishing the packages.

We would especially value feedback on three questions:

1. Is the Build Engine boundary high-level enough to stay stable without hiding important native
   behavior?
2. Which authority boundaries would you need before running third-party JavaScript extensions?
3. What is the smallest useful Node compatibility surface for a new application runtime?

Source: https://github.com/kunlunengine/core

License: MIT. The project copyright is held by Zixiao Laboratories.
