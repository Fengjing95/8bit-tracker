/**
 * 启动页:点击/回车即初始化 AudioContext(满足浏览器 autoplay 政策),
 * 同时兼作像素风开机画面。
 */
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react'
import s from './boot.module.css'

interface Props {
  onBoot: () => void
}

export function BootOverlay({ onBoot }: Props) {
  const onClick = (e: ReactMouseEvent): void => {
    e.preventDefault()
    onBoot()
  }
  const onKey = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onBoot()
    }
  }
  return (
    <div className={s.overlay} role="button" tabIndex={0} onClick={onClick} onKeyDown={onKey}>
      <div className={s.box}>
        <div className={s.logo}>8-BIT TRACKER</div>
        <div className={s.sub}>WEB AUDIO CHIP SEQUENCER</div>
        <div className={s.start}>▶ PRESS START ◀</div>
        <ul className={s.help}>
          <li>4 轨芯片音源:Pulse ×2 / Triangle Bass / Noise Drums</li>
          <li>点空格放置 · 点音符选中 · 拖动移位 / 右缘改长 · 右键删除</li>
          <li>方向键移光标 · Z/Q 行写入 · Backspace 删除选中 · SPACE 播放</li>
        </ul>
      </div>
    </div>
  )
}
