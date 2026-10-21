import { describe, expect, it } from 'vitest'
import { recentWorkspaceDirs } from './workspaceDirs'

const group = (cwd: string, ids: string[] = []) => ({
  cwd,
  label: cwd,
  sessions: ids.map((sessionId) => ({ sessionId, cwd })),
})

describe('recentWorkspaceDirs', () => {
  it('保留工作区顺序，再补 live 会话里没成组的目录', () => {
    const dirs = recentWorkspaceDirs(
      [group('/repo/b'), group('/repo/a')],
      [{ sessionId: 's1', cwd: '/repo/c' }, { sessionId: 's2', cwd: '/repo/b' }],
    )
    expect(dirs).toEqual(['/repo/b', '/repo/a', '/repo/c'])
  })

  it('跳过空 cwd、去重、并按 limit 截断', () => {
    const dirs = recentWorkspaceDirs(
      [group(''), group('/repo/a'), group('/repo/a')],
      [{ sessionId: 's1' }, { sessionId: 's2', cwd: '  ' }],
      1,
    )
    expect(dirs).toEqual(['/repo/a'])
  })

  it('没有任何目录 → 空数组', () => {
    expect(recentWorkspaceDirs([], [])).toEqual([])
  })
})
