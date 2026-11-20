# 8-BIT TRACKER · 概要设计

> Web 端 8bit 编曲工具(简化版库乐队):多音轨 + 步进音序器,全部声音由 WebAudio 实时合成,不使用任何音频素材文件。

## 1. 目标与范围

| 项 | 说明 |
| --- | --- |
| 音轨 | 4 条:Pulse Lead / Pulse Harmony / Triangle Bass / Noise Drums |
| 音序器 | 小节数可调(1–64 任意整数,工具栏 − / + 或直接键入,默认 2 小节 × 16 分音符 = 32 步);网格纵向为音高(25 行,MIDI 48–72 即 C3–C5),横向为步进 |
| 编辑 | 鼠标:点空格放置、点音符选中(黄框)、拖动移位/右缘改长、右键删除;键盘:方向键移光标、Z/Q 行写入、Backspace/Delete 删除选中;撤销/重做(Ctrl/Cmd+Z / Shift+Z 或 Ctrl+Y,工具栏按钮);播放列高亮实时跟随,播放头自动滚屏跟随 |
| 鼓轨 | 4 行鼓机(Kick / Snare / Hi-hat / Crash),点击开关,颜色区分鼓件 |
| 试奏 | 底部虚拟键盘 + tracker 电脑键位(Z 行白键、Q 行高八度、S/D/G/H/J 黑键) |
| 传输 | 播放/停止/循环(内置循环)、BPM 可调;每轨音量、静音、独奏 |
| 持久化 | 改动防抖 800ms 自动存 localStorage;工程 JSON 导出/导入 |
| 导出 | OfflineAudioContext 离线渲染整曲(循环 2 遍 + 尾音),16bit PCM WAV 下载 |
| 示例曲 | 内置 TETRIS A 主题《Korobeiniki》8 小节改编(公有领域民歌;旋律 + 和声 + Bass + 鼓),打开即有内容 |
| 移动端 | 单代码库响应式(≤1024px 轨道抽屉 / ≤640px 紧凑工具栏 + ⋯ 菜单);网格触控分级(滑动滚动、tap 放置、音符直接拖拽);虚拟键盘 WRITE 写入模式;100dvh + 安全区;PWA manifest 可安装主屏 |

## 2. 技术选型

- **React 19 + Vite 8 + TypeScript**(官方脚手架 `react-ts` 模板)
- **zustand v5**:轻量状态管理;store 订阅用于双向桥接音频引擎与持久化
- **手写 CSS(CSS Modules)+ 全局 token**:像素风完全自控,不引 UI 库
- **纯 WebAudio API**:无任何第三方音频库,无音频素材文件

## 3. 总体架构

三层结构,音频引擎与 React **完全解耦**(纯 TS 单例模块),React 只做视图与交互:

