
/** GET /api/extensions — one hook row. */
export type ExtensionHook = {
  name: string
  command?: string
  event?: string
  enabled?: boolean
}

/** GET /api/extensions — one plugin row. */


/** GET /api/extensions — one plugin row. */
export type ExtensionPlugin = {
  name: string
  source?: string
  enabled?: boolean
}

/** GET /api/extensions — one skill row (path = SKILL.md location). */
export type ExtensionSkill = {
  name: string
  scope?: string
  path?: string
  /** Optional enable state — skills without it stay visible under any filter. */
  enabled?: boolean
}

/**
 * POST /api/workflows/list (x.ai/workflows/list) — one workflow catalog
 * entry. Mirrors the shell's `WorkflowListing`
 * (xai-grok-shell/src/session/workflow/registry.rs) and the pager's
 * `WorkflowInfo` (extensions_modal.rs): name / description always present;
 * when_to_use and path are skipped on the wire when absent.
 */
export type WorkflowInfo = {
  name: string
  description: string
  when_to_use?: string
  source: string
  path?: string
}

/**
 * Structured "always allow" scope sent on a permission response — mirrors
 * TUI `BashCommandSelectedTerms` (xai-grok-workspace permission/prompter.rs):
 * a literal command-prefix word list (`isGlob: false`, the ←/→ word-scope)
 * or a single free-form pattern (`isGlob: true`, the pattern editor).
 * Host contract (parallel): POST /api/permission-response `scope` field,
 * parsed verbatim — field names must match exactly.
 */


/**
 * One `[model.<id>]` entry from config.toml — the custom BYOK model schema
 * (mirrors the TUI's `ConfigModelOverride` in
 * xai-grok-shell/src/agent/config.rs). All fields optional except the id
 * (section key), `model` (routing slug) and `base_url`.
 */
export type CustomModelConfig = {
  /** Section key — `[model.<id>]`. Required; stable identifier. */
  id: string
  /** Routing slug sent in API requests. Required. */
  model?: string
  /** Endpoint base URL, e.g. "https://api.x.ai/v1". Required. */
  base_url?: string
  name?: string
  description?: string
  api_key?: string
  /** Env var name(s) for the provider key — string or array. */
  env_key?: string | string[]
  /** Name of a `[auth_provider.<name>]` credential helper. */
  auth_provider?: string
  model_provider?: string
  /** Base URL for API-key auth (session auth uses base_url). */
  api_base_url?: string
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  /** "chat_completions" (default), "responses", "messages". */
  api_backend?: 'chat_completions' | 'responses' | 'messages'
  context_window?: number
  /** Auto-compact threshold percent (0-100). */
  auto_compact_threshold_percent?: number
  system_prompt_label?: string
  use_concise?: boolean
  /** System-prompt identity, e.g. "grok-build". */
  agent_type?: string
  inference_idle_timeout_secs?: number
  max_retries?: number
  hidden?: boolean
  supported_in_api?: boolean
  /** none | minimal | low | medium | high | xhigh | max */
  reasoning_effort?: string
  supports_reasoning_effort?: boolean
  reasoning_efforts?: (
    | string
    | { value: string; id?: string; label?: string; description?: string; default?: boolean }
  )[]
  supports_backend_search?: boolean
  /** true/false dynamic, or fixed N. */
  compactions_remaining?: boolean | number
  compaction_at_tokens?: boolean | number
  show_model_fingerprint?: boolean
  stream_tool_calls?: boolean
  extra_headers?: Record<string, string>
  query_params?: Record<string, string>
  env_http_headers?: Record<string, string>
}

/** One entry of agentInfo._meta.modelState.availableModels. */


/** One entry of agentInfo._meta.modelState.availableModels. */
export type ModelOption = {
  modelId: string
  name?: string
  description?: string
  agentType?: string
  /** Current/default effort on this model (from meta). */
  reasoningEffort?: string
  /** Whether the model advertises supportsReasoningEffort. */
  supportsReasoningEffort?: boolean
  /** Selectable effort levels (empty when unsupported). */
  reasoningEfforts?: ReasoningEffortOption[]
  /** Model context window tokens (meta.totalContextTokens) — TUI context bar total. */
  contextWindow?: number
}

/**
 * One agent-advertised slash command — ACP `AvailableCommand`
 * (agent-client-protocol-schema, `rename_all = "camelCase"`), forwarded
 * verbatim by capri-host as the `commands_update` SSE event's `commands`
 * array. Wire fields: `name`, `description`, `input: { hint }`, `_meta`.
 * The store normalizes it defensively (name required; the rest optional).
 */


/** One effort row from model `_meta.reasoningEfforts` (or built-in fallback). */
export type ReasoningEffortOption = {
  /** Menu id (may remap, e.g. "deep" → wire "xhigh"). */
  id: string
  /** Display label (falls back to id/value). */
  label: string
  /** Canonical wire value sent as `_meta.reasoningEffort`. */
  value: string
  default?: boolean
}

/**
 * One `[model.<id>]` entry from config.toml — the custom BYOK model schema
 * (mirrors the TUI's `ConfigModelOverride` in
 * xai-grok-shell/src/agent/config.rs). All fields optional except the id
 * (section key), `model` (routing slug) and `base_url`.
 */
