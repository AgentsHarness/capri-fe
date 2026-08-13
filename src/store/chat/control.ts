import { usePromptQueue } from '../promptQueue'
import type { ChatState, SetState } from './types'

/**
 * Send a workflow control prompt through the PROMPT path: queue
 * mid-turn like any Enter prompt (promptQueue auto-sends at turn end),
 * send immediately otherwise. `feedback` lands on the status line AFTER
 * send()'s synchronous 'Thinking' stamp so the confirmation stays
 * visible; the next connection event replaces it.
 * (Goals no longer use this path — they are driven by the host engine
 * via /api/goal/*; see the goalSet docs above.)
 */
export function sendControlPrompt(
  get: () => ChatState,
  set: SetState,
  text: string,
  feedback: string,
): void {
  const st = get()
  if (st.conn === 'busy') {
    usePromptQueue.getState().enqueue(
      {
        text,
        blocks: [{ type: 'text', text }],
      },
      st.sessionId ?? '',
    )
    set({ statusText: `${feedback}（已排队，回合结束后发送）` })
    return
  }
  void st.send(text)
  set({ statusText: feedback })
}
