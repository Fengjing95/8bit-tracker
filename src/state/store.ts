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

  setBpm: (bpm: number) => void
  setBars: (bars: number) => void
  select: (i: number) => void
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
      }
    }),

  select: (i) => set({ selected: i }),

  setVolume: (i, volume) =>
    set((st) => patchTrack(st, i, (t) => ({ ...t, volume }))),

  toggleMute: (i) =>
    set((st) => patchTrack(st, i, (t) => ({ ...t, muted: !t.muted }))),

  toggleSolo: (i) =>
    set((st) => patchTrack(st, i, (t) => ({ ...t, solo: !t.solo }))),

  setInstrument: (i, inst) =>
    set((st) => patchTrack(st, i, (t) => ({ ...t, instrument: inst }))),

  addNote: (i, step, pitch) =>
    set((st) =>
      patchTrack(st, i, (t) => {
        if (t.notes.some((n) => sameCell(n, step, pitch))) return t
        const len = Math.min(DEFAULT_NOTE_LEN, stepCountOf(st.project.bars) - step)
        const note: Note = { step, pitch, len }
        return { ...t, notes: [...t.notes, note] }
      }),
    ),

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
