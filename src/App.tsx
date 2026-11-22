import { useCallback, useState } from 'react'
import { engine } from './audio/engine'
import { BootOverlay } from './components/BootOverlay'
import { Grid } from './components/Grid'
import { Keyboard } from './components/Keyboard'
import { Toast } from './components/Toast'
import { Toolbar } from './components/Toolbar'
import { TrackPanel } from './components/TrackPanel'
import { useComputerKeys } from './hooks/useComputerKeys'
import { useEngineSync } from './hooks/useEngineSync'
import { useStepRecorder } from './hooks/useStepRecorder'
import { useVisibilityResume } from './hooks/useVisibilityResume'
import { useStore } from './state/store'
import st from './app.module.css'

export default function App() {
  const [booted, setBooted] = useState(false)
  useEngineSync()
  useComputerKeys(booted)
  useStepRecorder(booted)
  useVisibilityResume()

  // 启动页手势:在这里创建/恢复 AudioContext(autoplay 政策);ensure 幂等
  const boot = useCallback(() => {
    engine
      .ensure()
      .then(() => setBooted(true))
      .catch(() => {
        useStore.getState().showToast('音频初始化失败,请检查浏览器支持', 'err')
      })
  }, [])

  return (
    <div className={st.app}>
      <Toolbar />
      <main className={st.main}>
        <TrackPanel />
        <Grid />
      </main>
      <Keyboard />
      <Toast />
      {!booted && <BootOverlay onBoot={boot} />}
    </div>
  )
}
