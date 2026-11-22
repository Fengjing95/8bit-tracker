/**
 * 电脑键盘:tracker 式音符写入 + 传输快捷键。
 *
 * 音轨(tracker 键位编辑):
 *   方向键移动写入光标(Shift+左右 = ±4 步),Z/Q 行字符键在光标处写入并前进一格,
 *   Backspace/Delete 删除光标处音符,[ / ] 调整写入时值;
 *   REC 录制:写入落在光标当前步(光标由 useStepRecorder 按 BPM 推进),按住琴键
 *   持续发声,松手按持按步数定稿时值;倒数阶段只试听不写入;
 *   PLAY 播放中与编辑互斥:字符键只试听不写入,Backspace/Delete 无效;
 * 鼓轨:Z/X/C/V 试奏;REC 录制(非倒数)写入光标当前步(只加不删)。
 * Space = 播放/停止,Esc = 先清框选→再取消选中→最后停止;
 * Ctrl/Cmd+C/X/V = 复制/剪切/粘贴,框选存在时 Backspace/Delete 批量删除框内音符;
 * Ctrl/Cmd+Z 撤销,Ctrl/Cmd+Shift+Z 或 Ctrl+Y 重做。
 * 仅在启动(active)后挂载;keydown 属用户手势。
 */
import { useEffect, useRef } from 'react'
import { engine } from '../audio/engine'
import { DRUM_KEYS, KEYMAP } from '../lib/keys'
import { PITCH_MAX, PITCH_MIN, stepCountOf } from '../state/model'
import { useStore } from '../state/store'

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** REC 长按中的音符:按下时刻的步位与时间戳,松手按时值定稿 */
interface HeldNote {
  step: number
  pitch: number
  t0: number
}

