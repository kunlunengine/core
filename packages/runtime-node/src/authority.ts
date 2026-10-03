import { AsyncLocalStorage } from 'node:async_hooks'
import { realpath, stat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
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
        try { request = new Request(input, init) } catch { deny() }
        const url = new URL(request.url)
        if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== hostname || url.username || url.password) deny()
        check(scope)
        activeCalls++
        let released = false
        const release = () => { if (!released) { released = true; activeCalls-- } }
        try {
          const response = await directFetch(scope, request, url, release, trackTransport)
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

/** Direct node transport: no ambient proxy, and no redirect following. */
async function directFetch(scope: Scope, request: Request, url: URL, release: () => void, track: (pending: Promise<void>) => void): Promise<Response> {
  check(scope)
  if (request.signal.aborted) { release(); deny() }
  return new Promise<Response>((resolveResponse, reject) => {
    const fail = () => reject(new NodeAuthorityError())
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
    let outgoing: ReturnType<typeof httpRequest>
    try {
      const headers = Object.fromEntries(request.headers)
      if (headers.host !== undefined && headers.host !== url.host) deny()
      outgoing = transport(url, { method: request.method, headers, agent: false })
    } catch { release(); fail(); return }
    track(new Promise<void>(resolve => { outgoing.once('close', resolve) }))
    let upload: ReadableStreamDefaultReader<Uint8Array> | undefined
    let completed = false
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      release()
      outgoing.destroy()
      void upload?.cancel().catch(() => {})
      request.signal.removeEventListener('abort', abort)
      scope.cleanups.delete(abort)
    }
    const abort = () => { cleanup(); fail() }
    request.signal.addEventListener('abort', abort, { once: true })
    scope.cleanups.add(abort)
    outgoing.on('error', () => { cleanup(); fail() })
    outgoing.on('response', incoming => {
      try {
        check(scope)
        const headers = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
        }
        const iterator = incoming[Symbol.asyncIterator]()
        let size = 0
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              check(scope)
              const item = await Promise.race([iterator.next(), scope.ended])
              check(scope)
              if (item.done) { completed = true; controller.close(); cleanup() }
              else {
                size += item.value.length
                if (size > limit) deny()
                controller.enqueue(new Uint8Array(item.value))
              }
            } catch { controller.error(new NodeAuthorityError()); incoming.destroy(); cleanup() }
          },
          cancel() {
            try { check(scope) } finally { incoming.destroy(); cleanup() }
          },
        }, { highWaterMark: 0 })
        const status = incoming.statusCode ?? 500
        const noBody = request.method === 'HEAD' || [204, 205, 304].includes(status)
        const response = new Response(noBody ? null : stream, { status, headers })
        if (noBody) { incoming.destroy(); cleanup() }
        resolveResponse(response)
      } catch { incoming.destroy(); cleanup(); fail() }
    })
    void (async () => {
      try {
        if (request.body) {
          upload = request.body.getReader()
          let size = 0
          while (!completed) {
            check(scope)
            const item = await Promise.race([upload.read(), scope.ended])
            check(scope)
            if (item.done) break
            size += item.value.byteLength
            if (size > limit) deny()
            if (!outgoing.write(item.value)) await Promise.race([
              new Promise<void>((resolve, rejectDrain) => {
                const remove = () => {
                  outgoing.removeListener('drain', drained)
                  outgoing.removeListener('error', failed)
                  outgoing.removeListener('close', failed)
                }
                const drained = () => { remove(); resolve() }
                const failed = () => { remove(); rejectDrain(new NodeAuthorityError()) }
                outgoing.once('drain', drained)
                outgoing.once('error', failed)
                outgoing.once('close', failed)
              }), scope.ended,
            ])
          }
        }
        outgoing.end()
      } catch { cleanup(); fail() }
    })()
  })
}
