import { describe, expect, it } from 'vitest'
import {
  alive,
  createSiteId,
  entriesFromView,
  feKey,
  maxAt,
  mergeEntries,
  projectEntries,
  pruneTombstones,
  putEntry,
  sameEntries,
  sessionKey,
  todoKey,
  wsKey,
  type PrefsEntries,
} from './prefsEntries'

const DAY = 24 * 60 * 60 * 1000

const pin = (key: string, at: number, site: string): PrefsEntries => ({
  [key]: { v: '1', at, site },
})

describe('条目合并（按 key 的 last-write-wins）', () => {
  it('较晚的写入胜出，与 src/dst 谁在后无关', () => {
    const old = pin(sessionKey('s1'), 100, 'A')
    const fresh = pin(sessionKey('s1'), 200, 'B')
    expect(mergeEntries(old, fresh)[sessionKey('s1')].at).toBe(200)
    expect(mergeEntries(fresh, old)[sessionKey('s1')].at).toBe(200)
  })

  it('同一毫秒按 site 定序（全序，不留随机胜负）', () => {
    const a = pin(sessionKey('s1'), 500, 'AAA')
    const b = pin(sessionKey('s1'), 500, 'BBB')
    expect(mergeEntries(a, b)[sessionKey('s1')].site).toBe('BBB')
    expect(mergeEntries(b, a)[sessionKey('s1')].site).toBe('BBB')
  })

  it('合并满足交换律与幂等', () => {
    const x = { ...pin(wsKey('/a'), 10, 'A'), ...pin(todoKey('s1'), 20, 'A') }
    const y = { ...pin(wsKey('/b'), 30, 'B'), ...pin(todoKey('s1'), 5, 'B') }
    const xy = mergeEntries(x, y)
    const yx = mergeEntries(y, x)
    expect(sameEntries(xy, yx)).toBe(true)
    expect(sameEntries(mergeEntries(xy, x), xy)).toBe(true)
    // 同一个 todo key 上，A 的 at=20 压过 B 的 at=5
    expect(value(xy, todoKey('s1'))).toBe('1')
    expect(value(yx, todoKey('s1'))).toBe('1')
  })

  it('删除写成墓碑，并压住更早的新增', () => {
    const added = pin(sessionKey('s1'), 100, 'A')
    const deleted = { [sessionKey('s1')]: { v: '', at: 200, site: 'A', d: true } }
    const merged = mergeEntries(added, deleted)
    expect(alive(merged, sessionKey('s1'))).toBe(false)
    expect(projectEntries(merged).pinnedSessions).toEqual([])
    // 陈旧端把自己那份「还pin着」推回来，也翻不了案
    expect(alive(mergeEntries(merged, added), sessionKey('s1'))).toBe(false)
  })

  it('墓碑之后的真实新增仍然生效', () => {
    const tomb = { [sessionKey('s1')]: { v: '', at: 200, site: 'A', d: true } }
    expect(alive(mergeEntries(tomb, pin(sessionKey('s1'), 300, 'B')), sessionKey('s1'))).toBe(true)
  })

  it('互不相干的 key 各自保留（一端的新增不会挤掉另一端的）', () => {
    const merged = mergeEntries(pin(wsKey('/a'), 10, 'A'), pin(wsKey('/b'), 20, 'B'))
    expect(Object.keys(merged).sort()).toEqual([wsKey('/a'), wsKey('/b')])
  })
})

describe('墓碑回收', () => {
  const now = 1_700_000_000_000

  it('超过期限的删除记录被清，活记录再老也留着', () => {
    const entries: PrefsEntries = {
      [sessionKey('old')]: { v: '', at: now - 61 * DAY, site: 'A', d: true },
      [sessionKey('young')]: { v: '', at: now - DAY, site: 'A', d: true },
      [sessionKey('ancient-live')]: { v: '1', at: now - 365 * DAY, site: 'A' },
    }
    const pruned = pruneTombstones(entries, now)
    expect(pruned[sessionKey('old')]).toBeUndefined()
    expect(pruned[sessionKey('young')].d).toBe(true)
    expect(pruned[sessionKey('ancient-live')].d).toBeUndefined()
  })

  it('无可清时返回原对象（不制造新引用）', () => {
    const entries = pin(wsKey('/a'), now, 'A')
    expect(pruneTombstones(entries, now)).toBe(entries)
  })
})

describe('投影与物化', () => {
  it('entries ↔ 集合快照往返一致', () => {
    const entries: PrefsEntries = {
      [wsKey('/z')]: { v: '1', at: 1, site: 'A' },
      [wsKey('/a')]: { v: '1', at: 2, site: 'A' },
      [sessionKey('s1')]: { v: '1', at: 3, site: 'A' },
      [todoKey('s2')]: { v: 'completed', at: 4, site: 'A' },
      [feKey('collapseToolGroups')]: { v: 'false', at: 5, site: 'A' },
    }
    const view = projectEntries(entries)
    expect(view.pinnedWorkspaces).toEqual(['/a', '/z']) // 稳定排序
    expect(view.pinnedSessions).toEqual(['s1'])
    expect(view.todos).toEqual({ s2: 'completed' })
    expect(view.fePrefs).toEqual({ collapseToolGroups: false })
    // 快照再物化回去，投影结果不变
    expect(projectEntries(entriesFromView(view, 0, 'x'))).toEqual(view)
  })

  it('fe 条目只认布尔字面量，其它值不进投影', () => {
    const view = entriesFromView({ fePrefs: { collapseToolGroups: true } }, 0, 'x')
    expect(view[feKey('collapseToolGroups')]).toEqual({ v: 'true', at: 0, site: 'x' })
  })

  it('物化不猜测删除：快照里没有的 key 不生成墓碑', () => {
    const entries = entriesFromView({ pinnedSessions: ['s1'] }, 7, 'hub')
    expect(entries[sessionKey('s1')]).toEqual({ v: '1', at: 7, site: 'hub' })
    expect(Object.keys(entries)).toEqual([sessionKey('s1')])
  })
})

describe('写入辅助', () => {
  it('putEntry 写入 / 墓碑化同一个 key', () => {
    const stamp = { at: 10, site: 'A' }
    const added = putEntry({}, sessionKey('s1'), '1', stamp)
    expect(alive(added, sessionKey('s1'))).toBe(true)
    const removed = putEntry(added, sessionKey('s1'), null, { at: 20, site: 'A' })
    expect(alive(removed, sessionKey('s1'))).toBe(false)
    expect(removed[sessionKey('s1')].d).toBe(true)
  })

  it('maxAt 驱动「本次写入一定更新」的兜底', () => {
    const entries = { ...pin(wsKey('/a'), 100, 'A'), [wsKey('/b')]: { v: '', at: 400, site: 'A', d: true } }
    expect(maxAt(entries)).toBe(400)
    expect(maxAt({})).toBe(0)
  })
})

describe('site 标识', () => {
  it('每次生成都不同且非空（同分裁决必须可区分）', () => {
    const a = createSiteId()
    const b = createSiteId()
    expect(a).toBeTruthy()
    expect(a).not.toBe(b)
  })
})

/** 读取投影前的一条原始值（合并用例里做断言用）。 */
function value(entries: PrefsEntries, key: string): string | undefined {
  const e = entries[key]
  return e && !e.d ? e.v : undefined
}
