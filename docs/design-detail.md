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

### 2.6 调度器(`scheduler.ts` + `scheduler.worker.ts`,lookahead 模式)

```
scheduler.worker.ts(Worker 线程):setInterval 25ms → postMessage('tick')
scheduler.ts(主线程):收到 'tick' → while (nextTime < ctx.currentTime + 0.12)
    onSchedule(step, nextTime, stepDur)   // 排音频(仍在主线程 AudioContext 上)
    queue.push({step, time: nextTime})
    nextTime += getStepDur()              // BPM 每步实时读取
    step = (step+1) % getStepCount()      // 步数随小节数实时读取
requestAnimationFrame(主线程):queue 中 time ≤ now 的条目 → onVisual(step)  // 排 UI
```

- **心跳跑在 Web Worker 里**:后台标签页主线程定时器被节流至 ≥1s,Worker 线程不受节流 ⇒
  后台播放音频不断拍;协议 `start` / `stop` / `tick`,Worker 在 Scheduler 构造时以
  Vite 原生写法创建(`new Worker(new URL('./scheduler.worker.ts', import.meta.url), { type: 'module' })`),
  构建产物为独立 chunk;
- **降级路径**:Worker 构造失败(环境不支持/CSP)时回退主线程 `setInterval(25ms)`,
  对外 API(start/stop/playing)签名不变;
- 音频排程始终在主线程用 `ctx.currentTime`(audio 时钟),不依赖 rAF/定时器精度 ⇒ 稳定不掉拍;
  UI 高亮按 **audible time** 触发,听视同步;后台时视觉 rAF 暂停属预期,音频不受影响;
- BPM / 小节数都在调度循环内实时读取,播放中改动即时生效;
- `start` 可重入保护;`stop` 通知 Worker 停心跳(或清主线程定时器)、cancel rAF、清队列并
  `onVisual(-1)` 通知清场;Worker 实例与 App 同生命周期(单例),不 terminate;
- Worker 侧消息处理幂等(重复 `start` 不叠加定时器,`stop` 后心跳清空)。

### 2.7 引擎对外接口(`engine.ts` 单例)

