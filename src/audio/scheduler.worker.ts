/**
 * 调度心跳 Worker:主线程 setInterval 在后台标签页被节流至 ≥1s,
 * Worker 线程不受节流,保证 lookahead 排程在后台连续不掉拍。
 * 协议:'start' 启动心跳,'stop' 停止;每次心跳 postMessage('tick')。
 * 音频排程仍由主线程收到 'tick' 后在 AudioContext 上完成(见 scheduler.ts)。
 */

const TICK_MS = 25

// 不引 webworker lib(避免与 DOM lib 冲突),按需声明用到的 scope 形状
interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage: (msg: string) => void
}

const scope = self as unknown as WorkerScope

let timer: ReturnType<typeof setInterval> | null = null

scope.onmessage = (e: MessageEvent): void => {
  if (e.data === 'start') {
    if (timer !== null) return // 幂等(重复 start)
    timer = setInterval(() => scope.postMessage('tick'), TICK_MS)
  } else if (e.data === 'stop') {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}
