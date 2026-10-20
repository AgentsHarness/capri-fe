import { describe, expect, it } from 'vitest'

/**
 * 分层守卫：`api → store → components` 单向。
 *
 * 这条边界靠约定维持——oxlint 不带 import/no-restricted-paths，一次误加的
 * `import { useChatStore }` 就能把传输层拖进 React，或让 store 反向依赖
 * 视图：编译期不报，只在运行时靠模块求值顺序侥幸过关，review 里也难发现。
 *
 * 只拦运行时依赖（`import ... from` / `export ... from` / 副作用 import /
 * 动态 import）。`import type` 允许反向：类型层没有求值顺序问题，而且
 * `lib/layerErr.ts` 这类模块本来就只借一个类型。
 */

const files = import.meta.glob('./**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

type Spec = { spec: string; typeOnly: boolean }

/** 取出一个源文件里所有指向相对路径的模块说明符。 */
export function importedSpecs(source: string): Spec[] {
  const out: Spec[] = []
  const staticRe = /(^|\n)\s*(?:import|export)\s+(type\s+)?[^;\n]*?from\s+'([^']+)'/g
  for (const m of source.matchAll(staticRe)) {
    out.push({ spec: m[3], typeOnly: m[2] != null })
  }
  const sideEffectRe = /(^|\n)\s*import\s+'([^']+)'/g
  for (const m of source.matchAll(sideEffectRe)) {
    out.push({ spec: m[2], typeOnly: false })
  }
  const dynamicRe = /\bimport\(\s*'([^']+)'\s*\)/g
  for (const m of source.matchAll(dynamicRe)) {
    out.push({ spec: m[1], typeOnly: false })
  }
  return out
}

/**
 * `src` 内相对说明符解析后的顶层目录（跨层时即层名）。
 *
 * 手写归一化而不是引 node:path：测试跑在 jsdom 环境，tsconfig 没有 node
 * 类型（api / store 里也不该出现 node 内建模块的引用）。
 */
export function targetLayer(importer: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const parts = importer.split('/').slice(0, -1)
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
    } else {
      parts.push(seg)
    }
  }
  return parts[0]
}

const RULES: { from: string; forbid: string[] }[] = [
  { from: 'api', forbid: ['store', 'components', 'hooks', 'commands'] },
  { from: 'store', forbid: ['components', 'hooks', 'commands'] },
]

describe('分层依赖方向', () => {
  for (const rule of RULES) {
    it(`${rule.from} 不 import ${rule.forbid.join(' / ')}（运行时）`, () => {
      const offenders: string[] = []
      let scanned = 0
      for (const [key, source] of Object.entries(files)) {
        const here = key.replace(/^\.\//, '')
        if (!here.startsWith(rule.from + '/')) continue
        if (/\.test\.(ts|tsx)$/.test(here)) continue
        scanned += 1
        for (const { spec, typeOnly } of importedSpecs(source)) {
          if (typeOnly) continue
          const layer = targetLayer(here, spec)
          if (layer && rule.forbid.includes(layer)) offenders.push(`${here} → ${spec}`)
        }
      }
      // 空转的守卫等于没有守卫：确认真扫到了这个层的文件。
      expect(scanned).toBeGreaterThan(5)
      expect(offenders).toEqual([])
    })
  }

  it('能识别违规（守卫本身有效）', () => {
    expect(targetLayer('api/transport.ts', '../store/chat')).toBe('store')
    expect(targetLayer('api/rpc/core.ts', '../../store/chat')).toBe('store')
    expect(targetLayer('store/chat/store.ts', '../toast')).toBe('store')
    expect(targetLayer('store/chat/store.ts', './types')).toBe('store')
    expect(importedSpecs("import type { A } from '../components/A'")).toEqual([
      { spec: '../components/A', typeOnly: true },
    ])
    expect(importedSpecs("import { b } from '../components/B'")).toEqual([
      { spec: '../components/B', typeOnly: false },
    ])
  })
})
