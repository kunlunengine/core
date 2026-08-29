import { readdir, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

const DEFAULT_EXTENSIONS = Object.freeze([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
])

export const ROUTE_HANDLER_METHODS = Object.freeze([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const)

export type RouteHandlerMethod = (typeof ROUTE_HANDLER_METHODS)[number]

export type AppRouteDiagnosticCode =
  | 'APP_DIRECTORY_NOT_FOUND'
  | 'DUPLICATE_CONVENTION'
  | 'DUPLICATE_DYNAMIC_PARAMETER'
  | 'DUPLICATE_ROUTE_PATTERN'
  | 'INVALID_DYNAMIC_SEGMENT'
  | 'ROUTE_KIND_CONFLICT'

export interface AppRouteDiagnostic {
  code: AppRouteDiagnosticCode
  message: string
  sources: readonly string[]
}

export interface StaticAppRouteSegment {
  kind: 'static'
  value: string
}

export interface DynamicAppRouteSegment {
  kind: 'dynamic'
  name: string
}

export type AppRouteSegment = StaticAppRouteSegment | DynamicAppRouteSegment

interface DiscoveredRouteBase {
  path: string
  source: string
  segments: readonly AppRouteSegment[]
  params: readonly string[]
}

export interface DiscoveredPageRoute extends DiscoveredRouteBase {
  kind: 'page'
  layouts: readonly string[]
}

export interface DiscoveredRouteHandler extends DiscoveredRouteBase {
  kind: 'route'
}

export type DiscoveredAppRoute = DiscoveredPageRoute | DiscoveredRouteHandler

export interface DiscoveredLayout extends DiscoveredRouteBase {
  kind: 'layout'
}

export interface AppRouteManifest {
  appDir: string
  layouts: readonly DiscoveredLayout[]
  routes: readonly DiscoveredAppRoute[]
}

export interface DiscoverAppRoutesOptions {
  appDir: string
  extensions?: readonly string[]
}

export interface RouteHandlerContext {
  params: Readonly<Record<string, string>>
}

export type FetchRouteHandler = (
  request: Request,
  context: RouteHandlerContext,
) => Response | Promise<Response>

export type RouteHandlerModule = Readonly<Partial<Record<RouteHandlerMethod, FetchRouteHandler>>>

export type RouteHandlerModuleErrorCode =
  | 'INVALID_ROUTE_HANDLER_EXPORT'
  | 'MISSING_ROUTE_HANDLER_EXPORT'

export class AppRouteDiscoveryError extends Error {
  readonly diagnostics: readonly AppRouteDiagnostic[]

  constructor(diagnostics: readonly AppRouteDiagnostic[]) {
    const frozenDiagnostics = Object.freeze(diagnostics.map(freezeDiagnostic))
    super(formatDiagnostics(frozenDiagnostics))
    this.name = 'AppRouteDiscoveryError'
    this.diagnostics = frozenDiagnostics
  }
}

export class RouteHandlerModuleError extends Error {
  readonly code: RouteHandlerModuleErrorCode
  readonly source: string
  readonly exportName?: RouteHandlerMethod

  constructor(
    code: RouteHandlerModuleErrorCode,
    source: string,
    message: string,
    exportName?: RouteHandlerMethod,
  ) {
    super(message)
    this.name = 'RouteHandlerModuleError'
    this.code = code
    this.source = source
    if (exportName !== undefined) this.exportName = exportName
  }
}

/**
 * Discover the v0.2 app-directory conventions without importing application modules.
 * Returned source paths are POSIX-style and relative to `appDir`, so the manifest is stable
 * across checkout locations and operating systems.
 */
export async function discoverAppRoutes(
  options: DiscoverAppRoutesOptions,
): Promise<AppRouteManifest> {
  const appDir = resolve(options.appDir)
  const extensions = normalizeExtensions(options.extensions ?? DEFAULT_EXTENSIONS)
  await assertAppDirectory(appDir)

  const buckets = new Map<string, ConventionBucket>()
  await collectConventions(appDir, [], extensions, buckets)

  const diagnostics: AppRouteDiagnostic[] = []
  const directories = [...buckets.values()]
    .sort((left, right) => compareSources(left.sources, right.sources))
    .map((bucket) => validateDirectory(bucket, diagnostics))

  const layoutsByDirectory = new Map<string, DiscoveredLayout>()
  for (const directory of directories) {
    if (directory.layout === undefined || directory.parsed === undefined) continue
    layoutsByDirectory.set(
      directoryKey(directory.directorySegments),
      freezeLayout(directory.layout, directory.parsed),
    )
  }

  const routes: DiscoveredAppRoute[] = []
  for (const directory of directories) {
    const { page, parsed, route } = directory
    if (parsed === undefined) continue

    if (page !== undefined && route !== undefined) {
      diagnostics.push({
        code: 'ROUTE_KIND_CONFLICT',
        message: `Page and route handler both claim ${parsed.path}`,
        sources: [page, route],
      })
      continue
    }

    if (page !== undefined) {
      const layouts: string[] = []
      for (let depth = 0; depth <= directory.directorySegments.length; depth += 1) {
        const layout = layoutsByDirectory.get(
          directoryKey(directory.directorySegments.slice(0, depth)),
        )
        if (layout !== undefined) layouts.push(layout.source)
      }
      routes.push(freezePage(page, parsed, layouts))
    }

    if (route !== undefined) routes.push(freezeRouteHandler(route, parsed))
  }

  validateRoutePatterns(routes, diagnostics)
  if (diagnostics.length > 0) throw new AppRouteDiscoveryError(diagnostics)

  return Object.freeze({
    appDir,
    layouts: Object.freeze(
      [...layoutsByDirectory.values()].sort((left, right) => compareRoutes(left, right)),
    ),
    routes: Object.freeze(routes.sort(compareRoutes)),
  })
}

/**
 * Validate a loaded `route.*` module and retain only supported Fetch handler exports.
 */
export function validateRouteHandlerModule(
  module: unknown,
  source = '<route module>',
): RouteHandlerModule {
  if ((typeof module !== 'object' && typeof module !== 'function') || module === null) {
    throw new RouteHandlerModuleError(
      'MISSING_ROUTE_HANDLER_EXPORT',
      source,
      `Route handler module "${source}" must export at least one HTTP method`,
    )
  }

  const record = module as Record<string, unknown>
  const handlers: Partial<Record<RouteHandlerMethod, FetchRouteHandler>> = {}
  for (const method of ROUTE_HANDLER_METHODS) {
    if (!Object.prototype.hasOwnProperty.call(record, method)) continue
    const candidate = record[method]
    if (typeof candidate !== 'function') {
      throw new RouteHandlerModuleError(
        'INVALID_ROUTE_HANDLER_EXPORT',
        source,
        `Route handler export ${method} in "${source}" must be a function`,
        method,
      )
    }
    handlers[method] = candidate as FetchRouteHandler
  }

  if (Object.keys(handlers).length === 0) {
    throw new RouteHandlerModuleError(
      'MISSING_ROUTE_HANDLER_EXPORT',
      source,
      `Route handler module "${source}" must export at least one of ${ROUTE_HANDLER_METHODS.join(', ')}`,
    )
  }

  return Object.freeze(handlers)
}

type ConventionKind = 'layout' | 'page' | 'route'

interface ConventionBucket {
  directorySegments: readonly string[]
  layout: string[]
  page: string[]
  route: string[]
  sources: string[]
}

interface ParsedDirectory {
  path: string
  segments: readonly AppRouteSegment[]
  params: readonly string[]
}

interface ValidatedDirectory {
  directorySegments: readonly string[]
  layout?: string
  page?: string
  route?: string
  parsed?: ParsedDirectory
}

async function assertAppDirectory(appDir: string): Promise<void> {
  try {
    if ((await stat(appDir)).isDirectory()) return
  } catch (error) {
    if (!isMissingFileError(error)) throw error
  }

  throw new AppRouteDiscoveryError([{
    code: 'APP_DIRECTORY_NOT_FOUND',
    message: `App directory does not exist or is not a directory: ${appDir}`,
    sources: [],
  }])
}

async function collectConventions(
  absoluteDirectory: string,
  directorySegments: readonly string[],
  extensions: ReadonlySet<string>,
  buckets: Map<string, ConventionBucket>,
): Promise<void> {
  const entries = (await readdir(absoluteDirectory, { withFileTypes: true }))
    .sort((left, right) => compareText(left.name, right.name))

  for (const entry of entries) {
    if (entry.isDirectory()) {
      await collectConventions(
        resolve(absoluteDirectory, entry.name),
        [...directorySegments, entry.name],
        extensions,
        buckets,
      )
      continue
    }
    if (!entry.isFile()) continue

    const extension = extname(entry.name).toLowerCase()
    if (!extensions.has(extension)) continue
    const kind = conventionKind(entry.name.slice(0, -extension.length))
    if (kind === undefined) continue

    const key = directoryKey(directorySegments)
    const bucket = buckets.get(key) ?? {
      directorySegments: Object.freeze([...directorySegments]),
      layout: [],
      page: [],
      route: [],
      sources: [],
    }
    const source = toSource([...directorySegments, entry.name])
    bucket[kind].push(source)
    bucket.sources.push(source)
    buckets.set(key, bucket)
  }
}

function validateDirectory(
  bucket: ConventionBucket,
  diagnostics: AppRouteDiagnostic[],
): ValidatedDirectory {
  const layout = selectConvention('layout', bucket.layout, diagnostics)
  const page = selectConvention('page', bucket.page, diagnostics)
  const route = selectConvention('route', bucket.route, diagnostics)
  const parsed = parseDirectory(bucket.directorySegments, bucket.sources, diagnostics)

  return {
    directorySegments: bucket.directorySegments,
    ...(layout === undefined ? {} : { layout }),
    ...(page === undefined ? {} : { page }),
    ...(route === undefined ? {} : { route }),
    ...(parsed === undefined ? {} : { parsed }),
  }
}

function selectConvention(
  kind: ConventionKind,
  sources: readonly string[],
  diagnostics: AppRouteDiagnostic[],
): string | undefined {
  if (sources.length === 0) return undefined
  const sorted = [...sources].sort()
  if (sorted.length > 1) {
    diagnostics.push({
      code: 'DUPLICATE_CONVENTION',
      message: `Multiple ${kind} modules exist in the same route directory`,
      sources: sorted,
    })
  }
  return sorted[0]
}

function parseDirectory(
  directorySegments: readonly string[],
  sources: readonly string[],
  diagnostics: AppRouteDiagnostic[],
): ParsedDirectory | undefined {
  const segments: AppRouteSegment[] = []
  const params: string[] = []
  let valid = true

  for (const value of directorySegments) {
    if (!value.includes('[') && !value.includes(']')) {
      segments.push(Object.freeze({ kind: 'static', value }))
      continue
    }

    const match = /^\[([A-Za-z][A-Za-z0-9_]*)\]$/.exec(value)
    if (match === null) {
      diagnostics.push({
        code: 'INVALID_DYNAMIC_SEGMENT',
        message: `Dynamic segment "${value}" must use the form [name]; catch-all and optional segments are not supported in v0.2`,
        sources: [...sources].sort(),
      })
      valid = false
      continue
    }

    const name = match[1] as string
    if (params.includes(name)) {
      diagnostics.push({
        code: 'DUPLICATE_DYNAMIC_PARAMETER',
        message: `Dynamic parameter "${name}" appears more than once in the same route`,
        sources: [...sources].sort(),
      })
      valid = false
      continue
    }

    params.push(name)
    segments.push(Object.freeze({ kind: 'dynamic', name }))
  }

  if (!valid) return undefined
  const path = segments.length === 0
    ? '/'
    : `/${segments.map((segment) => segment.kind === 'static'
      ? encodeURIComponent(segment.value)
      : `:${segment.name}`).join('/')}`

  return {
    path,
    segments: Object.freeze(segments),
    params: Object.freeze(params),
  }
}

function validateRoutePatterns(
  routes: readonly DiscoveredAppRoute[],
  diagnostics: AppRouteDiagnostic[],
): void {
  const patterns = new Map<string, DiscoveredAppRoute[]>()
  for (const route of routes) {
    const key = route.segments.length === 0
      ? '/'
      : `/${route.segments.map((segment) => segment.kind === 'static' ? `s:${segment.value}` : 'd:').join('/')}`
    const matches = patterns.get(key) ?? []
    matches.push(route)
    patterns.set(key, matches)
  }

  for (const matches of patterns.values()) {
    if (matches.length < 2) continue
    diagnostics.push({
      code: 'DUPLICATE_ROUTE_PATTERN',
      message: `Multiple routes match the same URL pattern: ${matches.map((route) => route.path).join(', ')}`,
      sources: matches.map((route) => route.source).sort(),
    })
  }
}

function freezeLayout(source: string, parsed: ParsedDirectory): DiscoveredLayout {
  return Object.freeze({
    kind: 'layout',
    path: parsed.path,
    source,
    segments: parsed.segments,
    params: parsed.params,
  })
}

function freezePage(
  source: string,
  parsed: ParsedDirectory,
  layouts: readonly string[],
): DiscoveredPageRoute {
  return Object.freeze({
    kind: 'page',
    path: parsed.path,
    source,
    segments: parsed.segments,
    params: parsed.params,
    layouts: Object.freeze([...layouts]),
  })
}

function freezeRouteHandler(
  source: string,
  parsed: ParsedDirectory,
): DiscoveredRouteHandler {
  return Object.freeze({
    kind: 'route',
    path: parsed.path,
    source,
    segments: parsed.segments,
    params: parsed.params,
  })
}

function normalizeExtensions(extensions: readonly string[]): ReadonlySet<string> {
  if (extensions.length === 0) throw new TypeError('At least one app module extension is required')
  const normalized = extensions.map((extension) => {
    const trimmed = extension.trim().toLowerCase()
    if (!/^\.[a-z0-9]+$/.test(trimmed)) {
      throw new TypeError(`Invalid app module extension: "${extension}"`)
    }
    return trimmed
  })
  return new Set(normalized)
}

function conventionKind(basename: string): ConventionKind | undefined {
  if (basename === 'layout' || basename === 'page' || basename === 'route') return basename
  return undefined
}

function freezeDiagnostic(diagnostic: AppRouteDiagnostic): AppRouteDiagnostic {
  return Object.freeze({
    ...diagnostic,
    sources: Object.freeze([...diagnostic.sources]),
  })
}

function formatDiagnostics(diagnostics: readonly AppRouteDiagnostic[]): string {
  const summary = `App route discovery failed with ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'}`
  return [summary, ...diagnostics.map((diagnostic) => {
    const sources = diagnostic.sources.length === 0 ? '' : ` (${diagnostic.sources.join(', ')})`
    return `- [${diagnostic.code}] ${diagnostic.message}${sources}`
  })].join('\n')
}

function compareRoutes(
  left: Pick<DiscoveredRouteBase, 'path' | 'source'>,
  right: Pick<DiscoveredRouteBase, 'path' | 'source'>,
): number {
  return compareText(left.path, right.path) || compareText(left.source, right.source)
}

function compareSources(left: readonly string[], right: readonly string[]): number {
  return compareText(left[0] ?? '', right[0] ?? '')
}

function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function directoryKey(segments: readonly string[]): string {
  return segments.join('\u0000')
}

function toSource(parts: readonly string[]): string {
  return parts.join('/')
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && ((error as { code?: unknown }).code === 'ENOENT'
      || (error as { code?: unknown }).code === 'ENOTDIR')
}
