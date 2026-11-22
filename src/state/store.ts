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

/** 框选区域:存原始两角(拖拽中任一角可为起点),使用时归一化 */
export interface Region {
  s0: number
  s1: number
  p0: number
  p1: number
}

/** 剪贴板音符:相对框选左下角(最小 step、最小 pitch)的偏移 */
export interface ClipNote {
  dStep: number
  dPitch: number
  len: number
}

export interface ClipboardData {
  notes: ClipNote[]
  /** 框选步数宽度(连续粘贴时依次后移的步距) */
  w: number
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
  /** 框选区域(原始两角,归一化在使用处);仅音轨支持 */
  region: Region | null
  /** 复制/剪切缓冲(相对坐标),跨轨粘贴 */
  clipboard: ClipboardData | null
  /** ≤1024px 轨道抽屉开合(桌面恒显侧栏,此态无效) */
  panelOpen: boolean
  /** 底部虚拟键盘收合(收起给网格让空间) */
  keyboardOpen: boolean
  /** 底部键盘模式:关 = 编辑(试奏,鼠标操作网格);开 = 录制(步进光标按 BPM 前进,写入落当前步) */
  recMode: boolean
  /** 录制倒数阶段(1 小节拍点 click,光标闪烁,不写入);与 recMode 同时为 true 表示倒数中 */
  recCountin: boolean

  setBpm: (bpm: number) => void
  setBars: (bars: number) => void
  select: (i: number) => void
  setCaret: (c: { step: number; pitch: number } | null) => void
  setInsertLen: (n: number) => void
  /** 更新框选两角(拖拽中实时调用;归一化在使用处) */
  setRegion: (r: Region) => void
  clearRegion: () => void
  /** 复制:有框选收框内音符,无框选复制整轨(鼓轨为空操作) */
  copySelection: () => void
  /** 剪切:copy + 删除框内音符(一条历史);无框选为空操作 */
  cutSelection: () => void
  /** 粘贴到当前选中轨(锚点 = caret,缺省 {0,60});一次粘贴 = 一条历史 */
  pasteClipboard: () => void
  /** 删除框内全部音符并清除框选(一条历史) */
  deleteRegion: () => void
  setPanelOpen: (v: boolean) => void
  setKeyboardOpen: (v: boolean) => void
  /** 进入/退出录制;与播放互斥(开启时先停播放) */
  setRecMode: (v: boolean) => void
  /** 录制倒数相位切换(useStepRecorder 内部驱动) */
  setRecCountin: (v: boolean) => void
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

