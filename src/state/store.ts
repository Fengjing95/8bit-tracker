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
  /** 撤销栈(工程快照,上限 HISTORY_LIMIT 条) */
  past: Project[]
  /** 重做栈(undo/redo 时对换) */
  future: Project[]
  selected: number
  playing: boolean
  toast: ToastData | null
  /** 键盘写入光标(音轨网格上的插入位置) */
  caret: { step: number; pitch: number } | null
  /** 键盘写入时值(步数),由 [ / ] 调整 */
  insertLen: number
  /** ≤1024px 轨道抽屉开合(桌面恒显侧栏,此态无效) */
  panelOpen: boolean
  /** 底部虚拟键盘收合(收起给网格让空间) */
  keyboardOpen: boolean
  /** 虚拟键盘写入模式:关 = 试奏,开 = 点击写入光标处并前进 */
  writeMode: boolean

  setBpm: (bpm: number) => void
  setBars: (bars: number) => void
  select: (i: number) => void
  setCaret: (c: { step: number; pitch: number } | null) => void
  setInsertLen: (n: number) => void
  setPanelOpen: (v: boolean) => void
  setKeyboardOpen: (v: boolean) => void
  setWriteMode: (v: boolean) => void
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

  undo: () => void
  redo: () => void

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

// ── 撤销/重做:project 纯 JSON 数据,变更前整份快照 ─────────────
const HISTORY_LIMIT = 100

const snapshotProject = (p: Project): Project => JSON.parse(JSON.stringify(p)) as Project

/** 变更前把当前工程压入 past(超出上限丢最旧)并清空 future */
const pushHistory = (st: AppState): Partial<AppState> => ({
  past: [...st.past, snapshotProject(st.project)].slice(-HISTORY_LIMIT),
  future: [],
})

const initialProject: Project = loadStoredProject() ?? createDemoProject()