```ts
ensure(): Promise<void>                  // 手势后创建/恢复,幂等
play(startStep?) / stop() / isPlaying()
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
| `past / future` | 撤销/重做栈:project 的 JSON 深拷贝快照,上限 100 条(超出丢最旧) |
| `selected / playing / toast` | 选中轨、传输态镜像、Toast(带 seq 触发) |
| `panelOpen / keyboardOpen / writeMode` | 移动端 UI 态:轨道抽屉开合、键盘收合、虚拟键盘写入模式(不持久化、不入历史,见 §9) |
| `caret / insertLen` | 键盘写入光标与写入时值(不入历史) |
| `region / clipboard` | 框选区域(原始两角 `{s0,s1,p0,p1}`,归一化在使用处)/ 剪贴板(相对坐标音符 + 宽度 w);均不入历史、不持久化(见 §5.5) |
| `setBpm / setBars / select / setVolume / toggleMute / toggleSolo / setInstrument` | 工程字段编辑;setBars 缩小时丢弃范围外音符并钳制长度、框选越界直接清除;select 切轨清除框选(剪贴板保留,供跨轨粘贴) |
| `addNote / removeNote / setNoteLen / toggleDrum / writeNote / setNotePos` | 网格编辑(len 钳制 1..bars×16−step;drum 为开关;writeNote 单音覆盖本步;setNotePos 被占/越界原地不动) |
| `setRegion / clearRegion / copySelection / cutSelection / pasteClipboard / deleteRegion` | 框选与剪贴板(详见 §5.5) |
| `loadProject / loadDemo / clearProject` | 导入、示例曲、清空 |
| `undo / redo` | undo 弹 `past` 恢复并把当前工程压入 `future`;redo 反向;恢复用快照新引用 ⇒ 引擎同步与自动保存自动生效 |
| `playTransport / stopTransport` | 调 engine 并镜像 playing;失败回滚并 Toast |

**历史快照规则**:除 `select / setCaret / setInsertLen / showToast` 等纯 UI 态外,所有会改
`project` 的 mutation 在变更前 `JSON.parse(JSON.stringify(project))` 快照压栈并清空 `future`;
内容实际未变的调用(如边界值钳位后相同、目标格被占、同音同值重写)不入栈,避免空撤销步。
`caret / insertLen` 不入历史。

### 4.2 引擎/持久化桥接

- `useEngineSync`:effect 内 `engine.syncProject(初始值)` + `store.subscribe`(project 引用变化才同步),清理函数退订 —— StrictMode 下仅存一份订阅;
- 自动保存:store 模块级订阅,`project !== prev.project` 时防抖 800ms 写 localStorage(key `8bit-tracker-project-v1`,try/catch 兜底);
- undo/redo 恢复的 project 是深拷贝快照(必然新引用)⇒ 引擎同步与自动保存走同一通道自动生效,无需额外处理;
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

### 5.2 统一列级光标(常驻)与播放头(绕过 React state)

**统一列级光标**:位置光标与播放头共用同一列元素(每行一个绝对定位 `[data-ph]`,
音高行/鼓行/标尺各一 + 标尺 `[data-cursor-pin]` 三角指针),`translateX` 平移替代逐格
class 切换,每步仅 ~29 次 style 写入,零 re-render。三态配色由 `.wrap` 上的
`rec` / `playing` class 驱动:待机黄色薄纱(停在光标步,**常驻**,默认第 1 小节起始)、
播放绿色(即播放头)、录制红色(跟随 REC 步进时钟)。

```
engine.onStepPlayed(step):        // 每步回调,直接操作 style/class,零 re-render
  step < 0(停止)              → 列/指针回弹到 caret.step;熄灭 .ring;lastStep = -1
  否则                          → move(step):全部 [data-ph] translateX(GUTTER + step×CW)
                                   (半透明底对齐单元格;::after 为居中 2px 竖线针线)
                                   指针 [data-cursor-pin] translateX(… + CW/2 − 6,对准单元格中心)
                                   [data-note] 区间命中(step ∈ [a, a+len))加 .ring
未播放时 caret.step 变化(标尺点击/方向键/REC 时钟):
  useStore.subscribe → 列与指针跟随(播放中忽略——列归播放头所有)
自动滚屏 follow(step)(播放回调与未播放光标移动共用——REC 时屏幕跟着光标走):
  回绕检测:上一跟随步 ≥ 0 且 step 变小 → scroller.scrollLeft = 0(循环回绕归零)
  右侧余量:x − scrollLeft > clientWidth − 4×CW − GUTTER
           → scroller.scrollLeft = x − clientWidth + 4×CW + GUTTER(每步直接赋值,无动画)
  停止(engine step<0)回弹光标步时不调 follow——视图停留在停止瞬间,不干预用户滚动
```

- 标尺三角指针(`.cursorPin`,库乐队风格 ▼)对准单元格中心,待机黄 / 录制红;
- 音高行选中实线框(见 §5.3)独立于列光标:列指示步进/传输位置,
  行光标指示写入音高与选中;鼓轨无行光标(位置由红色列指示);
- 播放中点击标尺仅改写 caret(预定位),列归播放头所有不受干扰;停止后回弹 caret 步;
- 自动滚屏只在播放回调里触发:非播放状态完全不干预用户滚动;`scrollLeft` 直接赋值,
  回绕(步号从大值跳 0)时立即滚回开头;后台标签 rAF 暂停时回调不触发,视觉冻结属预期;
- 上一可听步在回调闭包内局部变量记录(不入 React 状态/ref),effect 清理时随闭包销毁。

### 5.3 指针交互状态机(pitched,选中模型)

```
pointerdown 空格              → addNote(len = insertLen)→ 选中该音符(mouse/pen 即刻;touch 见下;
                                放置前先清除框选)
