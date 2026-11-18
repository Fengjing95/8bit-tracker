/**
 * Tracker 试奏键位(按 e.code,与键盘布局无关):
 * Z 行 = C3 八度白键(S/D/G/H/J 为黑键),Q 行 = 高八度,恰好覆盖网格 C3–C5。
 */
export const KEYMAP: Record<string, number> = {
  // Z 行:C3 八度
  KeyZ: 48, // C3
  KeyS: 49, // C#3
  KeyX: 50, // D3
  KeyD: 51, // D#3
  KeyC: 52, // E3
  KeyV: 53, // F3
  KeyG: 54, // F#3
  KeyB: 55, // G3
  KeyH: 56, // G#3
  KeyN: 57, // A3
  KeyJ: 58, // A#3
  KeyM: 59, // B3
  Comma: 60, // C4
  // Q 行:C4 八度
  KeyQ: 60, // C4
  Digit2: 61, // C#4
  KeyW: 62, // D4
  Digit3: 63, // D#4
  KeyE: 64, // E4
  KeyR: 65, // F4
  Digit5: 66, // F#4
  KeyT: 67, // G4
  Digit6: 68, // G#4
  KeyY: 69, // A4
  Digit7: 70, // A#4
  KeyU: 71, // B4
  KeyI: 72, // C5
}

/** 鼓轨试奏键:Z/X/C/V → Kick/Snare/Hi-hat/Crash */
export const DRUM_KEYS: Record<string, 0 | 1 | 2 | 3> = {
  KeyZ: 0,
  KeyX: 1,
  KeyC: 2,
  KeyV: 3,
}
