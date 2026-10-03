import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as vm from 'node:vm'
import type { RuntimeApplication, RuntimeArtifactManifest, RuntimeFetchEntry } from '@kunlun-js/runtime-api'
import { createRequestAuthority, type NodeDeploymentGrants } from './authority.js'

type Application = RuntimeApplication & { readonly artifactManifest: RuntimeArtifactManifest }
const MiB = 1024 * 1024
function fail(detail: string): never { throw new Error(`Artifact admission failed: ${detail}`) }
const text = new TextDecoder('utf-8', { fatal: true })

function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid manifest shape')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key))
    || keys.some(key => !Object.hasOwn(record, key))) fail('invalid manifest fields')
  return record
}
function string(value: unknown): asserts value is string {
  if (typeof value !== 'string') fail('invalid manifest string')
}
function strings(value: unknown, supported: readonly string[]): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !supported.includes(item))
    || new Set(value).size !== value.length) fail('unsupported or duplicate compatibility requirement')
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value
}
function manifestSnapshot(input: unknown): RuntimeArtifactManifest {
  const m = object(input, ['schema', 'engine', 'entry_contract', 'entry', 'files', 'required_features', 'compatibility_flags', 'capabilities'])
  const engine = object(m.engine, ['abi', 'runtime_profile'])
  if (m.schema !== 'kunlun.runtime-manifest/v1' || engine.abi !== 1
    || engine.runtime_profile !== 'kunlun-m2-web/1' || m.entry_contract !== 'kunlun.fetch-entry/v1') fail('unsupported manifest contract')
  string(m.entry)
  strings(m.required_features, ['closed-module-graph'])
  strings(m.compatibility_flags, ['source-map-v3'])
  if (!Array.isArray(m.files) || !m.files.length || m.files.length > 1024) fail('invalid file count')
  for (const value of m.files) {
    const file = object(value, ['url', 'kind', 'sha256'], ['for'])
    string(file.url); string(file.sha256)
    if (!['module', 'asset', 'source_map'].includes(file.kind as string)) fail('unsupported file kind')
    digestSyntax(file.sha256)
    if (file.for != null) {
      string(file.for)
      if (file.kind !== 'source_map') fail('only source maps may have a for field')
    }
    if (file.kind === 'source_map' && typeof file.for !== 'string') fail('source map requires a for field')
  }
  const capabilities = object(m.capabilities, ['required', 'optional'])
  for (const list of [capabilities.required, capabilities.optional]) {
    if (!Array.isArray(list)) fail('invalid capabilities')
    for (const value of list) {
      const cap = object(value, ['name', 'resource'])
      string(cap.name); string(cap.resource)
    }
  }
  // Resource canonicalization, supported names, duplicates and grant intersection
  // have one source of truth in createRequestAuthority(), on both application paths.
  return freeze(JSON.parse(JSON.stringify(m)) as RuntimeArtifactManifest)
}
function digestSyntax(expected: string): void {
  if (!/^[a-f0-9]{64}$/.test(expected)) fail('SHA-256 must be 64 lowercase hexadecimal digits')
}
function digest(bytes: Uint8Array, expected: string): void {
  digestSyntax(expected)
  if (createHash('sha256').update(bytes).digest('hex') !== expected) fail('SHA-256 mismatch')
}

function parseJSON(source: string, manifest = false): unknown {
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { fail('invalid JSON') }
  // JSON.parse silently overwrites duplicate fields; serde's manifest structs do
  // not. Scan already-valid JSON tokens, decoding keys before comparing them.
  const stack: Array<{ keys?: Set<string>; expectingKey: boolean; path: string[]; key?: string }> = []
  for (const [token] of source.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    const frame = stack[stack.length - 1]
    const location = frame ? [...frame.path, frame.keys ? frame.key ?? '' : '[]'] : []
    if (token === '{') stack.push({ keys: new Set(), expectingKey: true, path: location })
    else if (token === '[') stack.push({ expectingKey: false, path: location })
    else if (token === '}' || token === ']') stack.pop()
    else if (token === ',' && frame?.keys) frame.expectingKey = true
    else if (token.startsWith('"') && frame?.keys && frame.expectingKey) {
      const key = JSON.parse(token) as string
      if (frame.keys.has(key)) fail('duplicate JSON field')
      frame.keys.add(key)
      frame.key = key
      frame.expectingKey = false
    } else if (manifest && frame?.path.length === 1 && frame.path[0] === 'engine' && frame.key === 'abi'
      && /^-?\d/.test(token) && !/^(0|[1-9]\d*)$/.test(token)) {
      // Serde's u32 rejects floating JSON tokens even when they normalize to 1.
      fail('ABI must be an unsigned integer JSON token')
    }
  }
  return parsed
}

