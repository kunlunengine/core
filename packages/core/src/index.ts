import type {
  ApplicationManifest,
  BuildConsumer,
  BuildEngine,
  BuildRequest,
} from '@kunlun-js/build-api'
import {
  toCapabilityRecord,
  type CapabilityProvider,
  type RuntimeAdapter,
  type RuntimeApplication,
  type RuntimeStartOptions,
} from '@kunlun-js/runtime-api'

export type { ApplicationManifest, BuildEngine, BuildCapabilities } from '@kunlun-js/build-api'
export {
  CapabilityRegistry,
  MissingRuntimeCapabilityError,
  type CapabilityProvider,
  type CorsSetting,
  type RuntimeAdapter,
  type RuntimeAddress,
  type RuntimeApplication,
  type RuntimeMode,
  type RuntimeServer,
  type RuntimeStartOptions,
} from '@kunlun-js/runtime-api'

export interface CapabilityRequirement {
  name: string
  optional?: boolean
  operations?: readonly string[]
}

export interface RouteContext {
  request: Request
  params: Readonly<Record<string, string>>
  capabilities: Readonly<Record<string, unknown>>
  service: string
}

export type RouteHandler = (context: RouteContext) => Response | Promise<Response>

export interface RouteDefinition {
  method: string
  path: string
  handler: RouteHandler
}

export interface ServiceDefinition {
  name: string
  basePath?: string
  capabilities?: readonly CapabilityRequirement[]
  routes: readonly RouteDefinition[]
}

export interface ApplicationDefinition {
  name: string
  version?: string
  services: readonly ServiceDefinition[]
}

export interface TargetDefinition extends BuildRequest {
  consumer: BuildConsumer
}

export interface KunlunConfig {
  application: ApplicationDefinition
  builder: BuildEngine
  targets?: readonly TargetDefinition[]
  runtime?: RuntimeAdapter
  runtimeOptions?: RuntimeStartOptions
  capabilities?: Readonly<Record<string, unknown>> | CapabilityProvider
}

export interface RequestHandlerOptions {
  capabilities?: Readonly<Record<string, unknown>> | CapabilityProvider
}

export class MissingCapabilityError extends Error {
  readonly service: string
  readonly capability: string

  constructor(service: string, capability: string) {
    super(`Service "${service}" requires capability "${capability}"`)
    this.name = 'MissingCapabilityError'
    this.service = service
    this.capability = capability
  }
}

export function capability(
  name: string,
  options: Omit<CapabilityRequirement, 'name'> = {},
): CapabilityRequirement {
  assertIdentifier(name, 'Capability')
  return Object.freeze({ name, ...options })
}

export function route(method: string, path: string, handler: RouteHandler): RouteDefinition {
  const normalizedMethod = method.trim().toUpperCase()
  if (!normalizedMethod) throw new TypeError('Route method cannot be empty')
  if (typeof handler !== 'function') throw new TypeError('Route handler must be a function')
  return Object.freeze({ method: normalizedMethod, path: normalizePath(path), handler })
}

export function defineService(definition: ServiceDefinition): ServiceDefinition {
  assertIdentifier(definition.name, 'Service')
  if (!Array.isArray(definition.routes)) throw new TypeError('Service routes must be an array')

  const normalizedRoutes = definition.routes.map((item) => route(item.method, item.path, item.handler))
  const normalizedCapabilities = (definition.capabilities ?? []).map((item) => {
    assertIdentifier(item.name, 'Capability')
    return Object.freeze({
      name: item.name,
      ...(item.optional === undefined ? {} : { optional: item.optional }),
      ...(item.operations === undefined ? {} : { operations: Object.freeze([...item.operations]) }),
    })
  })
  const seen = new Set<string>()
  for (const item of normalizedRoutes) {
    const key = `${item.method} ${normalizePath(item.path)}`
    if (seen.has(key)) throw new TypeError(`Duplicate route in service "${definition.name}": ${key}`)
    seen.add(key)
  }
  const capabilityNames = new Set<string>()
  for (const item of normalizedCapabilities) {
    if (capabilityNames.has(item.name)) {
      throw new TypeError(`Duplicate capability in service "${definition.name}": ${item.name}`)
    }
    capabilityNames.add(item.name)
  }

  return Object.freeze({
    ...definition,
    ...(definition.basePath === undefined ? {} : { basePath: normalizePath(definition.basePath) }),
    capabilities: Object.freeze(normalizedCapabilities),
    routes: Object.freeze(normalizedRoutes),
  })
}

