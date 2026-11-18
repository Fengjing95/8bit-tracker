/**
 * zustand store:工程唯一数据源 + UI 态。
 * 模块级订阅负责:① 自动保存(防抖 800ms);store → 引擎的同步在 useEngineSync 中。
 */
import { create } from 'zustand'
import { engine } from '../audio/engine'
import { createDemoProject, createEmptyProject } from '../song-demo'
import {
  DEFAULT_NOTE_LEN,
  MAX_BARS,
  PITCH_MAX,
  PITCH_MIN,
  stepCountOf,
  type InstrumentId,
  type Note,
  type Project,
  type Track,
} from './model'
import { loadStoredProject, saveProject } from './persistence'

export interface ToastData {
  msg: string
  kind: 'ok' | 'err'
  seq: number
}

interface AppState {
  project: Project
  selected: number
  playing: boolean
  toast: ToastData | null
  /** 键盘写入光标(音轨网格上的插入位置) */
  caret: { step: number; pitch: number } | null
  /** 键盘写入时值(步数),由 [ / ] 调整 */
  insertLen: number

  setBpm: (bpm: number) => void
  setBars: (bars: number) => void
  select: (i: number) => void
  setCaret: (c: { step: number; pitch: number } | null) => void
  setInsertLen: (n: number) => void
  /** 键盘写入:单音覆盖 step 列后插入 */
  writeNote: (i: number, step: number, pitch: number, len: number) => void
  /** 拖动音符:整体移动(位置 + 音高),目标被占则原地不动;返回实际落点(被阻挡时为 null) */
  setNotePos: (
    i: number,
    fromStep: number,
    fromPitch: number,
    toStep: number,
    toPitch: number,
  ) => { step: number; pitch: number } | null
  setVolume: (i: number, volume: number) => void
  toggleMute: (i: number) => void
  toggleSolo: (i: number) => void
  setInstrument: (i: number, inst: InstrumentId) => void

  addNote: (i: number, step: number, pitch: number) => void
  removeNote: (i: number, step: number, pitch: number) => void
  setNoteLen: (i: number, step: number, pitch: number, len: number) => void
  toggleDrum: (i: number, step: number, kind: number) => void

  loadProject: (p: Project) => void
  loadDemo: () => void
  clearProject: () => void

  showToast: (msg: string, kind?: 'ok' | 'err') => void
  clearToast: () => void

  playTransport: () => void
  stopTransport: () => void
}

/** 不可变更新第 i 条轨(其余轨引用不变,供 memo 生效) */
const patchTrack = (
  state: AppState,
  i: number,
  fn: (t: Track) => Track,
): Partial<AppState> => ({
  project: {
    ...state.project,
    tracks: state.project.tracks.map((t, idx) => (idx === i ? fn(t) : t)),
  },
})

const sameCell = (n: Note, step: number, pitch: number): boolean =>
  n.step === step && n.pitch === pitch

const initialProject: Project = loadStoredProject() ?? createDemoProject()

