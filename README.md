# 8-BIT TRACKER · WebAudio 芯片编曲器

Web 端 8bit 编曲工具(简化版库乐队):多音轨 + 步进音序器,全部声音由 WebAudio 实时合成(NES APU 风格),**不使用任何音频素材文件**。

## 运行

```bash
npm install
npm run dev        # 打开终端给出的地址(默认 http://localhost:5173)
```

构建与检查:

```bash
npm run build      # tsc -b && vite build
npx tsc --noEmit -p tsconfig.app.json
```

## 使用说明

1. 打开页面后点击 **▶ PRESS START**(创建/恢复 AudioContext,浏览器手势要求),内置示例曲已在工程中;
2. 点 **▶ PLAY** 播放(内置循环),播放列高亮实时跟随、**视口自动跟随播放头**(循环回绕自动滚回开头);**BPM 用 − / + 或直接键入(40–240,越界自动钳位)**,**BARS 用 − / + 步进或直接键入任意整数(1–64 小节,上限源于离线渲染内存)**,播放中改即时生效;
3. 左侧选择轨道,在网格上:**点空格放置 → 点音符选中(黄色实线框)→ 拖动移位 / 右缘改长 → Backspace / Delete 删除选中、右键快捷删除**;播放中也可以实时编辑;
4. **键盘高效输入**(tracker 键位):方向键移动黄色光标(Shift+左右 = ±4 步),`Z`–`I` 字符键在光标处写入音符并自动前进一格,`[` `]` 调整写入时值(鼠标放置共用),Backspace 删除;
5. **撤销 / 重做**:工具栏 **↶ UNDO / ↷ REDO** 按钮,或 `Ctrl/Cmd+Z`、`Ctrl/Cmd+Shift+Z`(重做也可 `Ctrl+Y`);任何编辑(音符、BPM、小节数、音量、导入工程、DEMO/NEW)都可逐步回退,上限 100 步;
6. 鼓轨显示为 4 行鼓机(Kick 红 / Snare 黄 / Hi-hat 青 / Crash 品红),点击开关;
7. 底部键盘或电脑键位单按试奏当前轨音色;
8. 每轨:**VOL** 音量、**M** 静音、**S** 独奏;Pulse 轨可切 12.5% / 25% / 50% 占空比;
9. **SAVE / LOAD JSON** 导出导入工程;**EXPORT WAV** 离线渲染整曲(循环 2 遍 + 尾音)下载 16bit PCM;
10. 任何改动防抖 800ms 自动保存到 localStorage,刷新页面自动恢复;**DEMO / NEW** 恢复示例曲 / 清空。

### 快捷键

| 键 | 作用 |
| --- | --- |
| `Z S X D C V G B H N J M ,` | 音轨:在光标处写入 C3 八度音符(S/D/G/H/J 黑键);单按也可试奏 |
| `Q 2 W 3 E R 5 T 6 Y 7 U I` | 写入 C4 八度(高八度) |
| `方向键` | 移动写入光标(Shift+左右 = ±4 步) |
| `[ / ]` | 调整写入时值(光标块宽度即时值) |
| `Backspace / Delete` | 删除光标处音符(即点选的音符);打字流中 Backspace 回退一格删除 |
| `Ctrl/Cmd + Z` | 撤销(输入框聚焦时不劫持,走文本撤销) |
| `Ctrl/Cmd + Shift + Z` 或 `Ctrl + Y` | 重做 |
| `ESC` | 取消选中;无选中时停止播放 |
| `Z / X / C / V`(鼓轨选中时) | 试奏 Kick / Snare / Hi-hat / Crash |
| `SPACE` | 播放 / 停止 |

## 架构

- `src/audio/` — 音频引擎(纯 TS 单例,与 React 完全解耦):`engine`(Context 生命周期/母线/试奏)、`scheduler` + `scheduler.worker`(lookahead 调度 + 视觉队列,心跳定时器跑在 Web Worker 里,后台标签页不掉拍;Worker 不可用时降级主线程定时器)、`instruments`(脉冲波 PeriodicWave、三角 bass、噪声鼓组)、`exporter`(OfflineAudioContext 渲染 + WAV 编码)
- `src/state/` — 数据模型 + zustand store + localStorage 持久化
- `src/components/` — Toolbar / TrackPanel / Grid / Keyboard / Toast / BootOverlay(CSS Modules 像素风)
- `src/song-demo.ts` — 内置示例曲:TETRIS A 主题《Korobeiniki》8 小节改编(公有领域民歌,非任天堂原版音频/谱面)

设计文档:[概要设计](docs/design-overview.md) · [详细设计](docs/design-detail.md)

## 已验证

- `tsc --noEmit` 与 `npm run build` 通过
- 浏览器实测:播放节拍稳定(120 BPM 下播放头 125ms/步)、列高亮正确移动、console 无报错
- 撤销/重做:音符写入/删除、BPM/小节数、DEMO/NEW、导入工程逐步回退与重做正确;按钮 disabled 态、输入框聚焦不劫持、undo 后播放内容与自动保存同步生效
- 播放头自动滚屏:8 小节播放视口持续跟随(右侧保持 4 格余量),循环回绕时 scrollLeft 归零滚回开头
- BPM 输入框:键入 768 钳到 240,清空不崩溃不误跳
- 调度心跳来自 Web Worker(页面加载 `scheduler.worker.ts` 独立 chunk,start/stop 消息协议实测);播放中面板遮挡 ≥10s,返回后播放头无大步跳跃、步进均匀连续
- 工程 JSON 导出→导入 round-trip 数据一致(sanitize 幂等,两轮验证)
- 导出 WAV 可解码、非静音(16bit/44.1kHz/双声道,峰值 0.7+)
- 鼓组 4 件(Kick / Snare / Hi-hat / Crash),小节数 1–64 任意整数(缩小自动丢弃范围外音符,旧存档兼容)

## 已知限制

- 后台播放依赖调度心跳 Worker;Worker 被环境禁用而降级为主线程定时器时,后台标签页仍会被节流掉拍(前台无差别);
- 小节数上限 64:WAV 导出需整曲一次性离线渲染,内存与文件体积随长度线性增长;
- 网格音高固定 C3–C5(Triangle Bass 写 C3 区、实际发音低八度 C2 区);
- 需要 Chrome / Edge / Firefox / Safari 等现代浏览器(支持 WebAudio、Pointer Events 与 Web Workers)。
