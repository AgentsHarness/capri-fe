import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useChatStore } from '../store/chat'
import { applyToolsetSettings, ensureToolsetSettings } from '../store/settings'
import { QuestionModal } from './QuestionModal'

const transportMock = vi.hoisted(() => ({
  settings: vi.fn(),
  onEvent: () => () => {},
}))
vi.mock('../api/client', () => ({ transport: transportMock }))

const respondXaiMock = vi.fn(async () => {})
const dismissXaiMock = vi.fn(async () => {})

const ANCHOR_ID = 'capri-xai-question-anchor'

/** 一张单题卡片（requestId r1）。卡片 portal 到 Composer 的 anchor。 */
function renderCard(params: Record<string, unknown>) {
  if (!document.getElementById(ANCHOR_ID)) {
    const anchor = document.createElement('div')
    anchor.id = ANCHOR_ID
    document.body.appendChild(anchor)
  }
  useChatStore.setState({
    xaiRequests: [
      {
        requestId: 'r1',
        method: 'x.ai/ask_user_question',
        params: {
          questions: [
            {
              question: 'Q?',
              options: [{ label: 'A', description: 'opt A' }],
            },
          ],
          ...params,
        },
      },
    ],
    respondXai: respondXaiMock,
    dismissXai: dismissXaiMock,
  })
  return render(<QuestionModal />)
}

afterEach(() => {
  applyToolsetSettings(undefined)
  transportMock.settings.mockReset()
  transportMock.settings.mockResolvedValue({})
  document.getElementById(ANCHOR_ID)?.remove()
  document.body.querySelectorAll('input').forEach((el) => el.remove())
})

describe('QuestionModal timeout 呈现', () => {
  it('wire 无 deadline + 配置开启 → 静态提示（基于配置秒数），不渲染倒计时', async () => {
    transportMock.settings.mockResolvedValue({
      toolset: { ask_user_question: { timeout_enabled: true, timeout_secs: 45 } },
    })
    await ensureToolsetSettings()
    renderCard({})
    await waitFor(() =>
      expect(screen.getByText('本会话提问超时 45 秒后自动放弃')).not.toBeNull(),
    )
    expect(screen.queryByText(/倒计时/)).toBeNull()
  })

  it('wire 无 deadline + timeout 关闭 → 不显示任何超时提示', async () => {
    transportMock.settings.mockResolvedValue({
      toolset: { ask_user_question: { timeout_enabled: false, timeout_secs: 45 } },
    })
    await ensureToolsetSettings()
    renderCard({})
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull())
    expect(screen.queryByText(/自动放弃/)).toBeNull()
    expect(screen.queryByText(/倒计时|超时/)).toBeNull()
  })

  it('wire 无 deadline + 未配置 → 提示 agent 默认 1800 秒并标注默认', async () => {
    transportMock.settings.mockResolvedValue({})
    await ensureToolsetSettings()
    renderCard({})
    await waitFor(() =>
      expect(screen.getByText('本会话提问超时 1800 秒后自动放弃（默认）')).not.toBeNull(),
    )
  })

  it('wire 带 deadlineAt（未来扩展）→ 真实倒计时，到点等待 agent 收尾', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_700_000_000_000)
      transportMock.settings.mockResolvedValue({})
      await ensureToolsetSettings()
      renderCard({ deadlineAt: 1_700_000_000_000 + 120_000 })
      const status = () => screen.getByRole('status')
      expect(status().textContent).toContain('提问倒计时 2:00')
      // 推进过 deadline：倒计时归零，等待 agent 收尾（FE 不自动应答）
      act(() => {
        vi.advanceTimersByTime(121_000)
      })
      expect(status().textContent).toContain('提问已超时，等待 agent 收尾…')
      expect(respondXaiMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('deadlineAt 非法/已过期 → 不渲染倒计时，回退静态提示', async () => {
    transportMock.settings.mockResolvedValue({
      toolset: { ask_user_question: { timeout_enabled: true, timeout_secs: 45 } },
    })
    await ensureToolsetSettings()
    renderCard({ deadlineAt: 1000 }) // 早已过期
    await waitFor(() => expect(screen.getByText('本会话提问超时 45 秒后自动放弃')).not.toBeNull())
    expect(screen.queryByText(/倒计时/)).toBeNull()
  })
})
describe('QuestionModal 键盘选择 + 提交', () => {
  beforeEach(() => {
    respondXaiMock.mockClear()
    dismissXaiMock.mockClear()
  })

  const twoOptions = {
    questions: [
      {
        question: 'Q?',
        options: [
          { label: 'A', description: 'opt A' },
          { label: 'B', description: 'opt B' },
        ],
      },
    ],
  }

  it('最后一题按 Enter → 提交刚选中的那一项（不是上一次渲染的旧选择）', async () => {
    renderCard(twoOptions)
    await waitFor(() => expect(screen.getByText('Q?')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() =>
      expect(respondXaiMock).toHaveBeenCalledWith('r1', {
        outcome: 'accepted',
        answers: { 'Q?': ['A'] },
      }),
    )
  })

  it('最后一题按数字键 → 提交该项', async () => {
    renderCard(twoOptions)
    await waitFor(() => expect(screen.getByText('Q?')).not.toBeNull())
    fireEvent.keyDown(window, { key: '2' })
    await waitFor(() =>
      expect(respondXaiMock).toHaveBeenCalledWith('r1', {
        outcome: 'accepted',
        answers: { 'Q?': ['B'] },
      }),
    )
  })

  it('多题：第一题 Enter 只前进到下一题，最后一题才提交（含各题选择）', async () => {
    renderCard({
      questions: [
        { question: 'Q1?', options: [{ label: 'A1' }, { label: 'A2' }] },
        { question: 'Q2?', options: [{ label: 'B1' }, { label: 'B2' }] },
      ],
    })
    await waitFor(() => expect(screen.getByText('Q1?')).not.toBeNull())
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(respondXaiMock).not.toHaveBeenCalled()
    // 前进到第二题，聚焦第 2 项后 Enter → 提交两题
    fireEvent.keyDown(window, { key: 'j' })
    fireEvent.keyDown(window, { key: 'Enter' })
    await waitFor(() =>
      expect(respondXaiMock).toHaveBeenCalledWith('r1', {
        outcome: 'accepted',
        answers: { 'Q1?': ['A1'], 'Q2?': ['B2'] },
      }),
    )
  })

  it('多选卡片：Space 切换不提交，提交按钮走当前选择', async () => {
    renderCard({
      questions: [
        { question: 'M?', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
      ],
    })
    await waitFor(() => expect(screen.getByText('M?')).not.toBeNull())
    fireEvent.keyDown(window, { key: ' ' })
    expect(respondXaiMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await waitFor(() =>
      expect(respondXaiMock).toHaveBeenCalledWith('r1', {
        outcome: 'accepted',
        answers: { 'M?': ['X'] },
      }),
    )
  })
})