/** Trusted handlers remain trusted code; the VM loader below is not hostile-code isolation. */
export async function createNodeApplication(
  manifest: RuntimeArtifactManifest, grants: NodeDeploymentGrants, handler: RuntimeFetchEntry,
): Promise<Application> {
  const artifactManifest = manifestSnapshot(manifest)
  if (typeof handler !== 'function') fail('entry fetch must be callable')
  const authority = await createRequestAuthority(artifactManifest.capabilities, grants)
  return application(artifactManifest, authority, handler)
}
function application(
  artifactManifest: RuntimeArtifactManifest,
  authority: Awaited<ReturnType<typeof createRequestAuthority>>,
  handler: RuntimeFetchEntry,
  dispose: () => void = () => {},
): Application {
  return Object.freeze({
    artifactManifest,
    manifest: freeze({ name: 'portable-runtime-artifact', services: [] }),
    fetch: (request: Request) => authority.fetch(request, handler),
    close: async () => {
      try { await authority.close() } finally { dispose() }
    },
  })
}

async function bounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    const disk = await lstat(path)
    if (await realpath(path) !== path || disk.isSymbolicLink()
      || disk.dev !== stat.dev || disk.ino !== stat.ino) fail('file identity changed during admission')
    if (!stat.isFile() || stat.size > limit) fail('invalid file or size limit exceeded')
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1))
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null)
      if (!bytesRead) {
        const after = await file.stat()
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail('file changed during admission')
        return bytes.subarray(0, offset)
      }
      offset += bytesRead
    }
    // A file growing during admission must not bypass the bound.
    const extra = Buffer.alloc(1)
    if (offset > limit || (await file.read(extra, 0, 1, null)).bytesRead) fail('file size limit exceeded')
    return bytes.subarray(0, offset)
  } finally { await file.close() }
}
async function canonical(root: string, rootURL: URL, value: string): Promise<string> {
  if (!value.startsWith('./') || /[?#\\]/.test(value)) fail('noncanonical file URL')
  const url = new URL(value, rootURL)
  if (!url.href.startsWith(rootURL.href) || `./${url.href.slice(rootURL.href.length)}` !== value) fail('noncanonical or escaping file URL')
  const path = fileURLToPath(url)
  const rel = relative(root, path)
  let current = root
  for (const part of rel.split(sep)) {
    current = join(current, part)
    if ((await lstat(current)).isSymbolicLink()) fail('symlink alias')
  }
  const resolved = await realpath(path)
  if (pathToFileURL(resolved).href !== url.href) fail('noncanonical file URL')
  return url.href
}

// Source maps are metadata only: no sources, sourceRoot or section URLs are fetched.
function validateMap(value: unknown): void {
  const map = value as Record<string, unknown>
  if (!map || typeof map !== 'object' || map.version !== 3) fail('invalid source map')
  if (Array.isArray(map.sections)) {
    let line = -1; let column = -1
    for (const section of map.sections) {
      const offset = section?.offset
      if (!offset || !Number.isInteger(offset.line) || !Number.isInteger(offset.column)
        || offset.line < 0 || offset.column < 0 || offset.line < line
        || (offset.line === line && offset.column <= column) || !section.map || section.url) fail('invalid source map section')
      line = offset.line; column = offset.column
      validateMap(section.map)
    }
    return
  }
  if (!Array.isArray(map.sources) || map.sources.some(source => typeof source !== 'string')
    || !Array.isArray(map.names) || map.names.some(name => typeof name !== 'string')
    || typeof map.mappings !== 'string' || !/^[A-Za-z0-9+/;,]*$/.test(map.mappings)
    || (map.sourcesContent != null && (!Array.isArray(map.sourcesContent)
      || map.sourcesContent.some(source => source !== null && typeof source !== 'string')))) fail('invalid source map')
  if ((map.file != null && typeof map.file !== 'string')
    || (map.sourceRoot != null && typeof map.sourceRoot !== 'string')) fail('invalid source map')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let source = 0; let originalLine = 0; let originalColumn = 0; let name = 0
  for (const line of (map.mappings as string).split(';')) {
    let generatedColumn = 0
    if (!line) continue
    for (const segment of line.split(',')) {
      const values: number[] = []
      let value = 0; let shift = 0
      for (const char of segment) {
        const digit = alphabet.indexOf(char)
        if (digit < 0 || shift > 30) fail('invalid source map mappings')
        value += (digit & 31) * 2 ** shift
        if (digit & 32) { shift += 5; continue }
        values.push((value & 1 ? -1 : 1) * Math.floor(value / 2))
        value = 0; shift = 0
      }
      if (shift || ![1, 4, 5].includes(values.length)) fail('invalid source map mappings')
      generatedColumn += values[0]!
      if (generatedColumn < 0) fail('invalid source map mappings')
      if (values.length > 1) {
        source += values[1]!; originalLine += values[2]!; originalColumn += values[3]!
        if (source < 0 || source >= map.sources.length || originalLine < 0 || originalColumn < 0) fail('invalid source map mappings')
      }
      if (values.length === 5) {
        name += values[4]!
        if (name < 0 || name >= map.names.length) fail('invalid source map mappings')
      }
    }
  }
}

export async function loadNodeApplication(
  root: string, options: { manifestSha256: string; grants: NodeDeploymentGrants },
): Promise<Application> {
  try {
    return await admitNodeApplication(root, options)
  } catch (error) {
    // OS errors include absolute deployment paths. Never surface those as
    // application diagnostics or attach an unredacted cause.
    if (error && typeof error === 'object' && 'code' in error) fail('artifact file access failed')
    throw error
  }
}

async function admitNodeApplication(
  root: string, options: { manifestSha256: string; grants: NodeDeploymentGrants },
): Promise<Application> {
  root = await realpath(root)
  const rootURL = pathToFileURL(`${root}${sep}`)
  const raw = await bounded(join(root, 'manifest.json'), MiB)
  digest(raw, options.manifestSha256)
  const manifest = manifestSnapshot(parseJSON(text.decode(raw), true))
  // Admit authority before any application module can evaluate.
  const authority = await createRequestAuthority(manifest.capabilities, options.grants)
  try {
    const entry = await canonical(root, rootURL, manifest.entry)
    const files = new Map<string, RuntimeArtifactManifest['files'][number]>()
    for (const file of manifest.files) {
      const url = await canonical(root, rootURL, file.url)
      if (file.url === './manifest.json' || files.has(url)) fail('duplicate canonical file identity')
      files.set(url, file)
    }
    if (files.get(entry)?.kind !== 'module') fail('entry must be an indexed module')
    const sources = new Map<string, string>()
    const maps = new Map<string, string>()
    const snapshot = new Map<string, Buffer>()
    let total = 0; let modules = 0; let mapBytes = 0
    for (const [url, file] of files) {
      const kind = file.kind as string
      const bytes = await bounded(fileURLToPath(url), kind === 'module' ? 8 * MiB : kind === 'asset' ? 16 * MiB : MiB)
      digest(bytes, file.sha256)
      snapshot.set(url, bytes)
      total += bytes.length
      if (total > 128 * MiB) fail('snapshot exceeds 128 MiB')
      if (kind === 'module') {
        modules += bytes.length
        if (modules > 64 * MiB) fail('module sources exceed 64 MiB')
        sources.set(url, text.decode(bytes))
      } else if (kind === 'source_map') {
        mapBytes += bytes.length
        if (mapBytes > 8 * MiB) fail('source maps exceed 8 MiB')
        const target = await canonical(root, rootURL, file.for!)
        if (files.get(target)?.kind !== 'module' || maps.has(target)) fail('invalid source map target')
        validateMap(parseJSON(text.decode(bytes)))
        maps.set(target, url)
      }
    }
    for (const [url, source] of sources) {
      const last = source.trimEnd().split(/\r?\n/).pop()!.trim()
      if (last.startsWith('//# sourceMappingURL=')
        && new URL(last.slice('//# sourceMappingURL='.length).trim(), url).href !== maps.get(url)) fail('sourceMappingURL disagrees with indexed map')
    }
    if (typeof vm.SourceTextModule !== 'function') fail('Node requires --experimental-vm-modules')
    const context = vm.createContext({
      Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
      AbortController, AbortSignal, ReadableStream, WritableStream, TransformStream,
    })
    const graph = new Map<string, vm.SourceTextModule>()
    const moduleURLs = new WeakMap<vm.Module, string>()
    const evaluations = new Map<vm.SourceTextModule, Promise<void>>()
    const resolve = (specifier: string, parent: string): vm.SourceTextModule => {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) fail('module import must be relative and indexed')
      if (/[?#\\]/.test(specifier)) fail('invalid module import')
      const url = new URL(specifier, parent).href
      const module = graph.get(url)
      if (!module) fail('module import is outside indexed graph')
      return module
    }
    for (const [url, source] of sources) {
      const module = new vm.SourceTextModule(source, {
        context, identifier: `kunlun-artifact:///${url.slice(rootURL.href.length)}`,
        importModuleDynamically: async (specifier, referencing) => {
          const module = resolve(specifier, moduleURLs.get(referencing)!)
          let evaluation = evaluations.get(module)
          if (!evaluation) {
            evaluation = Promise.resolve().then(async () => {
              if (module.status === 'unlinked') await module.link((s, r) => resolve(s, moduleURLs.get(r)!))
              if (module.status === 'linked' || module.status === 'evaluating') await module.evaluate()
              if (module.status === 'errored') throw module.error
            })
            evaluations.set(module, evaluation)
          }
          await evaluation
          return module
        },
      })
      graph.set(url, module)
      moduleURLs.set(module, url)
    }
    const module = graph.get(entry)!
    await module.link((specifier, referencing) => resolve(specifier, moduleURLs.get(referencing)!))
    await module.evaluate()
    const entryObject = (module.namespace as Record<string, unknown>).default
    if (!entryObject || typeof entryObject !== 'object'
      || typeof (entryObject as { fetch?: unknown }).fetch !== 'function') fail('entry requires a default object with callable fetch')
    const handler = (entryObject as { fetch: (request: Request, env: unknown, ctx: object) => Response | Promise<Response> }).fetch
    const dispatch: RuntimeFetchEntry = (request, env, context) => handler.call(entryObject, request, env, context)
    return application(manifest, authority, dispatch, () => {
      snapshot.clear()
      sources.clear()
      maps.clear()
      graph.clear()
      evaluations.clear()
    })
  } catch (error) {
    await authority.close()
    throw error
  }
}
