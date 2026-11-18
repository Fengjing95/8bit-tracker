/**
 * 电脑键盘:tracker 式音符写入 + 传输快捷键。
 *
 * 音轨(tracker 键位编辑):
 *   方向键移动写入光标(Shift+左右 = ±4 步),Z/Q 行字符键在光标处写入并前进一格,
 *   Backspace/Delete 删除光标处音符,[ / ] 调整写入时值;
 * 鼓轨:Z/X/C/V 试奏 Kick/Snare/Hi-hat/Crash。
 * Space = 播放/停止,Esc = 停止。仅在启动(active)后挂载;keydown 属用户手势。
 */
import { useEffect } from 'react'
import { engine } from '../audio/engine'
import { DRUM_KEYS, KEYMAP } from '../lib/keys'
import { PITCH_MAX, PITCH_MIN, stepCountOf } from '../state/model'
import { useStore } from '../state/store'

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export function useComputerKeys(active: boolean): void {
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
      if (e.code === 'Space') {
        e.preventDefault()
        if (st.playing) st.stopTransport()
        else st.playTransport()
        return
      }
      if (e.code === 'Escape') {
        if (st.caret) st.setCaret(null) // 先取消选中
        else st.stopTransport()
        return
      }

      const track = st.project.tracks[st.selected]
      if (!track) return
      if (track.instrument === 'noise') {
        const kind = DRUM_KEYS[e.code]
        if (kind !== undefined) {
          e.preventDefault()
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
        const sc2 = stepCountOf(st2.project.bars)
        const len = Math.max(1, Math.min(st2.insertLen, sc2 - caret.step))
        st2.writeNote(st2.selected, caret.step, pitch, len)
        st2.setCaret({ step: Math.min(caret.step + 1, sc2 - 1), pitch }) // 写入后前进一格
        timedPreview(pitch)
      }
    }

    const onKeyup = (e: KeyboardEvent): void => {
      engine.previewOff(e.code)
    }

    const onBlur = (): void => {
      engine.releaseAllPreviews()
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
