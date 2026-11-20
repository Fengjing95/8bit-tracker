/**
 * 底部试奏键盘:虚拟琴键(按住发声)+ 鼓轨时显示 4 个打击垫。
 * 电脑键位映射见 lib/keys.ts(与本组件共享同一音高表)。
 * WRITE toggle:开 = 点琴键在光标处写入对应音高并前进一格(tracker 写入流,
 * 与 useComputerKeys 一致,含 160ms 短促试听);关 = 现状试奏。
 * 收合按钮:隐藏琴体给网格让空间(状态存 store,不持久化)。
 */
import { useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { engine } from '../audio/engine'
import { INSTRUMENT_META, stepCountOf } from '../state/model'
import { useStore } from '../state/store'
import s from './keyboard.module.css'

const WW = 34 // 白键宽
const BW = 22 // 黑键宽

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
  const writeMode = useStore((st) => st.writeMode)
  const setWriteMode = useStore((st) => st.setWriteMode)
  const keyboardOpen = useStore((st) => st.keyboardOpen)
  const setKeyboardOpen = useStore((st) => st.setKeyboardOpen)
  const [pressed, setPressed] = useState<Set<number>>(new Set())

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

  // 写入音高:光标为空时先设 {step:0, pitch:60},写入并前进,160ms 短促试听
  const writePitch = (p: number): void => {
    const st = useStore.getState()
    const caret = st.caret ?? { step: 0, pitch: 60 }
    const sc = stepCountOf(st.project.bars)
    const len = Math.max(1, Math.min(st.insertLen, sc - caret.step))
    st.writeNote(st.selected, caret.step, p, len)
    st.setCaret({ step: Math.min(caret.step + 1, sc - 1), pitch: p })
    engine.previewOn(`m${p}`, st.selected, p)
    setTimeout(() => engine.previewOff(`m${p}`), 160)
  }

  // 写入鼓件:本步无同鼓件才写入(只加不删的写入语义),前进并试奏
  const writeDrum = (kind: number): void => {
    const st = useStore.getState()
    const caret = st.caret ?? { step: 0, pitch: 0 }
    const sc = stepCountOf(st.project.bars)
    const t = st.project.tracks[st.selected]
    const exists = t.notes.some((n) => n.step === caret.step && n.pitch === kind)
    if (!exists) st.toggleDrum(st.selected, caret.step, kind)
    st.setCaret({ step: Math.min(caret.step + 1, sc - 1), pitch: caret.pitch })
    engine.previewDrum(kind)
  }

  const down = (p: number) => (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    if (useStore.getState().writeMode) {
      writePitch(p)
      return
    }
    press(p)
  }
  const up = (p: number) => (): void => release(p)

  const headRow = (
    <div className={s.headRow}>
      <div className={s.label}>
        {inst === 'noise' ? 'DRUM PADS · NOISE' : `KEYBOARD · ${INSTRUMENT_META[inst].label}`}
      </div>
      <div className={s.headBtns}>
        <button
          className={`${s.kbtn} ${writeMode ? s.writeOn : ''}`}
          onClick={() => setWriteMode(!writeMode)}
          aria-label="写入模式"
        >
          WRITE
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
            <div className={`${s.pads} ${writeMode ? s.write : ''}`}>
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
                    if (useStore.getState().writeMode) writeDrum(d.kind)
                    else engine.previewDrum(d.kind)
                  }}
                >
                  <span className={s.padName}>{d.label}</span>
                  <span className={s.padKey}>{d.key}</span>
                </button>
              ))}
            </div>
            <div className={s.hint}>
              鼓轨:点击网格开关鼓件 · Z/X/C/V 试奏 · WRITE 开启后点垫写入光标处 · SPACE 播放/停止
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
          <div className={`${s.piano} ${writeMode ? s.write : ''}`}>
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
            Z/Q 行写入音符(方向键移光标 · [ ] 调时值)· WRITE 开启后点琴键写入 ·
            点音符选中 + Backspace 删除 · ESC 取消选中 · SPACE 播放/停止
          </div>
        </>
      )}
    </footer>
  )
}
