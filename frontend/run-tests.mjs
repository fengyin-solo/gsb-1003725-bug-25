// 轻量测试入口：用 esbuild 把 node:test 用例打成临时 ESM 再交给 node --test。
// 不引入 vitest，保持仓库「纯前端、无后端」的最小依赖。
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = dirname(fileURLToPath(import.meta.url))
const srcDir = join(root, 'src')

function resolveWithExtension(specifier) {
  const candidates = [specifier, `${specifier}.ts`, join(specifier, 'index.ts')]
  return candidates.find((candidate) => existsSync(candidate)) ?? specifier
}

const aliasPlugin = {
  name: 'at-alias',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@\// }, (args) => ({
      path: resolveWithExtension(join(srcDir, args.path.slice(2))),
    }))
  },
}

const outdir = join(root, 'node_modules', '.cache')
const outfiles = [
  join(outdir, 'water-quality.test.js'),
  join(outdir, 'water-quality.integration.test.js'),
]

await build({
  entryPoints: [
    join(root, 'tests', 'water-quality.test.ts'),
    join(root, 'tests', 'water-quality.integration.test.ts'),
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir,
  plugins: [aliasPlugin],
  resolveExtensions: ['.ts', '.mjs', '.js', '.json'],
})

try {
  execFileSync(process.execPath, ['--test', ...outfiles.map((file) => path.resolve(file))], {
    stdio: 'inherit',
  })
} catch {
  process.exitCode = 1
} finally {
  for (const file of outfiles) {
    await rm(file, { force: true })
  }
}
