import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../packages/cli/src/run.js'

describe('kunlun CLI', () => {
  it('scaffolds the selected build engine even when options precede the destination', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'kunlun-cli-'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await runCli(['new', '--builder', 'vite', 'hello'], parent)
      const packageJson = JSON.parse(await readFile(path.join(parent, 'hello/package.json'), 'utf8'))
      const config = await readFile(path.join(parent, 'hello/kunlun.config.mjs'), 'utf8')
      const client = await readFile(path.join(parent, 'hello/src/main.js'), 'utf8')
      expect(packageJson.packageManager).toBe('pnpm@11.22.0')
      expect(packageJson.scripts.start).toBe('kunlun start')
      expect(packageJson.dependencies['@kunlun-js/core']).toBe('^0.2.0')
      expect(packageJson.dependencies['@kunlun-js/builder-vite']).toBe('^0.1.0')
      expect(packageJson.devDependencies.vite).toBe('^8.2.2')
      expect(config).toContain("import { vite } from '@kunlun-js/builder-vite'")
      expect(config).toContain('builder: vite()')
      expect(client).toContain("fetch('http://localhost:3001/api/hello')")
    } finally {
      log.mockRestore()
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('starts a configured runtime and passes it the Fetch application', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kunlun-start-'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await writeFile(path.join(root, 'kunlun.config.mjs'), `export default {
  application: {
    name: 'hello-runtime',
    services: [{
      name: 'hello',
      routes: [{ method: 'GET', path: '/hello', handler: () => new Response('hello') }],
    }],
  },
  builder: { name: 'test', displayName: 'Test builder' },
  runtime: {
    name: 'test-runtime',
    displayName: 'Test runtime',
    async start(application, options) {
      const response = await application.fetch(new Request('http://runtime/hello'))
      if (await response.text() !== 'hello') throw new Error('Fetch application was not connected')
      if (options.port !== 0 || options.mode !== 'production') throw new Error('Runtime options were not forwarded')
      return {
        adapter: 'test-runtime',
        address: { host: '127.0.0.1', port: 0, family: 'IPv4' },
        url: 'http://runtime.test',
        fetch: application.fetch,
        async close() {},
      }
    },
  },
}
`)

    try {
      const running = runCli(['start', '--root', root, '--port', '0'])
      setTimeout(() => process.emit('SIGINT'), 25)
      await running
      expect(log).toHaveBeenCalledWith('✓ application running with Test runtime')
      expect(log).toHaveBeenCalledWith('  http://runtime.test')
    } finally {
      log.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