export const useStore = create<AppState>()((set, get) => ({
  project: initialProject,
  selected: 0,
  playing: false,
  toast: null,
  caret: null,
  insertLen: DEFAULT_NOTE_LEN,

  setBpm: (bpm) =>
    set((st) => ({
      project: { ...st.project, bpm: Math.min(240, Math.max(40, Math.round(bpm))) },
    })),

  setBars: (bars) =>
    set((st) => {
      const b = Math.min(MAX_BARS, Math.max(1, Math.round(bars)))
      const sc = stepCountOf(b)
      return {
        project: {
          ...st.project,
          bars: b,
          // 缩小时丢弃范围外音符,并把越界长度钳回来
          tracks: st.project.tracks.map((t) => ({
            ...t,
            notes: t.notes
              .filter((n) => n.step < sc)
              .map((n) => ({ ...n, len: Math.min(n.len, sc - n.step) })),
          })),
        },
        // 光标同步钳制在新的步数范围内
        caret: st.caret
          ? { step: Math.min(st.caret.step, sc - 1), pitch: st.caret.pitch }
          : null,
      }
    }),

  select: (i) => set({ selected: i }),

  setCaret: (c) => set({ caret: c }), // c 可为 null(Esc 取消选中)

  setInsertLen: (n) => set({ insertLen: Math.max(1, Math.min(32, Math.round(n))) }),

  writeNote: (i, step, pitch, len) =>
    set((st) => {
      const sc = stepCountOf(st.project.bars)
      const l = Math.max(1, Math.min(len, sc - step))
      return patchTrack(st, i, (t) => ({
        ...t,
        // 单音覆盖:清除本步其他音高的音符后写入
        notes: [...t.notes.filter((n) => n.step !== step), { step, pitch, len: l }],
      }))
    }),

  setNotePos: (i, fromStep, fromPitch, toStep, toPitch) => {
    let result: { step: number; pitch: number } | null = null
    set((st) => {
      const sc = stepCountOf(st.project.bars)
      return patchTrack(st, i, (t) => {
        const note = t.notes.find((n) => n.step === fromStep && n.pitch === fromPitch)
        if (!note) return t
        const ts = Math.max(0, Math.min(toStep, Math.max(0, sc - note.len)))
        const tp = Math.max(PITCH_MIN, Math.min(PITCH_MAX, toPitch))
        if (ts === fromStep && tp === fromPitch) return t
        const rest = t.notes.filter((n) => n !== note)
        if (rest.some((n) => n.step === ts && n.pitch === tp)) return t // 目标被占,原地不动
        result = { step: ts, pitch: tp }
        return { ...t, notes: [...rest, { ...note, step: ts, pitch: tp }] }
      })
    })
    return result
  },

  setVolume: (i, volume) =>
    set((st) => patchTrack(st, i, (t) => ({ ...t, volume }))),

  toggleMute: (i) =>
    set((st) => patchTrack(st, i, (t) => ({ ...t, muted: !t.muted }))),

  toggleSolo: (i) =>
    set((st) => patchTrack(st, i, (t) => ({ ...t, solo: !t.solo }))),

  setInstrument: (i, inst) =>
    set((st) => patchTrack(st, i, (t) => ({ ...t, instrument: inst }))),

  addNote: (i, step, pitch) =>
    set((st) => {
      const sc = stepCountOf(st.project.bars)
      // 鼠标放置与键盘写入共用 insertLen 时值
      const len = Math.max(1, Math.min(st.insertLen, sc - step))
      return patchTrack(st, i, (t) => {
        if (t.notes.some((n) => sameCell(n, step, pitch))) return t
        const note: Note = { step, pitch, len }
        return { ...t, notes: [...t.notes, note] }
      })
    }),

  removeNote: (i, step, pitch) =>
    set((st) =>
      patchTrack(st, i, (t) => ({
        ...t,
        notes: t.notes.filter((n) => !sameCell(n, step, pitch)),
      })),
    ),

  setNoteLen: (i, step, pitch, len) =>
    set((st) =>
      patchTrack(st, i, (t) => ({
        ...t,
        notes: t.notes.map((n) =>
          sameCell(n, step, pitch)
            ? { ...n, len: Math.max(1, Math.min(len, stepCountOf(st.project.bars) - step)) }
            : n,
        ),
      })),
    ),

  toggleDrum: (i, step, kind) =>
    set((st) =>
      patchTrack(st, i, (t) => {
        const exists = t.notes.some((n) => sameCell(n, step, kind))
        return {
          ...t,
          notes: exists
            ? t.notes.filter((n) => !sameCell(n, step, kind))
            : [...t.notes, { step, pitch: kind, len: 1 }],
        }
      }),
    ),

  loadProject: (p) => set({ project: p }),

  loadDemo: () => set({ project: createDemoProject() }),

  clearProject: () => set({ project: createEmptyProject() }),

  showToast: (msg, kind = 'ok') =>
    set({ toast: { msg, kind, seq: Date.now() } }),

  clearToast: () => set({ toast: null }),

  playTransport: () => {
    set({ playing: true })
    engine.play().catch((err: unknown) => {
      set({ playing: false })
      get().showToast(
        `音频启动失败:${err instanceof Error ? err.message : String(err)}`,
        'err',
      )
    })
  },

  stopTransport: () => {
    engine.stop()
    set({ playing: false })
  },
}))

// ── 自动保存:project 引用变化 → 防抖 800ms 写 localStorage ─────
let saveTimer: ReturnType<typeof setTimeout> | undefined
useStore.subscribe((state, prev) => {
  if (state.project !== prev.project) {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveProject(state.project)
    }, 800)
  }
})
