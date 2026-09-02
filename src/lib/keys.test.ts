// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEAD_KEYS, KEY, LEGACY_KEYS, migrateStorageKeys } from './keys'

/** 搬运用的独立句柄：直连 jsdom localStorage，不经过 storage.ts 的缓存。 */
const store = window.localStorage

function seedLegacy(entries: Record<string, string>): void {
  for (const [k, v] of Object.entries(entries)) store.setItem(k, v)
}

describe('key 注册表命名约定', () => {
  it('全部 key 统一 capri-fe. 前缀', () => {
    const values: string[] = Object.values(KEY)
    for (const v of values) expect(v.startsWith('capri-fe.')).toBe(true)
    // 不许有重复名（两个语义抢同一个键 = 互相覆盖）
    expect(new Set(values).size).toBe(values.length)
  })

  it('不再有任何旧前缀的字面量', () => {
    for (const v of Object.values(KEY)) {
      expect(v).not.toMatch(/^acpfe[.-]/)
      expect(v).not.toMatch(/^acp-fe[.-]/)
      expect(v).not.toMatch(/^capri-fe-/)
    }
  })

  it('LEGACY_KEYS 只指向注册表里的新名，且自身不是一次改名链', () => {
    const current: Set<string> = new Set(Object.values(KEY))
    for (const [legacy, target] of Object.entries(LEGACY_KEYS)) {
      expect(current.has(target), `${target} 应先在 KEY 里注册`).toBe(true)
      expect(current.has(legacy), `${legacy} 已是现行 key，不该出现在迁移表`).toBe(false)
      expect(legacy).not.toBe(target)
    }
  })

  it('DEAD_KEYS 与新名、迁移表都不相干（清掉的不会是需要保留的）', () => {
    const current: Set<string> = new Set(Object.values(KEY))
    for (const dead of DEAD_KEYS) {
      expect(current.has(dead)).toBe(false)
      expect(dead in LEGACY_KEYS).toBe(false)
    }
  })
})

describe('migrateStorageKeys', () => {
  beforeEach(() => {
    store.clear()
  })

  it('acpfe.* 旧键搬到 capri-fe.* 并删除旧键', () => {
    seedLegacy({
      'acpfe.modeFlags': '{"yoloMode":true}',
      'acpfe.historyPins.synced': 'snapshot-v1',
      'acpfe.multiline': 'true',
    })
    migrateStorageKeys(store)
    expect(store.getItem(KEY.modeFlags)).toBe('{"yoloMode":true}')
    expect(store.getItem(KEY.historyPinsSynced)).toBe('snapshot-v1')
    expect(store.getItem(KEY.multiline)).toBe('true')
    expect(store.getItem('acpfe.modeFlags')).toBeNull()
    expect(store.getItem('acpfe.historyPins.synced')).toBeNull()
    expect(store.getItem('acpfe.multiline')).toBeNull()
  })

  it('分隔符收口：短横键进点键', () => {
    seedLegacy({ 'capri-fe-token': 'sk-hub', 'capri-fe-workspace-mode': 'full' })
    migrateStorageKeys(store)
    expect(store.getItem(KEY.hubToken)).toBe('sk-hub')
    expect(store.getItem(KEY.workspaceMode)).toBe('full')
    expect(store.getItem('capri-fe-token')).toBeNull()
    expect(store.getItem('capri-fe-workspace-mode')).toBeNull()
  })

  it('更名前的 acp-fe.* 也能接上（主题/host 选择不丢）', () => {
    seedLegacy({ 'acp-fe.theme': 'groknight', 'acp-fe.host': 'mba' })
    migrateStorageKeys(store)
    expect(store.getItem(KEY.theme)).toBe('groknight')
    expect(store.getItem(KEY.host)).toBe('mba')
  })

  it('新旧并存时以新值为准，旧值丢弃（用户已在新版改过偏好）', () => {
    seedLegacy({ 'acpfe.historyView': '{"mode":"workspace"}', [KEY.historyView]: '{"mode":"marked"}' })
    migrateStorageKeys(store)
    expect(store.getItem(KEY.historyView)).toBe('{"mode":"marked"}')
    expect(store.getItem('acpfe.historyView')).toBeNull()
  })

  it('清除无新键对应的残留：拆分前的令牌键、已下线的时间戳键', () => {
    seedLegacy({ 'acp-fe-token': 'ancient', 'acpfe.lastViewedAt': '1700000000' })
    migrateStorageKeys(store)
    expect(store.getItem('acp-fe-token')).toBeNull()
    expect(store.getItem('acpfe.lastViewedAt')).toBeNull()
    expect(store.getItem(KEY.hubToken)).toBeNull()
  })

  it('幂等：第二次调用不再写任何东西', () => {
    seedLegacy({ 'acpfe.slashRecency': '{"a":1}' })
    migrateStorageKeys(store)
    const after = Object.keys(store).length
    const spy = vi.spyOn(store, 'setItem')
    const removeSpy = vi.spyOn(store, 'removeItem')
    migrateStorageKeys(store)
    expect(spy).not.toHaveBeenCalled()
    expect(removeSpy).not.toHaveBeenCalled()
    expect(Object.keys(store).length).toBe(after)
    spy.mockRestore()
    removeSpy.mockRestore()
  })

  it('空存储不动任何键', () => {
    seedLegacy({ 'capri-fe.someOther': 'keep-me' })
    migrateStorageKeys(store)
    expect(store.getItem('capri-fe.someOther')).toBe('keep-me')
  })

  it('存储抛错时静默跳过（隐私模式/配额）', () => {
    const boom: Storage = {
      ...store,
      getItem: () => {
        throw new Error('SecurityError')
      },
    } as Storage
    expect(() => migrateStorageKeys(boom)).not.toThrow()
  })
})

describe('storage.ts 的迁移挂载点', () => {
  beforeEach(() => {
    store.clear()
    vi.resetModules()
  })

  it('首笔读之前完成搬运，调用方拿到的就是新键的值', async () => {
    // 模拟老用户升级后的第一次启动：存储里只有旧名。
    seedLegacy({ 'acpfe.permissionReseededFor': 'stamp-42', 'capri-fe-token': 'sk-hub' })
    const { loadStr } = await import('./storage')
    expect(loadStr(KEY.permissionReseededFor)).toBe('stamp-42')
    expect(loadStr(KEY.hubToken)).toBe('sk-hub')
    // 旧名必须已经消失，否则下次改名时无从判断谁是权威值。
    expect(loadStr('acpfe.permissionReseededFor')).toBeNull()
    expect(loadStr('capri-fe-token')).toBeNull()
  })

  it('写入走新名，不会再产出旧名', async () => {
    const { saveStr } = await import('./storage')
    saveStr(KEY.defaultSelectedPermission, 'allow_once')
    expect(store.getItem('capri-fe.defaultSelectedPermission')).toBe('allow_once')
    expect(store.getItem('acpfe.defaultSelectedPermission')).toBeNull()
  })
})
