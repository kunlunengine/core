import { AsyncLocalStorage } from 'node:async_hooks'
import { realpath, stat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { types } from 'node:util'
import { Agent, type Dispatcher } from 'undici'
import type { RuntimeCapabilityRequirements, RuntimeRequestEnvironment, RuntimeFetchEntry } from '@kunlun-js/runtime-api'

export interface NodeDeploymentGrants {
  /** Trusted binding roots; only declared, granted labels are projected. */
  fs?: Readonly<Record<string, string>>
  /** Exact canonical hostnames, not origins, URL prefixes, or wildcard patterns. */
  http?: readonly string[]
}

export interface NodeRequestAuthority {
  /** Trusted host primitive, including execution of Runtime's unchanged probe. */
  invoke<T>(callback: (env: RuntimeRequestEnvironment) => T | Promise<T>, options?: { signal?: AbortSignal }): Promise<T>
  /** Owns the request through response-body EOF, cancellation, or failure. */
  fetch(request: Request, handler: RuntimeFetchEntry): Promise<Response>
  /** Stops admission, aborts current scopes, and drains host-owned resources. */
  close(): Promise<void>
}

/** Local denial, deliberately without paths, URLs, or transport error causes. */
export class NodeAuthorityError extends Error {
  constructor() { super('Request authority denied or ended'); this.name = 'NodeAuthorityError' }
}

const limit = 1024 * 1024
type Scope = { active: boolean; controller: AbortController; cleanups: Set<() => void>; ended: Promise<never>; end: () => void }
type FileRoot = { path: string; dev: number; ino: number }
// Only opaque identity is ambient; no environment or caller credentials are stored here.
const identity = new AsyncLocalStorage<Scope>()
const deny = (): never => { throw new NodeAuthorityError() }
function check(scope: Scope): void {
  if (!scope.active || identity.getStore() !== scope) deny()
}
function checkDestination(url: URL, hostname: string): void {
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== hostname || url.username || url.password) deny()
}
function requestOptions(init?: RequestInit): RequestInit | undefined {
  if (!init) return init
  const source = init.body
  let body = source
  // Older supported Node Fetch engines detach binary sources on the first
  // upload, breaking redirect replay. Blob preserves the exact bytes and its
  // replay source without changing the caller's buffer or adding a content type.
  if (types.isArrayBuffer(source) || ArrayBuffer.isView(source)) {
    const bytes = ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : new Uint8Array(source)
    if (bytes.byteLength > limit) deny()
    body = new Blob([bytes.slice()])
  }
  // Snapshot body once, preserving inherited options and accessor receivers.
  // Use an independent target so frozen init.body can be normalized without
  // violating Proxy invariants or mutating the caller's options.
  return new Proxy({}, {
    get(_target, key) { return key === 'body' ? body : Reflect.get(init, key, init) },
  })
}
function revoke(scope: Scope): void {
  if (!scope.active) return
  scope.active = false
  scope.controller.abort()
  scope.end()
  for (const cleanup of scope.cleanups) cleanup()
  scope.cleanups.clear()
}
function record<T extends object>(values: T): Readonly<T> {
  const result = Object.assign(Object.create(null), values)
  // A filesystem label named "toJSON" remains a binding, not a hidden reserved name.
  if (!Object.hasOwn(result, 'toJSON')) Object.defineProperty(result, 'toJSON', { value: deny })
  return Object.freeze(result)
}
function host(value: unknown): value is string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 256 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false
  try {
    // Match Runtime's URL canonicalization, not a separate DNS-label policy.
    const url = new URL(`https://${value}/`)
    return url.hostname === value && !url.port && !url.username && !url.password
  } catch { return false }
}
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key))
}

