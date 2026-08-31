import { describe, expect, it } from 'vitest'
import {
  extractDomain,
  mcpTitleizeSegment,
  normalizeLexically,
  pathBasename,
  pathForSurface,
  resolveToolPathTarget,
  shortenPath,
  splitMcpToolName,
  splitPathHeadTail,
  strWidth,
  truncateToWidth,
  uniqueDomains,
  workflowScriptName,
} from './toolPaths'

/**
 * Vectors mirror the Rust tests in
 * xai-grok-pager-render/src/render/tool_paths.rs so both sides stay pinned to
 * the same behaviour.
 */
describe('truncateToWidth / strWidth', () => {
  it('fits → 原样；超宽 → 截断加 …', () => {
    expect(truncateToWidth('main.rs', 20)).toBe('main.rs')
    expect(truncateToWidth('verylongfilename.rs', 10)).toBe('verylongf\u2026')
    expect(truncateToWidth('abc', 0)).toBe('')
  })

  it('东亚宽字符按 2 列计', () => {
    expect(strWidth('中文')).toBe(4)
    expect(strWidth('a中')).toBe(3)
    expect(truncateToWidth('a中文b', 3)).toBe('a\u2026')
  })
})

describe('normalizeLexically', () => {
  it('丢 . / 折叠 .. / 根上的 .. 吸收 / 相对路径保留 ..', () => {
    expect(normalizeLexically('src/./nested/../main.rs')).toBe('src/main.rs')
    expect(normalizeLexically('/Users/me/project/../outside.rs')).toBe('/Users/me/outside.rs')
    expect(normalizeLexically('/a/../../b')).toBe('/b')
    expect(normalizeLexically('../outside.rs')).toBe('../outside.rs')
    expect(normalizeLexically('')).toBe('.')
  })
})

describe('resolveToolPathTarget', () => {
  it('保留 symlink 敏感的 .. 段（不规范化）', () => {
    expect(resolveToolPathTarget('/repo/link/../target.rs')).toBe('/repo/link/../target.rs')
  })

  it('相对路径 join cwd；~ 无 home 时返回 undefined（fail closed）', () => {
    expect(resolveToolPathTarget('src/main.rs', '/Users/me/project')).toBe(
      '/Users/me/project/src/main.rs',
    )
    expect(resolveToolPathTarget('~/foo.rs', '/repo')).toBeUndefined()
    expect(resolveToolPathTarget('~//foo.rs', '/repo', '/home/me')).toBe('/home/me/foo.rs')
    expect(resolveToolPathTarget('~/dir/../foo.rs', '/repo', '/home/me')).toBe(
      '/home/me/dir/../foo.rs',
    )
  })
})

describe('pathBasename', () => {
  it('原生与混合分隔符、尾部分隔符', () => {
    expect(pathBasename('/Users/me/project/src/main.rs', 80)).toBe('main.rs')
    expect(pathBasename('src/main.rs', 80)).toBe('main.rs')
    expect(pathBasename('C:\\Users\\me/project/src/main.rs', 80)).toBe('main.rs')
    expect(pathBasename('C:\\Users\\me\\project\\src\\', 80)).toBe('src')
    expect(pathBasename('/Users/me/project/src/', 80)).toBe('src')
  })

  it('按预算截断；预算 0 → 空串', () => {
    expect(pathBasename('/x/verylongfilename.rs', 10)).toBe('verylongf\u2026')
    expect(pathBasename('src/main.rs', 0)).toBe('')
  })
})

