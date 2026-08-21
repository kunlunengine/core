import type { ApplicationManifest } from '@kunlun-js/build-api'

export type RuntimeMode = 'development' | 'production' | 'test'
export type CorsSetting = boolean | string | readonly string[]

export interface CapabilityProvider {
  has(name: string): boolean
  get<T = unknown>(name: string): T | undefined
  snapshot(): Readonly<Record<string, unknown>>
}

export class MissingRuntimeCapabilityError extends Error {
  readonly capability: string

  constructor(capability: string) {
    super(`Runtime capability "${capability}" is not available`)
    this.name = 'MissingRuntimeCapabilityError'
    this.capability = capability
  }
}

export class CapabilityRegistry implements CapabilityProvider {
  readonly #values = new Map<string, unknown>()

  constructor(initial: Readonly<Record<string, unknown>> = {}) {
    for (const [name, value] of Object.entries(initial)) this.bind(name, value)
  }

  bind(name: string, value: unknown): this {
    assertCapabilityName(name)
    this.#values.set(name, value)
    return this
  }

  delete(name: string): boolean {
    return this.#values.delete(name)
  }

  has(name: string): boolean {
    return this.#values.has(name)
  }

  get<T = unknown>(name: string): T | undefined {
    return this.#values.get(name) as T | undefined
  }

  require<T = unknown>(name: string): T {
    if (!this.#values.has(name)) throw new MissingRuntimeCapabilityError(name)
    return this.#values.get(name) as T
  }

  snapshot(): Readonly<Record<string, unknown>> {
    return Object.freeze(Object.fromEntries(this.#values))
  }
}

export interface RuntimeApplication {
  manifest: ApplicationManifest
  fetch(request: Request): Promise<Response>
}

export interface RuntimeStartOptions {
  host?: string
  port?: number
  mode?: RuntimeMode
  cors?: CorsSetting
  shutdownGracePeriodMs?: number
  signal?: AbortSignal
  onError?: (error: unknown, request?: Request) => void | Promise<void>
}

export interface RuntimeAddress {
  host: string
  port: number
  family: string
}

export interface RuntimeServer {
  readonly adapter: string
  readonly address: RuntimeAddress
  readonly url: string
  fetch(request: Request): Promise<Response>
  close(): Promise<void>
}

export interface RuntimeAdapter {
  readonly name: string
  readonly displayName: string
  start(application: RuntimeApplication, options?: RuntimeStartOptions): Promise<RuntimeServer>
}

export function toCapabilityRecord(
  capabilities: Readonly<Record<string, unknown>> | CapabilityProvider | undefined,
): Readonly<Record<string, unknown>> {
  return capabilities && isCapabilityProvider(capabilities)
    ? capabilities.snapshot()
    : capabilities ?? Object.freeze({})
}

function isCapabilityProvider(value: object): value is CapabilityProvider {
  return 'snapshot' in value && typeof value.snapshot === 'function'
}

function assertCapabilityName(name: string): void {
  if (!name.trim()) throw new TypeError('Capability name cannot be empty')
}