/** Request authority, not a hostile-code sandbox; revocation cannot undo completed effects. */
export async function createRequestAuthority(capabilities: RuntimeCapabilityRequirements, grants: NodeDeploymentGrants): Promise<NodeRequestAuthority> {
  if (!shape(capabilities, ['required', 'optional']) || !Object.hasOwn(capabilities, 'required') ||
    !Object.hasOwn(capabilities, 'optional') || !Array.isArray(capabilities.required) || !Array.isArray(capabilities.optional)) deny()
  if (!shape(grants, ['fs', 'http']) || (grants.fs !== undefined && (!grants.fs || typeof grants.fs !== 'object' || Array.isArray(grants.fs))) ||
    (grants.http !== undefined && (!Array.isArray(grants.http) || !grants.http.every(host)))) deny()
  // Admission owns a snapshot before its first await. Mutable deployment objects
  // or declaration arrays cannot change the policy while roots are canonicalized.
  const snapshot = (entries: RuntimeCapabilityRequirements['required']) => entries.map(entry => {
    if (!shape(entry, ['name', 'resource'])) deny()
    return { ...entry }
  })
  const declarations = [
    [snapshot(capabilities.required), true],
    [snapshot(capabilities.optional), false],
  ] as const
  const filesystemGrants = Object.assign(Object.create(null), grants.fs)
  const networkGrants = new Set(grants.http)
  const roots = new Map<string, FileRoot>()
  const hosts = new Set<string>()
  const seen = new Set<string>()
  for (const [entries, required] of declarations) {
    for (const entry of entries) {
      if (!shape(entry, ['name', 'resource']) || !Object.hasOwn(entry, 'name') || !Object.hasOwn(entry, 'resource') || typeof entry.resource !== 'string' ||
        !(entry.name === 'fs.binding' ? /^[A-Za-z0-9._-]{1,256}$/.test(entry.resource) : entry.name === 'http.host' && host(entry.resource))) deny()
      const key = `${entry.name}:${entry.resource}`
      if (seen.has(key)) deny()
      seen.add(key)
      if (entry.name === 'fs.binding') {
        const root = Object.hasOwn(filesystemGrants, entry.resource) ? filesystemGrants[entry.resource] : undefined
        if (root === undefined) { if (required) deny(); continue }
        try {
          if (typeof root !== 'string') deny()
          const canonical = await realpath(root)
          const directory = await stat(canonical)
          if (!directory.isDirectory()) deny()
          roots.set(entry.resource, { path: canonical, dev: directory.dev, ino: directory.ino })
        } catch { deny() }
      } else {
        if (networkGrants.has(entry.resource)) hosts.add(entry.resource)
        else if (required) deny()
      }
    }
  }
  let closed = false
  let activeCalls = 0
  const scopes = new Set<Scope>()
  const pendingFiles = new Set<Promise<void>>()
  const pendingTransports = new Set<Promise<void>>()
  function trackTransport(pending: Promise<void>): void {
    pendingTransports.add(pending)
    void pending.then(() => { pendingTransports.delete(pending) })
  }
  function start(signal?: AbortSignal): { scope: Scope; env: RuntimeRequestEnvironment; finish: () => void } {
    if (closed || signal?.aborted) deny()
    let end!: () => void
    const ended = new Promise<never>((_, reject) => { end = () => reject(new NodeAuthorityError()) })
    void ended.catch(() => {})
    const scope: Scope = { active: true, controller: new AbortController(), cleanups: new Set(), ended, end }
    scopes.add(scope)
    const finish = () => { revoke(scope); scopes.delete(scope); signal?.removeEventListener('abort', finish) }
    signal?.addEventListener('abort', finish, { once: true })
    scope.cleanups.add(() => { scopes.delete(scope); signal?.removeEventListener('abort', finish) })
    const fs: Record<string, RuntimeRequestEnvironment['fs'][string]> = Object.create(null)
    for (const [label, root] of roots) {
      let handle: RuntimeRequestEnvironment['fs'][string]
      handle = record({ async readTextFile(this: unknown, path: string) {
        check(scope)
        if (this !== handle || typeof path !== 'string' || !path || isAbsolute(path) || /^[A-Za-z]:/.test(path) ||
          path.includes('\\') || path.includes('\0') || path.split('/').includes('..') || activeCalls >= 256) deny()
        activeCalls++
        let settle!: () => void
        const pending = new Promise<void>(resolve => { settle = resolve })
        pendingFiles.add(pending)
        try {
          const directory = await stat(root.path)
          if (directory.dev !== root.dev || directory.ino !== root.ino) deny()
          const target = await realpath(resolve(root.path, path))
          const rel = relative(root.path, target)
          if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) deny()
          const expected = await stat(target)
          if (!expected.isFile()) deny()
          check(scope)
          const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          const cancel = () => { void file.close().catch(() => {}) }
          scope.cleanups.add(cancel)
          let text: string
          try {
            check(scope)
            const info = await file.stat()
            if (!info.isFile() || info.size > limit || info.dev !== expected.dev || info.ino !== expected.ino) deny()
            // Read a bounded amount, including one byte to detect concurrent growth.
            const bytes = Buffer.alloc(info.size + 1)
            let count = 0
            while (count < bytes.length) {
              const read = await file.read(bytes, count, bytes.length - count, count)
              if (!read.bytesRead) break
              count += read.bytesRead
            }
            // A swapped path must not deliver data from a now-escaped binding.
            const final = await stat(target)
            const finalRoot = await stat(root.path)
            if (await realpath(resolve(root.path, path)) !== target || count > limit ||
              finalRoot.dev !== root.dev || finalRoot.ino !== root.ino ||
              final.dev !== info.dev || final.ino !== info.ino || final.size !== info.size) deny()
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))
            check(scope)
          } finally {
            try { await file.close() }
            finally { scope.cleanups.delete(cancel) }
          }
          check(scope)
          return text
        } catch { return deny() }
        finally { activeCalls--; pendingFiles.delete(pending); settle() }
      } })
      fs[label] = handle
    }
    const http: Record<string, RuntimeRequestEnvironment['http'][string]> = Object.create(null)
    for (const hostname of hosts) {
      let handle: RuntimeRequestEnvironment['http'][string]
      handle = record({ async fetch(this: unknown, input: string | URL | Request, init?: RequestInit) {
        check(scope)
        if (this !== handle || activeCalls >= 256) deny()
        let request!: Request
        try { request = new Request(input, requestOptions(init)) } catch { deny() }
        const url = new URL(request.url)
        checkDestination(url, hostname)
        if (request.headers.has('host') && request.headers.get('host') !== url.host) deny()
        check(scope)
        activeCalls++
        let released = false
        const release = () => { if (!released) { released = true; activeCalls-- } }
        try {
          const response = await directFetch(scope, request, hostname, release, trackTransport)
          check(scope)
          return response
        }
        catch { release(); return deny() }
      } })
      http[hostname] = handle
    }
    return { scope, env: record({ fs: record(fs), http: record(http) }), finish }
  }
  return Object.freeze({
    async invoke<T>(callback: (env: RuntimeRequestEnvironment) => T | Promise<T>, options?: { signal?: AbortSignal }): Promise<T> {
      const { scope, env, finish } = start(options?.signal)
      try { return await identity.run(scope, () => Promise.race([Promise.resolve().then(() => { check(scope); return callback(env) }), scope.ended])) }
      finally { finish() }
    },
    async fetch(request: Request, handler: RuntimeFetchEntry): Promise<Response> {
      const { scope, env, finish } = start(request.signal)
      try {
        const scopedRequest = new Request(request, { signal: scope.controller.signal })
        const context = Object.freeze({
          signal: scopedRequest.signal,
          waitUntil: () => { throw new Error('Execution context waitUntil is unsupported') },
        })
        const completion = identity.run(scope, () => Promise.resolve().then(() => { check(scope); return handler(scopedRequest, env, context) }))
        // Cancellation can win before a slow handler returns. Its eventual body
        // must still be discarded, not left as an unowned stream.
        void completion.then(async response => {
          if (!scope.active && response instanceof Response && response.body && !response.body.locked) {
            try { await response.body.cancel() } catch {}
          }
        }, () => {})
        const response = await Promise.race([completion, scope.ended])
        if (!scope.active) deny()
        if (!(response instanceof Response)) throw new TypeError('Runtime handler must return a Response')
        if (!response.body) { finish(); return response }
        const reader = response.body.getReader()
        scope.cleanups.add(() => { void reader.cancel().catch(() => {}) })
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            return identity.run(scope, async () => {
              try {
                check(scope)
                const item = await Promise.race([reader.read(), scope.ended])
                check(scope)
                if (item.done) { controller.close(); finish() } else controller.enqueue(item.value)
              } catch { controller.error(new NodeAuthorityError()); finish() }
            })
          },
          async cancel() { try { await identity.run(scope, () => reader.cancel()) } finally { finish() } },
        }, { highWaterMark: 0 })
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      } catch (error) { finish(); throw error }
    },
    async close() {
      closed = true
      for (const scope of scopes) revoke(scope)
      scopes.clear()
      await Promise.all([...pendingFiles, ...pendingTransports])
    },
  })
}

