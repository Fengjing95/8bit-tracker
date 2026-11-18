/**
 * 步进音序器网格:bars×16 步(1–64 小节自由设置)× 25 音高(pitched)/ 4 鼓件(drum)。
 *
 * 性能设计(见 docs/design-detail.md §5):
 * - 底格/拍点/小节线用 CSS repeating-gradient 绘制,不再逐格出 DOM —— 小节数增大时
 *   DOM 只随标尺刻度线性增长,行本体是常量;
 * - PitchRow / DrumRow 均 memo;音符按音高分组且未变行保留数组引用 ⇒ 改动只重渲染对应行;
 * - 播放列高亮是高频更新,不经过 React state:订阅 engine.onStepPlayed,
 *   直接平移各行的 [data-ph] 覆盖列(每步 ~29 次 style 写入),零 re-render。
 */
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { engine } from '../audio/engine'
import {
  BAR_STEPS,
  DRUM_LABELS,
  DRUM_PITCHES,
  DEFAULT_NOTE_LEN,
  PITCH_MAX,
  PITCH_MIN,
  type Note,
} from '../state/model'
import { useStore } from '../state/store'
import { TRACK_COLORS } from './TrackPanel'
import s from './grid.module.css'

// ── 几何常量(JS 单一来源;grid.module.css 中的渐变周期与此一致) ──
const CW = 30 // 单元格宽 px
const GUTTER = 52 // 行标签宽 px

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const BLACK_SET = new Set([1, 3, 6, 8, 10])
const PITCHES: readonly number[] = Array.from(
  { length: PITCH_MAX - PITCH_MIN + 1 },
  (_, i) => PITCH_MAX - i, // 顶行最高音
)
const EMPTY: Note[] = []
const DRUM_COLORS = ['#ff5c5c', '#ffd23f', '#39dcff', '#ff4fd8']

const pitchName = (p: number): string =>
  `${NOTE_NAMES[p % 12]}${Math.floor(p / 12) - 1}`

const stepFromRow = (rowEl: HTMLElement, clientX: number, maxStep: number): number => {
  const rect = rowEl.getBoundingClientRect()
  const x = clientX - rect.left - GUTTER
  return Math.max(0, Math.min(maxStep - 1, Math.floor(x / CW)))
}

interface DragState {
  pitch: number
  step: number
  origLen: number
  placedNew: boolean
  moved: boolean
  rowEl: HTMLElement
}

/** 行内音符按音高分组;内容未变的行保留旧引用 ⇒ memo 行跳过重渲染 */
function useNotesByPitch(
  notes: Note[],
  pitches: readonly number[],
): Map<number, Note[]> {
  const prev = useRef<{ src: Note[]; map: Map<number, Note[]> } | null>(null)
  return useMemo(() => {
    if (prev.current && prev.current.src === notes) return prev.current.map
    const map = new Map<number, Note[]>()
    for (const p of pitches) {
      const items = notes.filter((n) => n.pitch === p)
      const old = prev.current?.map.get(p)
      const same =
        old !== undefined &&
        old.length === items.length &&
        old.every((n, i) => n === items[i])
      map.set(p, same ? old : items)
    }
    prev.current = { src: notes, map }
    return map
  }, [notes, pitches])
}

// ── 音高行(memo) ───────────────────────────────────────────────
interface PitchRowProps {
  pitch: number
  notes: Note[]
  color: string
  stepCount: number
  onDown: (e: ReactPointerEvent<HTMLElement>, pitch: number) => void
}

const PitchRow = memo(function PitchRow({
  pitch,
  notes,
  color,
  stepCount,
  onDown,
}: PitchRowProps) {
  const isBlack = BLACK_SET.has(pitch % 12)
  const isOct = pitch % 12 === 0
  return (
    <div
      className={`${s.row} ${isBlack ? s.blackRow : ''} ${isOct ? s.octRow : ''}`}
      style={{ '--nc': color, width: GUTTER + stepCount * CW } as CSSProperties}
      onPointerDown={(e) => onDown(e, pitch)}
    >
      <div className={s.rowLabel} data-gutter>
        {pitchName(pitch)}
      </div>
      <div
        className={`${s.stripes} ${isBlack ? s.stripesBlack : ''}`}
        style={{ width: stepCount * CW }}
      />
      {notes.map((n) => (
        <div
          key={`${n.step}:${n.pitch}`}
          data-note
          data-step={n.step}
          data-len={n.len}
          data-pitch={n.pitch}
          className={s.note}
          style={{ left: GUTTER + n.step * CW + 1, width: Math.max(10, n.len * CW - 3) }}
        />
      ))}
      <div className={s.phColumn} data-ph style={{ visibility: 'hidden' }} />
    </div>
  )
})

// ── 鼓件行(memo):点击开关,音符块化,颜色区分鼓件 ─────────────
interface DrumRowProps {
  kind: number
  notes: Note[]
  stepCount: number
  onDown: (e: ReactPointerEvent<HTMLElement>, kind: number) => void
}

const DrumRow = memo(function DrumRow({
  kind,
  notes,
  stepCount,
  onDown,
}: DrumRowProps) {
  const labelClass =
    kind === 0
      ? s.drumKick
      : kind === 1
        ? s.drumSnare
        : kind === 2
          ? s.drumHat
          : s.drumCrash
  return (
    <div
      className={`${s.row} ${s.drumRow}`}
      style={
        {
          '--nc': DRUM_COLORS[kind] ?? DRUM_COLORS[0],
          width: GUTTER + stepCount * CW,
        } as CSSProperties
      }
      onPointerDown={(e) => onDown(e, kind)}
    >
      <div className={`${s.rowLabel} ${labelClass}`} data-gutter>
        {DRUM_LABELS[kind]}
      </div>
      <div className={s.stripes} style={{ width: stepCount * CW }} />
      {notes.map((n) => (
        <div
          key={n.step}
          data-note
          data-step={n.step}
          data-len={n.len}
          data-pitch={kind}
          className={s.note}
          style={{ left: GUTTER + n.step * CW + 1, width: CW - 3 }}
        />
      ))}
      <div className={s.phColumn} data-ph style={{ visibility: 'hidden' }} />
    </div>
  )
})

