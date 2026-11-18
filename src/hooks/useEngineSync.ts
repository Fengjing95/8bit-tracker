/**
 * store → 引擎的单向桥接:初始同步一次,此后 project 引用变化才同步。
 * 订阅随 effect 清理退订,StrictMode 下 effect 双调用只保留一份。
 */
import { useEffect } from 'react'
import { engine } from '../audio/engine'
import { useStore } from '../state/store'

export function useEngineSync(): void {
  useEffect(() => {
    engine.syncProject(useStore.getState().project)
    return useStore.subscribe((state, prev) => {
      if (state.project !== prev.project) engine.syncProject(state.project)
    })
  }, [])
}