Shift + 空白 pointerdown      → 框选拖拽(不放置,见 §5.5)
pointerdown 音符              → 选中(不删除,先清除框选):光标吸附到音符,实线黄框包裹
  ├ 右缘 10px 拖动            → resize:横向改时值
  └ 其余区域拖动              → move:移位(步进 + 音高),选中跟随(setNotePos 返回实际落点)
pointerup                     → 无删除语义(防误操作)
contextmenu                   → preventDefault;命中音符则删除(显式快捷删除)
Esc(键盘)                   → 先清框选;再取消选中;均无时停止播放
```

触控分级(`pointerType`):mouse/pen 保持上表不变;touch 时空格/鼓格不再 pointerdown
立即放置,转入 tap 待定态,抬起按 位移<8px 且 <600ms 判定后放置/开关,滑动由
`touch-action: pan-x pan-y` 交给浏览器滚动(pointercancel 作废待定 tap);音符块
`touch-action: none` 保留直接拖拽,多指只跟踪起始 pointerId(详见 §9.2)。

选中由行级实线框承载:光标落在音符上 = 选中态(实线框包住整音符,Backspace 删除目标);
落在空格时不绘制任何行级框 —— 位置由统一列级光标指示(推进时无多余方框)。
命中计算基于常量几何(rect + CW/GUTTER/RH);move 用 lanes 容器几何而非 DOM 命中,并以"当前位置"为源持续更新(否则首格之后源查找落空)。

### 5.4 键盘编辑(tracker 键位,`lib/keys.ts` 按 `e.code` 布局无关)

| 键 | 音 | 键 | 音 |
| --- | --- | --- | --- |
| Z S X D C V G B H N J M , | C3…C4(含 S/D/G/H/J 黑键) | Q 2 W 3 E R 5 T 6 Y 7 U I | C4…C5(高八度) |

- 底部虚拟键盘与键位一一对应(白键标字母,C 键标音名);
- Space = 播放/停止,Esc = 停止,鼓轨下 Z/X/C/V 试奏 Kick/Snare/Hi-hat/Crash(REC 录制模式改为写入光标当前步,只加不删,见 §9.3);
- **键盘写入**:方向键移动网格光标(Shift+左右 ±4 步;**点击标尺任意步**亦可移动光标),Z/Q 行字符键在光标步写入对应音高并前进一格(`writeNote` 单音覆盖本步;REC 模式 1 步起录、按住持续发声,松手按持按步数定稿,光标由步进时钟推进),`[` `]` 调整写入时值(鼠标放置共用此时值);移动音高与写入均有 160ms 短促试听;
- **播放互斥**:播放中锁定一切音符编辑——网格手势(放置/拖动/改长/开关鼓件/右键删除)、字符键写入、Backspace/Delete、剪切与粘贴均无效(字符键/鼓键退化为纯试听),EDIT 菜单 CUT / PASTE 置灰;PLAY 从光标步开始播放(`engine.play(startStep)`);
- **删除语义**:Backspace/Delete = 框选存在时批量删除框内全部音符(一条历史);否则 Backspace = 光标处有音符(点击选中态)→ 删除之,否则回退一格删除(打字流"打错即退即重打"),Delete = 删除光标处音符(先精确 (step,pitch),否则本步任意音高并把光标对齐过去)。Esc = 先清框选,再取消选中,均无时停止播放;
- `e.repeat` 忽略;输入控件聚焦时不劫持;窗口失焦统一 `releaseAllPreviews`(安全停 4s 兜底)。

### 5.5 框选与剪贴板(region / clipboard)

**框选(region)**:store 存原始两角 `{s0,s1,p0,p1}`(拖拽中任一角可为起点),归一化在使用处;
仅音轨支持(切到鼓轨即清,鼓行 Shift 点击/拖拽为空操作)。渲染为 `.lanes` 内绝对定位覆盖层:
品红 `#ff4fd8` 2px 虚线框 + 8% 填充,`pointer-events:none`,几何由常量计算
(`left = GUTTER + min(s0,s1)·CW`、`top = (PITCH_MAX − max(p0,p1))·RH + 1`、
`width = (|s1−s0|+1)·CW`、`height = (|p1−p0|+1)·RH − 2`)。

