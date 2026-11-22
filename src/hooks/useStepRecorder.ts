/**
 * 录制模式步进时钟:驱动网格光标按 BPM 前进(16 分音符步长),
 * 虚拟琴键 / 鼓垫 / 电脑键位的写入落在光标当前步(见 Keyboard / useComputerKeys)。
 *
 * 两相位(recMode 开启即与播放互斥,见 store.setRecMode,故无播放同步分支):
 * - 倒数(recCountin = true):维持 1 小节拍点倒计时 —— 光标停在起始步闪烁,
 *   每拍(4 步)发一枚 hi-hat click 作计数音;倒数结束 setRecCountin(false);
 * - 录制(recCountin = false):本地相位时钟 —— t0 使「倒数结束时刻」对应 caret.step,
 *   每 60ms 轮询 floor((now − t0) / stepDur) 推步,不累积定时器漂移;
 *   BPM / 小节数变化重建时钟并从当前 caret.step 续相位。
 * rAF/定时器在后台标签被节流时步进会暂停,回前台自动续上(useVisibilityResume 兜底)。
 */
import { useEffect } from 'react'
import { engine } from '../audio/engine'
import { stepCountOf } from '../state/model'
import { useStore } from '../state/store'

const TICK_MS = 60 // 相位轮询周期(≤ 1/8 步长 @ 240bpm 即可,分辨率足够)
const COUNTIN_STEPS = 16 // 倒数 1 小节

export function useStepRecorder(active: boolean): void {
  const recMode = useStore((st) => st.recMode)
  const recCountin = useStore((st) => st.recCountin)
  const bpm = useStore((st) => st.project.bpm)
  const bars = useStore((st) => st.project.bars)

  useEffect(() => {
    if (!active || !recMode) return

    // 进入录制:光标为空先初始化(写入目标必须有)
    const st0 = useStore.getState()
    if (!st0.caret) st0.setCaret({ step: 0, pitch: 60 })

    const sc = stepCountOf(bars)
    const stepDurMs = 60000 / bpm / 4 // 16 分音符步长

    // ── 倒数相位:1 小节拍点 click,结束进入录制 ──
    if (recCountin) {
      const t0 = performance.now()
      let lastIdx = -1
      const timer = setInterval(() => {
        const idx = Math.floor((performance.now() - t0) / stepDurMs)
        if (idx === lastIdx) return
        lastIdx = idx
        if (idx < COUNTIN_STEPS) {
          if (idx % 4 === 0) engine.previewDrum(2) // 每拍一枚 hi-hat 计数音
          return
        }
        useStore.getState().setRecCountin(false) // 倒数结束 → 重建效果进入录制相位
      }, TICK_MS)
      return () => clearInterval(timer)
    }

    // ── 录制相位:本地相位时钟(无累积漂移)──
    // 相位一次性锚定:t0 使「此刻」对应 caret.step,此后步号纯由时间推出
    const startStep = useStore.getState().caret?.step ?? 0
    const t0 = performance.now() - startStep * stepDurMs
    let lastStep = -1
    const tick = (): void => {
      const st = useStore.getState()
      if (!st.recMode) return
      const step = Math.floor((performance.now() - t0) / stepDurMs) % sc
      if (step !== lastStep) {
        lastStep = step
        if (step !== st.caret?.step) {
          st.setCaret({ step, pitch: st.caret?.pitch ?? 60 })
        }
      }
    }
    const timer = setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  }, [active, recMode, recCountin, bpm, bars])
}
