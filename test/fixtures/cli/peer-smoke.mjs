import assert from 'node:assert/strict'
import config from './kunlun.config.mjs'

// Validate development-only peer resolution in the installed legacy scaffold.
// This is not the filesystem/full-stack reference-app release gate.
const session = await config.builder.createSession({ root: process.cwd(), mode: 'development' })
let dev
try {
  dev = await session.serve({ ...config.targets[0], port: 0 })
  assert.equal(dev.engine, config.builder.name)
  assert.equal(typeof dev.middleware, 'function')
  assert.match(dev.urls[0], /^http:\/\//)
  console.log(`✓ packed CLI: ${dev.engine} generated scaffold resolves peers and opens a dev session`)
} finally {
  await dev?.close()
  await session.close()
}
