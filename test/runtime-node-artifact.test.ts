import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createNodeApplication, loadNodeApplication } from '../packages/runtime-node/src/application.js'
import { NodeAuthorityError } from '../packages/runtime-node/src/authority.js'
import type { RuntimeArtifactManifest } from '../packages/runtime-api/src/index.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const roots: string[] = []
async function fixture(source = 'export default {fetch(){return new Response("ok")}}') {
  const root = await mkdtemp(join(tmpdir(), 'kunlun-artifact-'))
  roots.push(root)
  await writeFile(join(root, 'entry.js'), source)
  const manifest: RuntimeArtifactManifest = {
    schema: 'kunlun.runtime-manifest/v1',
    engine: { abi: 1, runtime_profile: 'kunlun-m2-web/1' },
    entry_contract: 'kunlun.fetch-entry/v1', entry: './entry.js',
    required_features: ['closed-module-graph'], compatibility_flags: [],
    capabilities: { required: [], optional: [] },
    files: [{ url: './entry.js', kind: 'module', sha256: hash(source) }],
  }
  const save = async () => {
    const bytes = JSON.stringify(manifest)
    await writeFile(join(root, 'manifest.json'), bytes)
    return { manifestSha256: hash(bytes), grants: {} }
  }
  return { root, manifest, save }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('portable artifact admission', () => {
  it('checks trusted manifest and module digests before evaluation', async () => {
    const f = await fixture('throw new Error("ENTRY EVALUATED")')
    const options = await f.save()
    await expect(loadNodeApplication(f.root, { ...options, manifestSha256: '0'.repeat(64) })).rejects.toThrow('SHA-256 mismatch')
    await writeFile(join(f.root, 'entry.js'), 'tampered')
    await expect(loadNodeApplication(f.root, options)).rejects.toThrow('SHA-256 mismatch')
  })
  it('rejects duplicate JSON fields, including escaped keys, without leaking JSON contents', async () => {
    const f = await fixture()
    for (const bytes of [
      JSON.stringify(f.manifest).replace('"abi":1', '"abi":1,"\\u0061bi":1'),
      JSON.stringify(f.manifest).replace('"files":', '"entry":"./entry.js","files":'),
      '{"schema":"PRIVATE_CREDENTIAL",invalid}',
    ]) {
      await writeFile(join(f.root, 'manifest.json'), bytes)
      await expect(loadNodeApplication(f.root, { manifestSha256: hash(bytes), grants: {} }))
        .rejects.toThrow(bytes.includes('invalid') ? 'invalid JSON' : 'duplicate JSON field')
    }
  })
  it('redacts host filesystem paths in admission failures', async () => {
    const f = await fixture()
    await expect(loadNodeApplication(join(f.root, 'PRIVATE_DEPLOYMENT_ROOT'), {
      manifestSha256: '0'.repeat(64), grants: {},
    })).rejects.toThrow('Artifact admission failed: artifact file access failed')
  })
  it('rejects floating ABI spellings that Runtime u32 parsing rejects', async () => {
    const f = await fixture()
    for (const abi of ['1.0', '1e0', '1E+0']) {
      const bytes = JSON.stringify(f.manifest).replace('"abi":1', `"abi":${abi}`)
      await writeFile(join(f.root, 'manifest.json'), bytes)
      await expect(loadNodeApplication(f.root, { manifestSha256: hash(bytes), grants: {} }))
        .rejects.toThrow('ABI must be an unsigned integer JSON token')
    }
  })
  it('rejects versions, unknown fields, escaping and symlink identities', async () => {
    const f = await fixture()
    ;(f.manifest.engine as { abi: number }).abi = 2
    await expect(loadNodeApplication(f.root, await f.save())).rejects.toThrow('unsupported manifest contract')
    f.manifest.engine.abi = 1
    Object.assign(f.manifest.engine, { surprise: true })
    await expect(loadNodeApplication(f.root, await f.save())).rejects.toThrow('invalid manifest fields')
    delete (f.manifest.engine as unknown as Record<string, unknown>).surprise
    f.manifest.entry = './../entry.js'
    await expect(loadNodeApplication(f.root, await f.save())).rejects.toThrow('escaping')
    await symlink('entry.js', join(f.root, 'alias.js'))
    f.manifest.entry = './alias.js'
    await expect(loadNodeApplication(f.root, await f.save())).rejects.toThrow('symlink')
  })
  it('rejects missing grants before entry evaluation and snapshots declarations', async () => {
    const f = await fixture('throw new Error("ENTRY EVALUATED")')
    f.manifest.capabilities.required = [{ name: 'fs.binding', resource: 'data' }]
    await expect(loadNodeApplication(f.root, await f.save())).rejects.toThrow(NodeAuthorityError)
    f.manifest.capabilities.required = []
    const app = await createNodeApplication(f.manifest, {}, (_request, env) => Response.json({
      fs: Object.keys(env.fs), http: Object.keys(env.http),
    }))
    f.manifest.capabilities.optional = [{ name: 'fs.binding', resource: 'data' }]
    expect(app.artifactManifest.capabilities.optional).toEqual([])
    expect(Object.isFrozen(app.artifactManifest.engine)).toBe(true)
    expect(await (await app.fetch(new Request('http://localhost/'))).json()).toEqual({ fs: [], http: [] })
    await app.close!()
    await expect(app.fetch(new Request('http://localhost/'))).rejects.toThrow()
  })
  it('rejects invalid and unindexed source maps before evaluation', async () => {
    const f = await fixture('export default {}; //# sourceMappingURL=entry.js.map')
    const bad = '{"version":2}'
    await writeFile(join(f.root, 'entry.js.map'), bad)
    f.manifest.files = [...f.manifest.files, { url: './entry.js.map', kind: 'source_map', sha256: hash(bad), for: './entry.js' }]
    await expect(loadNodeApplication(f.root, await f.save())).rejects.toThrow('invalid source map')
  })
})

describe('immutable VM artifact execution', () => {
  // Compile from a clean checkout rather than assuming dist already exists.
  beforeAll(() => { execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-b'], { cwd: process.cwd(), stdio: 'pipe' }) }, 60_000)
  it('executes checked static/dynamic modules, denies ambient authority and revokes on close', async () => {
    const source = `import {value} from './static.js';
      export default { async fetch(request,env,ctx) {
        const dynamic = await import('./dynamic.js');
        let unsupported = false; try {ctx.waitUntil(Promise.resolve())} catch {unsupported=true}
        return Response.json({value, dynamic:dynamic.value, ambient:typeof process+":"+typeof fetch+":"+typeof require,
          fs:Object.keys(env.fs), http:Object.keys(env.http), frozen:Object.isFrozen(ctx), unsupported});
      }}`
    const f = await fixture(source)
    for (const name of ['static', 'dynamic']) {
      const content = `export const value = '${name}-snapshot'`
      await writeFile(join(f.root, `${name}.js`), content)
      f.manifest.files = [...f.manifest.files, { url: `./${name}.js`, kind: 'module', sha256: hash(content) }]
    }
    const options = await f.save()
    const loader = pathToFileURL(join(process.cwd(), 'packages/runtime-node/dist/application.js')).href
    const script = `
      import {loadNodeApplication} from ${JSON.stringify(loader)};
      import {writeFile} from 'node:fs/promises';
      const app=await loadNodeApplication(${JSON.stringify(f.root)},${JSON.stringify(options)});
      await writeFile(${JSON.stringify(join(f.root, 'dynamic.js'))}, 'throw new Error("mutable disk")');
      const response=await app.fetch(new Request('http://localhost/'));
      console.log(await response.text());
      await app.close();
      try {await app.fetch(new Request('http://localhost/'));throw new Error("not revoked")}
      catch(error) {if(error.message==="not revoked") throw error}
    `
    const result = execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], { encoding: 'utf8' })
    expect(JSON.parse(result)).toEqual({
      value: 'static-snapshot', dynamic: 'dynamic-snapshot', ambient: 'undefined:undefined:undefined',
      fs: [], http: [], frozen: true, unsupported: true,
    })
  })
  it('fails explicitly without VM module support', async () => {
    const f = await fixture()
    const options = await f.save()
    const loader = pathToFileURL(join(process.cwd(), 'packages/runtime-node/dist/application.js')).href
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import {loadNodeApplication} from ${JSON.stringify(loader)};
      try {await loadNodeApplication(${JSON.stringify(f.root)},${JSON.stringify(options)});process.exitCode=1}
      catch(error) {console.log(error.message)}
    `], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
    expect(result).toContain('--experimental-vm-modules')
  })
  it.each(['node:fs', 'https://example.com/mod.js', './missing.js', '../outside.js'])(
    'rejects static and dynamic import %s through the closed resolver',
    async (specifier) => {
      const loader = pathToFileURL(join(process.cwd(), 'packages/runtime-node/dist/application.js')).href
      for (const dynamic of [false, true]) {
        const f = await fixture(dynamic
          ? `export default {async fetch(){await import(${JSON.stringify(specifier)});return new Response("unsafe")}}`
          : `import ${JSON.stringify(specifier)}; export default {fetch(){return new Response("unsafe")}}`)
        const options = await f.save()
        const result = execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
          import {loadNodeApplication} from ${JSON.stringify(loader)};
          let app;
          try {
            app=await loadNodeApplication(${JSON.stringify(f.root)},${JSON.stringify(options)});
            await app.fetch(new Request('http://localhost/'));process.exitCode=1;
          } catch(error) {console.log(error.message)}
          finally {await app?.close()}
        `], { encoding: 'utf8' })
        expect(result).toMatch(/module import/)
      }
    },
  )
})
