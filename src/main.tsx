import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { engine } from './audio/engine.ts'
import { useStore } from './state/store.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// 开发环境暴露调试句柄(生产构建不含):用于控制台验证 WAV 渲染 / round-trip
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__chip = { engine, useStore }
}
