/**
 * 工程数据模型与常量(纯数据,无 React / 无 WebAudio 依赖)。
 * 详见 docs/design-detail.md §1。
 */

export const PITCH_MIN = 48 // C3 —— 网格纵向 25 行的最低音
export const PITCH_MAX = 72 // C5 —— 最高音
export const DEFAULT_NOTE_LEN = 2 // 新音符默认长度(8 分音符)
export const STEP_GATE = 0.95 // 音符门限 = len × stepDur × STEP_GATE
export const BAR_STEPS = 16 // 每小节步数(16 分音符,用于小节分隔线)
export const MAX_BARS = 64 // 小节数上限:权衡网格 DOM、离线渲染内存与 WAV 体积
export const DEFAULT_BARS = 2 // 默认 2 小节 = 32 步

/** 小节数 → 总步数 */
export const stepCountOf = (bars: number): number => bars * BAR_STEPS

export type InstrumentId = 'pulse12' | 'pulse25' | 'pulse50' | 'triangle' | 'noise'

export interface InstrumentMeta {
  label: string
  /** 脉冲波占空比;0.5 走原生 square */
  duty?: number
  /** 播放移调(半音);triangle bass 降八度 */
  transpose?: number
}

export const INSTRUMENT_META: Record<InstrumentId, InstrumentMeta> = {
  pulse12: { label: 'PULSE 12.5%', duty: 0.125 },
  pulse25: { label: 'PULSE 25%', duty: 0.25 },
  pulse50: { label: 'PULSE 50%', duty: 0.5 },
  triangle: { label: 'TRIANGLE', transpose: -12 },
  noise: { label: 'NOISE' },
}

export const PULSE_IDS: InstrumentId[] = ['pulse12', 'pulse25', 'pulse50']

/** 鼓件编号(鼓轨 pitch 即鼓件编号) */
export type DrumKind = 0 | 1 | 2 | 3
export const DRUM_PITCHES = [0, 1, 2, 3] as const
export const DRUM_LABELS = ['KICK', 'SNARE', 'HI-HAT', 'CRASH'] as const

export interface Note {
  /** 步号 0–31 */
  step: number
  /** MIDI 编号;鼓轨为鼓件编号 0/1/2 */
  pitch: number
  /** 长度(步数),鼓轨恒为 1 */
  len: number
}

export interface Track {
  name: string
  instrument: InstrumentId
  /** 0–100 */
  volume: number
  muted: boolean
  solo: boolean
  notes: Note[]
}

export interface Project {
  /** 小节数(1/2/4/8) */
  bars: number
  bpm: number
  tracks: Track[]
}

export interface TrackDef {
  name: string
  instrument: InstrumentId
  volume: number
}

export const TRACK_DEFS: TrackDef[] = [
  { name: 'PULSE LEAD', instrument: 'pulse25', volume: 75 },
  { name: 'PULSE HARMONY', instrument: 'pulse50', volume: 58 },
  { name: 'TRIANGLE BASS', instrument: 'triangle', volume: 88 },
  { name: 'NOISE DRUMS', instrument: 'noise', volume: 80 },
]

export const noteKey = (n: Note): string => `${n.step}:${n.pitch}`

/** 乐器有效音高域(鼓轨为鼓件编号域) */
export function validPitchRange(inst: InstrumentId): [number, number] {
  return inst === 'noise' ? [0, 3] : [PITCH_MIN, PITCH_MAX]
}

const clampInt = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.round(v)))

/**
 * 导入 / 读档统一校验:非法字段逐个钳制或回退默认值;
 * 对合法数据是幂等的(导出 → 导入 round-trip 数据一致)。
 */
export function sanitizeProject(raw: unknown): Project {
  if (raw == null || typeof raw !== 'object') {
    throw new Error('不是有效的工程数据')
  }
  const obj = raw as Record<string, unknown>
  const inner =
    obj.project != null && typeof obj.project === 'object'
      ? (obj.project as Record<string, unknown>)
      : obj

  const bpmRaw = Number(inner.bpm)
  const bpm = Number.isFinite(bpmRaw) ? clampInt(bpmRaw, 40, 240) : 120
  const barsRaw = Number(inner.bars)
  const bars = Number.isFinite(barsRaw) ? clampInt(barsRaw, 1, MAX_BARS) : DEFAULT_BARS
  const sc = stepCountOf(bars)
  const list = Array.isArray(inner.tracks) ? inner.tracks : []
  if (list.length === 0) throw new Error('工程缺少音轨数据')

  const tracks: Track[] = TRACK_DEFS.map((def, i) => {
    const t =
      list[i] != null && typeof list[i] === 'object'
        ? (list[i] as Record<string, unknown>)
        : {}
    const instrument = (
      typeof t.instrument === 'string' && t.instrument in INSTRUMENT_META
        ? t.instrument
        : def.instrument
    ) as InstrumentId
    const volRaw = Number(t.volume)
    const volume = Number.isFinite(volRaw) ? clampInt(volRaw, 0, 100) : def.volume
    const [pMin, pMax] = validPitchRange(instrument)

    const seen = new Set<string>()
    const notes: Note[] = []
    if (Array.isArray(t.notes)) {
      for (const n of t.notes) {
        if (n == null || typeof n !== 'object') continue
        const step = Number((n as Record<string, unknown>).step)
        const pitch = Number((n as Record<string, unknown>).pitch)
        const len = Number((n as Record<string, unknown>).len)
        if (!Number.isFinite(step) || !Number.isFinite(pitch)) continue
        const s = Math.round(step)
        if (s < 0 || s >= sc) continue // 缩减小节时丢弃范围外的音符
        const p = clampInt(pitch, pMin, pMax)
        const l = clampInt(Number.isFinite(len) ? len : 1, 1, sc - s)
        const k = `${s}:${p}`
        if (seen.has(k)) continue
        seen.add(k)
        notes.push({ step: s, pitch: p, len: l })
      }
    }

    return {
      name: typeof t.name === 'string' && t.name ? t.name.slice(0, 24) : def.name,
      instrument,
      volume,
      muted: t.muted === true,
      solo: t.solo === true,
      notes,
    }
  })

  return { bars, bpm, tracks }
}
