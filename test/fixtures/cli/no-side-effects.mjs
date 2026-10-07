// Preload before the packed CLI: reads are allowed, but creation must never
// install packages, contact the network, or start a listener. Dry runs must
// additionally never mutate the filesystem.
import fs from 'node:fs'
import promises from 'node:fs/promises'
import childProcess from 'node:child_process'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import http2 from 'node:http2'
import dgram from 'node:dgram'
import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import workerThreads from 'node:worker_threads'
import { syncBuiltinESMExports } from 'node:module'

const expectedDenial = process.env.KUNLUN_PACKED_EXPECT_DENIAL
let observedExpectedDenial = false
if (expectedDenial) {
  process.on('exit', () => {
    if (!observedExpectedDenial) {
      process.stderr.write(`Packed CLI side-effect guard: expected ${expectedDenial} was not attempted\n`)
      process.exitCode = 1
    }
  })
}

function deny(label) {
  return function () {
    const message = `Packed CLI side-effect guard: ${label}`
    // An implementation must not be able to hide an attempted side effect by
    // catching the exception and continuing to print a successful plan. One
    // explicitly expected denial is silent to test structured write failures.
    if (label === expectedDenial) observedExpectedDenial = true
    else process.stderr.write(`${message}\n`)
    throw new Error(message)
  }
}

function block(target, names, label) {
  for (const name of names) {
    if (typeof target[name] === 'function') target[name] = deny(`${label}.${name}`)
  }
}

if (process.env.KUNLUN_PACKED_ALLOW_WRITES !== '1') {
  const mutations = [
    'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'fchmod', 'fchown',
    'fdatasync', 'fsync', 'ftruncate', 'futimes', 'lchmod', 'lchown',
    'link', 'lutimes', 'mkdir', 'mkdtemp', 'rename', 'rm', 'rmdir',
    'symlink', 'truncate', 'unlink', 'utimes', 'write', 'writeFile', 'writev',
  ]
  block(fs, [...mutations, ...mutations.map((name) => `${name}Sync`), 'createWriteStream'], 'fs')
  block(promises, mutations, 'fs/promises')
  for (const [target, name] of [[fs, 'open'], [fs, 'openSync'], [promises, 'open']]) {
    const original = target[name]
    target[name] = function (file, flags, ...rest) {
      const numericWrites = fs.constants.O_WRONLY | fs.constants.O_RDWR |
        fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND
      if (typeof flags === 'number' ? (flags & numericWrites) !== 0 : /[wa+]/.test(flags ?? 'r')) {
        return deny(`fs.${name} with writable flags`)()
      }
      return original.call(this, file, flags, ...rest)
    }
  }
  const open = promises.open
  promises.open = async function (...args) {
    const handle = await open(...args)
    block(handle, [
      'appendFile', 'chmod', 'chown', 'createWriteStream', 'datasync', 'sync',
      'truncate', 'utimes', 'write', 'writeFile', 'writev',
    ], 'FileHandle')
    return handle
  }
}

block(childProcess, ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork'], 'child_process')
block(workerThreads, ['Worker'], 'worker_threads')
block(net, ['connect', 'createConnection', 'createServer'], 'net')
block(net.Socket.prototype, ['connect'], 'net.Socket')
block(net.Server.prototype, ['listen'], 'net.Server')
block(tls, ['connect', 'createServer'], 'tls')
for (const [module, name] of [[http, 'http'], [https, 'https']]) {
  block(module, ['request', 'get', 'createServer'], name)
}
block(http2, ['connect', 'createServer', 'createSecureServer'], 'http2')
block(dgram, ['createSocket'], 'dgram')
block(dgram.Socket.prototype, ['bind', 'connect', 'send'], 'dgram.Socket')
for (const [module, name] of [[dns, 'dns'], [dnsPromises, 'dns/promises']]) {
  block(module, Object.keys(module).filter((key) => /^(lookup|resolve|reverse)/.test(key)), name)
}
globalThis.fetch = deny('fetch')
syncBuiltinESMExports()
