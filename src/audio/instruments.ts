/**
 * 音色合成(纯 WebAudio,NES APU 风格)。
 * 所有 voice 函数对 (ctx, dest) 参数化 —— 实时播放与 OfflineAudioContext
 * 离线渲染复用同一套逻辑。详见 docs/design-detail.md §2。
 */
import type { InstrumentId, Project } from '../state/model'

export interface VoiceHandle {
  /** 提前收音(cancelAndHold + 快速衰减) */
  stop(at: number, release?: number): void
}

// ── 脉冲波 PeriodicWave 缓存(按 ctx) ──────────────────────────
// 占空比 d 双极性脉冲的傅里叶系数(n≥1):
//   cos 系数 a_n = 2·sin(2πdn)/(nπ),sin 系数 b_n = 2·(1−cos(2πdn))/(nπ)
// d=0.5 时退化为标准方波级数(奇次 4/(nπ)),可作正确性校验。
const waveCache = new WeakMap<BaseAudioContext, Map<number, PeriodicWave>>()

export function getPulseWave(ctx: BaseAudioContext, duty: number): PeriodicWave {
  let byDuty = waveCache.get(ctx)
  if (!byDuty) {
    byDuty = new Map()
    waveCache.set(ctx, byDuty)
  }
  const cached = byDuty.get(duty)
  if (cached) return cached

  const N = 64
  const real = new Float32Array(N)
  const imag = new Float32Array(N)
  for (let n = 1; n < N; n++) {
    real[n] = (2 * Math.sin(2 * Math.PI * duty * n)) / (n * Math.PI)
    imag[n] = (2 * (1 - Math.cos(2 * Math.PI * duty * n))) / (n * Math.PI)
  }
  const wave = ctx.createPeriodicWave(real, imag)
  byDuty.set(duty, wave)
  return wave
}

// ── 白噪声缓冲缓存(按 ctx) ────────────────────────────────────
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>()

export function getNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseCache.get(ctx)
  if (cached) return cached
  const len = Math.floor(ctx.sampleRate)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  noiseCache.set(ctx, buf)
  return buf
}

const midiToFreq = (m: number): number => 440 * Math.pow(2, (m - 69) / 12)

const VOICE_PEAK: Partial<Record<InstrumentId, number>> = { triangle: 0.5 }
const voicePeak = (inst: InstrumentId): number => VOICE_PEAK[inst] ?? 0.28

/** 创建一个可持续的 voice(近瞬时 attack 后保持,由 stop 收音) */
function createVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  inst: InstrumentId,
  midi: number,
  t: number,
): { gain: GainNode; osc: OscillatorNode; handle: VoiceHandle } {
  const gain = ctx.createGain()
  gain.connect(dest)
  const osc = ctx.createOscillator()
  osc.connect(gain)

  if (inst === 'triangle') {
    osc.type = 'triangle'
  } else {
    const duty = inst === 'pulse50' ? 0.5 : (inst === 'pulse25' ? 0.25 : 0.125)
    if (duty === 0.5) {
      osc.type = 'square' // 50% 用原生 square
    } else {
      osc.setPeriodicWave(getPulseWave(ctx, duty))
    }
  }
  const transpose = inst === 'triangle' ? -12 : 0
  osc.frequency.value = midiToFreq(midi + transpose)

  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(voicePeak(inst), t + 0.004)

  osc.start(t)

  let stopped = false
  const handle: VoiceHandle = {
    stop(at: number, release = 0.05): void {
      if (stopped) return
      stopped = true
      const p = gain.gain
      const cur = Math.max(p.value, 0.0002)
      // cancelAndHold 冻结当前值并清除未来事件,避免残余 ramp 把音量"复活"
      if (typeof p.cancelAndHoldAtTime === 'function') {
        p.cancelAndHoldAtTime(at)
      } else {
        p.cancelScheduledValues(at)
        p.setValueAtTime(cur, at)
      }
      p.exponentialRampToValueAtTime(0.0008, at + release)
      try {
        osc.stop(at + release + 0.03)
      } catch {
        /* osc 已停止 */
      }
    },
  }
  return { gain, osc, handle }
}

/** 试奏/键盘:按住发声,松开收音 */
export function startVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  inst: InstrumentId,
  midi: number,
  t: number,
): VoiceHandle {
  return createVoice(ctx, dest, inst, midi, t).handle
}