```
Shift + 空白 pointerdown     → 进入 region 拖拽(pointermove 经 lanes 几何换算实时 setRegion;与
                               非 Shift 放置/音符拖动/右缘改长互斥:框选仅在 Shift+空白起点激活)
pointerup                    → 提交;起止同格(位移 <1 格)视为清除
清除时机                     → 点击空白(非 Shift)/ 点击或拖动音符 / 切轨 / setBars 缩小后越界 /
                               Esc(优先级:先清框选,再清 caret 选中,最后停播放)
```

**剪贴板(clipboard)**:`{ notes: [{dStep, dPitch, len}], w }`,均为不入历史的 UI 态。

- **copy**:有框选 → 收集当前轨落在框内(以音符起点格 (step,pitch) 判定)的音符,转相对
  框左下角(最小 step、最小 pitch)的偏移;无框选 → 复制整轨,w = 全轨步数。整轨剪贴板的
  dPitch 取相对**轨内内容最低音**的偏移(虚拟框左下角 = (0, 最低音)),使粘贴公式
  `pitch = caret.pitch + dPitch` 与框选剪贴板同构 —— 若按绝对音高存储,anchor.pitch(≥48)
  基准下所有音符必然越界被跳过。鼓轨复制/剪切为空操作(Toast 提示,本期不支持)。
- **cut** = copy + 删除框内全部音符(一条历史);**无框选时 cut 为空操作**。
- **paste**:锚点 = 当前 caret(无 caret 先设 `{0,60}`),粘贴到**当前选中轨**(跨轨复制
  melody → harmony 是明确用例)。逐音符:`step = anchor.step + dStep`、`pitch = anchor.pitch + dPitch`;
  pitch 越界 [PITCH_MIN,PITCH_MAX] 跳过、step ≥ 步数丢弃、len 钳到轨尾;与现有音符同格
  (step,pitch) 则替换(长度取新值),其余共存(不清除目标轨同步骤的其他音高)。一次粘贴
  = 一条历史(空粘贴不产生空历史条目)。粘贴后清框选,caret 移到
  `{step: min(anchor.step + w, 步数−1), pitch: anchor.pitch}` —— 连续 Ctrl+V 依次后移 w 步铺段落。
- **批量删除**:框选存在时 Backspace/Delete = 删除框内全部音符 + 清框选(一条历史);
  无框选保持原语义(§5.4)不变。Shift 框选之外的任何放置(鼠标/触控/键盘写入)均先清框选。

编辑操作在顶栏 **EDIT▾** 菜单(UNDO/REDO/COPY/CUT/PASTE,右侧对齐快捷键提示,Mac 显示
CMD 系;enabled 随框选/剪贴板/当前轨上下文:鼓轨全禁用、CUT 需框选、播放中 CUT/PASTE
置灰、无框选且轨内无音符时 COPY 禁用);快捷键
Ctrl/Cmd+C / X / V(输入控件聚焦时不劫持)。

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

### 6.1 顶栏 OS 菜单栏(Toolbar)

仿老式 tracker / 经典 Mac 菜单条:`品牌 │ FILE▾ EDIT▾ │ ▶ PLAY ● REC │ BPM −120+ │ BARS −2+`。

- **FILE▾**:EXPORT WAV(渲染中显示 RENDER… 并置灰)/ SAVE JSON / LOAD JSON / ─── / DEMO / NEW;
- **EDIT▾**:UNDO / REDO / ─── / COPY / CUT / PASTE,条目右侧对齐快捷键提示(`CTRL+Z` /
  `CMD+Z`,按 `navigator.platform` 判定);无可用操作置灰(无历史 / 鼓轨 / 无框选 / 播放中);
- 菜单交互:点击展开 → 展开时悬停另一菜单名即切换(`pointerenter`)→ 点击空白(外点
  pointerdown)或 Esc 收起;Esc 用 `window` **捕获段**监听,先于 `useComputerKeys`
  消费,避免顺手停播放;
