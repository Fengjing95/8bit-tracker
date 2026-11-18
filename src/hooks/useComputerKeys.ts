/**
 * 电脑键盘试奏(tracker 键位)+ 传输快捷键。
 * 仅在启动(active)后挂载;keydown 属用户手势,可安全触发 ensure()。
 */
import { useEffect } from 'react'
import { engine } from '../audio/engine'
import { DRUM_KEYS, KEYMAP } from '../lib/keys'
import { useStore } from '../state/store'

export function useComputerKeys(active: boolean): void {
  useEffect(() => {
    if (!active) return

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
        st.stopTransport()
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
      const pitch = KEYMAP[e.code]
      if (pitch !== undefined) {
        e.preventDefault()
        engine.previewOn(e.code, st.selected, pitch)
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
