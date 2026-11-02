import { describe, expect, it } from 'vitest'
import type { SessionInfo, WorkspaceGroup, WorkspaceSummary } from '../../api/types'
import { buildSessionRowIndex, summaryToSessionRow } from './sessionRows'

/** live 名册行（`/api/sessions` 原样行；上下文字段不在 SessionInfo 里）。 */
const live = (
  over: Partial<SessionInfo> & {
    sessionId: string
    contextUsed?: number
    contextSize?: number
  },
): SessionInfo => over
const summary = (over: Partial<WorkspaceSummary> & { sessionId: string }): WorkspaceSummary => ({
  cwd: '/w',
  ...over,
})
const group = (cwd: string, sessions: WorkspaceSummary[]): WorkspaceGroup => ({
  cwd,
  label: cwd,
  sessions,
})

describe('summaryToSessionRow', () => {
  it('摘要缺失 cwd 时用所属分组的 cwd 补', () => {
    const row = summaryToSessionRow(summary({ sessionId: 'a', cwd: '' }), '/g')
    expect(row.cwd).toBe('/g')
  })
})

describe('buildSessionRowIndex', () => {
  it('live 的标题与副行摘要覆盖 workspace 摘要', () => {
    const rows = buildSessionRowIndex(
      [live({ sessionId: 'a', cwd: '/w', title: 'live 标题', lastTurnSummary: 'live 副行' })],
      [group('/w', [summary({ sessionId: 'a', title: 'ws 标题', lastTurnSummary: 'ws 副行' })])],
    )
    expect(rows.get('a')).toMatchObject({
      title: 'live 标题',
      lastTurnSummary: 'live 副行',
    })
  })

  it('live 标题 / 副行摘要为空白时回退 workspace 摘要', () => {
    const rows = buildSessionRowIndex(
      [live({ sessionId: 'a', cwd: '/w', title: '   ', lastTurnSummary: '  ' })],
      [group('/w', [summary({ sessionId: 'a', title: 'ws 标题', lastTurnSummary: 'ws 副行' })])],
    )
    expect(rows.get('a')).toMatchObject({
      title: 'ws 标题',
      lastTurnSummary: 'ws 副行',
    })
  })

  it('只在 workspace 摘要里的行保留（live 名册没有也照样在索引里）', () => {
    const rows = buildSessionRowIndex(
      [live({ sessionId: 'a', cwd: '/w' })],
      [
        group('/w', [
          summary({ sessionId: 'a', cwd: '/w', title: 'live 侧' }),
          summary({ sessionId: 'b', cwd: '/w', title: '仅摘要' }),
        ]),
      ],
    )
    expect(rows.get('b')).toMatchObject({ sessionId: 'b', cwd: '/w', title: '仅摘要' })
  })

  it('运行态与 census 只取 live 行', () => {
    const rows = buildSessionRowIndex(
      [
        live({
          sessionId: 'a',
          cwd: '/w',
          status: { state: 'active', busy: true },
          bgRunning: 2,
          bgCount: 5,
          hasTasks: true,
          contextUsed: 30_000,
          contextSize: 100_000,
        }),
      ],
      [group('/w', [summary({ sessionId: 'a' })])],
    )
    expect(rows.get('a')).toMatchObject({
      status: { state: 'active', busy: true },
      bgRunning: 2,
      bgCount: 5,
      hasTasks: true,
      contextUsed: 30_000,
      contextSize: 100_000,
    })
  })

  it('updatedAt 用 live 值，live 缺失时用摘要', () => {
    const rows = buildSessionRowIndex(
      [
        live({ sessionId: 'live-time', cwd: '/w', updatedAt: '2026-01-02T00:00:00Z' }),
        live({ sessionId: 'fallback-time', cwd: '/w' }),
        live({ sessionId: 'blank-time', cwd: '/w', updatedAt: '' }),
      ],
      [
        group('/w', [
          summary({ sessionId: 'live-time', updatedAt: '2026-01-01T00:00:00Z' }),
          summary({ sessionId: 'fallback-time', updatedAt: '2025-12-31T00:00:00Z' }),
          summary({ sessionId: 'blank-time', updatedAt: '2025-12-30T00:00:00Z' }),
        ]),
      ],
    )
    expect(rows.get('live-time')?.updatedAt).toBe('2026-01-02T00:00:00Z')
    expect(rows.get('fallback-time')?.updatedAt).toBe('2025-12-31T00:00:00Z')
    // 空串不是活动时间，同样回退摘要。
    expect(rows.get('blank-time')?.updatedAt).toBe('2025-12-30T00:00:00Z')
  })

  it('sessions 比 workspaces 多：live-only 行也进索引，cwd 用 live', () => {
    const rows = buildSessionRowIndex(
      [
        live({ sessionId: 'a', cwd: '/w', title: '甲' }),
        live({ sessionId: 'extra', cwd: '/z', title: '只有 live' }),
        live({ sessionId: 'no-cwd', title: '没 cwd' }),
      ],
      [group('/w', [summary({ sessionId: 'a', title: '甲' })])],
    )
    expect([...rows.keys()].sort()).toEqual(['a', 'extra', 'no-cwd'])
    expect(rows.get('extra')?.cwd).toBe('/z')
    expect(rows.get('no-cwd')?.cwd).toBe('')
  })

  it('reasoningEffort：live 有值时优先，空白 / 缺失回退摘要', () => {
    const rows = buildSessionRowIndex(
      [
        live({ sessionId: 'live-effort', cwd: '/w', reasoningEffort: 'max' }),
        live({ sessionId: 'blank-effort', cwd: '/w', reasoningEffort: '  ' }),
        live({ sessionId: 'no-effort', cwd: '/w' }),
      ],
      [
        group('/w', [
          summary({ sessionId: 'live-effort', reasoningEffort: 'low' }),
          summary({ sessionId: 'blank-effort', reasoningEffort: 'high' }),
          summary({ sessionId: 'no-effort', reasoningEffort: 'medium' }),
        ]),
      ],
    )
    expect(rows.get('live-effort')?.reasoningEffort).toBe('max')
    expect(rows.get('blank-effort')?.reasoningEffort).toBe('high')
    expect(rows.get('no-effort')?.reasoningEffort).toBe('medium')
  })
})