- ▶ PLAY / ● REC 并排常驻按钮组(播放中 ▶→■ STOP 红、录制中 REC 品红实底);
  BPM / BARS 保持 − 输入 + 步进;
- ⋯ 折叠按钮退役:编辑/文件操作均入菜单,移动端无折叠需求(≤640px 仅收紧尺寸与标题缩写);
- 下拉面板:像素双线边框 + 硬投影,条目悬停黑底白字反色(快捷键提示转灰白)。

## 7. 资源清理与工程约束

- 播放中的 voice 注册于 `Set<VoiceHandle>`,`stop()` 时统一快速释放;`osc.onended` 移除注册并断开 gain;
- 试奏句柄按 key 存 `Map`,keyup/失焦释放;
- 订阅类(effect、store)一律返回退订;定时器/rAF 在 stop/unmount 清除;调度心跳 Worker 与 App 同生命周期(模块单例),`stop` 仅停心跳不清线程,降级路径下由主线程 `setInterval` 承担并在 `stop` 清除;
- `import type` 全量适配 `verbatimModuleSyntax`;不使用 enum/参数属性(`erasableSyntaxOnly`)。

## 8. 已知限制

- 后台播放依赖调度心跳 Worker:Worker 不可用降级为主线程定时器时,后台标签页仍会被节流掉拍(前台无差别);
- 页面被浏览器冻结/丢弃(长时间后台且无声音)时播放仍会暂停,属浏览器行为;
- 网格音高固定 C3–C5(Bass 实际发音 C2–C4);
- Safari 使用 `webkitAudioContext/OfflineAudioContext` 前缀兼容,`cancelAndHoldAtTime` 有降级路径。

## 9. 移动端适配(响应式 + 触控 + PWA)

单代码库 CSS 断点响应式,无"移动版页面"。断点:**≥1025px 现状 / ≤1024px 平板 / ≤640px 手机**。

### 9.1 布局响应式

| 断点 | 变化 |
| --- | --- |
| ≤1024px | TrackPanel 固定侧栏 → **抽屉**(默认收起):`position:fixed` 左侧 `min(300px, 86vw)`,`translateX(-104%)` 收起 / `.open` 滑出,半透明背板点击关闭;Toolbar 出现 ☰ 像素按钮切换(store `panelOpen`);Grid 占满剩余宽度 |
| ≤640px | Toolbar 为 OS 菜单栏紧凑单行:标题缩写 `8BIT`(两 span 断点切换)、FILE/EDIT 菜单、▶/■、● REC、BPM/BARS 输入框、☰;`BPM/BARS` 文字标签、LOOP 徽标隐藏,菜单名/按钮/输入框尺寸再收一档,375px 宽验证单行,320px 优雅两行 |
| 全部 | 键盘区 **收起/展开按钮**(store `keyboardOpen`,默认展开):收起仅留标题行,给网格让出高度;≤640px 琴键容器 `overflow-x:auto`(黑键 left 是按 34px 网格内联定位的 JS 常量,不改键宽;白键 `flex: 0 0 34px` 禁 flex 收缩,否则白键被压窄而黑键不动 → 错位)、鼓垫 2×2 换行 |

视口与安全区:`.app` 高度 `100vh`,`@supports (height: 100dvh)` 升级为 `100dvh`(iOS 动态地址栏);
Toolbar/Keyboard 内边距用 `max(原值, env(safe-area-inset-*))`;全局 `html { -webkit-tap-highlight-color: transparent; touch-action: manipulation }`(像素风自绘反馈,禁双击缩放)。

### 9.2 网格触控手势分级(Grid.tsx)

- **mouse/pen**:完全保持 §5.3 现状(pointerdown 立即放置/启动拖拽);
- **touch 空格/鼓格**:pointerdown 只记录待定 tap `{pointerId, rowEl, x0, y0, t0}`,不放置;
  行容器 `touch-action: pan-x pan-y` ⇒ 单指滑动 = 浏览器滚动网格,滚动接管触发
  `pointercancel` 作废待定 tap;抬起按 **位移 <8px 且时长 <600ms** 判定为 tap 才
  放置(pitched:`addNote` + caret 吸附;鼓行:`toggleDrum`);
