# 8-BIT TRACKER · 详细设计

> 上游文档:[design-overview.md](./design-overview.md)。本文覆盖音频合成、调度、渲染导出、状态与持久化、交互与样式的全部实现细节。

## 1. 数据模型与校验(`src/state/model.ts`)

### 1.1 常量

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `BAR_STEPS` | 16 | 每小节步数(16 分音符,用于小节分隔线) |
| `MAX_BARS` | 64 | 小节数上限(权衡网格 DOM、离线渲染内存与 WAV 体积),1–64 任意整数 |
| `DEFAULT_BARS` | 2 | 默认 2 小节(32 步) |
| `PITCH_MIN / PITCH_MAX` | 48 / 72 | C3–C5,网格 25 行 |
| `DEFAULT_NOTE_LEN` | 2 | 新音符默认长度(8 分音符) |
| `STEP_GATE` | 0.95 | 音符门限长度 = len × stepDur × 0.95 |
| `TRACK_DEFS` | 4 条 | 默认轨名/乐器/音量 |

`INSTRUMENT_META`:

| id | label | duty | transpose |
| --- | --- | --- | --- |
| `pulse12` | PULSE 12.5% | 0.125 | — |
| `pulse25` | PULSE 25% | 0.25 | — |
| `pulse50` | PULSE 50% | 0.5(走原生 square) | — |
| `triangle` | TRIANGLE | — | **-12**(降八度做 bass) |
| `noise` | NOISE | — | —(pitch 即鼓件 0/1/2/3) |

### 1.2 `sanitizeProject(raw): Project`

导入/读档统一入口,幂等(合法输入 round-trip 原样):

- 兼容 `{ app, version, project }` 包裹与裸 project;
- `bpm` 四舍五入钳制 40–240;`bars` 钳制 1–64(缺省 2);轨道补齐/裁到 `TRACK_DEFS` 4 条;
- `instrument` 白名单,`volume` 钳制 0–100,`muted/solo` 严格布尔;
- `notes`:step ∈ [0, bars×16−1](范围外丢弃)、pitch 按乐器有效域(鼓 0–3,其余 48–72)、len ∈ [1, bars×16−step],按 `step:pitch` 去重;
- 任一 gross 错误(非对象 / 无 tracks)抛错,由调用方转为 Toast。

## 2. 音频引擎(`src/audio/`)

### 2.1 Context 生命周期与幂等

```
ensure(): ctx 存在 → suspended 则 resume;否则 initPromise ??= init()
init(): new AudioContext({latencyHint:'interactive'})
        → buildMasterChain → 4 条轨道 GainNode + previewGain(0.55)
        → 预热 getPulseWave(0.125/0.25) 与 getNoiseBuffer
```

- `initPromise` 去重 ⇒ StrictMode 双调用只创建一个 Context;
- 所有出声入口(`play/previewOn/previewDrum`)都先 `ensure()`,键盘 keydown 属于用户激活手势。

### 2.2 母线(`instruments.buildMasterChain`)

```
trackGain ×4 ─┐
previewGain ──┼→ master Gain(0.85) → DynamicsCompressor → destination
              │   threshold −14dB / knee 4 / ratio 10 / attack 3ms / release 200ms(防爆音)
```

混音计算(实时与离线共用):`volumeToGain(v) = v^1.5`(0–1);有效静音 = `muted || (anySolo && !solo)`。

### 2.3 脉冲波 PeriodicWave(12.5% / 25%)

占空比 d 的双极性脉冲傅里叶级数(n ≥ 1):

```
a_n(cos 系数) = 2·sin(2πdn) / (nπ)
b_n(sin 系数) = 2·(1 − cos(2πdn)) / (nπ)
```

校验:d=0.5 时 a_n=0、b_n(odd)=4/(nπ),正是标准方波级数。实现取 N=64 次谐波,`createPeriodicWave(real, imag)`(默认归一化),按 `WeakMap<BaseAudioContext, Map<duty, PeriodicWave>>` 缓存复用;50% 直接用原生 `osc.type='square'`。

### 2.4 Voice 与包络(`startVoice` / `playVoice`)

