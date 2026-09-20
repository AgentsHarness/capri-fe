import { describe, expect, it } from 'vitest'
import {
  MEMORY_FORGET_MAX_FILE_BYTES,
  baseName,
  canEnableMemory,
  disabledMemoryNotice,
  disabledReasonLabel,
  emptyMemoryNotice,
  filterMemoryFiles,
  formatMemoryAge,
  groupMemoryFiles,
  isMemoryFileDeletable,
  memoryContentHash,
  memoryFileLabel,
  memoryHasNotes,
  memorySizeText,
  normalizeMemoryListing,
  observationKeyLabel,
  type MemoryFileInfo,
} from './memory'

const note = (over: Partial<MemoryFileInfo> = {}): MemoryFileInfo => ({
  path: '/ws/.grok/memory/topics/deploy.md',
  source: 'workspace',
  sizeBytes: 42,
  generated: false,
  ...over,
})

describe('normalizeMemoryListing', () => {
  it('读 agent 的 snake_case 快照，并保留 title/generated', () => {
    const listing = normalizeMemoryListing({
      files: [
        {
          path: '/ws/.grok/memory/topics/deploy.md',
          source: 'workspace',
          size_bytes: 94,
          modified_epoch_secs: 1_700_000_000,
          generated: false,
          title: '部署约定',
        },
      ],
      enabled: false,
      disabled_reason: 'config_opt_out',
      capture_enabled: false,
      dream_enabled: true,
    })
    expect(listing.enabled).toBe(false)
    expect(listing.disabledReason).toBe('config_opt_out')
    expect(listing.captureEnabled).toBe(false)
    expect(listing.dreamEnabled).toBe(true)
    expect(listing.files[0]).toEqual({
      path: '/ws/.grok/memory/topics/deploy.md',
      source: 'workspace',
      sizeBytes: 94,
      modifiedEpochSecs: 1_700_000_000,
      generated: false,
      title: '部署约定',
    })
  })

  it('老 shell 缺省字段按 agent 的 serde 默认补齐（enabled/capture/dream → true）', () => {
    const listing = normalizeMemoryListing({ files: [{ path: '/a.md' }] })
    expect(listing.enabled).toBe(true)
    expect(listing.captureEnabled).toBe(true)
    expect(listing.dreamEnabled).toBe(true)
    expect(listing.files[0]).toMatchObject({ path: '/a.md', sizeBytes: 0, generated: false })
  })

  it('丢弃没有 path 的条目，空响应退化为空列表而非抛错', () => {
    expect(normalizeMemoryListing({ files: [{ source: 'global' }] }).files).toEqual([])
    expect(normalizeMemoryListing(undefined).files).toEqual([])
  })
})

describe('labels and grouping', () => {
  it('title 优先，其次按 v2 observation key 生成可读标签，最后才是文件名', () => {
    expect(memoryFileLabel(note({ title: ' 部署约定 ' }))).toBe('部署约定')
    expect(baseName('/a/b/c.md')).toBe('c.md')
    expect(
      observationKeyLabel('01a0b305-5618-7202__t000003-000005__n000.md'),
    ).toBe('observation, turns 3–5 (#1)')
    expect(observationKeyLabel('01a0b305__t000007-000007__n002.md')).toBe(
      'observation, turn 7 (#3)',
    )
    expect(observationKeyLabel('MEMORY.md')).toBeNull()
    expect(observationKeyLabel('other__shape.md')).toBeNull()
    expect(memoryFileLabel(note({ path: '/ws/.grok/memory/observations/_inbox/x.md' }))).toBe('x.md')
  })

  it('Global / Workspace / Sessions 分组，会话日志按时间倒序', () => {
    const groups = groupMemoryFiles([
      note({ path: '/ws/.grok/memory/sessions/old.md', source: 'session', modifiedEpochSecs: 100 }),
      note({ path: '/ws/.grok/memory/MEMORY.md', source: 'workspace', generated: true }),
      note({ path: '/home/.grok/memory/topics/g.md', source: 'global' }),
      note({ path: '/ws/.grok/memory/sessions/new.md', source: 'session', modifiedEpochSecs: 900 }),
    ])
    expect(groups.map((g) => g.label)).toEqual(['Global', 'Workspace', 'Sessions'])
    expect(groups[2].items.map((f) => baseName(f.path))).toEqual(['new.md', 'old.md'])
  })

  it('source 缺失时按路径嗅探，无法分类的归入 Sessions（TUI `_ => session`）', () => {
    const groups = groupMemoryFiles([
      note({ path: '/x/.grok/memory/sessions/2026-09-18.md', source: '' }),
      note({ path: '/x/anything/else.md', source: '' }),
    ])
    expect(groups.map((g) => g.label)).toEqual(['Sessions'])
    expect(groups[0].items).toHaveLength(2)
  })

  it('过滤：每个词都必须命中标签/路径/内容', () => {
    const files = [note({ title: '部署约定' }), note({ path: '/ws/.grok/memory/topics/redis.md' })]
    expect(filterMemoryFiles(files, 'redis').map((f) => baseName(f.path))).toEqual(['redis.md'])
    expect(filterMemoryFiles(files, '部署 约定').map(memoryFileLabel)).toEqual(['部署约定'])
    // 内容命中需要已读入的正文
    expect(filterMemoryFiles(files, 'eu-west', { '/ws/.grok/memory/topics/redis.md': 'eu-west 集群' }))
      .toHaveLength(1)
    expect(filterMemoryFiles(files, '')).toHaveLength(2)
  })

  it('空列表 / 只有索引 → hasNotes 为 false（决定是否只渲染通告）', () => {
    expect(memoryHasNotes(normalizeMemoryListing({ files: [] }))).toBe(false)
    expect(
      memoryHasNotes(normalizeMemoryListing({ files: [{ path: '/a/MEMORY.md', generated: true }] })),
    ).toBe(false)
    expect(memoryHasNotes(normalizeMemoryListing({ files: [{ path: '/a/t.md' }] }))).toBe(true)
  })
})