/** Capture Node's Fetch engine, never its ambient dispatcher or proxy settings. */
const nodeFetch = globalThis.fetch

/** One host-call slot owns the entire redirect chain and final response body. */
async function directFetch(scope: Scope, request: Request, hostname: string, release: () => void, track: (pending: Promise<void>) => void): Promise<Response> {
  check(scope)
  if (request.signal.aborted) { release(); deny() }
  // This copy's proxy stream is adapter-owned even when init.body was a
  // caller-owned stream. Its internal replay source is preserved by Request.
  if (request.body) request = new Request(request)
  // A private plain Agent cannot inherit a global proxy/dispatcher. Disabling
  // keep-alive also prevents a completed request from leaving pooled sockets.
  const agent = new Agent({ pipelining: 0 })
  const controller = new AbortController()
  let settle!: () => void
  track(new Promise<void>(resolve => { settle = resolve }))
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    controller.abort()
    release()
    request.signal.removeEventListener('abort', cleanup)
    scope.cleanups.delete(cleanup)
    if (request.body && !request.body.locked) void request.body.cancel().catch(() => {})
    void agent.destroy().then(settle, settle)
  }
  request.signal.addEventListener('abort', cleanup, { once: true })
  scope.cleanups.add(cleanup)

  // Interpose below Fetch's redirect policy, not around its first response.
  // This gate runs for *every* destination before a connection can be created.
  // Keep Request's internal body source intact: turning it into a stream here
  // would lose buffered-body replay, while cloning a stream can buffer unboundedly.
  const dispatcher: Pick<Dispatcher, 'dispatch'> = {
    dispatch(options, handler) {
      check(scope)
      if (controller.signal.aborted) deny()
      // The transport connects to origin. A path beginning "//" is still a
      // request target, not authority that can replace the connection's host.
      const origin = new URL(options.origin ?? deny())
      checkDestination(origin, hostname)
      return agent.dispatch({
        ...options,
        ...(options.body ? { body: Readable.from(boundedUpload(options.body, scope, controller.signal), { objectMode: false }) } : {}),
      }, guardResponse(handler, options, origin, hostname, request.redirect, scope, controller.signal))
    },
  }
  try {
    const upstream = await fetchWithUploadCancellation(request, {
      signal: controller.signal,
      dispatcher,
    }, controller.signal)
    check(scope)
    const metadata = { url: upstream.url, redirected: upstream.redirected, type: upstream.type }
    if (!upstream.body) {
      // Older Node engines mark even an empty upstream body unusable on abort.
      // Return an independent bodyless response before closing owned transports.
      const response = new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers })
      cleanup()
      return responseMetadata(response, metadata)
    }
    const reader = upstream.body.getReader()
    let size = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(destination) {
        try {
          check(scope)
          const item = await Promise.race([reader.read(), scope.ended])
          check(scope)
          if (item.done) { destination.close(); cleanup() }
          else {
            size += item.value.byteLength
            if (size > limit) deny()
            destination.enqueue(item.value)
          }
        } catch { destination.error(new NodeAuthorityError()); cleanup() }
      },
      async cancel() {
        try { check(scope); await reader.cancel() } finally { cleanup() }
      },
    }, { highWaterMark: 0 })
    const response = new Response(stream, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers })
    return responseMetadata(response, metadata)
  } catch { cleanup(); return deny() }
}