// ── Grid 主体 ───────────────────────────────────────────────────
export function Grid() {
  const selected = useStore((st) => st.selected)
  const track = useStore((st) => st.project.tracks[st.selected])
  const bars = useStore((st) => st.project.bars)
  const stepCount = bars * BAR_STEPS
  const isDrum = track.instrument === 'noise'
  const notesByPitch = useNotesByPitch(track.notes, isDrum ? DRUM_PITCHES : PITCHES)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)

  // ── 拖拽改长度(窗口级监听,出界仍有效) ──────────────────────
  const onDragMove = useCallback((e: PointerEvent): void => {
    const d = dragRef.current
    if (!d) return
    const sc = useStore.getState().project.bars * BAR_STEPS
    const step = stepFromRow(d.rowEl, e.clientX, sc)
    const len = Math.max(1, Math.min(step - d.step + 1, sc - d.step))
    if (len !== d.origLen) {
      d.moved = true
      const st = useStore.getState()
      st.setNoteLen(st.selected, d.step, d.pitch, len)
    }
  }, [])

  const endDrag = useCallback((): void => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', endDrag)
    window.removeEventListener('pointercancel', endDrag)
    // "再点删除":点的是已有音符且没有拖动
    if (!d.placedNew && !d.moved) {
      const st = useStore.getState()
      st.removeNote(st.selected, d.step, d.pitch)
    }
  }, [onDragMove])

  const beginDrag = useCallback((): void => {
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
  }, [onDragMove, endDrag])

  const onRowDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, pitch: number): void => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('[data-gutter]')) return
      const rowEl = e.currentTarget
      const noteEl = target.closest('[data-note]') as HTMLElement | null
      const st = useStore.getState()
      const sc = st.project.bars * BAR_STEPS
      if (noteEl) {
        dragRef.current = {
          pitch,
          step: Number(noteEl.dataset.step),
          origLen: Number(noteEl.dataset.len),
          placedNew: false,
          moved: false,
          rowEl,
        }
      } else {
        const step = stepFromRow(rowEl, e.clientX, sc)
        st.addNote(st.selected, step, pitch)
        dragRef.current = {
          pitch,
          step,
          origLen: DEFAULT_NOTE_LEN,
          placedNew: true,
          moved: false,
          rowEl,
        }
      }
      beginDrag()
    },
    [beginDrag],
  )

  const onDrumDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, kind: number): void => {
      if (e.button !== 0) return
      if ((e.target as HTMLElement).closest('[data-gutter]')) return
      const st = useStore.getState()
      const step = stepFromRow(e.currentTarget, e.clientX, st.project.bars * BAR_STEPS)
      st.toggleDrum(st.selected, step, kind)
    },
    [],
  )

  const onContextMenu = useCallback((e: ReactMouseEvent): void => {
    e.preventDefault()
    const noteEl = (e.target as HTMLElement).closest('[data-note]') as HTMLElement | null
    if (!noteEl) return
    const st = useStore.getState()
    st.removeNote(st.selected, Number(noteEl.dataset.step), Number(noteEl.dataset.pitch))
  }, [])

  // ── 播放列高亮:调度器当前步回调 → ref 直移覆盖列(无 React state) ──
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const apply = (step: number): void => {
      const x = step < 0 ? 0 : GUTTER + step * CW
      wrap.querySelectorAll<HTMLElement>('[data-ph]').forEach((el) => {
        el.style.transform = `translateX(${x}px)`
        el.style.visibility = step < 0 ? 'hidden' : 'visible'
      })
      wrap.querySelectorAll<HTMLElement>('[data-note]').forEach((el) => {
        if (step < 0) {
          el.classList.remove(s.ring)
          return
        }
        const a = Number(el.dataset.step)
        const len = Number(el.dataset.len)
        el.classList.toggle(s.ring, step >= a && step < a + len)
      })
    }
    return engine.onStepPlayed(apply)
  }, [])

  return (
    <div className={s.wrap} ref={wrapRef}>
      <div className={s.scroller}>
        <div className={s.ruler}>
          <div className={s.corner} data-gutter>
            STEP
          </div>
          {Array.from({ length: stepCount }, (_, st) => (
            <div
              key={st}
              data-step={st}
              className={`${s.rulerCell} ${st % 4 === 0 ? s.rulerBeat : ''} ${
                st % 16 === 0 ? s.rulerBar : ''
              }`}
            >
              {st + 1}
            </div>
          ))}
          <div className={s.phColumn} data-ph style={{ visibility: 'hidden' }} />
        </div>
        <div className={s.lanes} onContextMenu={onContextMenu}>
          {isDrum
            ? DRUM_PITCHES.map((k) => (
                <DrumRow
                  key={k}
                  kind={k}
                  notes={notesByPitch.get(k) ?? EMPTY}
                  stepCount={stepCount}
                  onDown={onDrumDown}
                />
              ))
            : PITCHES.map((p) => (
                <PitchRow
                  key={p}
                  pitch={p}
                  notes={notesByPitch.get(p) ?? EMPTY}
                  color={TRACK_COLORS[selected] ?? TRACK_COLORS[0]}
                  stepCount={stepCount}
                  onDown={onRowDown}
                />
              ))}
        </div>
      </div>
    </div>
  )
}