describe('age / size / deletability', () => {
  it('年龄按 TUI format_modified 的档位（— <1m Nm Nh Nd Nw Ny）', () => {
    const now = 2_000_000_000
    expect(formatMemoryAge(undefined, now)).toBe('—')
    expect(formatMemoryAge(now - 10, now)).toBe('<1m')
    expect(formatMemoryAge(now - 300, now)).toBe('5m')
    expect(formatMemoryAge(now - 7200, now)).toBe('2h')
    expect(formatMemoryAge(now - 3 * 86400, now)).toBe('3d')
    // 100 天以内仍按天（TUI：days < 100 → d），之后才有周/年
    expect(formatMemoryAge(now - 30 * 86400, now)).toBe('30d')
    expect(formatMemoryAge(now - 120 * 86400, now)).toBe('17w')
    expect(formatMemoryAge(now - 400 * 86400, now)).toBe('1y')
  })

  it('大小与年龄合成元信息列', () => {
    expect(memorySizeText(note({ sizeBytes: 512, modifiedEpochSecs: Math.floor(Date.now() / 1000) - 60 })))
      .toBe('512 B · 1m')
  })

  it('只有 topics / observations/_inbox 笔记与会话日志可删；索引与超限笔记不可删', () => {
    expect(isMemoryFileDeletable(note())).toBe(true)
    expect(
      isMemoryFileDeletable(
        note({ path: '/ws/.grok/memory/observations/_inbox/01__t000001-000002__n000.md' }),
      ),
    ).toBe(true)
    expect(isMemoryFileDeletable(note({ path: '/ws/.grok/memory/sessions/x.md', source: 'session' }))).toBe(true)
    expect(isMemoryFileDeletable(note({ path: '/ws/.grok/memory/MEMORY.md', generated: true }))).toBe(false)
    expect(
      isMemoryFileDeletable(note({ path: '/ws/.grok/memory/topics/big.md', sizeBytes: MEMORY_FORGET_MAX_FILE_BYTES + 1 })),
    ).toBe(false)
    // 工作区/全局里的非笔记目录（如 manifest、索引旁文件）不可删
    expect(isMemoryFileDeletable(note({ path: '/ws/.grok/memory/manifest.json' }))).toBe(false)
    expect(isMemoryFileDeletable(note({ path: '/ws/.grok/memory/topics/deep/x.md' }))).toBe(false)
  })
})

describe('disabled / empty notices', () => {
  it('可开关的原因只有 session_toggle 与 config_opt_out（未知原因 fail closed）', () => {
    expect(canEnableMemory(undefined)).toBe(true)
    expect(canEnableMemory('session_toggle')).toBe(true)
    expect(canEnableMemory('config_opt_out')).toBe(true)
    expect(canEnableMemory('process_disabled')).toBe(false)
    expect(canEnableMemory('rollout_restricted')).toBe(false)
    expect(canEnableMemory('not_configured')).toBe(false)
    expect(canEnableMemory('something_new')).toBe(false)
  })

  it('每个关闭原因有独立文案，标签可读', () => {
    expect(disabledMemoryNotice('config_opt_out').title).toContain('config.toml')
    expect(disabledMemoryNotice('process_disabled').title).toContain('进程')
    expect(disabledMemoryNotice('rollout_restricted').title).toContain('本会话')
    expect(disabledMemoryNotice('not_configured').title).toContain('未配置')
    expect(disabledMemoryNotice(undefined).lines.length).toBeGreaterThan(1)
    expect(disabledReasonLabel('process_disabled')).toBe('进程级关闭')
    expect(disabledReasonLabel(undefined)).toBe('已关闭')
  })

  it('空状态只宣传本会话可用的动作（capture / dream）', () => {
    const both = emptyMemoryNotice(true, true)
    expect(both.lines.join('\n')).toContain('/remember')
    expect(both.lines.join('\n')).toContain('/dream')
    expect(both.lines.join('\n')).toContain('自动保存')
    const none = emptyMemoryNotice(false, false)
    expect(none.lines.join('\n')).not.toContain('/dream')
    expect(none.lines.join('\n')).not.toContain('自动保存')
  })
})

describe('memoryContentHash', () => {
  it('产出 store 比较用的 BLAKE3 十六进制（已知向量）', () => {
    expect(memoryContentHash('')).toBe(
      'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262',
    )
    expect(memoryContentHash('abc')).toBe(
      '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85',
    )
    // 多字节 UTF-8 按字节哈希（不是 UTF-16 码元）
    expect(memoryContentHash('# 部署约定\n')).toBe(
      '7dc8beba613a2aa536f5b3ac00defea45c09c02f00b0e49b7320ee781c58156f',
    )
    expect(memoryContentHash('abc')).toHaveLength(64)
  })
})