/**
 * 序列器音符:attack → 自然衰减 → release,一次性排完。
 * registry 用于实时播放时收集活动 voice(停止播放统一收音);离线渲染不传。
 */
export function playVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  inst: InstrumentId,
  midi: number,
  t: number,
  dur: number,
  registry?: Set<VoiceHandle>,
): void {
  const { gain, osc, handle } = createVoice(ctx, dest, inst, midi, t)
  const peak = voicePeak(inst)
  gain.gain.exponentialRampToValueAtTime(peak * 0.6, t + dur)
  gain.gain.exponentialRampToValueAtTime(0.0008, t + dur + 0.06)
  try {
    osc.stop(t + dur + 0.09)
  } catch {
    /* 忽略 */
  }
  if (registry) {
    registry.add(handle)
    osc.onended = () => registry.delete(handle)
  }
}

// ── 鼓组(单次触发) ────────────────────────────────────────────
/** kind:0=Kick 1=Snare 2=Hi-hat */
export function playDrum(
  ctx: BaseAudioContext,
  dest: AudioNode,
  kind: number,
  t: number,
): void {
  if (kind === 0) {
    // Kick:方波 120→40Hz pitch-drop + 快衰减
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.setValueAtTime(120, t)
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.12)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(1.0, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.24)
    osc.connect(gain)
    gain.connect(dest)
    osc.start(t)
    osc.stop(t + 0.26)
    return
  }

  if (kind === 1) {
    // Snare:白噪声(高通) + 低频方波短音
    const noise = ctx.createBufferSource()
    noise.buffer = getNoiseBuffer(ctx)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 700
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0.5, t)
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.16)
    noise.connect(hp)
    hp.connect(ng)
    ng.connect(dest)
    noise.start(t, Math.random() * 0.4, 0.18) // 随机起点,避免每击完全一致

    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = 190
    const og = ctx.createGain()
    og.gain.setValueAtTime(0.4, t)
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
    osc.connect(og)
    og.connect(dest)
    osc.start(t)
    osc.stop(t + 0.1)
    return
  }

  if (kind === 3) {
    // Crash:噪声 + 非谐波方波叠(TR-808 钹电路思路)金属质感,长衰减
    const noise = ctx.createBufferSource()
    noise.buffer = getNoiseBuffer(ctx)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 4500
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0.45, t)
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.9)
    noise.connect(hp)
    hp.connect(ng)
    ng.connect(dest)
    noise.start(t, Math.random() * 0.04, 0.95)

    const metalHP = ctx.createBiquadFilter()
    metalHP.type = 'highpass'
    metalHP.frequency.value = 4000
    const mg = ctx.createGain()
    mg.gain.setValueAtTime(0.15, t)
    mg.gain.exponentialRampToValueAtTime(0.001, t + 0.55)
    metalHP.connect(mg)
    mg.connect(dest)
    // 非谐波频率互拍产生"镲片"金属声
    for (const f of [205.3, 304.4, 369.6, 522.7]) {
      const osc = ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.value = f
      osc.connect(metalHP)
      osc.start(t)
      osc.stop(t + 0.6)
    }
    return
  }

  // Hi-hat:噪声 + 高通 7kHz + 极短衰减
  const noise = ctx.createBufferSource()
  noise.buffer = getNoiseBuffer(ctx)
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 7000
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.3, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
  noise.connect(hp)
  hp.connect(gain)
  gain.connect(dest)
  noise.start(t, Math.random() * 0.6, 0.07)
}

// ── 母线与混音(实时 / 离线共用) ────────────────────────────────
export const MASTER_GAIN = 0.85

export function buildMasterChain(ctx: BaseAudioContext): {
  input: GainNode
  output: DynamicsCompressorNode
} {
  const master = ctx.createGain()
  master.gain.value = MASTER_GAIN
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -14
  comp.knee.value = 4
  comp.ratio.value = 10
  comp.attack.value = 0.003
  comp.release.value = 0.2
  master.connect(comp)
  comp.connect(ctx.destination)
  return { input: master, output: comp }
}

/** 音量滑条 0–1 → 增益曲线 */
export function volumeToGain(v: number): number {
  const x = Math.min(1, Math.max(0, v))
  return Math.pow(x, 1.5)
}

/** 有效静音:muted,或有任一 solo 且本轨未 solo */
export function effectiveMutes(tracks: Project['tracks']): boolean[] {
  const anySolo = tracks.some((t) => t.solo)
  return tracks.map((t) => t.muted || (anySolo && !t.solo))
}
