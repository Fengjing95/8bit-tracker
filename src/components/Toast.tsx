/** 轻提示:2.6s 自动消失 */
import { useEffect } from 'react'
import { useStore } from '../state/store'
import s from './toast.module.css'

export function Toast() {
  const toast = useStore((st) => st.toast)
  const clearToast = useStore((st) => st.clearToast)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(clearToast, 2600)
    return () => clearTimeout(t)
  }, [toast, clearToast])

  if (!toast) return null
  return (
    <div key={toast.seq} className={`${s.toast} ${toast.kind === 'err' ? s.err : ''}`}>
      {toast.msg}
    </div>
  )
}
