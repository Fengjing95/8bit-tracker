/**
 * 底部试奏键盘:虚拟琴键(按住发声)+ 鼓轨时显示 4 个打击垫。
 * 电脑键位映射见 lib/keys.ts(与本组件共享同一音高表)。
 * 双模式(REC toggle,时钟见 useStepRecorder):
 * - 编辑(默认):点琴键/鼓垫纯试奏,音符用鼠标在网格上操作;
 * - 录制:步进光标按 BPM 自动前进,点琴键/鼓垫写入光标当前步(不手动前进;
 *   时值取 insertLen,可按 [ / ] 调),音符与鼓机同时生效。
 * 收合按钮:隐藏琴体给网格让空间(状态存 store,不持久化)。
 */
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { engine } from '../audio/engine'
import { INSTRUMENT_META, stepCountOf } from '../state/model'
import { useStore } from '../state/store'
import s from './keyboard.module.css'

const WW = 34 // 白键宽
const BW = 22 // 黑键宽

/** REC 长按中的音符:按下步位与时间戳,松手按时值定稿(音高 → 状态) */
interface HeldNote {
  step: number
  t0: number
}

const WHITES: number[] = [48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72]
const BLACKS: Array<{ p: number; i: number }> = [
  { p: 49, i: 0 },
  { p: 51, i: 1 },
  { p: 54, i: 3 },
  { p: 56, i: 4 },
  { p: 58, i: 5 },
  { p: 61, i: 7 },
  { p: 63, i: 8 },
  { p: 66, i: 10 },
  { p: 68, i: 11 },
  { p: 70, i: 12 },
]
const KEY_CHARS: Record<number, string> = {
  48: 'Z', 49: 'S', 50: 'X', 51: 'D', 52: 'C', 53: 'V', 54: 'G', 55: 'B',
  56: 'H', 57: 'N', 58: 'J', 59: 'M', 60: 'Q', 61: '2', 62: 'W', 63: '3',
  64: 'E', 65: 'R', 66: '5', 67: 'T', 68: '6', 69: 'Y', 70: '7', 71: 'U', 72: 'I',
}
const DRUM_PADS = [
  { kind: 0, label: 'KICK', key: 'Z' },
  { kind: 1, label: 'SNARE', key: 'X' },
  { kind: 2, label: 'HI-HAT', key: 'C' },
  { kind: 3, label: 'CRASH', key: 'V' },
]

