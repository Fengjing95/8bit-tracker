/**
 * Lookahead 步进调度器(audio 时钟排音频,rAF 按可听时间抛视觉步)。
 * 步数由 getStepCount 动态提供(小节数可调),每步读取,改动即时生效。
 * 心跳定时器跑在 Web Worker 里(后台标签页主线程定时器被节流至 ≥1s,
 * Worker 不受影响);Worker 构造失败时降级回主线程 setInterval。
 * 音频排程始终在主线程 AudioContext 上,用 ctx.currentTime,不受迁移影响。
 * 详见 docs/design-detail.md §2.6。
 */

export type ScheduleStepFn = (step: number, time: number, stepDur: number) => void
export type VisualStepFn = (step: number) => void // step < 0 表示清场

const TICK_MS = 25
const LOOKAHEAD_S = 0.12

interface QueueEntry {
  step: number
  time: number
}

export class Scheduler {
  playing = false

  private ctx: AudioContext | null = null
  private worker: Worker | null = null
  private timer: ReturnType<typeof setInterval> | null = null // 降级用主线程定时器
  private rafId = 0
  private step = 0
  private nextTime = 0
  private queue: QueueEntry[] = []
  private getStepDur: (() => number) | null = null
  private getStepCount: (() => number) | null = null
  private onSchedule: ScheduleStepFn | null = null
  private onVisual: VisualStepFn | null = null

  constructor() {
    try {
      // Vite 原生 Worker 写法:构建时作为独立 chunk 打包
      const w = new Worker(new URL('./scheduler.worker.ts', import.meta.url), {
        type: 'module',
      })
      w.onmessage = (e: MessageEvent): void => {
        if (e.data === 'tick') this.tick() // playing 已在 tick 内守卫
      }
      this.worker = w
    } catch {
      this.worker = null // 环境不支持 Worker → 主线程 setInterval 降级
    }
  }

  start(
    ctx: AudioContext,
    getStepDur: () => number,
    getStepCount: () => number,
    onSchedule: ScheduleStepFn,
    onVisual: VisualStepFn,
    startStep = 0,
  ): void {
    if (this.playing) return // 幂等(StrictMode / 双击保护)
    this.playing = true
    this.ctx = ctx
    this.getStepDur = getStepDur
    this.getStepCount = getStepCount
    this.onSchedule = onSchedule
    this.onVisual = onVisual
    this.step = startStep
    this.queue = []
    this.nextTime = ctx.currentTime + 0.08

    this.tick()
    if (this.worker) {
      this.worker.postMessage('start')
    } else {
      this.timer = setInterval(() => this.tick(), TICK_MS)
    }

    const raf = (): void => {
      if (!this.playing || !this.ctx) return
      const now = this.ctx.currentTime
      while (this.queue.length > 0 && this.queue[0].time <= now) {
        const entry = this.queue.shift()
        if (entry) this.onVisual?.(entry.step)
      }
      this.rafId = requestAnimationFrame(raf)
    }
    this.rafId = requestAnimationFrame(raf)
  }

  stop(): void {
    if (!this.playing) return
    this.playing = false
    if (this.worker) {
      this.worker.postMessage('stop')
    } else if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    cancelAnimationFrame(this.rafId)
    this.queue = []
    this.onVisual?.(-1)
  }

  private tick(): void {
    if (!this.playing || !this.ctx || !this.getStepDur || !this.getStepCount) return
    const horizon = this.ctx.currentTime + LOOKAHEAD_S
    while (this.nextTime < horizon) {
      const dur = this.getStepDur()
      const sc = this.getStepCount()
      this.onSchedule?.(this.step, this.nextTime, dur)
      this.queue.push({ step: this.step, time: this.nextTime })
      this.nextTime += dur
      this.step = (this.step + 1) % sc
    }
  }
}
