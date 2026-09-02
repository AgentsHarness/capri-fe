import { describe, expect, it } from 'vitest'
import type { ScrollEntry } from '../api/types'
import { buildUserNavItems } from './userNav'

function user(id: string, text: string, msgSeq?: number): ScrollEntry {
  return { id, kind: 'user', text, ...(msgSeq != null ? { msgSeq } : {}) }
}

function assistant(id: string, msgSeq?: number): ScrollEntry {
  return { id, kind: 'assistant', text: 'a', ...(msgSeq != null ? { msgSeq } : {}) }
}

describe('buildUserNavItems', () => {
  it('promptStarts+promptPreviews 齐全 → 全量目录：未加载轮用 host 预览，序号与可见轮一致', () => {
    // 已加载区只有最后一轮（msgSeq 20），更早两轮未加载。
    const entries = [
      user('u1', '第一轮', 0),
      assistant('a1', 1),
      user('u2', '第二轮', 10),
      assistant('a2', 11),
      user('u3', '第三轮', 20),
      assistant('a3', 21),
    ]
    const items = buildUserNavItems(entries, [0, 10, 20], ['第一轮预览', '第二轮预览', '第三轮预览'])
    // 全部命中已加载 → 全部 loaded，id 用渲染条目 id，预览用条目文本。
    expect(items).toEqual([
      { id: 'u1', seq: 0, preview: '第一轮', turnIdx: 0, loaded: true },
      { id: 'u2', seq: 10, preview: '第二轮', turnIdx: 1, loaded: true },
      { id: 'u3', seq: 20, preview: '第三轮', turnIdx: 2, loaded: true },
    ])
  })

  it('只加载最新一轮时：未加载轮带合成 id 与 host 预览，已加载轮用渲染文本', () => {
    const entries = [user('u3', '第三轮', 20), assistant('a3', 21)]
    const items = buildUserNavItems(entries, [0, 10, 20], ['第一轮预览', '第二轮预览', '第三轮预览'])
    expect(items).toEqual([
      { id: 'prompt:0', seq: 0, preview: '第一轮预览', turnIdx: 0, loaded: false },
      { id: 'prompt:10', seq: 10, preview: '第二轮预览', turnIdx: 1, loaded: false },
      { id: 'u3', seq: 20, preview: '第三轮', turnIdx: 2, loaded: true },
    ])
  })

  it('隐藏 prompt（system-reminder / monitor events）按 FE 同套规则过滤，序号跳过', () => {
    const entries = [user('u3', '真实第三轮', 20)]
    const items = buildUserNavItems(
      entries,
      [0, 10, 20],
      [
        '<system-reminder>这是一条系统提示</system-reminder>',
        '42 monitor events from langchain (use /pause to inspect)',
        '真实第三轮预览',
      ],
    )
    expect(items).toEqual([{ id: 'u3', seq: 20, preview: '真实第三轮', turnIdx: 0, loaded: true }])
  })

  it('空预览（图块 run / 空文本）被过滤：滚动区没有对应 user 行', () => {
    const entries = [user('u3', '第三轮', 20)]
    const items = buildUserNavItems(entries, [0, 20], ['', '第三轮预览'])
    expect(items).toEqual([{ id: 'u3', seq: 20, preview: '第三轮', turnIdx: 0, loaded: true }])
  })

  it('缺 previews / 长度不一致 → 回退只列已加载轮（旧 host 行为）', () => {
    const entries = [user('u1', '第一轮', 0), user('u2', '第二轮', 10)]
    expect(buildUserNavItems(entries, [0, 10], undefined)).toEqual([
      { id: 'u1', seq: 0, preview: '第一轮', turnIdx: 0, loaded: true },
      { id: 'u2', seq: 10, preview: '第二轮', turnIdx: 1, loaded: true },
    ])
    // 缺 promptStarts 同样回退。
    expect(buildUserNavItems(entries, undefined, ['p0', 'p1'])).toHaveLength(2)
    // 长度不一致（防御 host 异常）：回退，不得错位。
    expect(buildUserNavItems(entries, [0, 10], ['p0'])).toHaveLength(2)
  })

  it('promptStarts 快照之后到达的 live user 行（无 msgSeq）补在目录末尾', () => {
    const entries = [user('u0', '已加载轮', 10), user('live', '正在问', undefined)]
    const items = buildUserNavItems(entries, [10], ['已加载轮预览'])
    expect(items).toEqual([
      { id: 'u0', seq: 10, preview: '已加载轮', turnIdx: 0, loaded: true },
      { id: 'live', seq: undefined, preview: '正在问', turnIdx: 1, loaded: true },
    ])
  })
})
