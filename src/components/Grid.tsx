/**
 * 步进音序器网格:bars×16 步(1–64 小节自由设置)× 25 音高(pitched)/ 4 鼓件(drum)。
 *
 * 性能设计(见 docs/design-detail.md §5):
 * - 底格/拍点/小节线用 CSS repeating-gradient 绘制,不再逐格出 DOM —— 小节数增大时
 *   DOM 只随标尺刻度线性增长,行本体是常量;
 * - PitchRow / DrumRow 均 memo;音符按音高分组且未变行保留数组引用 ⇒ 改动只重渲染对应行;
 * - 播放列高亮是高频更新,不经过 React state:订阅 engine.onStepPlayed,
 *   直接平移各行的 [data-ph] 覆盖列(每步 ~29 次 style 写入),零 re-render;
 *   同回调内做播放头自动滚屏(视口跟随 + 回绕归零);
 * - 触控手势分级:pointerType 为 mouse/pen 保持指针行为;touch 的空格/鼓格
 *   走 tap 语义(位移 <8px 且 <600ms 才放置/开关),滑动由 touch-action
 *   pan-x pan-y 交给浏览器滚动;音符块 touch-action:none 保留直接拖拽,多指只跟踪第一根。
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
const RH = 22 // 音高行高 px(与 CSS 一致;border-box,无累积偏移)

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
  /** resize = 右缘把手改时值;move = 拖动音符移位(步进 + 音高);region = Shift 框选 */
  mode: 'resize' | 'move' | 'region'
  pitch: number
  step: number // resize 源起始步;region 起始角
  curStep: number
  curPitch: number
  origLen: number
  rowEl: HTMLElement
  /** 多指触控时只跟踪起始指针 */
  pointerId: number
}

/** 触控空格 tap:指针抬起时按位移/时长判定,通过才放置(空格滑动 = 滚动网格) */
interface TapState {
  drum: boolean
  /** pitched = 音高;drum 行 = 鼓件编号 */
  pitch: number
  rowEl: HTMLElement
  pointerId: number
  x0: number
  y0: number
  t0: number
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
      <div className={s.phColumn} data-ph />
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
      <div className={s.phColumn} data-ph />
    </div>
  )
})

