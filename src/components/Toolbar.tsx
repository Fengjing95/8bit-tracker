/**
 * 顶部传输与文件工具条:播放/停止、BPM/BARS、撤销/重做、WAV 导出、JSON 存取、示例曲/清空。
 * 音频能力全部通过显式接口调用 engine,Context 不进组件状态。
 */
import { useRef, useState } from 'react'
import { engine } from '../audio/engine'
import { downloadBlob } from '../lib/download'
import { MAX_BARS, sanitizeProject } from '../state/model'
import { useStore } from '../state/store'
import s from './toolbar.module.css'

export function Toolbar() {
  const bpm = useStore((st) => st.project.bpm)
  const bars = useStore((st) => st.project.bars)
  const playing = useStore((st) => st.playing)
  const setBpm = useStore((st) => st.setBpm)
  const setBars = useStore((st) => st.setBars)

  // BPM 自由整数 40..240(store 内钳制):− / + 步进,输入框可直接键入
  const changeBpm = (dir: number): void => {
    setBpm(bpm + dir)
  }
  const commitBpmInput = (v: number): void => {
    if (Number.isFinite(v)) setBpm(Math.round(v))
  }

  // 小节数自由整数 1..MAX_BARS:− / + 步进,输入框可直接键入
  const changeBars = (dir: number): void => {
    setBars(bars + dir)
  }
  const commitBarsInput = (v: number): void => {
    if (Number.isFinite(v)) setBars(Math.round(v))
  }

  const undo = useStore((st) => st.undo)
  const redo = useStore((st) => st.redo)
  const canUndo = useStore((st) => st.past.length > 0)
  const canRedo = useStore((st) => st.future.length > 0)
  const playTransport = useStore((st) => st.playTransport)
  const stopTransport = useStore((st) => st.stopTransport)
  const loadProject = useStore((st) => st.loadProject)
  const loadDemo = useStore((st) => st.loadDemo)
  const clearProject = useStore((st) => st.clearProject)
  const showToast = useStore((st) => st.showToast)
  const [rendering, setRendering] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const exportWav = (): void => {
    setRendering(true)
    engine
      .renderWav()
      .then((blob) => {
        downloadBlob(blob, `chiptune-${bpm}bpm.wav`)
        showToast('WAV 已导出(整曲循环 2 遍)✓')
      })
      .catch((err: unknown) => {
        showToast(`导出失败:${err instanceof Error ? err.message : String(err)}`, 'err')
      })
      .finally(() => setRendering(false))
  }

  const exportJson = (): void => {
    const file = {
      app: '8bit-tracker',
      version: 1,
      project: useStore.getState().project,
    }
    const blob = new Blob([JSON.stringify(file, null, 2)], {
      type: 'application/json',
    })
    downloadBlob(blob, 'chiptune-project.json')
    showToast('工程 JSON 已导出 ✓')
  }

  const onImportFile = (f: File): void => {
    f.text()
      .then((text) => {
        const p = sanitizeProject(JSON.parse(text))
        loadProject(p)
        showToast('工程已导入 ✓')
      })
      .catch(() => {
        showToast('导入失败:不是有效的工程 JSON', 'err')
      })
  }

  return (
    <header className={s.bar}>
      <h1 className={s.title}>8-BIT TRACKER</h1>

      <div className={s.group}>
        <button
          className={`${s.playBtn} ${playing ? s.isStop : s.isPlay}`}
          onClick={() => (playing ? stopTransport() : playTransport())}
        >
          {playing ? '■ STOP' : '▶ PLAY'}
        </button>
        <span className={s.loopBadge}>LOOP</span>
      </div>

      <div className={s.group}>
        <span className={s.label}>BPM</span>
        <button className={s.stepBtn} onClick={() => changeBpm(-1)} aria-label="降 BPM">
          −
        </button>
        <input
          className={s.bpmInput}
          type="number"
          min={40}
          max={240}
          value={bpm}
          onChange={(e) => commitBpmInput(e.target.valueAsNumber)}
          aria-label="BPM"
        />
        <button className={s.stepBtn} onClick={() => changeBpm(1)} aria-label="升 BPM">
          +
        </button>
      </div>

      <div className={s.group}>
        <span className={s.label}>BARS</span>
        <button className={s.stepBtn} onClick={() => changeBars(-1)} aria-label="减小节数">
          −
        </button>
        <input
          className={s.barsInput}
          type="number"
          min={1}
          max={MAX_BARS}
          value={bars}
          onChange={(e) => commitBarsInput(e.target.valueAsNumber)}
          aria-label="小节数"
        />
        <button className={s.stepBtn} onClick={() => changeBars(1)} aria-label="加小节数">
          +
        </button>
      </div>

      <div className={s.group}>
        <button className={s.pbtn} onClick={undo} disabled={!canUndo} aria-label="撤销">
          ↶ UNDO
        </button>
        <button className={s.pbtn} onClick={redo} disabled={!canRedo} aria-label="重做">
          ↷ REDO
        </button>
      </div>

      <div className={s.group}>
        <button className={s.pbtn} onClick={exportWav} disabled={rendering}>
          {rendering ? 'RENDER…' : 'EXPORT WAV'}
        </button>
        <button className={s.pbtn} onClick={exportJson}>
          SAVE JSON
        </button>
        <button className={s.pbtn} onClick={() => fileRef.current?.click()}>
          LOAD JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className={s.fileInput}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onImportFile(f)
            e.target.value = '' // 允许连续选择同一文件
          }}
        />
      </div>

      <div className={s.group}>
        <button className={s.pbtn} onClick={loadDemo}>
          DEMO
        </button>
        <button className={s.pbtn} onClick={clearProject}>
          NEW
        </button>
      </div>
    </header>
  )
}
