import type { TransportCore } from '../transport'
import { assertRpcOk, readRpcJson } from './core'

export type AgentRow = {
  name: string
  description: string
  scope: string
  path?: string
  enabled: boolean
  builtin: boolean
  isDefault: boolean
  /** "inherit" or a model id. */
  model: string
  /** "extend" or "full". */
  promptMode: string
  /** Authored allowlist. Empty with toolsDeclared false means the default toolset. */
  tools: string[]
  toolsDeclared: boolean
  disallowedTools: string[]
  skills: string[]
  effort?: string
  isolation?: string
  /** First 120 characters of the prompt body. */
  promptPreview?: string
  promptBody?: string
  promptTruncated?: boolean
}

export type PersonaIO = {
  name: string
  type: string
  required: boolean
  description?: string
}

export type PersonaRow = {
  name: string
  description?: string
  instructions?: string
  instructionsFile?: string
  scope: string
  path?: string
  deletable: boolean
  model?: string
  reasoningEffort?: string
  defaultIsolation?: string
  inputs: PersonaIO[]
  outputs: PersonaIO[]
  hasInputs: boolean
  hasOutputs: boolean
  instructionsTruncated?: boolean
}

async function getJson(core: TransportCore, path: string): Promise<Record<string, unknown>> {
  const res = await core.fetch(core.url(path))
  const data = await readRpcJson(res)
  assertRpcOk(res, data, path + ' failed')
  return (data ?? {}) as Record<string, unknown>
}

async function postJson(core: TransportCore, path: string, body: Record<string, unknown>) {
  const res = await core.fetch(core.url(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await readRpcJson(res)
  assertRpcOk(res, data, path + ' failed')
}

export const agentsRpc = {
  async agentsList(this: TransportCore, cwd?: string): Promise<{ agents: AgentRow[]; configuredDefault: string }> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    const data = await getJson(this, `/api/agents${q}`)
    return {
      agents: Array.isArray(data.agents) ? (data.agents as AgentRow[]) : [],
      configuredDefault: typeof data.configuredDefault === 'string' ? data.configuredDefault : '',
    }
  },
  async agentsSetDefault(this: TransportCore, name: string) {
    await postJson(this, '/api/agents/default', { name })
  },
  async agentsToggle(this: TransportCore, name: string, enabled: boolean) {
    await postJson(this, '/api/agents/toggle', { name, enabled })
  },
  async personasList(this: TransportCore, cwd?: string): Promise<PersonaRow[]> {
    const q = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    const data = await getJson(this, `/api/personas${q}`)
    return Array.isArray(data.personas) ? (data.personas as PersonaRow[]) : []
  },
  async personasCreate(
    this: TransportCore,
    body: { name: string; description: string; instructions: string; scope: 'user' | 'project'; cwd?: string },
  ) {
    await postJson(this, '/api/personas', body)
  },
  async personasDelete(this: TransportCore, path: string) {
    await postJson(this, '/api/personas/delete', { path })
  },
}
