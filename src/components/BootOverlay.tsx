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
          <li>点格子放音符 · 横向拖拽改长度 · 再点 / 右键删除</li>
          <li>Z/Q 行键盘试奏 · SPACE 播放 · 改动自动保存</li>
        </ul>
      </div>
    </div>
  )
}
