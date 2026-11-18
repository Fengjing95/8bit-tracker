/**
 * 内置示例曲:TETRIS A 主题 ——《Korobeiniki(货郎)》。
 * 旋律为 19 世纪俄罗斯民歌,已进入公有领域;本文件是自写的 8bit 改编谱,
 * 8 小节(128 步)@ 149 BPM,经典掌机 Tetris 的 A 段。
 *
 * 音域适配:网格写音范围 C3–C5(48–72)。
 * - Lead(pulse25)写在 A3–A4 区,即原曲主旋律低八度;
 * - Bass(triangle)自带 -12 移调,写在 C3–A3 区、实际发音 C2–A2 区;
 * - Harmony(pulse50)为和弦内音反拍短促音;Drums 为轻量节拍 + 循环下拍 Crash。
 */
import type { Note, Project } from './state/model'
import { DEFAULT_BARS, TRACK_DEFS } from './state/model'

type NoteTuple = [step: number, pitch: number, len: number]

const toNotes = (rows: NoteTuple[]): Note[] =>
  rows.map(([step, pitch, len]) => ({ step, pitch, len }))

// ── Lead:主旋律(pulse25,原曲低八度;每小节 16 步,4 步 = 1 拍) ──
const LEAD: NoteTuple[] = [
  // m1 Am: E4 B3 C4 | D4 C4 B3
  [0, 64, 4], [4, 59, 2], [6, 60, 2], [8, 62, 4], [12, 60, 2], [14, 59, 2],
  // m2 Am: A3 A3 C4 | E4 D4 C4
  [16, 57, 4], [20, 57, 2], [22, 60, 2], [24, 64, 4], [28, 62, 2], [30, 60, 2],
  // m3 E: B3· C4 | D4 E4
  [32, 59, 6], [38, 60, 2], [40, 62, 4], [44, 64, 4],
  // m4 Am: C4 A3 A3——
  [48, 60, 4], [52, 57, 4], [56, 57, 8],
  // m5 Dm: D4· F4 | A4 G4 F4
  [64, 62, 6], [70, 65, 2], [72, 69, 4], [76, 67, 2], [78, 65, 2],
  // m6 Am: E4· C4 | E4 D4 C4
  [80, 64, 6], [86, 60, 2], [88, 64, 4], [92, 62, 2], [94, 60, 2],
  // m7 E: B3 B3 C4 | D4 E4
  [96, 59, 4], [100, 59, 2], [102, 60, 2], [104, 62, 4], [108, 64, 4],
  // m8 Am: C4 A3 A3——
  [112, 60, 4], [116, 57, 4], [120, 57, 8],
]

// ── Harmony:和弦内音反拍短促(pulse50;Am=C4+E4 / E=G#3+B3 / Dm=D4+F4) ──
const HARMONY_CHORDS: number[][] = [
  [60, 64], [60, 64], [56, 59], [60, 64],
  [62, 65], [60, 64], [56, 59], [60, 64],
]
const HARMONY: NoteTuple[] = []
HARMONY_CHORDS.forEach((chord, bar) => {
  for (const off of [4, 12]) {
    for (const p of chord) HARMONY.push([bar * 16 + off, p, 3])
  }
})

// ── Bass:根音-五音八分律动(triangle;写 C3 区,发音低八度) ─────
// [根音, 五音]:Am=A3/E3  E=G#3/E3  Dm=D3/A3
const BASS_ROOTS: Array<[number, number]> = [
  [57, 52], [57, 52], [56, 52], [57, 52],
  [50, 57], [57, 52], [56, 52], [57, 52],
]
const BASS: NoteTuple[] = []
BASS_ROOTS.forEach(([root, fifth], bar) => {
  for (let i = 0; i < 4; i++) {
    BASS.push([bar * 16 + i * 4, root, 2])
    BASS.push([bar * 16 + i * 4 + 2, fifth, 2])
  }
})

// ── Drums:Kick 1/3 拍 + Snare 2/4 拍 + Hi-hat 八分 + 下拍 Crash ──
const DRUMS: NoteTuple[] = []
for (let bar = 0; bar < 8; bar++) {
  const b = bar * 16
  DRUMS.push([b, 0, 1], [b + 8, 0, 1])
  DRUMS.push([b + 4, 1, 1], [b + 12, 1, 1])
  for (let i = 0; i < 16; i += 2) DRUMS.push([b + i, 2, 1])
}
DRUMS.push([0, 3, 1]) // 循环下拍 Crash

export function createDemoProject(): Project {
  const notes = [LEAD, HARMONY, BASS, DRUMS].map(toNotes)
  const volumes = [75, 30, 85, 60]
  return {
    bars: 8,
    bpm: 149,
    tracks: TRACK_DEFS.map((def, i) => ({
      name: def.name,
      instrument: def.instrument,
      volume: volumes[i],
      muted: false,
      solo: false,
      notes: notes[i],
    })),
  }
}

export function createEmptyProject(): Project {
  return {
    bars: DEFAULT_BARS,
    bpm: 120,
    tracks: TRACK_DEFS.map((def) => ({
      name: def.name,
      instrument: def.instrument,
      volume: def.volume,
      muted: false,
      solo: false,
      notes: [],
    })),
  }
}
