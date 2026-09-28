import { describe, expect, it } from 'vitest'
import {
  SECRET_FIELDS,
  buildImportValues,
  classifyImportRows,
  hasSecretFields,
  type ImportRow,
} from './importModels'
import type { CustomModelConfig } from '../api/types'

const dsChat: CustomModelConfig = {
  id: 'ds-chat',
  model: 'deepseek-chat',
  base_url: 'https://api.deepseek.com/v1',
  name: 'DeepSeek Chat',
  api_key: 'sk-src-secret',
  context_window: 128000,
  api_backend: 'chat_completions',
}

describe('SECRET_FIELDS 覆盖会带凭据的字段', () => {
  it('api_key 与其他三个键值对字段都在名单里', () => {
    expect([...SECRET_FIELDS]).toEqual([
      'api_key',
      'extra_headers',
      'env_http_headers',
      'query_params',
    ])
  })
})

describe('hasSecretFields', () => {
  it('api_key 有值 → true', () => {
    expect(hasSecretFields(dsChat)).toBe(true)
  })

  it('只有 base_url / name 这类无凭据字段 → false', () => {
    expect(
      hasSecretFields({
        id: 'plain',
        model: 'plain',
        base_url: 'https://api.example.com/v1',
        context_window: 200000,
      }),
    ).toBe(false)
  })

  it('空串、空对象不算「有凭据」（写进配置也开不了门）', () => {
    expect(hasSecretFields({ id: 'x', model: 'x', api_key: '' })).toBe(false)
    expect(hasSecretFields({ id: 'x', model: 'x', extra_headers: {} })).toBe(false)
    expect(hasSecretFields({ id: 'x', model: 'x', query_params: {} })).toBe(false)
  })

  it('藏在 headers 里的 token 也算（列表要标「含密钥」）', () => {
    expect(
      hasSecretFields({ id: 'x', model: 'x', extra_headers: { 'X-Api-Key': 'k' } }),
    ).toBe(true)
  })
})

describe('classifyImportRows', () => {
  it('目标上没有同 id → new', () => {
    const rows = classifyImportRows([dsChat], [])
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('new')
    expect(rows[0].id).toBe('ds-chat')
  })

  it('目标已有同 id → overwrite（整节替换语义）', () => {
    const rows = classifyImportRows([dsChat], [{ id: 'ds-chat', model: 'deepseek-chat' }])
    expect(rows[0].status).toBe('overwrite')
  })

  it('同 slug 属于目标上别的 id → slug-conflict（host 必拒）', () => {
    const rows = classifyImportRows(
      [dsChat],
      [{ id: 'other-entry', model: 'deepseek-chat' }],
    )
    expect(rows[0].status).toBe('slug-conflict')
    expect(rows[0].reason).toContain('other-entry')
  })

  it('同 slug 且就是自己这个 id（改 id 之外的字段）→ overwrite，不算冲突', () => {
    const rows = classifyImportRows([dsChat], [{ id: 'ds-chat', model: 'deepseek-chat' }])
    expect(rows[0].status).toBe('overwrite')
  })

  it('缺 model / base_url → invalid（与 host 侧必填校验一致）', () => {
    const rows = classifyImportRows(
      [
        { id: 'no-slug', base_url: 'https://api.example.com/v1' },
        { id: 'no-url', model: 'x' },
      ],
      [],
    )
    expect(rows.map((r) => r.status)).toEqual(['invalid', 'invalid'])
    expect(rows[0].reason).toContain('model')
    expect(rows[1].reason).toContain('base_url')
  })

  it('空白 slug 不算填了（\'\' 与空格都拒）', () => {
    const rows = classifyImportRows([{ id: 'x', model: '   ', base_url: 'https://a/v1' }], [])
    expect(rows[0].status).toBe('invalid')
  })

  it('源 Host 自己有多条同 slug：留第一条，其余标冲突（导过去必被 host 拒）', () => {
    const rows = classifyImportRows(
      [
        { id: 'a', model: 'same-slug', base_url: 'https://a/v1' },
        { id: 'b', model: 'same-slug', base_url: 'https://b/v1' },
      ],
      [],
    )
    expect(rows.map((r) => r.status)).toEqual(['new', 'slug-conflict'])
    expect(rows[1].reason).toContain('[model.a]')
  })

  it('同 slug 属于目标上同一个 id（正是要覆盖它）→ 不算冲突', () => {
    const rows = classifyImportRows(
      [{ id: 'a', model: 'same-slug', base_url: 'https://a/v2' }],
      [{ id: 'a', model: 'same-slug', base_url: 'https://a/v1' }],
    )
    expect(rows[0].status).toBe('overwrite')
  })
})

describe('buildImportValues', () => {
  const targetWithKey: CustomModelConfig = {
    id: 'ds-chat',
    model: 'deepseek-chat',
    base_url: 'https://api.deepseek.com/v1',
    api_key: 'sk-target-existing',
    extra_headers: { 'X-Tenant': 'target' },
  }

  it('默认复制密钥：源值写进 payload', () => {
    const row: ImportRow = { id: 'ds-chat', cfg: dsChat, status: 'overwrite' }
    const values = buildImportValues(row, targetWithKey, true)
    expect(values.api_key).toBe('sk-src-secret')
    expect(values.model).toBe('deepseek-chat')
    expect(values.context_window).toBe(128000)
  })

  it('不带 id：它是 section 键，由调用方单独传', () => {
    const row: ImportRow = { id: 'ds-chat', cfg: dsChat, status: 'new' }
    expect(buildImportValues(row, undefined, true)).not.toHaveProperty('id')
  })

  it('关掉密钥复制 + 覆盖已有条目 → 保留目标原 key 与 headers（不冲空）', () => {
    const row: ImportRow = { id: 'ds-chat', cfg: dsChat, status: 'overwrite' }
    const values = buildImportValues(row, targetWithKey, false)
    expect(values.api_key).toBe('sk-target-existing')
    expect(values.extra_headers).toEqual({ 'X-Tenant': 'target' })
    // 非密钥字段照常以源为准
    expect(values.context_window).toBe(128000)
  })

  it('关掉密钥复制 + 目标是新建 → 不写密钥字段', () => {
    const row: ImportRow = { id: 'ds-chat', cfg: dsChat, status: 'new' }
    const values = buildImportValues(row, undefined, false)
    expect(values).not.toHaveProperty('api_key')
    expect(values.model).toBe('deepseek-chat')
  })

  it('关掉密钥复制 + 目标该字段本就没值 → 不凭空补空串', () => {
    const row: ImportRow = { id: 'ds-chat', cfg: dsChat, status: 'overwrite' }
    const values = buildImportValues(row, { id: 'ds-chat', model: 'deepseek-chat' }, false)
    expect(values).not.toHaveProperty('api_key')
    expect(values).not.toHaveProperty('extra_headers')
  })

  it('FE 类型不认识的字段也原样透传（host 与 agent 的字段集会演进）', () => {
    const exotic = {
      ...dsChat,
      some_future_field: 'keep-me',
      nested_unknown: { a: 1 },
    } as CustomModelConfig
    const row: ImportRow = { id: 'ds-chat', cfg: exotic, status: 'new' }
    const values = buildImportValues(row, undefined, true)
    expect(values.some_future_field).toBe('keep-me')
    expect(values.nested_unknown).toEqual({ a: 1 })
  })
})