  addNote: (i: number, step: number, pitch: number, len?: number) => void
  removeNote: (i: number, step: number, pitch: number) => void
  /** len 变更;push = false 用于录制长按的中间延长(不入撤销历史,定稿时统一入账) */
  setNoteLen: (i: number, step: number, pitch: number, len: number, push?: boolean) => void
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

/** 框选归一化:左下角 (min step, min pitch) 与右上角 */
const normRegion = (r: Region): { s0: number; s1: number; p0: number; p1: number } => ({
  s0: Math.min(r.s0, r.s1),
  s1: Math.max(r.s0, r.s1),
  p0: Math.min(r.p0, r.p1),
  p1: Math.max(r.p0, r.p1),
})

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
  region: null,
  clipboard: null,
  panelOpen: false,
  keyboardOpen: true,
  recMode: false,
  recCountin: false,

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
      // 框选越界(右缘超出新步数)直接清除,未越界保留
      const region =
        st.region && normRegion(st.region).s1 < sc ? st.region : null
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
        region,
      }
    }),

  // 切换轨道清除框选(剪贴板保留:跨轨复制粘贴用)
  select: (i) => set({ selected: i, region: null }),

  setCaret: (c) => set({ caret: c }), // c 可为 null(Esc 取消选中)

  setInsertLen: (n) => set({ insertLen: Math.max(1, Math.min(32, Math.round(n))) }),

  setRegion: (r) => set({ region: r }),

  clearRegion: () => set((st) => (st.region ? { region: null } : {})),

  // ── 复制/剪切/粘贴:相对坐标剪贴板,锚点粘贴,同格替换其余共存 ──

  copySelection: () => {
    const st = get()
    const t0 = st.project.tracks[st.selected]
    if (!t0) return
    if (t0.instrument === 'noise') {
      st.showToast('鼓轨暂不支持复制', 'err')
      return
    }
    if (!st.region) {
      // 无框选:复制整轨,虚拟框 = 全轨 × 内容音域(左下角 = (0, 最低音))。
      // dPitch 取相对最低音的偏移而非绝对音高 —— 粘贴公式统一为 caret + d,
      // 绝对音高在 caret.pitch(≥48)基准下必然越界被全部跳过。
      const minPitch = t0.notes.length
        ? Math.min(...t0.notes.map((n) => n.pitch))
        : PITCH_MIN
      set({
        clipboard: {
          notes: t0.notes.map((n) => ({
            dStep: n.step,
            dPitch: n.pitch - minPitch,
            len: n.len,
          })),
          w: stepCountOf(st.project.bars),
        },
      })
      st.showToast(`已复制整轨 ${t0.notes.length} 个音符`)
      return
    }
    const { s0, s1, p0, p1 } = normRegion(st.region)
    const notes = t0.notes
      .filter((n) => n.step >= s0 && n.step <= s1 && n.pitch >= p0 && n.pitch <= p1)
      .map((n) => ({ dStep: n.step - s0, dPitch: n.pitch - p0, len: n.len }))
    set({ clipboard: { notes, w: s1 - s0 + 1 } })
    st.showToast(`已复制框内 ${notes.length} 个音符`)
  },

  cutSelection: () => {
    const st = get()
    if (!st.region) return // 无框选 cut 为空操作
    const t0 = st.project.tracks[st.selected]
    if (!t0 || t0.instrument === 'noise') return
    const { s0, s1, p0, p1 } = normRegion(st.region)
    const inBox = (n: Note): boolean =>
      n.step >= s0 && n.step <= s1 && n.pitch >= p0 && n.pitch <= p1
    const notes = t0.notes.filter(inBox).map((n) => ({
      dStep: n.step - s0,
      dPitch: n.pitch - p0,
      len: n.len,
    }))
    if (!t0.notes.some(inBox)) {
      // 框内无音符:仅落剪贴板并清框选,不产生空历史
      set({ clipboard: { notes, w: s1 - s0 + 1 }, region: null })
      return
    }
    set((cur) => ({
      ...pushHistory(cur),
      clipboard: { notes, w: s1 - s0 + 1 },
      region: null,
      ...patchTrack(cur, cur.selected, (t) => ({
        ...t,
        notes: t.notes.filter((n) => !inBox(n)),
      })),
    }))
    st.showToast(`已剪切 ${notes.length} 个音符`)
  },

  pasteClipboard: () => {
    const st = get()
    if (!st.clipboard) return
    const t0 = st.project.tracks[st.selected]
    if (!t0) return
    if (t0.instrument === 'noise') {
      st.showToast('鼓轨暂不支持粘贴', 'err')
      return
    }
    set((cur) => {
      const clip = cur.clipboard
      if (!clip) return {}
      const sc = stepCountOf(cur.project.bars)
      const anchor = cur.caret ?? { step: 0, pitch: 60 }
      // pitch 越界跳过;step ≥ 步数丢弃;长度钳到轨尾
      const pasted: Note[] = []
      for (const c of clip.notes) {
        const step = anchor.step + c.dStep
        const pitch = anchor.pitch + c.dPitch
        if (pitch < PITCH_MIN || pitch > PITCH_MAX) continue
        if (step >= sc) continue
        pasted.push({ step, pitch, len: Math.max(1, Math.min(c.len, sc - step)) })
      }
      const patch = pasted.length
        ? { ...pushHistory(cur), ...patchTrack(cur, cur.selected, (t) => ({
            ...t,
            // 同格 (step,pitch) 替换(长度取新值),其余共存
            notes: [
              ...t.notes.filter(
                (n) => !pasted.some((m) => m.step === n.step && m.pitch === n.pitch),
              ),
              ...pasted,
            ],
          })) }
        : {}
      return {
        region: null,
        // 连续粘贴依次后移 w 步
        caret: { step: Math.min(anchor.step + clip.w, sc - 1), pitch: anchor.pitch },
        ...patch,
      }
    })
  },

  deleteRegion: () => {
    const st = get()
    if (!st.region) return
    const { s0, s1, p0, p1 } = normRegion(st.region)
    const inBox = (n: Note): boolean =>
      n.step >= s0 && n.step <= s1 && n.pitch >= p0 && n.pitch <= p1
    set((cur) => {
      const t0 = cur.project.tracks[cur.selected]
      if (!t0 || !t0.notes.some(inBox)) return { region: null } // 框内无音符只清框选
      return {
        ...pushHistory(cur),
        region: null,
        ...patchTrack(cur, cur.selected, (t) => ({
          ...t,
          notes: t.notes.filter((n) => !inBox(n)),
        })),
      }
    })
  },

  setPanelOpen: (v) => set({ panelOpen: v }),
  setKeyboardOpen: (v) => set({ keyboardOpen: v }),
  // 录制与播放互斥:开启录制时先停播放
  setRecMode: (v) => {
    const st = get()
    if (v && st.playing) {
      engine.stop()
      set({ recMode: true, recCountin: true, playing: false })
    } else {
      set(v ? { recMode: true, recCountin: true } : { recMode: false, recCountin: false })
    }
  },

  setRecCountin: (v) => set({ recCountin: v }),

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

  addNote: (i, step, pitch, len) =>
    set((st) => {
      const t0 = st.project.tracks[i]
      if (!t0 || t0.notes.some((n) => sameCell(n, step, pitch))) return {}
      const sc = stepCountOf(st.project.bars)
      // 缺省取 insertLen(鼠标放置/键盘写入);显式传入用于录制(1 步起录,长按延长)
      const l = Math.max(1, Math.min(len ?? st.insertLen, sc - step))
      return {
        ...pushHistory(st),
        ...patchTrack(st, i, (t) => ({ ...t, notes: [...t.notes, { step, pitch, len: l }] })),
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

  setNoteLen: (i, step, pitch, len, push = true) =>
    set((st) => {
      const target = st.project.tracks[i]?.notes.find((n) => sameCell(n, step, pitch))
      const clamped = Math.max(1, Math.min(len, stepCountOf(st.project.bars) - step))
      if (!target || target.len === clamped) return {}
      // push = false:录制长按的中间延长,不入撤销历史(松手定稿时一次性入账)
      const hist = push ? pushHistory(st) : {}
      return {
        ...hist,
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
    // 播放与编辑/录制互斥:开播即退出录制
    set({ playing: true, recMode: false, recCountin: false })
    const start = get().caret?.step ?? 0
    engine.play(start).catch((err: unknown) => {
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