export const useStore = create<AppState>()((set, get) => ({
  project: initialProject,
  past: [],
  future: [],
  selected: 0,
  playing: false,
  toast: null,
  caret: null,
  insertLen: DEFAULT_NOTE_LEN,
  panelOpen: false,
  keyboardOpen: true,
  writeMode: false,

  setBpm: (bpm) =>
    set((st) => {
      const v = Math.min(240, Math.max(40, Math.round(bpm)))
      if (v === st.project.bpm) return {} // 已在边界,避免空历史条目
      return {
        ...pushHistory(st),
        project: { ...st.project, bpm: v },
      }
    }),

  setBars: (bars) =>
    set((st) => {
      const b = Math.min(MAX_BARS, Math.max(1, Math.round(bars)))
      if (b === st.project.bars) return {}
      const sc = stepCountOf(b)
      return {
        ...pushHistory(st),
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

  setPanelOpen: (v) => set({ panelOpen: v }),
  setKeyboardOpen: (v) => set({ keyboardOpen: v }),
  setWriteMode: (v) => set({ writeMode: v }),

  writeNote: (i, step, pitch, len) =>
    set((st) => {
      const sc = stepCountOf(st.project.bars)
      const l = Math.max(1, Math.min(len, sc - step))
      const t0 = st.project.tracks[i]
      if (!t0) return {}
      const at = t0.notes.filter((n) => n.step === step)
      // 内容不变(同音同时值且本步无其他音高)则不进入历史
      const exact = at.find((n) => n.pitch === pitch)
      if (exact && exact.len === l && at.length === 1) return {}
      return {
        ...pushHistory(st),
        ...patchTrack(st, i, (t) => ({
          ...t,
          // 单音覆盖:清除本步其他音高的音符后写入
          notes: [...t.notes.filter((n) => n.step !== step), { step, pitch, len: l }],
        })),
      }
    }),

  setNotePos: (i, fromStep, fromPitch, toStep, toPitch) => {
    let result: { step: number; pitch: number } | null = null
    set((st) => {
      const sc = stepCountOf(st.project.bars)
      const note = st.project.tracks[i]?.notes.find(
        (n) => n.step === fromStep && n.pitch === fromPitch,
      )
      if (!note) return {}
      const ts = Math.max(0, Math.min(toStep, Math.max(0, sc - note.len)))
      const tp = Math.max(PITCH_MIN, Math.min(PITCH_MAX, toPitch))
      if (ts === fromStep && tp === fromPitch) return {} // 原地,无变更
      if (st.project.tracks[i]?.notes.some((n) => n !== note && n.step === ts && n.pitch === tp))
        return {} // 目标被占,原地不动
      result = { step: ts, pitch: tp }
      return {
        ...pushHistory(st),
        ...patchTrack(st, i, (t) => {
          const rest = t.notes.filter((n) => n !== note)
          return { ...t, notes: [...rest, { ...note, step: ts, pitch: tp }] }
        }),
      }
    })
    return result
  },

  setVolume: (i, volume) =>
    set((st) => {
      const t0 = st.project.tracks[i]
      if (!t0 || t0.volume === volume) return {}
      return { ...pushHistory(st), ...patchTrack(st, i, (t) => ({ ...t, volume })) }
    }),

  toggleMute: (i) =>
    set((st) => ({ ...pushHistory(st), ...patchTrack(st, i, (t) => ({ ...t, muted: !t.muted })) })),

  toggleSolo: (i) =>
    set((st) => ({ ...pushHistory(st), ...patchTrack(st, i, (t) => ({ ...t, solo: !t.solo })) })),

  setInstrument: (i, inst) =>
    set((st) => {
      const t0 = st.project.tracks[i]
      if (!t0 || t0.instrument === inst) return {}
      return { ...pushHistory(st), ...patchTrack(st, i, (t) => ({ ...t, instrument: inst })) }
    }),

  addNote: (i, step, pitch) =>
    set((st) => {
      const t0 = st.project.tracks[i]
      if (!t0 || t0.notes.some((n) => sameCell(n, step, pitch))) return {}
      const sc = stepCountOf(st.project.bars)
      // 鼠标放置与键盘写入共用 insertLen 时值
      const len = Math.max(1, Math.min(st.insertLen, sc - step))
      return {
        ...pushHistory(st),
        ...patchTrack(st, i, (t) => ({ ...t, notes: [...t.notes, { step, pitch, len }] })),
      }
    }),

  removeNote: (i, step, pitch) =>
    set((st) => {
      const t0 = st.project.tracks[i]
      if (!t0 || !t0.notes.some((n) => sameCell(n, step, pitch))) return {}
      return {
        ...pushHistory(st),
        ...patchTrack(st, i, (t) => ({
          ...t,
          notes: t.notes.filter((n) => !sameCell(n, step, pitch)),
        })),
      }
    }),

  setNoteLen: (i, step, pitch, len) =>
    set((st) => {
      const target = st.project.tracks[i]?.notes.find((n) => sameCell(n, step, pitch))
      const clamped = Math.max(1, Math.min(len, stepCountOf(st.project.bars) - step))
      if (!target || target.len === clamped) return {}
      return {
        ...pushHistory(st),
        ...patchTrack(st, i, (t) => ({
          ...t,
          notes: t.notes.map((n) => (sameCell(n, step, pitch) ? { ...n, len: clamped } : n)),
        })),
      }
    }),

  toggleDrum: (i, step, kind) =>
    set((st) => {
      const exists = st.project.tracks[i]?.notes.some((n) => sameCell(n, step, kind)) ?? false
      return {
        ...pushHistory(st),
        ...patchTrack(st, i, (t) => ({
          ...t,
          notes: exists
            ? t.notes.filter((n) => !sameCell(n, step, kind))
            : [...t.notes, { step, pitch: kind, len: 1 }],
        })),
      }
    }),

  loadProject: (p) => set((st) => ({ ...pushHistory(st), project: p })),

  loadDemo: () => set((st) => ({ ...pushHistory(st), project: createDemoProject() })),

  clearProject: () => set((st) => ({ ...pushHistory(st), project: createEmptyProject() })),

  undo: () => {
    const st = get()
    const prev = st.past[st.past.length - 1]
    if (!prev) return
    set({
      past: st.past.slice(0, -1),
      future: [...st.future, snapshotProject(st.project)].slice(-HISTORY_LIMIT),
      project: prev,
    })
  },

  redo: () => {
    const st = get()
    const next = st.future[st.future.length - 1]
    if (!next) return
    set({
      past: [...st.past, snapshotProject(st.project)].slice(-HISTORY_LIMIT),
      future: st.future.slice(0, -1),
      project: next,
    })
  },

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
