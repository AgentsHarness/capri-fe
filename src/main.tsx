import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { useChatStore } from './store/chat'

if (import.meta.env.DEV) {
  // @ts-expect-error dev inspection hook
  window.__chatStore = useChatStore
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