export function useComputerKeys(active: boolean): void {
  const heldRef = useRef<Map<string, HeldNote>>(new Map())
  const recMode = useStore((st) => st.recMode)

  // REC 长按:每 120ms 巡检按住键位的应有时值(步数),
  // 以静默更新方式延长(push = false 不入撤销历史,松手定稿时一次性入账)
  useEffect(() => {
    if (!active || !recMode) return
    const timer = setInterval(() => {
      const st = useStore.getState()
      if (!st.recMode || st.recCountin || heldRef.current.size === 0) return
      const stepDurMs = 60000 / st.project.bpm / 4
      for (const [, held] of heldRef.current) {
        const steps = Math.floor((performance.now() - held.t0) / stepDurMs) + 1
        st.setNoteLen(st.selected, held.step, held.pitch, steps, false)
      }
    }, 120)
    return () => clearInterval(timer)
  }, [active, recMode])

  useEffect(() => {
    if (!active) return

    let previewSeq = 0
    const timedPreview = (pitch: number): void => {
      const id = `kb${previewSeq++}`
      engine.previewOn(id, useStore.getState().selected, pitch)
      setTimeout(() => engine.previewOff(id), 160) // 短促试听反馈
    }

    const onKeydown = (e: KeyboardEvent): void => {
      if (e.repeat) return
      const el = e.target as HTMLElement | null
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      ) {
        return
      }

      const st = useStore.getState()

      // Ctrl/Cmd+Z = 撤销,Ctrl/Cmd+Shift+Z / Ctrl+Y = 重做
      if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyZ' || e.code === 'KeyY')) {
        e.preventDefault()
        const isRedo =
          (e.code === 'KeyZ' && e.shiftKey) || (e.code === 'KeyY' && e.ctrlKey && !e.metaKey)
        if (isRedo) st.redo()
        else if (!e.shiftKey) st.undo()
        return
      }

      // Ctrl/Cmd+C / X / V = 复制 / 剪切 / 粘贴(剪贴板语义,见 store)
      if (e.ctrlKey || e.metaKey) {
        if (e.code === 'KeyC') {
          e.preventDefault()
          st.copySelection()
          return
        }
        if (e.code === 'KeyX') {
          e.preventDefault()
          st.cutSelection()
          return
        }
        if (e.code === 'KeyV') {
          e.preventDefault()
          st.pasteClipboard()
          return
        }
      }

      if (e.code === 'Space') {
        e.preventDefault()
        if (st.playing) st.stopTransport()
        else st.playTransport()
        return
      }
      if (e.code === 'Escape') {
        // Esc 优先级:先清框选,再清 caret 选中,最后停播放
        if (st.region) st.clearRegion()
        else if (st.caret) st.setCaret(null)
        else st.stopTransport()
        return
      }

      const track = st.project.tracks[st.selected]
      if (!track) return
      if (track.instrument === 'noise') {
        const kind = DRUM_KEYS[e.code]
        if (kind !== undefined) {
          e.preventDefault()
          // REC 录制(非倒数):写入光标当前步,只加不删 + 试奏反馈;其余情况纯试奏
          if (st.recMode && !st.recCountin) {
            const caret = st.caret ?? { step: 0 }
            const exists = track.notes.some(
              (n) => n.step === caret.step && n.pitch === kind,
            )
            if (!exists) st.toggleDrum(st.selected, caret.step, kind)
          }
          engine.previewDrum(kind)
        }
        return
      }

      // ── 音轨:键盘编辑 ──
      const sc = stepCountOf(st.project.bars)

      if (
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight'
      ) {
        e.preventDefault()
        const caret = st.caret ?? { step: 0, pitch: 60 }
        const dStep =
          e.code === 'ArrowLeft'
            ? e.shiftKey
              ? -4
              : -1
            : e.code === 'ArrowRight'
              ? e.shiftKey
                ? 4
                : 1
              : 0
        const dPitch = e.code === 'ArrowUp' ? 1 : e.code === 'ArrowDown' ? -1 : 0
        const next = {
          step: clamp(caret.step + dStep, 0, sc - 1),
          pitch: clamp(caret.pitch + dPitch, PITCH_MIN, PITCH_MAX),
        }
        st.setCaret(next)
        if (dPitch !== 0) timedPreview(next.pitch)
        return
      }

      if (e.code === 'Backspace' || e.code === 'Delete') {
        e.preventDefault()
        if (st.playing) return // 播放与编辑互斥
        // 框选存在:批量删除框内全部音符并清框选(一条历史)
        if (st.region) {
          st.deleteRegion()
          return
        }
        const caret = st.caret
        if (!caret) return
        const t = st.project.tracks[st.selected]
        if (e.code === 'Delete') {
          // Delete:删除光标处(先精确音高,否则本步任意音高并把光标对齐过去)
          const exact = t.notes.find((n) => n.step === caret.step && n.pitch === caret.pitch)
          const target = exact ?? t.notes.find((n) => n.step === caret.step)
          if (target) {
            st.removeNote(st.selected, target.step, target.pitch)
            st.setCaret({ step: caret.step, pitch: target.pitch })
          }
          return
        }
        // Backspace:光标处有音符(点击选中态)→ 直接删除它;
        // 否则(打字后的插入态)→ 回退一格并删除该步音符,便于"打错即退即重打"
        const atCaret = t.notes.find((n) => n.step === caret.step && n.pitch === caret.pitch)
        if (atCaret) {
          st.removeNote(st.selected, atCaret.step, atCaret.pitch)
          return
        }
        if (caret.step <= 0) return
        const prevStep = caret.step - 1
        const exact = t.notes.find((n) => n.step === prevStep && n.pitch === caret.pitch)
        const target = exact ?? t.notes.find((n) => n.step === prevStep)
        if (target) {
          st.removeNote(st.selected, target.step, target.pitch)
          st.setCaret({ step: prevStep, pitch: target.pitch })
        } else {
          st.setCaret({ step: prevStep, pitch: caret.pitch })
        }
        return
      }

      if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        e.preventDefault()
        st.setInsertLen(st.insertLen + (e.code === 'BracketLeft' ? -1 : 1))
        return
      }

      const pitch = KEYMAP[e.code]
      if (pitch !== undefined) {
        e.preventDefault()
        const st2 = useStore.getState()
        const caret = st2.caret ?? { step: 0, pitch: 60 }
        // 播放中与编辑互斥:只试听不写入
        if (st2.playing) {
          timedPreview(pitch)
          return
        }
        // REC 录制:1 步起录 + 长按持续发声,松手按时值定稿;倒数中只试听不写入
        if (st2.recMode) {
          if (st2.recCountin) {
            timedPreview(pitch)
            return
          }
          const sc2 = stepCountOf(st2.project.bars)
          const step = Math.min(caret.step, sc2 - 1)
          st2.clearRegion() // 键盘写入也是"放置",先清除框选
          st2.addNote(st2.selected, step, pitch, 1)
          heldRef.current.set(e.code, { step, pitch, t0: performance.now() })
          engine.previewOn(e.code, st2.selected, pitch) // 按住持续发声,keyup 释放
          return
        }
        // 编辑模式:写入并前进一格(tracker 流)
        const sc2 = stepCountOf(st2.project.bars)
        const len = Math.max(1, Math.min(st2.insertLen, sc2 - caret.step))
        st2.clearRegion() // 键盘写入也是"放置",先清除框选
        st2.writeNote(st2.selected, caret.step, pitch, len)
        st2.setCaret({ step: Math.min(caret.step + 1, sc2 - 1), pitch }) // 写入后前进一格
        timedPreview(pitch)
      }
    }

    // 松手:释放试奏;REC 长按的音符按持按时值定稿(一条历史)
    const finalizeHeld = (code: string): void => {
      const held = heldRef.current.get(code)
      if (!held) return
      heldRef.current.delete(code)
      const st = useStore.getState()
      const stepDurMs = 60000 / st.project.bpm / 4
      const heldSteps = Math.max(1, Math.floor((performance.now() - held.t0) / stepDurMs) + 1)
      st.setNoteLen(st.selected, held.step, held.pitch, heldSteps)
    }

    const onKeyup = (e: KeyboardEvent): void => {
      engine.previewOff(e.code)
      finalizeHeld(e.code)
    }

    const onBlur = (): void => {
      engine.releaseAllPreviews()
      // 失焦时长按中的音符按已持按时值定稿(键位状态不可信)
      for (const code of [...heldRef.current.keys()]) finalizeHeld(code)
    }

    window.addEventListener('keydown', onKeydown)
    window.addEventListener('keyup', onKeyup)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('keyup', onKeyup)
      window.removeEventListener('blur', onBlur)
      engine.releaseAllPreviews()
    }
  }, [active])
}