/** Check redirect URLs before Fetch erases credentials, and count wire bytes before decoding. */
function guardResponse(handler: Dispatcher.DispatchHandler, options: Dispatcher.DispatchOptions, origin: URL, hostname: string, redirect: RequestRedirect, scope: Scope, signal: AbortSignal): Dispatcher.DispatchHandler {
  const receiveHeaders = handler.onHeaders ?? deny()
  const receiveData = handler.onData ?? deny()
  let size = 0
  const onHeaders: NonNullable<Dispatcher.DispatchHandler['onHeaders']> = (status, headers, resume, statusText) => {
    if (!scope.active || signal.aborted) deny()
    if (redirect === 'follow' && [301, 302, 303, 307, 308].includes(status)) {
      const locations: string[] = []
      for (let index = 0; index < headers.length; index += 2) {
        if (headers[index]!.toString('latin1').toLowerCase() === 'location') locations.push(headers[index + 1]!.toString('latin1'))
      }
      if (locations.length) {
        // Concatenate the origin and request target: resolving a leading "//"
        // target would incorrectly replace the connection authority.
        const current = new URL(origin.origin + options.path)
        checkDestination(new URL(locations.join(', '), current), hostname)
      }
    }
    return receiveHeaders.call(handler, status, headers, resume, statusText)
  }
  const onData: NonNullable<Dispatcher.DispatchHandler['onData']> = chunk => {
    if (!scope.active || signal.aborted) deny()
    size += chunk.byteLength
    if (size > limit) deny()
    return receiveData.call(handler, chunk)
  }
  // Delegate all other callbacks with their original receiver, including methods
  // inherited from a handler's prototype. Do not copy mutable handler state.
  return new Proxy(handler, {
    get(target, key) {
      if (key === 'onHeaders') return onHeaders
      if (key === 'onData') return onData
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** A stream wrapper and all of its clones retain the Fetch engine's metadata. */
function responseMetadata(response: Response, metadata: Pick<Response, 'url' | 'redirected' | 'type'>): Response {
  const clone = response.clone.bind(response)
  Object.defineProperties(response, {
    url: { value: metadata.url },
    redirected: { value: metadata.redirected },
    type: { value: metadata.type },
    clone: { value: () => responseMetadata(clone(), metadata) },
  })
  return response
}

/**
 * Node copies a Request body with pipeThrough during synchronous Fetch admission.
 * Give that transfer a cancellation signal: aborting Fetch alone cannot cancel a
 * source reader already locked inside its pending upload iterator.
 *
 * Only this adapter-owned stream is interposed, only during admission. No global
 * prototypes or private Request fields are touched, and body replay metadata is
 * unchanged. The stalled-upload regression must cover supported Node versions.
 */
function fetchWithUploadCancellation(request: Request, init: RequestInit & { dispatcher: Pick<Dispatcher, 'dispatch'> }, signal: AbortSignal): Promise<Response> {
  const body = request.body
  if (!body) return nodeFetch(request, init)
  const pipeThrough = body.pipeThrough
  let transferred = false
  Object.defineProperty(body, 'pipeThrough', {
    configurable: true,
    value(transform: ReadableWritablePair<Uint8Array, Uint8Array>, options?: StreamPipeOptions) {
      transferred = true
      return pipeThrough.call(body, transform, {
        ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, signal]) : signal,
      })
    },
  })
  try {
    const pending = nodeFetch(request, {
      ...init,
      dispatcher: {
        dispatch(options, handler) {
          if (!transferred) deny()
          return init.dispatcher.dispatch(options, handler)
        },
      },
    } as RequestInit & { dispatcher: Pick<Dispatcher, 'dispatch'> })
    // A future Node engine must not silently bypass the ownership bridge.
    if (!transferred) { void pending.catch(() => {}); deny() }
    return pending
  }
  finally { Reflect.deleteProperty(body, 'pipeThrough') }
}

/** Bound each actual upload, including buffered-body replays, without prebuffering. */
async function* boundedUpload(body: NonNullable<Dispatcher.DispatchOptions['body']>, scope: Scope, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const chunks = typeof body === 'string' || types.isUint8Array(body) ? [body] : body
  let size = 0
  for await (const chunk of chunks) {
    if (!scope.active || signal.aborted) deny()
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    if (!types.isUint8Array(bytes)) deny()
    size += bytes.byteLength
    if (size > limit) deny()
    yield bytes
  }
}