```
osc(周期波/三角波) → voiceGain → dest(trackGain)
attack:  setValueAtTime(0.0001, t) → exponentialRamp(peak, t+4ms)   近瞬时,8bit 硬朗
sustain: exponentialRamp(peak×0.6, t+dur)                            全程自然衰减
release: exponentialRamp(0.0008, t+dur+60ms);osc.stop(t+dur+90ms)
```

- `peak`:脉冲 0.28,三角 0.5;频率 `440 × 2^((midi+transpose−69)/12)`;
- `VoiceHandle.stop(at, release)`:提前释放(键盘抬起/停止播放)用 `cancelAndHoldAtTime`(无则 `cancelScheduledValues + setValueAtTime(当前值)`),再 ramp 到 0.0008,避免"尾事件复活";
- `playVoice(ctx, dest, inst, midi, t, dur, registry?)`:实时调度传 registry(停止播放时统一收尾,`osc.onended` 自清理),离线渲染不传 —— **同一函数参数化 AudioContext/destination**。

### 2.5 鼓组(`playDrum`,噪声缓冲按 WeakMap 按 ctx 缓存)

| 鼓件 | 合成 |
| --- | --- |
| Kick | 方波 120Hz →40Hz exponential pitch-drop(120ms),gain 1.0 → 0.001(240ms) |
| Snare | 白噪声(高通 700Hz)gain 0.5→0.001(160ms)+ 190Hz 方波短音 0.4→0.001(80ms);噪声随机起点避免完全一致 |
| Hi-hat | 白噪声 → 高通 7kHz,gain 0.3 → 0.001(50ms)极短衰减 |
| Crash | 白噪声(高通 4.5kHz)gain 0.45→0.001(900ms)长衰减 + 4 个非谐波方波(205.3/304.4/369.6/522.7Hz,TR-808 钹电路思路)经高通 4kHz 做金属质感(0.15→0.001,550ms) |

### 2.6 调度器(`scheduler.ts`,lookahead 模式)

```
setInterval 25ms:while (nextTime < ctx.currentTime + 0.12)
    onSchedule(step, nextTime, stepDur)   // 排音频
    queue.push({step, time: nextTime})
    nextTime += getStepDur()              // BPM 每步实时读取
    step = (step+1) % getStepCount()      // 步数随小节数实时读取
requestAnimationFrame:queue 中 time ≤ now 的条目 → onVisual(step)  // 排 UI
```

- 调度用 audio 时钟,不依赖 rAF/定时器精度 ⇒ 稳定不掉拍;UI 高亮按 **audible time** 触发,听视同步;
- BPM / 小节数都在调度循环内实时读取,播放中改动即时生效;
- `start` 可重入保护;`stop` 清定时器/rAF/队列并 `onVisual(-1)` 通知清场;
- 已知限制:后台标签 setInterval 被节流至 ≥1s,长前瞻音频会出现间隙(设计如此,建议前台使用)。

### 2.7 引擎对外接口(`engine.ts` 单例)

```ts
ensure(): Promise<void>                  // 手势后创建/恢复,幂等
play() / stop() / isPlaying()
onStepPlayed(cb): () => void             // 当前步回调(−1=清场)
syncProject(p)                           // store → 引擎:重建 step→notes 索引 + 应用混音
previewOn(key, trackIdx, midi) / previewOff(key) / releaseAllPreviews()
previewDrum(kind)                        // 试奏走 previewGain,不随轨道静音
renderWav(): Promise<Blob>               // 委托 exporter,使用当前已同步工程
```

调度步回调:`scheduleStep` 逐轨查 `index[track].get(step)`,噪声轨 `playDrum(pitch)`,其余 `playVoice(len×stepDur×0.95)`;静音轨靠 trackGain=0 消音(调度照常,语义与离线一致)。

## 3. 离线渲染与 WAV(`exporter.ts`)