```
┌───────────────────────────── 视图层(React)─────────────────────────────┐
│  Toolbar   TrackPanel   Grid(网格/播放头)   Keyboard   Toast   Boot    │
│    │            │            │                    │                     │
│    └── 显式接口调用 ─────────┴────────────────────┘                     │
│         engine.play/stop/renderWav/previewOn(…) / useStore actions     │
└───────────────┬──────────────────────────────────┬──────────────────────┘
                │ store.subscribe(项目变更)         │ engine.onStepPlayed(当前步回调)
                ▼                                  ▼
┌──────── 状态层(zustand + 持久化)────────┐   ┌──── 播放头直通通道(绕过 React state)────┐
│  project / selected / playing / toast    │   │  Scheduler 视觉队列 → Grid 用 ref 直接   │
│  persistence: localStorage 防抖 800ms    │   │  切换单元格 class,零 re-render          │
└───────────────┬──────────────────────────┘   └──────────────────────────────────────────┘
                │ engine.syncProject(project)
                ▼
┌──────────────────── 音频引擎层(纯 TS 单例,无 React)────────────────────┐
│  engine.ts    单例编排:Context 生命周期 / 轨道增益 / 试奏 / 对外接口        │
│  scheduler.ts lookahead 步进调度器 + 视觉队列                                │
│  instruments.ts  音色合成:pulse×3 / triangle / noise 鼓组 / 母线            │
│  exporter.ts  OfflineAudioContext 离线渲染 + 16bit WAV 编码                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

关键约束的落实:

1. **AudioContext 不进 React 状态**:引擎为模块级单例,组件只调用显式接口。
2. **用户手势后创建/恢复 Context**:启动页(PRESS START)点击/回车触发 `engine.ensure()`;所有出声入口都先 `ensure()`。
3. **StrictMode 幂等**:`ensure()` 用 `initPromise` 去重;scheduler.start 可重入保护;store 订阅、播放头订阅均返回取消函数。
4. **实时与离线复用同一套调度逻辑**:`playVoice / playDrum(ctx, dest, …)` 对 `AudioContext` 与 `destination` 参数化,实时调度器与离线渲染都调用它们。
5. **播放列高亮高频更新不经过 React state**:调度器抛出当前步回调,Grid 用 ref 直切单元格 class。

## 4. 模块职责

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `src/audio/engine.ts` | 引擎单例:Context 创建/恢复、母线与轨道增益、项目同步、试奏、播放头分发、导出 | instruments / scheduler / exporter / model |
| `src/audio/scheduler.ts` | lookahead 步进调度(Worker 心跳 25ms / 120ms 前瞻,构造失败降级主线程定时器)+ rAF 视觉队列 | model |
| `src/audio/scheduler.worker.ts` | 调度心跳 Worker:后台标签页不被节流,postMessage('tick') 驱动主线程排程 | — |
| `src/audio/instruments.ts` | 音色合成:PeriodicWave 缓存、噪声缓冲、Voice 包络、鼓组、母线、混音计算 | model |
| `src/audio/exporter.ts` | 离线渲染(2 遍循环 + 尾音)与 WAV 编码 | instruments / model |
| `src/state/model.ts` | 数据模型 + 常量 + `sanitizeProject` 校验 | — |
| `src/state/store.ts` | zustand store(工程/选择/播放态/Toast + 移动端 UI 态)+ 编辑/撤销重做 action + 自动保存订阅 | model / engine / persistence |
| `src/state/persistence.ts` | localStorage 读写 | model |
| `src/song-demo.ts` | 内置示例曲与空工程 | model |
| `src/components/*` | Toolbar / TrackPanel / Grid / Keyboard / Toast / BootOverlay | store / engine |
| `src/lib/keys.ts`、`src/lib/download.ts` | tracker 键位表 / 通用下载 | — |

## 5. 数据模型

```ts
project = {
  bars: number,                   // 小节数 1–64(总步数 = bars × 16)
  bpm: number,                    // 40–240
  tracks: [                       // 固定 4 条
    { name, instrument, volume,   // instrument: 'pulse12'|'pulse25'|'pulse50'|'triangle'|'noise'
      muted, solo,
      notes: [{ step, pitch, len }] }   // step: 0..bars×16−1;pitch: MIDI 编号(鼓轨为鼓件编号 0=Kick 1=Snare 2=Hi-hat 3=Crash);len: 步数
  ]
}
```

- 网格音高范围统一为 **MIDI 48–72(C3–C5,25 行)**;Triangle Bass 音色带 `-12` 移调(写 C3 听 C2),符合"降八度做 bass"。
- 缩小小节数时丢弃范围外音符、钳制越界长度(`sanitizeProject` / `setBars` 同规则);旧存档无 `bars` 字段默认 2。
- 导出/导入 JSON:`{ app, version, savedAt, project }`,导入兼容包裹结构与裸 project,经 `sanitizeProject` 逐字段校验/钳制。

## 6. 关键流程

### 6.1 启动与音频初始化(autoplay 政策)

```
打开页面 → BootOverlay(PRESS START)
  └─ 点击/Enter → engine.ensure():创建 AudioContext → 母线 → 预热 PeriodicWave/噪声缓冲 → resume
  └─ 成功 → 揭开界面(此后任何出声入口仍幂等调用 ensure)
```

### 6.2 播放调度(实时)

```
store.playTransport → engine.play → scheduler.start
  └─ Worker 心跳 25ms(降级:主线程 setInterval):收到 'tick' → while (nextTime < now + 120ms) 按步调度
       ├─ onSchedule(step, time, stepDur):查音符索引 → playVoice/playDrum(ctx, trackGain[i], …)
       └─ 视觉队列 push {step, time}
  └─ rAF:time 到点后 → engine 分发当前步 → Grid(ref)切换列 class(并做播放头自动滚屏)
BPM 变更:stepDur 每步实时读取,下一拍立即生效
停止:停心跳 + cancelAndHold 快速收掉所有 voice + 分发 step=-1 清高亮
```

### 6.3 编辑

```
Grid 指针事件 → store action(不可变更新对应轨 notes)
  ├─ zustand → engine.syncProject(重建 step→notes 索引,实时生效)
  ├─ Row(memo)按音高行粒度重渲染(音高内音符数组引用不变则跳过)
  └─ store.subscribe → 防抖 800ms → localStorage
```

### 6.4 WAV 导出

```
Toolbar → engine.renderWav → renderProjectToWav(project):
  OfflineAudioContext(2ch, 44100Hz, 时长 = 2×循环 + 1.2s 尾音)
  重建与实时一致的母线与轨道增益(含 mute/solo)→ 逐音符 playVoice/playDrum(离线 ctx)
  → startRendering → encodeWav(16bit PCM 交错)→ Blob 下载
```

## 7. 目录结构

```
├── docs/                    设计文档
├── src/
│   ├── audio/               引擎与音色合成(纯 TS,无 React)
│   │   ├── engine.ts  scheduler.ts  scheduler.worker.ts  instruments.ts  exporter.ts
│   ├── state/               数据模型 + zustand store + localStorage 持久化
│   │   ├── model.ts  store.ts  persistence.ts
│   ├── components/          Toolbar / TrackPanel / Grid / Keyboard / Toast / BootOverlay
│   ├── hooks/               useEngineSync / useComputerKeys / useVisibilityResume
│   ├── lib/                 keys.ts(键位)/ download.ts
│   ├── song-demo.ts         内置示例曲
│   ├── App.tsx  main.tsx  index.css
├── index.html               Press Start 2P 字体、favicon
```

## 8. 视觉风格

- 深色底(`#0b0d10`)+ 荧光绿/青/品红/黄点缀;全局无圆角,`box-shadow` 无模糊硬投影
- 标题/数字用 Press Start 2P(Google Fonts),中文回退系统字体
- 网格:黑键行底色区分、八度分隔线(C 行)、4 步一拍分组、16 步小节强分隔
- 播放头列半透明荧光绿,正在发声的音符加亮;CRT 扫描线纹理 overlay(克制)
- 图标用字符(▶ ■ ±),不引图标库

## 9. 验收对照

| 验收项 | 实现点 |
| --- | --- |
| console 无报错 | 严格 TS + 生命周期清理(见详细设计 §9) |
| 节拍稳定不掉拍 | lookahead 调度器(audio 时钟),不受 rAF 抖动影响 |
| 播放列高亮正确移动 | 视觉队列按 audible time 分发,ref 直切 class |
| JSON 导出→导入 round-trip | `sanitizeProject` 幂等:合法数据原样往返 |
| WAV 可播放、非静音 | 与实时同一合成路径;标准 RIFF 头;导出后可解码验证 |
| tsc / build 通过 | 模板严格配置(verbatimModuleSyntax 等)全量适配 |
