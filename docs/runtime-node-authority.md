# Node request authority and Runtime integration

This is the Core implementation follow-up requested by Runtime
[#50](https://github.com/kunlunengine/runtime/issues/50) and
[#53](https://github.com/kunlunengine/runtime/issues/53). It adds real Node
filesystem/HTTP request bindings and a portable artifact consumer. It is not
complete native/Node qualification, a BuildEngine artifact producer, or a
hostile-code sandbox.

## Two application paths

The existing `createRuntimeApplication()` and `nodeRuntime().start()` APIs keep
their legacy Core application manifest. That manifest is not silently interpreted
as `kunlun.runtime-manifest/v1`, and a `CapabilityRegistry` is not a deployment
grant.

For a portable artifact, use the separate `loadNodeApplication()` consumer:

```js
import { loadNodeApplication, nodeRuntime } from '@kunlun-js/runtime-node'

// These values come from trusted deployment configuration, NOT the artifact.
const application = await loadNodeApplication('/deployment/application', {
  manifestSha256: trustedManifestDigest,
  grants: {
    fs: { 'public-data': '/deployment/read-only-public-data' },
    http: ['api.example.test'],
  },
})
const server = await nodeRuntime().start(application, { port: 3000 })
// await server.close() also revokes application-owned request resources.
```

Start the artifact consumer with Node's `--experimental-vm-modules` flag. Without
VM module support the loader fails explicitly; it does not fall back to importing
mutable disk files with ambient Node authority.

The portable manifest and its default export `{ fetch(request, env, ctx) }` follow
Runtime's `kunlun.runtime-manifest/v1` and `kunlun.fetch-entry/v1` contracts.
Admission verifies the trusted manifest digest, supported versions/features,
indexed file identities and hashes, limits, and capability declarations before
entry evaluation. Static and dynamic imports resolve only within the admitted
module snapshot. Node built-ins, bare packages, network imports, and undeclared
files are not an implicit fallback.

`createNodeApplication(manifest, grants, handler)` is the trusted in-process
handler path. It admits the same declarations and uses the same request provider,
but cannot retroactively validate how an already-created handler was evaluated.
It is not a substitute for artifact integrity admission.

## Authority rules

Effective authority is **manifest declarations ∩ explicit deployment grants**.

- A missing required grant rejects admission before entry evaluation.
- An absent optional grant produces an absent binding, not a placeholder with
  ambient permission.
- Extra deployment grants are not exposed.
- Unknown capabilities, duplicate declarations, and noncanonical resources
  reject, including optional declarations.
- Supported names are `fs.binding` and `http.host`. Filesystem resources are
  labels, not host paths. HTTP resources are exact canonical hostnames; v1
  does not narrow authority by port or path.

The host creates a new frozen, null-prototype environment per request:

```js
const text = await env.fs['public-data'].readTextFile('message.txt')
const response = await env.http['api.example.test'].fetch(
  'https://api.example.test/data',
)
```

Environments and handles are nonserializable. Methods validate private
request ownership and lifetime on every privileged call and after asynchronous
completion. Retaining a handle does not let a later request use it.
Host roots and caller credentials are not projected into `env`.

File reads are bounded UTF-8 reads within the canonical binding root. Absolute
paths, parent traversal, symlink escapes, missing/nonregular files, and invalid
UTF-8 are denied. HTTP uses direct Node transports rather than ambient proxy
configuration or the global Fetch dispatcher. Each HTTP call owns a private
plain Undici Agent; the Fetch engine's dispatcher checks every destination before
connecting. Node's Fetch engine owns redirect semantics, not the transport:

- Default/`follow` follows at most 20 redirects, with the exact handle hostname,
  HTTP(S) scheme, and absence of URL credentials checked at every hop. Even a
  second admitted host is not authority carried by the first host's handle.
- `manual` returns the redirect status, headers, and body without following.
  `error` rejects redirects. Denials and transport failures remain redacted.
- POST 301/302 and non-GET/HEAD 303 rewrite to GET and drop body headers.
  HEAD 303 remains HEAD. String/Blob bodies, including those in `Request` inputs,
  replay where required; non-replayable streaming bodies reject non-303 redirects.
  Explicit binary `RequestInit.body` is snapshotted into a Blob to preserve replay
  on older supported Node engines without detaching the caller's buffer.
- Cross-origin hops, including the same hostname on a new port, drop
  Authorization, Cookie, and Proxy-Authorization and regenerate Host.

The entire redirect chain and final response share one host-call slot. Uploads
and both wire/decoded responses remain bounded to 1 MiB without eagerly buffering
streams. Owned Agents are destroyed and drained on completion, cancellation, failure, or
revocation. A scoped compatibility shim makes Node's Request-copy body transfer
abortable through its public `pipeThrough` call, so a stalled upload is canceled
even after an early redirect. It touches only an adapter-owned stream during
synchronous admission, never global prototypes or private Request fields, and
denies admission if a future Node implementation bypasses the transfer hook.
The stalled-upload and buffered-Request replay tests protect this dependency on
Node's implementation.

Some body forms remain **unqualified upstream Fetch behavior**, not portable
parity claims: an already-created byte-backed Node `Request` can fail replay on
Node 20/22 because its opaque source buffer is detached; use an explicit binary
`RequestInit.body` or construct the Request with a Blob instead. Multipart
FormData redirect replay also inherits Node's boundary-reencoding limitation and
is not part of the shared Runtime body contract. The provider does not inspect
private Request state, guess replayability, or turn streams into buffered bodies
to hide these limitations.

Invocation return, failure, cancellation, and application shutdown revoke
request authority and cancel owned host work. Fetch handlers retain their scope
through response-body completion or cancellation. Disconnects abort the incoming
request signal; in-process and HTTP dispatch use the same application path.
Cancellation does not undo completed effects or preempt a running filesystem
syscall. No caller auth/provider/billing context is stored in process globals.

Filesystem roots must remain deployment-owned: untrusted OS processes must not be
able to race mutations of their directory tree. The Node provider pins root/file
identities and rechecks canonical paths, but Node's path-based filesystem API is
not native `cap-std` atomic root-relative traversal. It is not qualification of
adversarial filesystem mutation by an independent process.

The v1 entry context has a cancellation signal. Background `ctx.waitUntil()`
is explicitly unsupported in this slice; calls throw synchronously rather than
silently outliving request authority. Full background-work/lifecycle
compatibility is still a separate acceptance item.

Neither Node `vm` nor a JavaScriptCore realm is hostile-code isolation. Trusted
in-process handlers can still import Node APIs themselves; the scoped provider
does not secure those ambient APIs. Use process/container isolation for hostile
code. Stable local errors are not a portable denial-code standard.

## Run the unchanged shared authority slice

The Node collector reads the fixture and contract from the supplied Runtime
checkout. It does not vendor or rewrite the probe, simulate its permissions,
precompute observations, or normalize mismatches into success.

```sh
pnpm install --frozen-lockfile
pnpm authority:node \
  --runtime-root /path/to/runtime \
  --output .kunlun/evidence/node-development \
  --development
```

It force-rebuilds the real workspace package (never trusting ignored incremental
compiler outputs), records and rechecks the emitted implementation hashes, creates
actual public/private filesystem fixtures, runs the exact probe body twice in one realm with fresh request scopes,
and compares the actual JSON observations exactly. It then closes the authority,
removes its temporary fixtures, and writes `report.json`.

`--development` reports use `status: "development"` and `qualification: false`.
They are useful for local verification but Runtime's strict comparator must
reject them as release evidence.

For reviewed evidence, omit `--development` and use **clean, committed Core and
Runtime checkouts**, a new output directory, and a physical macOS/Linux arm64/x64
runner. Reports contain the actual Node/package versions, Core and Runtime
commits, runner identity, fixture/contract hashes, and observed results. Dirty
sources, changed commits/corpus, translated execution, cleanup failure, or
observation mismatches cannot produce a qualifying `passed` report.

Runtime's `distribution/jsc/scripts/m3_authority.py` owns the aggregate comparison:
it requires eight matching reports, one real Node and one pinned native JSC report
for each of four platforms. One local Node run proves only the current
`request-authority/v1` filesystem/lifetime slice. The current shared contract does
not qualify HTTP parity, request context, revocation, all diagnostics, generated
producer artifacts, full inbound lifecycle, or the complete #50/#53 corpus.

Runtime's separate development HTTP checker runs its unchanged shared HTTP and
revocation fixtures against this package's actual build. With a matching native
report, it compares the raw observations, traffic, lifecycle results, and source
hashes without treating a returned 302 as denial:

```sh
pnpm exec tsc -b packages/runtime-node --force --pretty false
node /path/to/runtime/distribution/jsc/scripts/check-authority-http.mjs \
  --core-root "$PWD" \
  --native /path/to/native-http.json \
  --output /path/to/new-node-http.json
```

This checker is also `qualification: false`. A successful local system-JSC/Node
comparison is development evidence, not physical pinned-JSC matrix qualification
and not grounds to close Runtime #50 or #53.

## Remaining cross-repository gates

- Runtime's retained macOS launcher fix (`/usr/bin/env` stripping
  `DYLD_LIBRARY_PATH`) belongs to the Runtime checkout.
- Pinned native JSC and real Node evidence are still needed on all four physical
  platforms.
- Runtime #51 owns native inbound HTTP/lifecycle integration.
- Runtime #52 and Core's producer work must qualify an actual BuildEngine-emitted
  portable artifact; the consumer implemented here does not claim emission.
- The development HTTP corpus and local HTTP/cancellation tests are not the full
  cross-adapter qualification corpus. Do not use this slice to close #50 or #53.
