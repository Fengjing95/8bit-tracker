/**
 * 离线渲染与 WAV 导出:与实时播放复用同一套 playVoice / playDrum / 母线,
 * 仅将 (AudioContext, destination) 参数化为 OfflineAudioContext。
 * 详见 docs/design-detail.md §3。
 */
import { STEP_GATE, stepCountOf, type Project } from '../state/model'
import {
  buildMasterChain,
  effectiveMutes,
  playDrum,
  playVoice,
  volumeToGain,
} from './instruments'

export interface RenderOptions {
  /** 循环遍数,默认 2 */
  loops?: number
  /** 尾音余量秒数,默认 1.2 */
  tailSec?: number
  sampleRate?: number
}

export async function renderProjectToWav(
  project: Project,
  opts: RenderOptions = {},
): Promise<Blob> {
  const loops = opts.loops ?? 2
  const tailSec = opts.tailSec ?? 1.2
  const sr = opts.sampleRate ?? 44100

  const stepDur = 60 / project.bpm / 4
  const loopDur = stepDur * stepCountOf(project.bars)
  const totalSec = loopDur * loops + tailSec

  const OfflineCtor =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext
  if (!OfflineCtor) throw new Error('当前浏览器不支持 OfflineAudioContext')

  const ctx = new OfflineCtor(2, Math.ceil(totalSec * sr), sr)
  const { input } = buildMasterChain(ctx)

  const mutes = effectiveMutes(project.tracks)
  const trackGains = project.tracks.map((t, i) => {
    const g = ctx.createGain()
    g.gain.value = mutes[i] ? 0 : volumeToGain(t.volume / 100)
    g.connect(input)
    return g
  })

  for (let loop = 0; loop < loops; loop++) {
    const base = loop * loopDur
    for (let i = 0; i < project.tracks.length; i++) {
      const track = project.tracks[i]
      for (const note of track.notes) {
        const t = base + note.step * stepDur
        if (track.instrument === 'noise') {
          playDrum(ctx, trackGains[i], note.pitch, t)
        } else {
          playVoice(
            ctx,
            trackGains[i],
            track.instrument,
            note.pitch,
            t,
            Math.max(0.05, note.len * stepDur * STEP_GATE),
          )
        }
      }
    }
  }

  const buffer = await ctx.startRendering()
  return encodeWav(buffer)
}

/** AudioBuffer → 16bit PCM WAV(标准 44 字节 RIFF 头,交错双声道) */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels)
  const frames = buffer.length
  const dataBytes = frames * channels * 2
  const ab = new ArrayBuffer(44 + dataBytes)
  const dv = new DataView(ab)

  const wstr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i))
  }
  wstr(0, 'RIFF')
  dv.setUint32(4, 36 + dataBytes, true)
  wstr(8, 'WAVE')
  wstr(12, 'fmt ')
  dv.setUint32(16, 16, true) // PCM chunk 大小
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, channels, true)
  dv.setUint32(24, buffer.sampleRate, true)
  dv.setUint32(28, buffer.sampleRate * channels * 2, true) // byte rate
  dv.setUint16(32, channels * 2, true) // block align
  dv.setUint16(34, 16, true) // bits per sample
  wstr(36, 'data')
  dv.setUint32(40, dataBytes, true)

  const ch0 = buffer.getChannelData(0)
  const ch1 = channels > 1 ? buffer.getChannelData(1) : ch0
  let off = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.min(1, Math.max(-1, (c === 0 ? ch0 : ch1)[i]))
      dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      off += 2
    }
  }
  return new Blob([ab], { type: 'audio/wav' })
}