// ── Grid 主体 ───────────────────────────────────────────────────
export function Grid() {
  const selected = useStore((st) => st.selected)
  const track = useStore((st) => st.project.tracks[st.selected])
  const bars = useStore((st) => st.project.bars)
  const caret = useStore((st) => st.caret)
  const region = useStore((st) => st.region)
  const insertLen = useStore((st) => st.insertLen)
  const recMode = useStore((st) => st.recMode)
  const recCountin = useStore((st) => st.recCountin)
  const playing = useStore((st) => st.playing)
  const stepCount = bars * BAR_STEPS
  const isDrum = track.instrument === 'noise'
  const notesByPitch = useNotesByPitch(track.notes, isDrum ? DRUM_PITCHES : PITCHES)

  const wrapRef = useRef<HTMLDivElement | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const lanesRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const tapRef = useRef<TapState | null>(null)

  // ── 触控 tap 判定(窗口级常驻监听,无待定 tap 时立即返回) ──
  // 抬起时:位移 <8px 且时长 <600ms 才算 tap 放置/开关;滚动接管会触发
  // pointercancel(行容器 touch-action: pan-x pan-y),待定 tap 直接作废。
  useEffect(() => {
    const onUp = (e: PointerEvent): void => {
      const tap = tapRef.current
      if (!tap || e.pointerId !== tap.pointerId) return
      tapRef.current = null
      const dt = performance.now() - tap.t0
      const dist = Math.hypot(e.clientX - tap.x0, e.clientY - tap.y0)
      if (dist >= 8 || dt >= 600) return
      const st = useStore.getState()
      const sc = st.project.bars * BAR_STEPS
      const step = stepFromRow(tap.rowEl, e.clientX, sc)
      if (tap.drum) {
        st.toggleDrum(st.selected, step, tap.pitch)
      } else {
        st.clearRegion() // 触控放置同样先清框选
        st.addNote(st.selected, step, tap.pitch)
        st.setCaret({ step, pitch: tap.pitch }) // 放置后光标吸附该音符
      }
    }
    const onCancel = (e: PointerEvent): void => {
      const tap = tapRef.current
      if (tap && e.pointerId === tap.pointerId) tapRef.current = null
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [])

  // ── 拖拽:右缘改时值 / 拖动音符移位(窗口级监听,出界仍有效) ──
  const onDragMove = useCallback((e: PointerEvent): void => {
    const d = dragRef.current
    if (!d) return
    if (e.pointerId !== d.pointerId) return // 多指触控只跟踪起始指针
    const st = useStore.getState()
    const sc = st.project.bars * BAR_STEPS
    if (d.mode === 'resize') {
      const step = stepFromRow(d.rowEl, e.clientX, sc)
      const len = Math.max(1, Math.min(step - d.step + 1, sc - d.step))
      if (len !== d.origLen) {
        st.setNoteLen(st.selected, d.step, d.pitch, len)
      }
      return
    }
    // region / move:用 lanes 几何换算目标格(不依赖 DOM 时序),支持跨行改音高
    const lanes = lanesRef.current
    if (!lanes) return
    const rect = lanes.getBoundingClientRect()
    const step = Math.max(
      0,
      Math.min(sc - 1, Math.floor((e.clientX - rect.left - GUTTER) / CW)),
    )
    const isDrum = st.project.tracks[st.selected]?.instrument === 'noise'
    const pitch = isDrum
      ? d.pitch
      : Math.max(
          PITCH_MIN,
          Math.min(PITCH_MAX, PITCH_MAX - Math.floor((e.clientY - rect.top) / RH)),
        )
    if (d.mode === 'region') {
      // 框选:两角实时更新(存原始两角,归一化在使用处)
      if (step !== d.curStep || pitch !== d.curPitch) {
        d.curStep = step
        d.curPitch = pitch
        st.setRegion({ s0: d.step, s1: step, p0: d.pitch, p1: pitch })
      }
      return
    }
    if (step !== d.curStep || pitch !== d.curPitch) {
      // 以"当前位置"为源持续移动;若用原始位置,首格之后源查找会落空
      const pos = st.setNotePos(st.selected, d.curStep, d.curPitch, step, pitch)
      if (pos) {
        d.curStep = pos.step
        d.curPitch = pos.pitch
        st.setCaret(pos) // 选中跟随
      }
    }
  }, [])

  const endDrag = useCallback((): void => {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', endDrag)
    window.removeEventListener('pointercancel', endDrag)
    if (d.mode === 'region') {
      // 位移 <1 格(起止同格)视为清除框选;否则拖拽中已实时提交
      const st = useStore.getState()
      if (d.curStep === d.step && d.curPitch === d.pitch) st.clearRegion()
    }
    // 选中模型:点击 = 选中(不删除);删除走 Backspace / Delete / 右键
  }, [onDragMove])

  const beginDrag = useCallback((): void => {
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
  }, [onDragMove, endDrag])

  const onRowDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, pitch: number): void => {
      if (e.button !== 0) return
      if (useStore.getState().playing) return // 播放与编辑互斥:播放中锁定网格编辑
      const target = e.target as HTMLElement
      if (target.closest('[data-gutter]')) return
      const rowEl = e.currentTarget
      const noteEl = target.closest('[data-note]') as HTMLElement | null
      const st = useStore.getState()
      const sc = st.project.bars * BAR_STEPS
      if (noteEl) {
        // 触控多指:已有拖拽/待定 tap 会话时只跟踪第一根
        if (e.pointerType === 'touch' && (dragRef.current || tapRef.current)) return
        // 命中音符:右缘 10px 为改时值把手,其余区域为整体拖动;点击 = 选中
        // 任何音符交互(选中/拖动/改长)先清除框选
        st.clearRegion()
        const rect = noteEl.getBoundingClientRect()
        const mode: DragState['mode'] = e.clientX >= rect.right - 10 ? 'resize' : 'move'
        const step0 = Number(noteEl.dataset.step)
        st.setCaret({ step: step0, pitch }) // 光标吸附到音符(选中)
        dragRef.current = {
          mode,
          pitch,
          step: step0,
          curStep: step0,
          curPitch: pitch,
          origLen: Number(noteEl.dataset.len),
          rowEl,
          pointerId: e.pointerId,
        }
      } else if (e.pointerType === 'touch') {
        // 触控空格:不立即放置,等抬起按 tap 语义判定(滑动 = 滚动网格)
        if (dragRef.current || tapRef.current) return
        tapRef.current = {
          drum: false,
          pitch,
          rowEl,
          pointerId: e.pointerId,
          x0: e.clientX,
          y0: e.clientY,
          t0: performance.now(),
        }
        return
      } else if (e.shiftKey) {
        // Shift + 空白起点 = 框选(mouse/pen;touch 无 Shift 不进入此分支)
        if (dragRef.current || tapRef.current) return
        const lanes = lanesRef.current
        if (!lanes) return
        const rect = lanes.getBoundingClientRect()
        const startStep = Math.max(
          0,
          Math.min(sc - 1, Math.floor((e.clientX - rect.left - GUTTER) / CW)),
        )
        const startPitch = Math.max(
          PITCH_MIN,
          Math.min(PITCH_MAX, PITCH_MAX - Math.floor((e.clientY - rect.top) / RH)),
        )
        st.setRegion({
          s0: startStep,
          s1: startStep,
          p0: startPitch,
          p1: startPitch,
        })
        dragRef.current = {
          mode: 'region',
          pitch: startPitch,
          step: startStep,
          curStep: startStep,
          curPitch: startPitch,
          origLen: 0,
          rowEl,
          pointerId: e.pointerId,
        }
      } else {
        // 普通放置:先清除框选,再放置
        st.clearRegion()
        const step = stepFromRow(rowEl, e.clientX, sc)
        st.addNote(st.selected, step, pitch)
        st.setCaret({ step, pitch }) // 放置即选中,便于立即 Backspace 撤掉
        dragRef.current = {
          mode: 'resize',
          pitch,
          step,
          curStep: step,
          curPitch: pitch,
          origLen: Math.max(1, Math.min(st.insertLen, sc - step)),
          rowEl,
          pointerId: e.pointerId,
        }
      }
      beginDrag()
    },
    [beginDrag],
  )

  const onDrumDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>, kind: number): void => {
      if (e.button !== 0) return
      if (useStore.getState().playing) return // 播放与编辑互斥
      if ((e.target as HTMLElement).closest('[data-gutter]')) return
      if (e.shiftKey) return // 鼓轨不支持框选:Shift 点击/拖拽为空操作
      if (e.pointerType === 'touch') {
        // 触控鼓行空格:tap 开关(滑动 = 滚动),不立即切换
        if (dragRef.current || tapRef.current) return
        tapRef.current = {
          drum: true,
          pitch: kind,
          rowEl: e.currentTarget,
          pointerId: e.pointerId,
          x0: e.clientX,
          y0: e.clientY,
          t0: performance.now(),
        }
        return
      }
      const st = useStore.getState()
      const step = stepFromRow(e.currentTarget, e.clientX, st.project.bars * BAR_STEPS)
      st.toggleDrum(st.selected, step, kind)
    },
    [],
  )

  const onContextMenu = useCallback((e: ReactMouseEvent): void => {
    e.preventDefault()
    if (useStore.getState().playing) return // 播放与编辑互斥
    const noteEl = (e.target as HTMLElement).closest('[data-note]') as HTMLElement | null
    if (!noteEl) return
    const st = useStore.getState()
    st.removeNote(st.selected, Number(noteEl.dataset.step), Number(noteEl.dataset.pitch))
  }, [])

  // 点击标尺:自由移动写入光标到该步(不放置音符;播放中也可预定位)
  const onRulerDown = useCallback((e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('[data-gutter]')) return
    const st = useStore.getState()
    const sc = st.project.bars * BAR_STEPS
    const step = stepFromRow(e.currentTarget, e.clientX, sc)
    st.setCaret({ step, pitch: st.caret?.pitch ?? 60 })
  }, [])

  // ── 统一列级光标:常驻显示光标所在步(默认第 1 小节起始;顶部标尺带三角指针),
  // 播放时该列即播放头(自动滚屏 + 音符点亮),停止后回弹到光标步 ──
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const move = (step: number): void => {
      const x = GUTTER + step * CW
      wrap.querySelectorAll<HTMLElement>('[data-ph]').forEach((el) => {
        el.style.transform = `translateX(${x}px)`
      })
      const pin = wrap.querySelector<HTMLElement>('[data-cursor-pin]')
      if (pin) pin.style.transform = `translateX(${x + CW / 2 - 6}px)` // 三角对准单元格中心
    }
    move(useStore.getState().caret?.step ?? 0)
    // 未播放时光标步变化(标尺点击 / 方向键 / REC 步进时钟)→ 列与指针跟随
    const unsubStore = useStore.subscribe((st, prev) => {
      if ((st.caret?.step ?? 0) !== (prev.caret?.step ?? 0) && !engine.isPlaying()) {
        move(st.caret?.step ?? 0)
      }
    })
    // 播放:列即播放头;停止(调度器回 step<0)回弹到光标步并熄灭点亮
    let lastStep = -1
    const unsubEngine = engine.onStepPlayed((step) => {
      if (step < 0) {
        move(useStore.getState().caret?.step ?? 0)
        wrap.querySelectorAll<HTMLElement>('[data-note]').forEach((el) => {
          el.classList.remove(s.ring)
        })
        lastStep = -1
        return
      }
      const x = GUTTER + step * CW
      move(step)
      wrap.querySelectorAll<HTMLElement>('[data-note]').forEach((el) => {
        const a = Number(el.dataset.step)
        const len = Number(el.dataset.len)
        el.classList.toggle(s.ring, step >= a && step < a + len)
      })
      const scroller = scrollerRef.current
      if (scroller) {
        if (lastStep >= 0 && step < lastStep) {
          scroller.scrollLeft = 0 // 循环回绕:滚回开头
        } else if (x - scroller.scrollLeft > scroller.clientWidth - 4 * CW - GUTTER) {
          scroller.scrollLeft = x - scroller.clientWidth + 4 * CW + GUTTER
        }
      }
      lastStep = step
    })
    return () => {
      unsubStore()
      unsubEngine()
    }
  }, [])

  // 音高行写入光标:落在音符上 = 选中态(实线框包住整音符);落在空格 = 插入态(虚线 ghost);
  // REC 录制模式加 .rec 红色样式,倒数阶段加 .countin 闪烁。
  // 鼓轨无此光标 —— 步进位置由统一列级光标(红色)指示。
  const caretNode = (() => {
    if (isDrum || !caret) return null
    const cs = Math.min(caret.step, stepCount - 1)
    const noteAt = notesByPitch.get(caret.pitch)?.find((n) => n.step === cs)
    const width =
      (noteAt ? noteAt.len : Math.max(1, Math.min(insertLen, stepCount - cs))) * CW
    return (
      <div
        className={`${s.caret} ${noteAt ? s.caretSel : ''} ${recMode ? s.rec : ''} ${
          recMode && recCountin ? s.countin : ''
        }`}
        style={{
          left: GUTTER + cs * CW,
          top: (PITCH_MAX - caret.pitch) * RH + 1,
          width,
        }}
      />
    )
  })()

  // 框选覆盖层:品红虚线框 + 8% 填充(存原始两角,渲染时归一化;
  // 仅音轨渲染 —— 切轨已清框选,此处为防御)
  const regionNode = (() => {
    if (isDrum || !region) return null
    const s0 = Math.min(region.s0, region.s1)
    const s1 = Math.max(region.s0, region.s1)
    const p0 = Math.min(region.p0, region.p1)
    const p1 = Math.max(region.p0, region.p1)
    return (
      <div
        className={s.region}
        style={{
          left: GUTTER + s0 * CW,
          top: (PITCH_MAX - p1) * RH + 1,
          width: (s1 - s0 + 1) * CW,
          height: (p1 - p0 + 1) * RH - 2,
        }}
      />
    )
  })()

  return (
    <div
      className={`${s.wrap} ${recMode ? s.rec : ''} ${playing ? s.playing : ''}`}
      ref={wrapRef}
    >
      <div className={s.scroller} ref={scrollerRef}>
        <div className={s.ruler} onPointerDown={onRulerDown}>
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
          <div className={s.phColumn} data-ph />
          <div className={s.cursorPin} data-cursor-pin />
        </div>
        <div className={s.lanes} ref={lanesRef} onContextMenu={onContextMenu}>
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
          {caretNode}
          {regionNode}
        </div>
      </div>
    </div>
  )
}
