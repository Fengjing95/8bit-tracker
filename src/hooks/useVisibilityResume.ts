/**
 * 移动端生命周期:页面隐藏期间(iOS 切后台等)AudioContext 可能被系统挂起,
 * 回到可见时若仍在播放态则幂等恢复(engine.ensure 对 suspended ctx 执行 resume)。
 * 调度心跳在 Worker 内持续运行,恢复后音频接续,无需重启传输。
 */
import { useEffect } from 'react'
import { engine } from '../audio/engine'
import { useStore } from '../state/store'

export function useVisibilityResume(): void {
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && useStore.getState().playing) {
        void engine.ensure()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
}