export function Keyboard() {
  const selected = useStore((st) => st.selected)
  const inst = useStore((st) => st.project.tracks[st.selected].instrument)
  const recMode = useStore((st) => st.recMode)
  const setRecMode = useStore((st) => st.setRecMode)
  const keyboardOpen = useStore((st) => st.keyboardOpen)
  const setKeyboardOpen = useStore((st) => st.setKeyboardOpen)
  const [pressed, setPressed] = useState<Set<number>>(new Set())
  const heldRef = useRef<Map<number, HeldNote>>(new Map())

  // REC 长按:每 120ms 巡检各按住音符(虚拟琴键 + 电脑键位共用)的应有时值(步数),
  // 以静默更新方式延长(push = false 不入撤销历史,松手定稿时一次性入账)
  useEffect(() => {
    if (!recMode) return
    const timer = setInterval(() => {
      const st = useStore.getState()
      if (!st.recMode || st.recCountin || heldRef.current.size === 0) return
      const stepDurMs = 60000 / st.project.bpm / 4
      for (const [pitch, held] of heldRef.current) {
        const steps = Math.floor((performance.now() - held.t0) / stepDurMs) + 1
        st.setNoteLen(st.selected, held.step, pitch, steps, false)
      }
    }, 120)
    return () => clearInterval(timer)
  }, [recMode])

  // REC 录制定稿:按持按步数写入最终时值(与中间延长不同,入撤销历史)
  const finalizeHeld = (p: number): void => {
    const held = heldRef.current.get(p)
    if (!held) return
    heldRef.current.delete(p)
    const st = useStore.getState()
    const stepDurMs = 60000 / st.project.bpm / 4
    const heldSteps = Math.max(1, Math.floor((performance.now() - held.t0) / stepDurMs) + 1)
    st.setNoteLen(st.selected, held.step, p, heldSteps)
  }

  const press = (p: number): void => {
    if (pressed.has(p)) return
    setPressed((prev) => new Set(prev).add(p))
    engine.previewOn(`m${p}`, selected, p)
  }

  const release = (p: number): void => {
    engine.previewOff(`m${p}`)
    setPressed((prev) => {
      if (!prev.has(p)) return prev
      const next = new Set(prev)
      next.delete(p)
      return next
    })
  }

  // REC 录制写入音高:落在步进光标当前步(光标由 useStepRecorder 按 BPM 推进),
  // 1 步起录 + 按住持续发声,松手按持按步数定稿时值;倒数阶段只试听不写入
  const recPitch = (p: number): void => {
    const st = useStore.getState()
    if (st.recCountin) {
      engine.previewOn(`m${p}`, st.selected, p)
      return
    }
    const sc = stepCountOf(st.project.bars)
    const step = Math.min(st.caret?.step ?? 0, sc - 1)
    st.clearRegion() // 写入也是"放置",先清除框选
    st.addNote(st.selected, step, p, 1) // 同格已存在则跳过(addNote 幂等)
    heldRef.current.set(p, { step, t0: performance.now() })
    setPressed((prev) => new Set(prev).add(p)) // 按压视觉态
    engine.previewOn(`m${p}`, st.selected, p)
  }

  // REC 录制写入鼓件:光标当前步,本步无同鼓件才写入(只加不删);倒数阶段只试听
  const writeDrum = (kind: number): void => {
    const st = useStore.getState()
    if (st.recCountin) {
      engine.previewDrum(kind)
      return
    }
    const caret = st.caret ?? { step: 0 }
    const t = st.project.tracks[st.selected]
    const exists = t.notes.some((n) => n.step === caret.step && n.pitch === kind)
    if (!exists) st.toggleDrum(st.selected, caret.step, kind)
    engine.previewDrum(kind)
  }

  const down = (p: number) => (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    if (useStore.getState().recMode) {
      recPitch(p)
      return
    }
    press(p)
  }
  const up = (p: number) => (): void => {
    if (useStore.getState().recMode && heldRef.current.has(p)) {
      engine.previewOff(`m${p}`)
      finalizeHeld(p)
      release(p) // 清理按压视觉态
      return
    }
    release(p)
  }

  const headRow = (
    <div className={s.headRow}>
      <div className={s.label}>
        {inst === 'noise' ? 'DRUM PADS · NOISE' : `KEYBOARD · ${INSTRUMENT_META[inst].label}`}
      </div>
      <div className={s.headBtns}>
        <button
          className={`${s.kbtn} ${recMode ? s.writeOn : ''}`}
          onClick={() => setRecMode(!recMode)}
          aria-label="录制模式"
        >
          ● REC
        </button>
        <button
          className={s.kbtn}
          onClick={() => setKeyboardOpen(!keyboardOpen)}
          aria-label="收起或展开键盘"
        >
          {keyboardOpen ? '▼' : '▲'}
        </button>
      </div>
    </div>
  )

  if (inst === 'noise') {
    return (
      <footer className={s.wrap}>
        {headRow}
        {keyboardOpen && (
          <>
            <div className={`${s.pads} ${recMode ? s.write : ''}`}>
              {DRUM_PADS.map((d) => (
                <button
                  key={d.kind}
                  className={`${s.pad} ${
                    d.kind === 0
                      ? s.padKick
                      : d.kind === 1
                        ? s.padSnare
                        : d.kind === 2
                          ? s.padHat
                          : s.padCrash
                  }`}
                  onPointerDown={() => {
                    if (useStore.getState().recMode) writeDrum(d.kind)
                    else engine.previewDrum(d.kind)
                  }}
                >
                  <span className={s.padName}>{d.label}</span>
                  <span className={s.padKey}>{d.key}</span>
                </button>
              ))}
            </div>
            <div className={s.hint}>
              鼓轨:编辑模式点垫试奏 · REC 录制:光标按 BPM 前进,点垫写入当前步 · SPACE 播放(录制与回放同步)
            </div>
          </>
        )}
      </footer>
    )
  }

  return (
    <footer className={s.wrap}>
      {headRow}
      {keyboardOpen && (
        <>
          <div className={`${s.piano} ${recMode ? s.write : ''}`}>
            {WHITES.map((p) => (
              <div
                key={p}
                className={`${s.white} ${pressed.has(p) ? s.whiteOn : ''}`}
                onPointerDown={down(p)}
                onPointerUp={up(p)}
                onLostPointerCapture={() => release(p)}
              >
                <span className={s.wname}>
                  {p % 12 === 0 ? `C${Math.floor(p / 12) - 1}` : ''}
                </span>
                <span className={s.wchar}>{KEY_CHARS[p] ?? ''}</span>
              </div>
            ))}
            {BLACKS.map((b) => (
              <div
                key={b.p}
                className={`${s.black} ${pressed.has(b.p) ? s.blackOn : ''}`}
                style={{ left: (b.i + 1) * WW - BW / 2 }}
                onPointerDown={down(b.p)}
                onPointerUp={up(b.p)}
                onLostPointerCapture={() => release(b.p)}
              >
                <span className={s.bchar}>{KEY_CHARS[b.p] ?? ''}</span>
              </div>
            ))}
          </div>
          <div className={s.hint}>
            编辑模式:点琴键试奏 · 鼠标操作网格音符 · REC 录制:光标按 BPM 前进,点琴键或
            Z/Q 行写入当前步([ ] 调时值)· SPACE 播放/停止
          </div>
        </>
      )}
    </footer>
  )
}