describe('shortenPath', () => {
  it('放得下 → 原样', () => {
    expect(shortenPath('src/main.rs', 20)).toBe('src/main.rs')
  })

  it('fish 式压缩首字母，保住最后一段', () => {
    const r = shortenPath('crates/codegen/xai-grok-pager/src/views/foo.rs', 25)
    expect(strWidth(r)).toBeLessThanOrEqual(25)
    expect(r.endsWith('foo.rs')).toBe(true)
  })

  it('无分隔符 → 硬截断；预算 0 → 空串', () => {
    expect(shortenPath('verylongfilename.rs', 10)).toBe('verylongf\u2026')
    expect(shortenPath('src/main.rs', 0)).toBe('')
  })

  it('压缩后仍超宽 → …/ 尾巴兜底；连尾巴都放不下 → 硬截断', () => {
    expect(shortenPath('aaa/bbb/ccc/filename.rs', 15)).toBe('\u2026/filename.rs')
    const r = shortenPath('crates/codegen/xai-grok-pager/src/views/very_long_filename.rs', 20)
    expect(strWidth(r)).toBeLessThanOrEqual(20)
  })
})

describe('pathForSurface', () => {
  it('collapsed = 只留文件名（原始串，不解析）', () => {
    expect(
      pathForSurface('/Users/me/project/src/main.rs', 'collapsed', { width: 80, reserved: 5 }),
    ).toBe('main.rs')
    expect(pathForSurface('~/x/main.rs', 'collapsed')).toBe('main.rs')
  })

  it('expanded = cwd 相对，否则规范化绝对路径', () => {
    const cwd = '/Users/me/project'
    expect(pathForSurface('/Users/me/project/src/main.rs', 'expanded', { cwd })).toBe(
      'src/main.rs',
    )
    expect(pathForSurface('src/./nested/../main.rs', 'expanded', { cwd })).toBe('src/main.rs')
    expect(pathForSurface('../outside.rs', 'expanded', { cwd })).toBe('/Users/me/outside.rs')
  })

  it('fullscreen = 规范化绝对路径；raw = 原样（导出用）', () => {
    expect(
      pathForSurface('/Users/me/project/./src/main.rs', 'fullscreen', {
        cwd: '/Users/me/project',
      }),
    ).toBe('/Users/me/project/src/main.rs')
    expect(pathForSurface('/x/./y.rs', 'raw')).toBe('/x/./y.rs')
  })
})

describe('splitPathHeadTail', () => {
  it('目录段可被 CSS 省略，末段固定', () => {
    expect(splitPathHeadTail('src/scrollback/toolDetail.ts')).toEqual({
      head: 'src/scrollback/',
      tail: 'toolDetail.ts',
    })
    expect(splitPathHeadTail('main.rs')).toEqual({ head: '', tail: 'main.rs' })
  })
})

describe('workflowScriptName', () => {
  it('.rhai 且在 workflows 目录下 → 脚本名；否则 undefined', () => {
    expect(workflowScriptName('/x/.grok/workflows/review-changes.rhai')).toBe('review-changes')
    expect(workflowScriptName('/x/workflows/a/b.rhai')).toBe('b')
    expect(workflowScriptName('/x/workflows/plain.ts')).toBeUndefined()
    expect(workflowScriptName('/x/other/review.rhai')).toBeUndefined()
    expect(workflowScriptName('/x/workflows/.rhai')).toBeUndefined()
  })
})

describe('splitMcpToolName', () => {
  it('__ 前缀拆 server/action 并 titleize', () => {
    expect(splitMcpToolName('linear__save_issue')).toEqual({
      server: 'Linear',
      action: 'Save Issue',
    })
    expect(splitMcpToolName('search_tool')).toEqual({ server: '', action: 'Search Tool' })
    expect(mcpTitleizeSegment('')).toBe('')
  })
})

describe('uniqueDomains / extractDomain', () => {
  it('去重主机名（TUI 不剥 www.），保首次出现顺序', () => {
    expect(
      uniqueDomains([
        'https://stripe.com/docs',
        'https://www.stripe.com/pricing',
        'https://react.dev/',
      ]),
    ).toEqual(['stripe.com', 'www.stripe.com', 'react.dev'])
    expect(uniqueDomains(['https://a.com/x', 'https://a.com/y'])).toEqual(['a.com'])
    expect(extractDomain('not a url')).toBeUndefined()
  })
})
