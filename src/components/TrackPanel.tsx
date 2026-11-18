/**
 * 左侧轨道面板:选中、占空比音色切换(Pulse 轨)、音量、静音、独奏。
 */
import { INSTRUMENT_META, PULSE_IDS, type InstrumentId } from '../state/model'
import { useStore } from '../state/store'
import s from './trackpanel.module.css'

export const TRACK_COLORS = ['#3dff7c', '#39dcff', '#ff4fd8', '#ffd23f']
const DUTY_LABEL: Record<string, string> = {
  pulse12: '12.5%',
  pulse25: '25%',
  pulse50: '50%',
}

export function TrackPanel() {
  const tracks = useStore((st) => st.project.tracks)
  const selected = useStore((st) => st.selected)
  const select = useStore((st) => st.select)
  const setVolume = useStore((st) => st.setVolume)
  const toggleMute = useStore((st) => st.toggleMute)
  const toggleSolo = useStore((st) => st.toggleSolo)
  const setInstrument = useStore((st) => st.setInstrument)

  return (
    <aside className={s.panel}>
      <div className={s.title}>TRACKS</div>
      {tracks.map((t, i) => (
        <div
          key={i}
          className={`${s.track} ${i === selected ? s.sel : ''}`}
          onClick={() => select(i)}
        >
          <div className={s.head}>
            <span className={s.dot} style={{ background: TRACK_COLORS[i] }} />
            <span className={s.name}>{t.name}</span>
            <span className={s.inst}>{INSTRUMENT_META[t.instrument].label}</span>
          </div>

          {t.instrument !== 'triangle' && t.instrument !== 'noise' && (
            <div className={s.duty}>
              {PULSE_IDS.map((id: InstrumentId) => (
                <button
                  key={id}
                  className={`${s.dutyBtn} ${t.instrument === id ? s.dutyOn : ''}`}
                  onClick={(e) => {
                    e.stopPropagation() // 控件本身不触发选中
                    setInstrument(i, id)
                  }}
                >
                  {DUTY_LABEL[id]}
                </button>
              ))}
            </div>
          )}

          <div className={s.vol}>
            <span className={s.volLabel}>VOL</span>
            <input
              type="range"
              min={0}
              max={100}
              value={t.volume}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setVolume(i, Number(e.target.value))}
            />
            <span className={s.volVal}>{String(t.volume).padStart(3, '0')}</span>
          </div>

          <div className={s.switches}>
            <button
              className={`${s.sw} ${t.muted ? s.muteOn : ''}`}
              onClick={(e) => {
                e.stopPropagation() // 控件本身不触发选中
                toggleMute(i)
              }}
              title="静音"
            >
              M
            </button>
            <button
              className={`${s.sw} ${t.solo ? s.soloOn : ''}`}
              onClick={(e) => {
                e.stopPropagation() // 控件本身不触发选中
                toggleSolo(i)
              }}
              title="独奏"
            >
              S
            </button>
          </div>
        </div>
      ))}
      <div className={s.hint}>
        点击选中轨道 · M 静音 / S 独奏 · Pulse 轨可切换占空比音色
      </div>
    </aside>
  )
}
