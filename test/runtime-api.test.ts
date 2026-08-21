import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  MissingRuntimeCapabilityError,
  toCapabilityRecord,
} from '../packages/runtime-api/src/index.js'

describe('runtime capability registry', () => {
  it('binds, resolves, snapshots, and removes explicit capabilities', () => {
    const database = { query: () => 'ok' }
    const capabilities = new CapabilityRegistry({ logger: console }).bind('database.orders', database)

    expect(capabilities.has('database.orders')).toBe(true)
    expect(capabilities.require('database.orders')).toBe(database)
    expect(toCapabilityRecord(capabilities)['database.orders']).toBe(database)
    expect(Object.isFrozen(capabilities.snapshot())).toBe(true)
    expect(capabilities.delete('database.orders')).toBe(true)
    expect(() => capabilities.require('database.orders')).toThrow(MissingRuntimeCapabilityError)
  })
})
