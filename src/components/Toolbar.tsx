/**
 * 顶部 OS 风格菜单栏(仿老式 tracker / 经典 Mac 菜单条):
 *   品牌 │ FILE▾ EDIT▾ │ ▶ PLAY ● REC │ BPM 步进 │ BARS 步进
 * - FILE▾:EXPORT WAV / SAVE JSON / LOAD JSON / DEMO / NEW(渲染中 EXPORT 显示 RENDER… 并置灰)
 * - EDIT▾:UNDO / REDO / COPY / CUT / PASTE,右侧对齐快捷键提示(Mac 显示 CMD);
 *   无可用操作置灰;播放中 CUT/PASTE 置灰(播放与编辑互斥)
 * - 菜单交互:点击展开 → 展开时悬停另一菜单名即切换 → 点击空白 / Esc 收起
 *   (Esc 用捕获段监听,先于 useComputerKeys 消费,避免顺手停播放)
 * - ▶ PLAY / ● REC 并排常驻(播放与录制互斥由 store 保证);
 *   BPM / BARS 保持 − 输入 + 步进;音频能力全部通过显式接口调用 engine。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { engine } from '../audio/engine'
import { downloadBlob } from '../lib/download'
import { MAX_BARS, sanitizeProject } from '../state/model'
import { useStore } from '../state/store'
import s from './toolbar.module.css'

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const MOD = IS_MAC ? 'CMD' : 'CTRL'

type MenuId = 'file' | 'edit'

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

  // 复制/剪切/粘贴:enabled 随框选/剪贴板/当前轨上下文(鼓轨不支持;播放与编辑互斥)
  const track = useStore((st) => st.project.tracks[st.selected])
  const region = useStore((st) => st.region)
  const clipboard = useStore((st) => st.clipboard)
  const copySelection = useStore((st) => st.copySelection)
  const cutSelection = useStore((st) => st.cutSelection)
  const pasteClipboard = useStore((st) => st.pasteClipboard)
  const isDrum = track?.instrument === 'noise'
  const canCopy = !isDrum && (region != null || (track?.notes.length ?? 0) > 0)
  const canCut = !isDrum && region != null && !playing
  const canPaste = !isDrum && clipboard != null && !playing

  // 录制(与播放互斥,store 内保证)
  const recMode = useStore((st) => st.recMode)
  const setRecMode = useStore((st) => st.setRecMode)

  const panelOpen = useStore((st) => st.panelOpen)
  const setPanelOpen = useStore((st) => st.setPanelOpen)

  const playTransport = useStore((st) => st.playTransport)
  const stopTransport = useStore((st) => st.stopTransport)
  const loadProject = useStore((st) => st.loadProject)
  const loadDemo = useStore((st) => st.loadDemo)
  const clearProject = useStore((st) => st.clearProject)
  const showToast = useStore((st) => st.showToast)
  const [rendering, setRendering] = useState(false)
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const menusRef = useRef<HTMLElement | null>(null)

  // 菜单外点关闭(仅打开时挂监听,effect 清理退订,StrictMode 安全)
  useEffect(() => {
    if (!openMenu) return
    const close = (e: PointerEvent): void => {
      if (!menusRef.current?.contains(e.target as Node)) setOpenMenu(null)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [openMenu])

  // Esc 收起菜单:捕获段监听,先于 useComputerKeys 的 Esc(停止播放)消费
  useEffect(() => {
    if (!openMenu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setOpenMenu(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [openMenu])

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

  /** 菜单项:执行动作并收起菜单 */
  const run = (fn: () => void) => (): void => {
    setOpenMenu(null)
    fn()
  }

  /** 菜单名按钮:点击切换展开;已有菜单展开时悬停即切换(OS 菜单栏行为) */
  const menuBtn = (id: MenuId, label: string): ReactElement => (
    <button
      className={`${s.menuName} ${openMenu === id ? s.menuNameOn : ''}`}
      onClick={() => setOpenMenu(openMenu === id ? null : id)}
      onPointerEnter={() => {
        if (openMenu && openMenu !== id) setOpenMenu(id)
      }}
      aria-haspopup="menu"
      aria-expanded={openMenu === id}
    >
      {label}
    </button>
  )

  const sc = (keys: string): ReactElement => <span className={s.sc}>{keys}</span>

  return (
    <header className={s.bar}>
      <button
        className={s.menuBtn}
        onClick={() => setPanelOpen(!panelOpen)}
        aria-label="轨道面板"
      >
        ☰
      </button>

      <h1 className={s.title}>
        <span className={s.titleFull}>8-BIT TRACKER</span>
        <span className={s.titleShort}>8BIT</span>
      </h1>

      <nav className={s.menus} ref={menusRef} aria-label="主菜单">
        <div className={s.menuWrap}>
          {menuBtn('file', 'FILE')}
          {openMenu === 'file' && (
            <div className={s.dropdown} role="menu">
              <button className={s.item} onClick={run(exportWav)} disabled={rendering}>
                {rendering ? 'RENDER…' : 'EXPORT WAV'}
              </button>
              <button className={s.item} onClick={run(exportJson)}>
                SAVE JSON
              </button>
              <button className={s.item} onClick={run(() => fileRef.current?.click())}>
                LOAD JSON
              </button>
              <div className={s.sep} />
              <button className={s.item} onClick={run(loadDemo)}>
                DEMO
              </button>
              <button className={s.item} onClick={run(clearProject)}>
                NEW
              </button>
            </div>
          )}
        </div>
        <div className={s.menuWrap}>
          {menuBtn('edit', 'EDIT')}
          {openMenu === 'edit' && (
            <div className={s.dropdown} role="menu">
              <button className={s.item} onClick={run(undo)} disabled={!canUndo}>
                UNDO {sc(`${MOD}+Z`)}
              </button>
              <button className={s.item} onClick={run(redo)} disabled={!canRedo}>
                REDO {sc(IS_MAC ? `${MOD}+SHIFT+Z` : 'CTRL+SHIFT+Z')}
              </button>
              <div className={s.sep} />
              <button className={s.item} onClick={run(copySelection)} disabled={!canCopy}>
                COPY {sc(`${MOD}+C`)}
              </button>
              <button className={s.item} onClick={run(cutSelection)} disabled={!canCut}>
                CUT {sc(`${MOD}+X`)}
              </button>
              <button className={s.item} onClick={run(pasteClipboard)} disabled={!canPaste}>
                PASTE {sc(`${MOD}+V`)}
              </button>
            </div>
          )}
        </div>
      </nav>

      <div className={s.group}>
        <button
          className={`${s.playBtn} ${playing ? s.isStop : s.isPlay}`}
          onClick={() => (playing ? stopTransport() : playTransport())}
        >
          {playing ? '■ STOP' : '▶ PLAY'}
        </button>
        <button
          className={`${s.recBtn} ${recMode ? s.recOn : ''}`}
          onClick={() => setRecMode(!recMode)}
          aria-label="录制模式"
        >
          ● REC
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
    </header>
  )
}
