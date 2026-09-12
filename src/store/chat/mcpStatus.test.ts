import { describe, expect, it } from 'vitest'
import { mcpTone } from './mcpStatus'

describe('mcpTone — x.ai/mcp/server_status status 分级', () => {
  it('shell 的四个 wire 取值各有档位', () => {
    expect(mcpTone('ready')).toBe('ok')
    expect(mcpTone('initializing')).toBe('pending')
    expect(mcpTone('unavailable')).toBe('error')
    expect(mcpTone('needs_auth')).toBe('auth')
  })

  it('list 侧与旧 shell 的同义写法归入正确档位', () => {
    expect(mcpTone('connected')).toBe('ok')
    expect(mcpTone('running')).toBe('ok')
    expect(mcpTone('ok')).toBe('ok')
    expect(mcpTone('setuprequired')).toBe('pending')
    expect(mcpTone('setup_required')).toBe('pending')
    expect(mcpTone('NEEDS_AUTH')).toBe('auth')
    expect(mcpTone(' ready ')).toBe('ok')
  })

  it('缺 status → unknown（未连接，灰）；未知新取值 → error（先亮红再补映射）', () => {
    expect(mcpTone(undefined)).toBe('unknown')
    expect(mcpTone('')).toBe('unknown')
    expect(mcpTone('blocked_by_policy')).toBe('error')
  })
})