- `OfflineAudioContext(2ch, ⌈sr×时长⌉, 44100)`,时长 = 2 × (bars×16×stepDur) + 1.2s 尾音;
- `buildMasterChain(off)` + 按轨 GainNode(含 mute/solo/volumeToGain),逐循环逐音符调用同一 `playVoice/playDrum`;
- `encodeWav`:44 字节 RIFF 头(RIFF/WAVE/fmt(PCM=1, ch, sr, byteRate, blockAlign, bits=16)/data),float 采样钳制 [-1,1] 交错编码 int16(负值 ×0x8000、正值 ×0x7FFF),单声道复制为双声道。

## 4. 状态管理与持久化(`src/state/`)

### 4.1 store 切片

| 字段/动作 | 说明 |
| --- | --- |
| `project` | 工程(唯一数据源,不可变更新) |
| `selected / playing / toast` | 选中轨、传输态镜像、Toast(带 seq 触发) |
| `setBpm / setBars / select / setVolume / toggleMute / toggleSolo / setInstrument` | 工程字段编辑;setBars 缩小时丢弃范围外音符并钳制长度 |
| `addNote / removeNote / setNoteLen / toggleDrum` | 网格编辑(len 钳制 1..bars×16−step;drum 为开关) |
| `loadProject / loadDemo / clearProject` | 导入、示例曲、清空 |
| `playTransport / stopTransport` | 调 engine 并镜像 playing;失败回滚并 Toast |

### 4.2 引擎/持久化桥接

- `useEngineSync`:effect 内 `engine.syncProject(初始值)` + `store.subscribe`(project 引用变化才同步),清理函数退订 —— StrictMode 下仅存一份订阅;
- 自动保存:store 模块级订阅,`project !== prev.project` 时防抖 800ms 写 localStorage(key `8bit-tracker-project-v1`,try/catch 兜底);
- 启动初值:`loadStoredProject() ?? createDemoProject()`。

## 5. 网格渲染与交互(`components/Grid.tsx`)

### 5.1 渲染策略

- 布局常量(JS 单一来源,与 CSS 渐变周期对齐):`CW=30px`、`GUTTER=52px`、行高 22(鼓行 30);
- **底格不逐格出 DOM**:拍点亮色(每 4 格 = 120px 周期)、小节分隔线(每 16 格 = 480px 周期)与底色由行内 `repeating-linear-gradient` 绘制(`.stripes`),小节数 1–64 任意可调时行 DOM 是常量,标尺刻度(`16×bars` 个)是唯一的线性增长项;
- **播放头覆盖列**:每行一个 `[data-ph]` 绝对定位色条,`engine.onStepPlayed` 回调里直接 `translateX(GUTTER + step×CW)` 平移(每步约 29 次 style 写入),替代旧的逐格 class 切换;
- **键盘写入光标**:store 持有 `caret {step,pitch}` 与 `insertLen`,Grid 渲染单个绝对定位 ghost 块(`.caret`,低频更新走 React state);
- `PitchRow = memo`:以 **音高行** 为粒度;`useNotesByPitch` 在 notes 变化时按行重建,但**行内数组内容不变则保留旧引用**(音符对象不可变)⇒ 改动一个音符只重渲染所在行;
- 音符块为行内绝对定位元素(`left = GUTTER + step×CW`,`width = len×CW`),`data-step/data-len/data-pitch` 供交互、删除与发声加亮(`.ring`)使用;鼓行复用同一音符块结构(宽 1 格,按鼓件着色);
- 鼓轨 `DrumRow`:4 行(Kick 红 / Snare 黄 / Hi-hat 青 / Crash 品红),单元格按 `(step, kind)` 开关,颜色区分鼓件。

### 5.2 播放头(绕过 React state)

```
engine.onStepPlayed(step):
  wrap.querySelectorAll(`[data-step="${prev}"]`) → 移除 .ph
  wrap.querySelectorAll(`[data-step="${step}"]`) → 加 .ph(含标尺)
  wrap.querySelectorAll('[data-note]')           → 区间命中者加 .ring(正在发声更亮)
```

每步仅 ~几十次 classList 操作,无 re-render。

### 5.3 指针交互状态机(pitched,选中模型)

