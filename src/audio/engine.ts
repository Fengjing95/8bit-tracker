/**
 * 音频引擎单例:与 React 完全解耦的纯 TS 模块。
 * Context 生命周期、母线与轨道增益、项目同步、试奏、播放头分发、WAV 导出。
 * 详见 docs/design-detail.md §2.7。
 */
import {
  DEFAULT_BARS,
  STEP_GATE,
  stepCountOf,
  type Note,
  type Project,
} from '../state/model'
import {
  buildMasterChain,
  effectiveMutes,
  getNoiseBuffer,
  getPulseWave,
  playDrum,
  playVoice,
  startVoice,
  volumeToGain,
  type VoiceHandle,
} from './instruments'
import { Scheduler } from './scheduler'
import { renderProjectToWav } from './exporter'

export type StepListener = (step: number) => void

class AudioEngine {
  private ctx: AudioContext | null = null
  private initPromise: Promise<void> | null = null
  private trackGains: GainNode[] = []
  private previewGain: GainNode | null = null
  private voices = new Set<VoiceHandle>()
  private previews = new Map<string, VoiceHandle>()
  private scheduler = new Scheduler()
  private project: Project | null = null
  /** 每轨 step → 起始音符表 */
  private index: Array<Map<number, Note[]>> = []
  private stepListeners = new Set<StepListener>()

  // ── Context 生命周期(用户手势后创建;幂等) ─────────────────
  ensure(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        return this.ctx.resume().then(() => undefined)
      }
      return Promise.resolve()
    }
    if (!this.initPromise) this.initPromise = this.init()
    return this.initPromise
  }

  private async init(): Promise<void> {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!Ctor) throw new Error('当前浏览器不支持 WebAudio')
    const ctx = new Ctor({ latencyHint: 'interactive' })
    this.ctx = ctx

    const { input } = buildMasterChain(ctx)
    this.trackGains = [0, 1, 2, 3].map(() => {
      const g = ctx.createGain()
      g.connect(input)
      return g
    })
    this.previewGain = ctx.createGain()
    this.previewGain.gain.value = 0.55
    this.previewGain.connect(input)

    // 启动时预热:脉冲波缓存 + 噪声缓冲
    getPulseWave(ctx, 0.125)
    getPulseWave(ctx, 0.25)
    getNoiseBuffer(ctx)

    if (ctx.state === 'suspended') await ctx.resume()
    this.applyMix()
  }

  // ── 项目同步(store → 引擎) ─────────────────────────────────
  syncProject(p: Project): void {
    this.project = p
    this.index = p.tracks.map((t) => {
      const m = new Map<number, Note[]>()
      for (const n of t.notes) {
        const arr = m.get(n.step)
        if (arr) arr.push(n)
        else m.set(n.step, [n])
      }
      return m
    })
    this.applyMix()
  }

  private applyMix(): void {
    const p = this.project
    if (!p || !this.ctx) return
    const mutes = effectiveMutes(p.tracks)
    const now = this.ctx.currentTime
    p.tracks.forEach((t, i) => {
      const g = this.trackGains[i]
      if (!g) return
      const v = mutes[i] ? 0 : volumeToGain(t.volume / 100)
      g.gain.setTargetAtTime(v, now, 0.01)
    })
  }

  private stepDur = (): number => 60 / (this.project?.bpm ?? 120) / 4
  private stepCount = (): number => stepCountOf(this.project?.bars ?? DEFAULT_BARS)

  // ── 传输 ─────────────────────────────────────────────────────
  async play(): Promise<void> {
    await this.ensure()
    if (!this.ctx || this.scheduler.playing) return
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    this.scheduler.start(
      this.ctx,
      this.stepDur,
      this.stepCount,
      (step, time, dur) => this.scheduleStep(step, time, dur),
      (step) => this.dispatchStep(step),
    )
  }

  stop(): void {
    this.scheduler.stop()
    this.stopAllVoices(0.03)
    this.dispatchStep(-1)
  }

  isPlaying(): boolean {
    return this.scheduler.playing
  }

  private stopAllVoices(release: number): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    for (const h of this.voices) h.stop(now, release)
    this.voices.clear()
  }

  private scheduleStep(step: number, time: number, stepDur: number): void {
    const p = this.project
    if (!p || !this.ctx) return
    for (let i = 0; i < p.tracks.length; i++) {
      const notes = this.index[i]?.get(step)
      if (!notes || notes.length === 0) continue
      const dest = this.trackGains[i]
      if (!dest) continue
      const inst = p.tracks[i].instrument
      for (const n of notes) {
        if (inst === 'noise') {
          playDrum(this.ctx, dest, n.pitch, time)
        } else {
          playVoice(
            this.ctx,
            dest,
            inst,
            n.pitch,
            time,
            Math.max(0.05, n.len * stepDur * STEP_GATE),
            this.voices,
          )
        }
      }
    }
  }

  // ── 播放头(视觉)分发 ────────────────────────────────────────
  onStepPlayed(cb: StepListener): () => void {
    this.stepListeners.add(cb)
    return () => {
      this.stepListeners.delete(cb)
    }
  }

  private dispatchStep(step: number): void {
    this.stepListeners.forEach((cb) => cb(step))
  }

  // ── 试奏(走 previewGain,不随轨道静音) ──────────────────────
  previewOn(key: string, trackIdx: number, midi: number): void {
    void this.ensure().then(() => {
      if (!this.ctx || !this.previewGain || !this.project) return
      if (this.previews.has(key)) return
      const inst = this.project.tracks[trackIdx]?.instrument
      if (!inst || inst === 'noise') return
      const t = this.ctx.currentTime + 0.01
      const h = startVoice(this.ctx, this.previewGain, inst, midi, t)
      this.previews.set(key, h)
      // 兜底:keyup 丢失(如窗口切换)时不悬挂
      setTimeout(() => this.previewOff(key), 4000)
    })
  }

  previewOff(key: string): void {
    if (!this.ctx) return
    const h = this.previews.get(key)
    if (!h) return
    this.previews.delete(key)
    h.stop(this.ctx.currentTime, 0.07)
  }

  releaseAllPreviews(): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    this.previews.forEach((h) => h.stop(now, 0.05))
    this.previews.clear()
  }

  previewDrum(kind: number): void {
    void this.ensure().then(() => {
      if (!this.ctx || !this.previewGain) return
      playDrum(this.ctx, this.previewGain, kind, this.ctx.currentTime + 0.005)
    })
  }

  // ── 离线导出 ─────────────────────────────────────────────────
  renderWav(): Promise<Blob> {
    if (!this.project) throw new Error('还没有工程数据')
    return renderProjectToWav(this.project)
  }
}

/** 全局唯一实例(模块级单例,不进 React 状态) */
export const engine = new AudioEngine()
