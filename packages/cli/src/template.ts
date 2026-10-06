import type { GeneratorBuilder, GeneratorTemplate } from './generator-types.js'

const peers: Record<GeneratorBuilder, Record<string, string>> = {
  nasti: { '@nasti-toolchain/nasti': '^2.4.4' },
  vite: { vite: '^8.2.2' },
  webpack: { webpack: '^5.109.2', 'webpack-dev-middleware': '^8.3.0' },
  rspack: { '@rspack/core': '^2.1.10', '@rspack/dev-middleware': '^2.0.3' },
}

// Preserve the runnable v0.2 scaffold without claiming the unfinished full-stack gate.
export const clientFetchTemplate: GeneratorTemplate = {
  identity: {
    protocol: 'kunlun.generator/v1',
    template: '@kunlun-js/client-fetch',
    version: '1.0.0',
  },
  generate(project) {
    const dependencies = {
      dependencies: {
        '@kunlun-js/core': '^0.2.0',
        [`@kunlun-js/builder-${project.builder}`]: '^0.1.0',
      },
      devDependencies: {
        '@kunlun-js/cli': '^0.2.0',
        ...peers[project.builder],
      },
    }
    return {
      dependencies,
      files: [
        {
          path: 'package.json',
          contents: `${JSON.stringify({
            name: project.name,
            version: '0.0.0',
            private: true,
            type: 'module',
            packageManager: project.packageManager,
            scripts: { dev: 'kunlun dev', build: 'kunlun build', start: 'kunlun start', doctor: 'kunlun doctor' },
            ...dependencies,
          }, null, 2)}\n`,
        },
        { path: 'kunlun.config.mjs', contents: configTemplate(project.builder) },
        {
          path: 'index.html',
          contents: '<!doctype html>\n<meta charset="utf-8">\n<title>Kunlun Engine</title>\n<div id="app">Loading…</div>\n<script type="module" src="/src/main.js"></script>\n',
        },
        {
          path: 'src/main.js',
          contents: `const app = document.querySelector('#app')
try {
  const response = await fetch('http://localhost:3001/api/hello')
  const result = await response.json()
  app.textContent = result.hello
} catch (error) {
  app.textContent = \`Runtime unavailable: \${error.message}\`
}
`,
        },
        { path: '.gitignore', contents: 'node_modules/\ndist/\n.kunlun/\n' },
      ],
    }
  },
}

function configTemplate(name: GeneratorBuilder): string {
  return `import { ${name} } from '@kunlun-js/builder-${name}'
import { defineApplication, defineConfig, defineService, route } from '@kunlun-js/core'

const application = defineApplication({
  name: 'hello-kunlun',
  services: [
    defineService({
      name: 'hello',
      routes: [route('GET', '/api/hello', () => Response.json({ hello: 'Kunlun' }))],
    }),
  ],
})

export default defineConfig({
  application,
  builder: ${name}(),
  targets: [
    {
      name: 'client',
      consumer: 'client',
      entries: { main: './src/main.js' },
      outDir: 'dist/client',
    },
  ],
})
`
}