```
pointerdown 空格              → addNote(len = insertLen)→ 选中该音符
pointerdown 音符              → 选中(不删除):光标吸附到音符,实线黄框包裹
  ├ 右缘 10px 拖动            → resize:横向改时值
  └ 其余区域拖动              → move:移位(步进 + 音高),选中跟随(setNotePos 返回实际落点)
pointerup                     → 无删除语义(防误操作)
contextmenu                   → preventDefault;命中音符则删除(显式快捷删除)
Esc(键盘)                   → 先取消选中;无选中时停止播放
```

选中与插入统一由光标承载:落在音符上为选中态(实线框),落在空格为插入态(虚线 ghost,宽度 = insertLen)。
命中计算基于常量几何(rect + CW/GUTTER/RH);move 用 lanes 容器几何而非 DOM 命中,并以"当前位置"为源持续更新(否则首格之后源查找落空)。

### 5.4 键盘编辑(tracker 键位,`lib/keys.ts` 按 `e.code` 布局无关)

| 键 | 音 | 键 | 音 |
| --- | --- | --- | --- |
| Z S X D C V G B H N J M , | C3…C4(含 S/D/G/H/J 黑键) | Q 2 W 3 E R 5 T 6 Y 7 U I | C4…C5(高八度) |

- 底部虚拟键盘与键位一一对应(白键标字母,C 键标音名);
- Space = 播放/停止,Esc = 停止,鼓轨下 Z/X/C/V 试奏 Kick/Snare/Hi-hat/Crash;
- **键盘写入**:方向键移动网格光标(Shift+左右 ±4 步),Z/Q 行字符键在光标步写入对应音高并前进一格(`writeNote` 单音覆盖本步),`[` `]` 调整写入时值(鼠标放置共用此时值);移动音高与写入均有 160ms 短促试听;
- **删除语义**:Backspace = 光标处有音符(点击选中态)→ 删除之;否则回退一格删除(打字流"打错即退即重打")。Delete = 删除光标处音符(先精确 (step,pitch),否则本步任意音高并把光标对齐过去)。Esc = 取消选中,再按停止播放;
- `e.repeat` 忽略;输入控件聚焦时不劫持;窗口失焦统一 `releaseAllPreviews`(安全停 4s 兜底)。

## 6. UI 样式规格

| Token | 值 | 用途 |
| --- | --- | --- |
| `--bg / --panel / --panel2 / --line` | `#0b0d10 / #141920 / #1a2029 / #2c3542` | 底/面板/分隔 |
| `--green / --cyan / --magenta / --yellow / --red` | `#3dff7c / #39dcff / #ff4fd8 / #ffd23f / #ff5c5c` | Lead/和声/Bass/标尺与鼓件 |
| 字体 | `'Press Start 2P', ui-monospace` | 标题/数字/按钮;中文回退系统字体 |
| 投影 | `box-shadow: 3px 3px 0 #000`(无模糊) | 硬像素立体 |
| 圆角 | 0 | 全局 |
| 扫描线 | `body::after` fixed overlay,repeating-gradient 1px/3px | CRT 质感,克制 |

布局:`100vh` 三段(Toolbar / TrackPanel+Grid / Keyboard);Grid 内部滚动(标尺 sticky-top、行标签 sticky-left);BootOverlay 全屏启动页(闪烁 PRESS START,兼作 autoplay 手势)。

## 7. 资源清理与工程约束

- 播放中的 voice 注册于 `Set<VoiceHandle>`,`stop()` 时统一快速释放;`osc.onended` 移除注册并断开 gain;
- 试奏句柄按 key 存 `Map`,keyup/失焦释放;
- 订阅类(effect、store)一律返回退订;定时器/rAF 在 stop/unmount 清除;
- `import type` 全量适配 `verbatimModuleSyntax`;不使用 enum/参数属性(`erasableSyntaxOnly`)。

## 8. 已知限制

- 后台标签页音频调度受浏览器节流影响(前台使用无问题);
- 网格音高固定 C3–C5(Bass 实际发音 C2–C4);
- Safari 使用 `webkitAudioContext/OfflineAudioContext` 前缀兼容,`cancelAndHoldAtTime` 有降级路径。
