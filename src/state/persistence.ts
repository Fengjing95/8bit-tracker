/**
 * localStorage 持久化:保存(防抖由 store 订阅侧控制)与读取。
 * 读取一律过 sanitizeProject,坏档静默回退 null(回落到示例曲)。
 */
import { sanitizeProject, type Project } from './model'

const LS_KEY = '8bit-tracker-project-v1'

interface StoredFile {
  app: string
  version: number
  savedAt: number
  project: Project
}

export function saveProject(p: Project): boolean {
  try {
    const file: StoredFile = {
      app: '8bit-tracker',
      version: 1,
      savedAt: Date.now(),
      project: p,
    }
    localStorage.setItem(LS_KEY, JSON.stringify(file))
    return true
  } catch {
    return false // 隐私模式 / 配额满等情况,静默失败不打断使用
  }
}

export function loadStoredProject(): Project | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    return sanitizeProject(JSON.parse(raw))
  } catch {
    return null
  }
}