export function defineApplication(definition: ApplicationDefinition): ApplicationDefinition {
  assertIdentifier(definition.name, 'Application')
  if (!Array.isArray(definition.services) || definition.services.length === 0) {
    throw new TypeError('Application must contain at least one service')
  }

  const serviceNames = new Set<string>()
  const routes = new Set<string>()
  const services = definition.services.map((service) => defineService(service))

  for (const service of services) {
    if (serviceNames.has(service.name)) throw new TypeError(`Duplicate service: ${service.name}`)
    serviceNames.add(service.name)

    for (const item of service.routes) {
      const fullPath = joinPaths(service.basePath, item.path)
      const key = `${item.method} ${fullPath}`
      if (routes.has(key)) throw new TypeError(`Duplicate application route: ${key}`)
      routes.add(key)
    }
  }

  return Object.freeze({ ...definition, services: Object.freeze(services) })
}

export function defineConfig(config: KunlunConfig): KunlunConfig {
  if (!config.builder?.name) throw new TypeError('A build engine is required')
  const application = defineApplication(config.application)
  const targets = Object.freeze([...(config.targets ?? defaultTargets())])

  const names = new Set<string>()
  for (const target of targets) {
    assertIdentifier(target.name, 'Build target')
    if (names.has(target.name)) throw new TypeError(`Duplicate build target: ${target.name}`)
    names.add(target.name)
    if (!target.outDir) throw new TypeError(`Build target "${target.name}" requires outDir`)
  }

  return Object.freeze({
    application,
    builder: config.builder,
    targets,
    ...(config.runtime === undefined ? {} : { runtime: config.runtime }),
    ...(config.runtimeOptions === undefined ? {} : { runtimeOptions: Object.freeze({ ...config.runtimeOptions }) }),
    ...(config.capabilities === undefined ? {} : { capabilities: config.capabilities }),
  })
}

export function createApplicationManifest(application: ApplicationDefinition): ApplicationManifest {
  return {
    name: application.name,
    ...(application.version === undefined ? {} : { version: application.version }),
    services: application.services.map((service) => ({
      name: service.name,
      capabilities: (service.capabilities ?? []).map((item) => ({
        name: item.name,
        optional: item.optional ?? false,
        operations: [...(item.operations ?? [])],
      })),
      routes: service.routes.map((item) => ({
        method: item.method,
        path: joinPaths(service.basePath, item.path),
      })),
    })),
  }
}

export function createRequestHandler(
  application: ApplicationDefinition,
  options: RequestHandlerOptions = {},
): (request: Request) => Promise<Response> {
  const capabilities = toCapabilityRecord(options.capabilities)
  const compiled = application.services.flatMap((service) => {
    for (const requirement of service.capabilities ?? []) {
      if (!requirement.optional && !(requirement.name in capabilities)) {
        throw new MissingCapabilityError(service.name, requirement.name)
      }
    }

    return service.routes.map((item) => {
      const path = joinPaths(service.basePath, item.path)
      return { service: service.name, route: item, path, pattern: compilePath(path) }
    })
  })

  return async (request) => {
    const pathname = new URL(request.url).pathname
    let pathMatched = false

    for (const candidate of compiled) {
      const match = candidate.pattern.regexp.exec(pathname)
      if (!match) continue
      pathMatched = true
      if (candidate.route.method !== request.method.toUpperCase()) continue

      const params = Object.fromEntries(
        candidate.pattern.names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? '')]),
      )
      return candidate.route.handler({
        request,
        params: Object.freeze(params),
        capabilities,
        service: candidate.service,
      })
    }

    return new Response(pathMatched ? 'Method Not Allowed' : 'Not Found', {
      status: pathMatched ? 405 : 404,
    })
  }
}

export function createRuntimeApplication(
  application: ApplicationDefinition,
  options: RequestHandlerOptions = {},
): RuntimeApplication {
  const fetch = createRequestHandler(application, options)
  return Object.freeze({
    manifest: createApplicationManifest(application),
    fetch,
  })
}

function defaultTargets(): TargetDefinition[] {
  return [
    {
      name: 'client',
      consumer: 'client',
      entries: { main: 'index.html' },
      outDir: 'dist/client',
    },
  ]
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(value)) {
    throw new TypeError(`${label} name "${value}" is invalid`)
  }
}

function normalizePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return '/'
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, '') : prefixed
}

function joinPaths(basePath: string | undefined, path: string): string {
  if (!basePath || basePath === '/') return normalizePath(path)
  if (path === '/') return normalizePath(basePath)
  return normalizePath(`${normalizePath(basePath)}/${path.replace(/^\/+/, '')}`)
}

function compilePath(path: string): { regexp: RegExp; names: string[] } {
  const names: string[] = []
  const segments = normalizePath(path).split('/').filter(Boolean)
  const source = segments
    .map((segment) => {
      if (segment.startsWith(':')) {
        const name = segment.slice(1)
        assertIdentifier(name, 'Route parameter')
        names.push(name)
        return '([^/]+)'
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { regexp: new RegExp(`^/${source}/?$`), names }
}
