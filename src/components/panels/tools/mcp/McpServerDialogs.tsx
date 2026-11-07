import { Check, Copy, X } from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import { Spinner } from '../../../ui/Spinner'
import type { McpListServer } from '../../../../api/client'
import type { McpRow } from '../../../../lib/mcpPanel'

type AddServerFormState = {
  name: string
  command: string
  args: string
  env: string
  url: string
  type: string
  headers: string
}

type AddServerPanelProps = {
  form: AddServerFormState
  setForm: Dispatch<SetStateAction<AddServerFormState>>
  addTransport: 'stdio' | 'http'
  setAddTransport: (transport: 'stdio' | 'http') => void
  formError?: string
  adding: boolean
  onClose: () => void
  onSubmit: () => void
}

/** 底部「添加服务器」表单（stdio / http 两种 transport）。 */
export function AddServerPanel({
  form,
  setForm,
  addTransport,
  setAddTransport,
  formError,
  adding,
  onClose,
  onSubmit,
}: AddServerPanelProps) {
  return (
            <div className="mt-1 max-h-[50vh] overflow-y-auto rounded-lg border border-gn-prompt-border/70 bg-gn-bg-base p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="text-[11.5px] font-bold text-gn-fg">添加 MCP 服务器</div>
                <div className="flex items-center gap-0.5 rounded border border-gn-prompt-border/70 bg-gn-bg-dark p-0.5" role="tablist" aria-label="transport">
                  {(['stdio', 'http'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      aria-selected={addTransport === t}
                      onClick={() => setAddTransport(t)}
                      className={`rounded px-2.5 py-0.5 font-mono text-[10.5px] font-medium transition-colors ${
                        addTransport === t
                          ? 'bg-gn-bg-highlight text-gn-fg'
                          : 'text-gn-muted hover:text-gn-fg'
                      }`}
                      title={
                        t === 'stdio'
                          ? '本地进程：command / args / env'
                          : 'Streamable HTTP / SSE：url / headers'
                      }
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">name *</span>
                  <input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="filesystem"
                    className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                  />
                </label>
                {addTransport === 'stdio' ? (
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-wider text-gn-gutter">command *</span>
                    <input
                      type="text"
                      value={form.command}
                      onChange={(e) => setForm({ ...form, command: e.target.value })}
                      placeholder="npx"
                      className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                    />
                  </label>
                ) : (
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-wider text-gn-gutter">type</span>
                    <select
                      value={form.type}
                      onChange={(e) => setForm({ ...form, type: e.target.value })}
                      className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                      title="SSE 会走旧式 HTTP+SSE 传输；默认 streamable http"
                    >
                      <option value="http">http</option>
                      <option value="sse">sse</option>
                    </select>
                  </label>
                )}
              </div>
              {addTransport === 'stdio' ? (
                <>
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-wider text-gn-gutter">args</span>
                    <input
                      type="text"
                      value={form.args}
                      onChange={(e) => setForm({ ...form, args: e.target.value })}
                      placeholder='空格分隔，或 JSON 数组，如 ["-y","pkg"]'
                      className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-wider text-gn-gutter">env</span>
                    <textarea
                      value={form.env}
                      onChange={(e) => setForm({ ...form, env: e.target.value })}
                      placeholder={"每行 KEY=value"}
                      rows={2}
                      className="mt-0.5 w-full resize-y rounded border border-gn-prompt-border bg-gn-bg-dark px-2.5 py-1 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-wider text-gn-gutter">url *</span>
                    <input
                      type="text"
                      value={form.url}
                      onChange={(e) => setForm({ ...form, url: e.target.value })}
                      placeholder="https://mcp.example.com/api/mcp"
                      className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-wider text-gn-gutter">headers</span>
                    <textarea
                      value={form.headers}
                      onChange={(e) => setForm({ ...form, headers: e.target.value })}
                      placeholder={'每行 Name: value，如\nAuthorization: Bearer sk-…'}
                      rows={2}
                      className="mt-0.5 w-full resize-y rounded border border-gn-prompt-border bg-gn-bg-dark px-2.5 py-1 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                    />
                  </label>
                </>
              )}
              {formError ? (
                <div className="rounded border border-gn-diff-del-bg px-2 py-1 text-[11px] text-gn-red">
                  {formError}
                </div>
              ) : null}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={adding}
                  onClick={onClose}
                  className="rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={adding}
                  onClick={() => onSubmit()}
                  className="inline-flex items-center gap-1.5 rounded border border-gn-prompt-border bg-gn-bg-highlight px-3 py-1 text-[11px] font-medium text-gn-fg hover:bg-gn-bg-hover hover:border-gn-prompt-border-active disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {adding ? <Spinner size={11} /> : null}
                  {adding ? '添加中…' : '添加'}
                </button>
              </div>
            </div>  )
}

type CallToolPanelProps = {
  rows: McpRow[]
  list: McpListServer[]
  callForm: { server: string; tool: string; args: string }
  setCallForm: Dispatch<SetStateAction<{ server: string; tool: string; args: string }>>
  callError?: string
  callResult?: string
  calling: boolean
  copiedResult: boolean
  onCopyResult: (text: string) => void
  onClose: () => void
  onSubmit: () => void
}

/** 底部「调用工具」调试表单与结果。 */
export function CallToolPanel({
  rows,
  list,
  callForm,
  setCallForm,
  callError,
  callResult,
  calling,
  copiedResult,
  onCopyResult,
  onClose,
  onSubmit,
}: CallToolPanelProps) {
  return (
            <div className="mt-1 max-h-[50vh] overflow-y-auto rounded-lg border border-gn-prompt-border/70 bg-gn-bg-base p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="text-[11.5px] font-bold text-gn-fg">调试 MCP 工具调用</div>
                <button
                  type="button"
                  onClick={onClose}
                  className="text-gn-muted hover:text-gn-fg"
                >
                  <X size={13} />
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">server *</span>
                  <select
                    value={callForm.server}
                    onChange={(e) => {
                      const server = e.target.value
                      setCallForm((f) => ({ ...f, server, tool: '' }))
                    }}
                    className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                  >
                    <option value="">— 选择服务器 —</option>
                    {rows.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">tool *</span>
                  <input
                    type="text"
                    list="mcp-call-tools"
                    value={callForm.tool}
                    onChange={(e) => setCallForm({ ...callForm, tool: e.target.value })}
                    placeholder="工具名（可从已连接服务器的工具列表选择）"
                    className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-prompt-border-active"
                  />
                  <datalist id="mcp-call-tools">
                    {list
                      .find((s) => s.name === callForm.server)
                      ?.tools?.map((t) => <option key={t.name} value={t.name} />)}
                  </datalist>
                </label>
              </div>

              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-gn-gutter">arguments（可选 JSON）</span>
                <textarea
                  value={callForm.args}
                  onChange={(e) => setCallForm({ ...callForm, args: e.target.value })}
                  placeholder='{"path": "/tmp/x"}'
                  rows={2}
                  className="mt-0.5 w-full resize-y rounded border border-gn-prompt-border bg-gn-bg-dark px-2 py-1 font-mono text-[11.5px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-prompt-border-active"
                />
              </label>

              {callError ? (
                <div className="rounded border border-gn-diff-del-bg px-2 py-1 text-[11px] text-gn-red">
                  {callError}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={calling}
                  onClick={onClose}
                  className="rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={calling}
                  onClick={() => onSubmit()}
                  className="inline-flex items-center gap-1.5 rounded border border-gn-prompt-border bg-gn-bg-highlight px-3 py-1 text-[11px] font-medium text-gn-fg hover:bg-gn-bg-hover hover:border-gn-prompt-border-active disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {calling ? <Spinner size={11} /> : null}
                  {calling ? '调用中…' : '调用'}
                </button>
              </div>

              {callResult ? (
                <div className="mt-2">
                  <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gn-gutter mb-1">
                    <span>调用结果</span>
                    <button
                      type="button"
                      onClick={() => onCopyResult(callResult)}
                      className="flex items-center gap-1 text-gn-muted hover:text-gn-fg"
                    >
                      {copiedResult ? <Check size={11} className="text-gn-green" /> : <Copy size={11} />}
                      <span>{copiedResult ? '已复制' : '复制结果'}</span>
                    </button>
                  </div>
                  <pre className="gn-no-scrollbar max-h-44 overflow-auto whitespace-pre-wrap break-all rounded border border-gn-prompt-border bg-gn-bg-dark p-2 font-mono text-[10.5px] leading-snug text-gn-fg2">
                    {callResult}
                  </pre>
                </div>
              ) : null}
            </div>  )
}

type ReadResourcePanelProps = {
  rows: McpRow[]
  readForm: { server: string; uri: string }
  setReadForm: Dispatch<SetStateAction<{ server: string; uri: string }>>
  readError?: string
  readResult?: string
  reading: boolean
  copiedResult: boolean
  onCopyResult: (text: string) => void
  onClose: () => void
  onSubmit: () => void
}

/** 底部「读取资源」表单与结果。 */
export function ReadResourcePanel({
  rows,
  readForm,
  setReadForm,
  readError,
  readResult,
  reading,
  copiedResult,
  onCopyResult,
  onClose,
  onSubmit,
}: ReadResourcePanelProps) {
  return (
            <div className="mt-1 max-h-[50vh] overflow-y-auto rounded-lg border border-gn-prompt-border/70 bg-gn-bg-base p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="text-[11.5px] font-bold text-gn-fg">读取 MCP 资源</div>
                <button
                  type="button"
                  onClick={onClose}
                  className="text-gn-muted hover:text-gn-fg"
                >
                  <X size={13} />
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">server *</span>
                  <select
                    value={readForm.server}
                    onChange={(e) => setReadForm((f) => ({ ...f, server: e.target.value }))}
                    className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none focus:border-gn-prompt-border-active"
                  >
                    <option value="">— 选择服务器 —</option>
                    {rows.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-gn-gutter">uri *</span>
                  <input
                    type="text"
                    value={readForm.uri}
                    onChange={(e) => setReadForm({ ...readForm, uri: e.target.value })}
                    placeholder="file:///… 或 mcp://… 等资源 URI"
                    className="mt-0.5 box-border h-7 w-full rounded border border-gn-prompt-border bg-gn-bg-dark px-2 font-mono text-[11.5px] text-gn-fg outline-none placeholder:text-gn-gray focus:border-gn-prompt-border-active"
                  />
                </label>
              </div>

              {readError ? (
                <div className="rounded border border-gn-diff-del-bg px-2 py-1 text-[11px] text-gn-red">
                  {readError}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={reading}
                  onClick={onClose}
                  className="rounded px-3 py-1 text-[11px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={reading}
                  onClick={() => onSubmit()}
                  className="inline-flex items-center gap-1.5 rounded border border-gn-prompt-border bg-gn-bg-highlight px-3 py-1 text-[11px] font-medium text-gn-fg hover:bg-gn-bg-hover hover:border-gn-prompt-border-active disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {reading ? <Spinner size={11} /> : null}
                  {reading ? '读取中…' : '读取'}
                </button>
              </div>

              {readResult ? (
                <div className="mt-2">
                  <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-gn-gutter mb-1">
                    <span>资源内容</span>
                    <button
                      type="button"
                      onClick={() => onCopyResult(readResult)}
                      className="flex items-center gap-1 text-gn-muted hover:text-gn-fg"
                    >
                      {copiedResult ? <Check size={11} className="text-gn-green" /> : <Copy size={11} />}
                      <span>{copiedResult ? '已复制' : '复制内容'}</span>
                    </button>
                  </div>
                  <pre className="gn-no-scrollbar max-h-44 overflow-auto whitespace-pre-wrap break-all rounded border border-gn-prompt-border bg-gn-bg-dark p-2 font-mono text-[10.5px] leading-snug text-gn-fg2">
                    {readResult}
                  </pre>
                </div>
              ) : null}
            </div>  )
}