- **touch 音符块/右缘把手**:保持 pointerdown 直接启动 move/resize 拖拽(音符块
  `touch-action: none` 不被滚动打断);DragState/TapState 记录 `pointerId`,
  move/up/cancel 全部按 id 过滤 ⇒ **多指只跟踪第一根**,拖拽会话期间其余手指的
  空格 tap 请求被忽略;
- tap 判定监听为 Grid effect 内常驻 window `pointerup/pointercancel`(无待定 tap
  立即返回),effect 清理退订,StrictMode 安全。

### 9.3 虚拟键盘双模式:编辑 / 录制 REC(移动端 tracker 录制流)

- 键盘标题行右侧 **● REC toggle**(store `recMode`,不持久化),与播放**互斥**
  (开启录制先停播放;开播即退出录制),双模式:
  - **编辑(默认)**:点琴键/鼓垫纯试奏(按住发声),音符用鼠标在网格上操作;
  - **录制(REC)**:进入先**倒数 1 小节**(列光标停在起始步闪烁 `.countin`,每拍一枚
    hi-hat click 计数,倒数中敲键只试听不写入),倒数结束从光标步开始录制——步进光标
    按 BPM **自动前进**(16 分音符步长,`60/BPM/4` 秒),点琴键 / 鼓垫 / 电脑 Z·Q 行(音)
    与 Z/X/C/V(鼓)写入**光标当前步**,不手动前进;音符 **1 步起录、按住持续发声,
    松手按持按步数定稿时值**(中间延长 `setNoteLen(…, push=false)` 不入撤销历史,
    定稿一次性入账;短按 = 16 分音符);鼓**无同鼓件才写入**(只加不删)+
    `previewDrum` 试奏;写入各自入撤销历史;
- 步进时钟(`hooks/useStepRecorder`,挂载于 App,启动后生效)两相位:
  - **倒数**(`recCountin = true`):60ms 轮询计步,`idx % 4 === 0` 发 click,
    计满 1 小节(16 步)置 `recCountin = false`;
  - **录制**(`recCountin = false`):本地相位时钟 —— `t0` 使「倒数结束时刻」对应
    `caret.step`,每 60ms 轮询 `floor((now − t0)/stepDur) % stepCount` 推步
    (不累积定时器漂移);caret 为空先设 `{step:0, pitch:60}`;BPM / 小节数变化
    重建时钟并从当前 step 续相位;
- 光标自由控制:**点击标尺任意步移动光标**(不放置音符),方向键微调;
  光标视觉:列光标红色(`.rec .phColumn`/`.cursorPin`),倒数时列与指针闪烁
  (`.countin`,动画作用于针线与指针,不再闪烁行级方框);音轨选中实线框在录制态同样转红;
  鼓轨仅在 REC 显示步进光标(纵跨 4 鼓件行的红框)——编辑模式鼓轨无光标;
- 开启时琴键/鼓垫品红描边、REC 按钮品红实底;键盘区另有收合按钮(§9.1)。

### 9.4 音频生命周期与 PWA

- **`useVisibilityResume`**:监听 `visibilitychange`,回到 visible 且 `playing` 时
  幂等调用 `engine.ensure()`(iOS 切后台可能挂起 AudioContext;调度心跳在 Worker
  内持续,恢复后音频接续,无需重启传输);挂载于 App,effect 清理退订;
- **PWA**:`viewport-fit=cover` + `theme-color` + `manifest.webmanifest`
  (name/short_name、`display: standalone`、theme/background `#0b0d10`、图标
  favicon.svg + icon-192.png + icon-512.png[purpose 含 maskable],无 Service Worker、
  不强制离线缓存);iOS 另有 `apple-mobile-web-app-*` meta 与 apple-touch-icon。
