# CLAUDE.md

> 给 Claude Code / AI 助手的项目说明文件
> 详细需求请参考 [Spec.md](./Spec.md)

## 一、项目简介

**peiyuan（英语听力练习）** 是一个跨平台桌面英语听力练习程序，基于 **Tauri 2.0 + React 18 + TypeScript + Tailwind CSS + shadcn/ui**。

完整模拟 19 道英语听说考试题：
- **第 1-14 题**：听后选择（短对话 / 长对话 / 独白）
- **第 15-19 题**：听后转述（挖空填空 + 口头转述录音）

所有题目内容由本地/自建的 OpenAI 兼容 LLM 实时生成，语音由 TTS 实时合成，第 19 题用户录音经 STT 转写后由 LLM 判分。

**所有 Prompt 模板与判分规则均可在设置界面编辑，无需修改代码。**

---

## 二、技术栈

### 2.1 前端

| 技术 | 版本 | 用途 |
|------|------|------|
| Tauri | 2.x | 桌面运行时（含 protocol-asset feature） |
| React | 18 | UI 框架 |
| TypeScript | 5.6+ | strict 模式 |
| Vite | 5 | 构建工具 |
| Tailwind CSS | 3.4 | 样式 |
| shadcn/ui | 最新 | UI 组件（手动引入源码） |
| Zustand | 5 | 状态管理 |
| React Router | 6 | 路由 |
| @tauri-apps/api | 2 | 与 Rust 后端通信 |

### 2.2 后端 Rust

| 技术 | 版本 | 用途 |
|------|------|------|
| Rust | 2021 ≥ 1.75 | 系统语言 |
| tokio | 1（full | 异步运行时 |
| reqwest | 0.12 | HTTP 客户端（含 stream + multipart + rustls-tls） |
| eventsource-stream | 0.2 | SSE 流式响应解析 |
| cpal | 0.15 | 跨平台麦克风采集 |
| rodio | 0.19 | 跨平台音频播放 |
| hound | 3.5 | WAV 编码/解码 |
| serde / serde_json | 1 | 序列化 |
| tracing | 0.1 | 日志门面 |
| tracing-subscriber | 0.3 | 日志格式化 + EnvFilter |
| tracing-appender | 0.2 | 按天滚动日志文件（详见 §4.4.13） |
| dirs | 5 | 跨平台路径解析（应用数据目录） |
| chrono | 0.4 | 时间戳（评分 prompt 用） |
| once_cell | 1 | 懒加载静态变量 |
| base64 | 0.22 | 音频内嵌备用编码 |
| futures | 0.3 | StreamExt（SSE 流解析） |
| uuid | 1（v4 | 会话标识 |
| thiserror / anyhow | - | 错误处理 |
| adaptive_difficulty | workspace path `src-tauri/adaptive_difficulty` | 自适应难度算法 crate（纯函数 + 内部状态机，详见 §4.4.8） |

### 2.3 数据存储

- 配置文件：`{app_data_dir}/config.json`
- 测试缓存：`{app_data_dir}/cache/{session_uuid}/`
  - 题目内容、生成的音频片段
  - `recording.wav` — Q19 用户录音（落盘前下采样到 mono 16kHz PCM，详见 §4.4.10）
- 设备测试录音：`{app_data_dir}/device-tests/` （由 `commands/device.rs::test_input_device` 按需创建）
- 日志：`{app_data_dir}/logs/peiyuan.log.YYYY-MM-DD` — 按天滚动，详见 §4.4.13

平台路径（应用 identifier 为 `com.peiyuan.desktop`，与 `tauri.conf.json:5` 一致）：
- Windows: `%APPDATA%\com.peiyuan.desktop\`
- macOS: `~/Library/Application Support/com.peiyuan.desktop/`
- Linux: `~/.local/share/com.peiyuan.desktop/`

---

## 三、目录结构

```
peiyuan/
├── src/                              # 前端 React + TS
│   ├── components/
│   │   ├── ui/                       # shadcn/ui 基础组件（button, card, input, tabs, ...）+ ConfirmDialog
│   │   ├── settings/                 # ModelConfigForm / PromptEditor / MicTest / KeyboardTest / AudioSettingsPanel / LlmParamsPanel / TimingPanel / IntroPanel（5 段开场介绍文案，v1.2+ 见 §4.4.15）/ DifficultyPanel（含自适应开关 / 重置 / 只读读数，v1.1+ 见 §4.4.8）
│   │   ├── test/                     # GlobalHeader / PhaseCountdown / QuestionDisplay / FillBlankTable / RecorderPanel
│   │   ├── ErrorBoundary.tsx
│   │   └── Toast.tsx
│   ├── pages/                         # MainMenu / Settings / Test / Result
│   ├── store/                         # Zustand: settings / test / testFlow / result / confirm / adaptive（v1.1+：mode 镜像 + state 只读快照，详见 §4.4.8）
│   ├── hooks/                         # useTimerEvent / useAudioPlayer / useRecorder / useGenerationProgress / useTestFlowEvents
│   ├── types/                         # TypeScript 类型（与 Rust models/ 对齐）
│   ├── lib/                           # tauri invoke 封装 + utils
│   ├── App.tsx                        # 路由根
│   └── main.tsx                       # React 入口
│
├── src-tauri/                         # 后端 Rust
│   ├── src/
│   │   ├── commands/                  # Tauri commands
│   │   │   ├── app_close.rs           # 关窗拦截：confirm_close_app / cancel_close_app（Rust 驱动，见 §4.4.14）
│   │   │   ├── config.rs              # get_config / save_config / reset_config / restore_default_prompt / restore_default_timing / restore_default_intro(_all) / open_config_dir
│   │   │   ├── llm.rs                 # test_llm_connection / generate_with_llm
│   │   │   ├── tts.rs                 # test_tts_connection
│   │   │   ├── stt.rs                 # test_stt_connection / transcribe_audio
│   │   │   ├── audio.rs               # play_audio_file / play_audio_background（切歌由 skip_to_next 通过 AudioPlaybackState.active_stop_flag 实现）
│   │   │   ├── recorder.rs            # start_recording / stop_recording / get_audio_level
│   │   │   ├── device.rs              # list_input/output_devices / test_input/output_device
│   │   │   ├── test_session.rs        # generate_test_session / get_test_session / clear_test_session
│   │   │   ├── test_flow.rs           # start_test_flow / submit_answer / get_flow_state / get_answer_set / reset_test_flow / skip_to_next / notify_recording_completed
│   │   │   ├── scoring.rs             # score_full_test（末尾触发 adaptive::update，见 §4.4.8）
│   │   │   └── adaptive.rs            # get_adaptive_state / reset_adaptive_state / set_adaptive_mode（v1.1+，详见 §4.4.8）
│   │   ├── services/                  # 内部服务层（与 commands 一一对应或多个合并）
│   │   │   ├── http_client.rs
│   │   │   ├── llm_service.rs         # 流式 LLM + SSE 拼接
│   │   │   ├── tts_service.rs         # 多 voice 拼接
│   │   │   ├── stt_service.rs
│   │   │   ├── audio_pipeline.rs      # 音频生成流水线
│   │   │   ├── audio_player.rs        # rodio 后端播放
│   │   │   ├── prompt_engine_service.rs # 占位符替换
│   │   │   ├── question_generator.rs  # LLM 出题
│   │   │   ├── recorder.rs            # cpal 录音（worker 线程 + 共享 Arc；支持 downmix_to_mono + linear_resample，见 §4.4.10）
│   │   │   ├── scoring.rs             # 1-14 本地 / 15-18 LLM JSON 每空评分（见 §4.4.12） / 19 STT+LLM；末尾触发 adaptive::update
│   │   │   ├── adaptive.rs            # adaptive_difficulty crate 包装 + AdaptiveState 持久化（v1.1+，详见 §4.4.8）
│   │   │   ├── test_flow.rs           # 状态机编排
│   │   │   ├── test_session.rs        # 测试会话生成
│   │   │   ├── timer.rs               # 精确计时 + 事件推送
│   │   │   └── tts_service.rs
│   │   ├── models/                    # 数据结构
│   │   │   ├── config.rs              # AppConfig / ModelConfig / LlmParams / PromptConfig / AudioConfig / TimingConfig（见 §4.4.8）/ IntroConfig（见 §4.4.15）
│   │   │   ├── question.rs            # ShortDialogue / LongDialogue / Monologue / RetellMaterial / TestSession
│   │   │   └── result.rs              # McqResult / BlankResult / RetellResult / TestResult / AdaptiveSummary（v1.1+，详见 §4.4.8）
│   │   ├── utils/
│   │   │   ├── json_extract.rs       # 剥离 ```json 围栏 + 容错解析
│   │   │   ├── path.rs                # 应用数据目录
│   │   │   ├── prompt_engine.rs       # {{KEY}} 占位符替换
│   │   │   ├── retry.rs               # 指数退避重试
│   │   │   └── wav.rs                 # wav 读写 / 拼接 / 静音生成
│   │   ├── lib.rs                     # Tauri Builder（注册 commands 与 State）
│   │   └── main.rs                    # 主入口
│   ├── prompts/                       # 默认 Prompt 模板（编译期 include_str! 嵌入）
│   │   ├── q1_4.txt
│   │   ├── q5_14.txt
│   │   ├── q15_18.txt
│   │   ├── q15_18_scoring.txt
│   │   └── q19_scoring.txt
│   ├── adaptive_difficulty/       # workspace member：自适应算法 crate（v1.1+，详见 §4.4.8）
│   │   ├── Cargo.toml
│   │   ├── src/{lib,state,level,params,hysteresis,algorithm,trace,error}.rs
│   │   └── README.md / INTEGRATION.md
│   ├── Cargo.toml                 # workspace manifest，members = [".", "adaptive_difficulty"]（v1.1+）
│   ├── tauri.conf.json                # 含 assetProtocol.scope: ["**"]
│   ├── capabilities/default.json
│   └── build.rs
│
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
├── postcss.config.js
├── components.json
├── Spec.md                            # 详细需求规格
├── CLAUDE.md                          # 本文件
└── README.md                          # 启动 / 跨平台打包指南
```

---

## 四、核心架构约定

### 4.1 前后端数据流

- **命令式调用**：前端通过 `invoke('command_name', args)` 主动调用后端命令
- **事件式通知**：后端通过 `app.emit('event_name', payload)` 主动推送，前端 `listen` 订阅
- **共享类型**：TS 类型在 `src/types/`，Rust 类型在 `src-tauri/src/models/`，字段一一对应

### 4.2 后端状态管理（Tauri State）

| 状态 | 类型 | 生命周期 | 用途 |
|------|------|----------|------|
| `ConfigState` | `RwLock<AppConfig>` | 整个 App | 内存中的配置缓存 |
| `SessionState` | `Mutex<Option<TestSession>>` | 整个 App | 当前测试会话 |
| `FlowGlobal` | 含 `FlowStateContainer` | 整个 App | 1-19 题流程运行时状态 |
| `RecorderGlobal` | 含 `Arc<RecorderState>` | 整个 App | 录音状态（worker 线程） |
| `AudioPlaybackState` | 含 `Arc<Mutex<bool>>` | 整个 App | 音频播放状态标记 |
| `AudioPlaybackState.active_stop_flag` | `Mutex<Option<Arc<AtomicBool>>>` | 整个 App | `skip_to_next` 中断当前 rodio 播放（§4.4.9） |
| `CloseGuardState` | `prompt_pending: AtomicBool` | 整个 App | 关窗拦截运行时状态：确认框是否已弹出。逃生阀：弹着时再点 X 直接放行（详见 §4.4.14） |
| `FlowStateInner.skip_requested` | `Arc<AtomicBool>` | 单次 run_* | 「下一题」信号位，interruptible_sleep 轮询 |
| `FlowStateInner.recording_completed` | `Arc<AtomicBool>` | 单次 run_* | 「提前结束录音」信号位，interruptible_sleep 轮询 |
| `FlowStateInner.group_membership` | `HashMap<u32, u32>` | 单次 run_* | 内部：题号 → 组号（用于 5-12 题共享 ANSWERING 时段） |
| `AdaptiveState` | `RwLock<adaptive_difficulty::AdaptiveState>` | 整个 App | 自适应难度运行时状态（ability_score / trend / current_level / update_count），启动时从 `adaptive_state.json` 加载，详见 §4.4.8 |
| `AdaptiveMode` | `RwLock<AdaptiveMode>`（`Auto` / `Manual`，默认 `Manual`） | 整个 App | 自适应开关（持久化到 `config.json::difficulty.mode`） |

### 4.3 后端事件命名

| 事件名 | Payload | 触发时机 |
|--------|---------|----------|
| `test-generation-progress` | `{stage, message, progress}` | 题目预生成各阶段 |
| `test-timer-tick` | `{phase, elapsedMs, durationMs, remainingMs, progress}` | 每 100ms |
| `test-phase-finished` | `phase` | 阶段倒计时结束 |
| `test-flow-state` | `FlowState`（含 `play_count: Option<u32>`，15-19 题 PLAYING 时取 1/2/3；含 `intro_text: Option<String>`，仅 5 个 INTRO 阶段为 Some，见 §4.4.15） | 阶段切换 |
| `test-flow-finished` | `{ok, completed?, error?}` | 1-19 题全部完成 |
| `test-audio-play` | `{path, loop}` | 通知前端播放（实际播放由后端 rodio 完成）。**两次 PLAYING 之间的静音间隔会以 `{ path: null }` 发射一次**，前端需据此重置进度 |
| `test-record-start` | `{durationMs}` | 进入 19 题录音阶段 |
| `test-record-stop` | - | 录音结束 |
| `adaptive-level-changed` | `{from: String, to: String, ability: f64, trend: f64, update_count: u64}` | **每次成功的非 retest 自适应更新后**发射（不论档位是否翻转），前端用于设置界面（DifficultyPanel）同步刷新 ability / trend / update_count。**判断档位是否真正翻转**应通过 `score_full_test` 返回的 `TestResult.adaptive.level_before/level_after`，不要依赖事件名 |
| `adaptive-state-reset` | `{new_level: String, ability: f64, trend: f64}` | 用户点击「重置自适应状态」后发射 |
| `test-score-progress` | `{stage, message}`（`stage ∈ {"mcq","blanks","retell","done"}`） | **已定义但当前未发射**（详见 §六） |
| `app-close-requested` | `{reason: "generating" \| "testing"}` | 用户点 X，Rust 判定有进行中的任务（生成中 / 答题中），`prevent_close` 后 emit。前端 `CloseGuard` 据此弹应用内确认框。<br>**⚠️ 绝不能监听 `tauri://close-requested`** —— Tauri 一旦发现该事件有 JS 监听就无条件 `prevent_close`（详见 §4.4.14） |

### 4.4 关键设计决策

#### 4.4.1 后端驱动计时
所有倒计时由 Rust `tokio::time::Instant` 驱动，每 100ms emit `test-timer-tick` 事件。前端订阅事件渲染进度条，避免 `setTimeout` 在 webview 失焦时漂移。

#### 4.4.2 后端驱动音频播放
测试阶段音频由后端 **rodio** 播放，而非前端 HTML5 audio。原因：
- 避免 WebKitGTK / Chromium webview 的 autoplay 限制
- 避免 asset protocol 跨平台兼容问题
- 跨平台一致

#### 4.4.3 cpal::Stream 非 Send/Sync 的处理
cpal::Stream 标记为 `!Send + !Sync`，无法在 Tauri State 中直接保存。解决方案：
- `RecorderState` 仅保存 Send + Sync 字段（Sender、共享 Arc<Mutex<Vec<f32>>>）
- 独立 worker 线程通过 `mpsc::channel` 接收命令，持有实际的 cpal::Stream

#### 4.4.4 LLM 流式响应拼接
- reqwest `bytes_stream()` + `eventsource-stream` 解析 SSE
- 拼接 `choices[0].delta.content` 得到完整文本
- 用 `utils::json_extract::try_parse` 剥离 ```json 围栏后解析

#### 4.4.5 JSON 解析容错
- `try_parse(text)` 自动剥离 ```json 围栏与首尾杂文
- 解析失败 → `retry_async` 重试（最多 2-3 次）
- 重试全部失败 → 返回错误给前端，用户可手动重试

#### 4.4.6 配置向后兼容
新增字段（如 `protocol`）使用 `#[serde(default = "default_xxx")]`，旧配置文件自动回退默认值。

#### 4.4.7 UTF-8 字符串安全截断
日志/预览中涉及字符串截断时，必须按字符而非字节切割（避免多字节字符中间 panic）。
- 前端使用 `src/lib/utils.ts::truncate(s, max)`。
- 后端日志直接打印完整字符串，不再做截断（日志已落盘，原 `truncate_chars` 工具已删除）。

#### 4.4.8 自适应难度集成（v1.1+）

- **算法 crate**：`src-tauri/adaptive_difficulty/`，零运行时依赖（仅 `serde` / `serde_json` / `thiserror`），纯函数 `update` + 内部 `AdaptiveState`
- **Cargo 接入**：`src-tauri/Cargo.toml` 升级为 workspace 根，`[workspace] members = [".", "adaptive_difficulty"]`；主 crate 加 `adaptive_difficulty = { path = "adaptive_difficulty" }`
- **输入分数规整**：在 `services/scoring.rs::score_full_test` 末尾，把 `TestResult` 转换为 `(a, b, c)` 三元组：
  - `a = correct_count_1_to_14 as f64 / 14.0`
  - `b = blanks_total_score as f64 / 6.0`
  - `c = q19_score as f64 / 10.0`
  - 三者均 `clamp` 到 `[0, 1]` 后再传入 crate
- **调用顺序**（伪代码）：
  ```rust
  let a = correct_1_14 as f64 / 14.0;
  let b = blanks_score as f64 / 6.0;
  let c = q19_score as f64 / 10.0;

  let mut guard = adaptive_state.write().await;            // RwLock
  let trace = adaptive_difficulty::update(&mut guard, a, b, c)?;
  drop(guard);

  persist_adaptive_state(&app, &guard)?;                   // tempfile + rename 原子写
  // 每次成功更新都发射事件（不论档位是否翻转），让前端 store 同步最新
  // ability / trend / update_count，避免设置界面显示陈旧值。
  app.emit("adaptive-level-changed", AdaptiveLevelChangedPayload::from(&trace))?;
  result.adaptive = Some(AdaptiveSummary::from(&trace));   // 加到 TestResult
  Ok(result)
  ```
- **下一次出题读取**：`commands/test_session.rs::generate_test_session` 在注入 `{{DIFFICULTY_DEMAND_*}}` 时调用 `effective_level()`：
  ```rust
  fn effective_level(state: &AdaptiveState, mode: &AdaptiveMode, manual: &str) -> String {
      match mode {
          AdaptiveMode::Auto   => state.current_level.as_str().to_string(),
          AdaptiveMode::Manual => manual.to_string(),
      }
  }
  ```
- **UI 互斥**（重点）：`DifficultyPanel` 中「自动切换难度」开关与手动档下拉框是 mutually exclusive：
  - 开关 ON → 下拉框 `disabled`（greyed out），提示「已启用自动档」
  - 开关 OFF → 下拉框 `enabled`，可手动切档
  - 切换瞬间不重置 AdaptiveState；用户切回 Auto 时继续使用上次计算结果
- **容错**：`AdaptiveError` → `Result<TestResult, AppError>`，前端弹 toast「自适应更新失败」；state 不被错误路径修改；下一次测试仍使用旧档位
- **持久化**：
  - 运行时态：`{app_data_dir}/adaptive_state.json`，结构 `{ "ability_score": f64, "trend": f64, "current_level": String, "update_count": u64 }`，使用 `tempfile + rename` 原子写
  - 配置项：`config.json::difficulty.mode = "auto" | "manual"`（默认 `"manual"`），与现有 `DifficultyConfig` 同级，`#[serde(default)]` 回退
- **启动加载**：`lib.rs` Builder `setup` 中读 `adaptive_state.json` → `validate_loaded`；校验失败 → `reset_to(JuniorHigh)`；同时把 state 注入 Tauri State
- **重置按钮**：`commands/adaptive.rs::reset_adaptive_state` 调用 `adaptive_svc::hard_reset_to(&mut state, level)`
  （等价于 `adaptive_difficulty::reset_to` + 额外把 `update_count` 归零），其中 `level` 来源：
  - 若当前 mode = Manual → 使用 `config.difficulty.level`（手动档值）
  - 若当前 mode = Auto   → 强制 `JuniorHigh`（避免破坏自动档语义）
- **关闭自动档副作用**：`commands/adaptive.rs::set_adaptive_mode(auto=false)` 也走
  `hard_reset_to`（与重置按钮同语义）：关闭自动档瞬间把 `ability_score` /
  `trend` / `current_level` / `update_count` 全部清零，下次再开启自动档时以全新起点开始。
  `manual → auto` 路径保持原样（软重置或不动）。
- **与 `DifficultyConfig` 的关系**：
  - 旧 `DifficultyConfig.level`（String）保留 = **手动档 / 初始档 / 兜底档**
  - 新 `AdaptiveState.current_level` = **下一次实际使用档（mode = Auto 时）**
  - `DifficultyDemand` 三档文字不变；UI 在「设置 → 难度」Tab 同时展示手动档（可编辑或 disabled）与自适应档（只读）
  - `inject_difficulty_vars` 调用方改为读取 `effective_level()`，不再是裸 `config.difficulty.level`（**Prompt 模板本体不变**，仅改变量来源；详见 Spec.md §5.5）

#### 4.4.14 关窗拦截（Rust 驱动）

**架构**：拦截决策放在 `src-tauri/src/commands/app_close.rs` + `lib.rs::on_window_event`，
前端 `src/components/CloseGuard.tsx` 只负责显示确认框。

**为什么不能在前端用 `Window.onCloseRequested`**：
Tauri 2 的 `tauri-2.11.5/src/manager/window.rs:170` 在收到 `CloseRequested` 时，
只要 `has_js_listener(WINDOW_CLOSE_REQUESTED_EVENT)` 为 true 就**无条件** `api.prevent_close()`。
于是原生关窗被永久禁用，唯一出路变成前端主动调 `destroy()`。而
`plugin:window|destroy` 受 ACL 管控——`core:window:default` 只含 28 条只读 getter，
不含 `allow-destroy`/`allow-close`——每次 `destroy()` 都被驳回，
但驳回错误只在 webview console 出现，不落盘日志，所以极难发现。
旧版 `CloseGuard.tsx` 即因此**关不掉窗口**。

**为什么能跑通**：
1. 不在前端注册 `tauri://close-requested` 监听 → Tauri 不会自动 `prevent_close`
2. Rust 端 `lib.rs::on_window_event` 收到 `CloseRequested` 后：
   - 调 `services::pregen::is_generating(app)`（同步：worker 锁 try_lock + pending 原子读）
   - 调 `FlowStateContainer::is_running()`（同步：inner 锁 try_lock，fail-open）
   - 都 false → **不**调 `prevent_close`，原生关窗，零 ACL 依赖
   - 任一 true → `prevent_close` + emit 自定义事件 `app-close-requested`（payload: `{reason}`）
3. 前端 `CloseGuard.tsx` `listen("app-close-requested")`（自定义名，不是 `tauri://`），
   弹应用内 `ConfirmDialog`（`src/components/ui/confirm-dialog.tsx`，已全局挂载，
   正是项目为规避 WKWebView `window.confirm` 不可用而引入）。用户选「确认关闭」→
   `confirm_close_app` → Rust `pregen_svc::request_cancel` + `reset_test_flow`
   （abort run_flow + 置 rodio `active_stop_flag`）+ `Window::destroy()`（Rust 直接调，
   不受 IPC ACL 管控）。Rust `destroy` 而非 `app.exit`，让事件循环正常结束、`run()`
   正常返回，`lib.rs:71` 的 `_log_guard` 才会 drop 并 flush 日志。

**两道保险**：
- 前端异常（确认框 store 异常、IPC 失败等）：CloseGuard 的 try/catch 兜底视为「已确认」直接关窗。
- 用户逃生阀：`CloseGuardState.prompt_pending`（`AtomicBool`）。确认框弹着时再点一次 X，
  Rust 端 `swap(true)` 返回旧值 `true` → 放行第二次关闭请求。

**新增 commands**（`src-tauri/src/commands/app_close.rs`）：
- `confirm_close_app(app, audio, flow)` —— 用户确认后：取消预生成队列 + 重置测试流程 + `destroy("main")`
- `cancel_close_app(guard)` —— 用户取消后：清 `prompt_pending` 标志位

**新增事件**：`app-close-requested`（payload `{reason: "generating" | "testing"}`）

**修改文件**：
- `src-tauri/src/services/pregen.rs` —— 抽出 `pub fn is_generating(app: &AppHandle) -> bool`（同步）供 `on_window_event` 调用；`build_summary` 复用之
- `src-tauri/src/services/test_flow.rs` —— `FlowStateInner::is_running` + `FlowStateContainer::is_running`（`try_lock` + fail-open）
- `src-tauri/src/commands/test_flow.rs` —— `start_test_flow` 的防重复启动检查改为调用 `guard.is_running()` 共享谓词
- `src-tauri/src/commands/app_close.rs` —— 新建
- `src-tauri/src/lib.rs` —— `.manage(CloseGuardState::default())` + `.on_window_event(...)` + 注册 commands
- `src/components/CloseGuard.tsx` —— 重写：监听自定义事件 + 复用 `ConfirmDialog` + 异常兜底
- `src/lib/tauri.ts` —— 新增 `confirmCloseApp` / `cancelCloseApp` / `onAppCloseRequested` 封装

**`capabilities/default.json` 不变**：本方案不依赖任何 window 变更或 dialog ACL。

#### 4.4.15 五段开场介绍（v1.2+，2026-09 新增 play3）

**需求**：除原有第 1 题前的开场介绍外，5-14 题前、15-18 题前、15-18 题 PLAYING #3 前、
19 题录音前各增加一段介绍，纯文字 + 倒计时（不合成 / 不播放语音），文案与时长均可在设置界面编辑。

**共用 `Phase::Intro`**：没有新增 Phase 变体，也没有改 TS 的 `TestPhase` 联合类型与
`PHASE_LABELS`。五段介绍靠 `FlowState.question_index` 区分：

| question_index | 插入位置 | 时长字段 | 文案字段 |
|---|---|---|---|
| 1 | `run_short_dialogue` 内 `qnum == 1` | `timing.intro_ms` | `intro.text_1_4` |
| 5 | `run_flow` 中长对话循环之前 | `timing.group_intro_ms` | `intro.text_5_14` |
| 15 | `run_retell` 的 PREPARE 之前 | `timing.retell_intro_ms` | `intro.text_15_18` |
| 15 | `run_retell` 的 FILL_BLANK 之后、PLAYING #3 之前（play3 helper） | `timing.retell_play3_intro_ms` | `intro.text_15_18_play3` |
| 19 | `finish_recording_phases` 中 RECALL_PREP 之后 | `timing.retell_q19_intro_ms` | `intro.text_19` |

**文案由后端下发**：`FlowState` 新增 `intro_text: Option<String>`（camelCase `introText`），
仅 INTRO 阶段为 `Some`。前端 `Test.tsx` 直接渲染 `introText`，不再维护「阶段 → 文案」映射，
因此不存在前后端映射漂移；`get_flow_state` 的快照重放同样带着文案。

**共享 helper** `services/test_flow.rs::run_intro(...)`：
- `duration_ms == 0` 或文案 `trim()` 为空 → 整段跳过（用户可用「时长设 0」关掉某个介绍）
- 进入与退出都 `skip_flag.store(false)`；skip 语义仅「提前结束本介绍」，
  不中止本题、不跳到 PLAYING #3（前端在 intro 阶段隐藏「下一题」，故实际不可达，属防御性兜底）
- play3 介绍被抽成 `run_play3_intro(...)` helper，因为 `run_retell` 内有 6 处需要调用
  （5 个 escape 分支 + 1 个 fall-through），靠 helper 避免重复

**⚠️ 19 题介绍必须排在 `RECORD_START_EVENT` 之前**：`test-record-start` 是前端
`useRecorder` 真正开始采集麦克风的唯一触发源。若在介绍前发射，介绍还在显示时就已开始录音，
且 90 秒录音预算会被介绍时长吃掉。

**配置**：
- `AppConfig.intro`（`IntroConfig`，`#[serde(default)]`）5 个 String 字段，默认文案硬编码在
  `models/config.rs::default_intro_texts()`（与前端 `defaultIntroConfig()` 一字一致，同 difficulty 惯例）
- `TimingConfig` 新增 `group_intro_ms` / `retell_intro_ms` / `retell_play3_intro_ms` /
  `retell_q19_intro_ms`（各默认 10s）
- commands：`restore_default_intro`（单段）/ `restore_default_intro_all`（全部），对齐 `restore_default_prompt`
- UI：「设置 → 开场介绍」Tab（`IntroPanel`）编辑文案；时长仍在「流程时长」Tab（`TimingPanel`，共 14 项）

### 4.5 模块分层

```
UI (React 组件)
  ↓ invoke / listen
Tauri commands (commands/*.rs)        ← 入参校验、状态读写、事件发射
  ↓
Services (services/*.rs)              ← 业务逻辑、HTTP / 音频处理、状态机
  ↓
Models (models/*.rs)                  ← 数据结构（与前端 types/ 对齐）
  ↓
Utils (utils/*.rs)                    ← 通用工具：JSON 解析、重试、占位符、wav
```

### 4.6 测试流程状态机

```
1-4 题：INTRO(intro_ms) → PREPARE(short_dialogue_prepare_ms) → PLAYING(1x) → ANSWERING(short_dialogue_answer_ms) → 下一题
5-14 题开场介绍：INTRO(group_intro_ms) —— 仅第 5 题前一次，由 run_flow 在长对话循环前调用
5-12 题（4 段共享一个 ANSWERING 时段）：PREPARE(group_prepare_ms) → PLAYING #1 → 间隔(group_pause_ms) → PLAYING #2 → ANSWERING(共享 group_answer_ms)
13-14 题（独白）：PREPARE(group_prepare_ms) → PLAYING(1x) → ANSWERING(group_answer_ms)
15-19 题：
  INTRO(retell_intro_ms) → PREPARE(retell_prepare_ms) → PLAYING #1 → 间隔(retell_pause_ms) → PLAYING #2 →
  FILL_BLANK(retell_fill_blank_ms) → INTRO(retell_play3_intro_ms) → PLAYING #3 →
  RECALL_PREP(retell_recall_prep_ms) → INTRO(retell_q19_intro_ms) → RECORDING(固定 90s) → DONE
```

关键约定：
- **所有时长（除 RECORDING 固定 90s 外）均由 `TimingConfig` 控制**，详见 §4.4.8
- **5 个 INTRO 阶段共用 `Phase::Intro`**（1-4 / 5-14 / 15-18 / 15-18 PLAYING #3 前 / 19 题前），靠 `question_index`（1 / 5 / 15 / 15 / 19）区分；文案取自 `AppConfig.intro`（`IntroConfig`）并随 `FlowState.intro_text` 下发，前端不维护「阶段 → 文案」映射。详见 §4.4.15
- 15-19 题 PLAYING 阶段在 `test-flow-state` 事件中带 `play_count: Some(1|2|3)` 字段；前端在 `play_count = Some(3)` 时必须禁用填空白编辑
- `skip_to_next` 可用阶段：PREPARE / PLAYING #1 / pause / PLAYING #2 / FILL_BLANK（直接跳到 PLAYING #3）
- `skip_to_next` **不可用**阶段：PLAYING #3 / RECALL_PREP / RECORDING（保证最后两段答题时间不被压缩）；INTRO 阶段前端隐藏「下一题」按钮，`run_intro` 内即使收到信号也只是提前结束介绍本身
- `notify_recording_completed` 可在 RECORDING 任意时刻触发，提前结束录音
- 所有跨阶段睡眠均走 `interruptible_sleep()`，每 100ms 轮询对应信号位（详见 §4.4.9 / §4.4.11）

---

## 五、开发与构建

### 5.1 开发模式

```bash
npm install
npm run tauri:dev
```

启用 debug 日志：
```bash
RUST_LOG=peiyuan=debug npm run tauri:dev
RUST_LOG=trace npm run tauri:dev
```

查看落盘日志文件（按天滚动，详见 §4.4.13）：
```bash
# Linux
tail -F ~/.local/share/com.peiyuan.desktop/logs/peiyuan.log.*
# macOS
tail -F "$HOME/Library/Application Support/com.peiyuan.desktop/logs/peiyuan.log.*"
# Windows (PowerShell)
Get-Content "$env:APPDATA\com.peiyuan.desktop\logs\peiyuan.log.*" -Wait
```

### 5.2 生产打包

```bash
npm run tauri:build                                    # 当前平台
npm run tauri:build -- --target x86_64-pc-windows-msvc # Windows
npm run tauri:build -- --target aarch64-apple-darwin  # macOS ARM
npm run tauri:build -- --target x86_64-unknown-linux-gnu # Linux
```

详见 [README.md](./README.md)。

### 5.3 自适应 crate 工作区成员（v1.1+）

- `src-tauri/Cargo.toml` 的 `[workspace] members = [".", "adaptive_difficulty"]`
- 单独测试 crate：`cd src-tauri && cargo test -p adaptive_difficulty`
- crate API 速查（详见 `src-tauri/adaptive_difficulty/README.md`）：
  - `AdaptiveState { ability_score, trend, current_level, update_count }`
  - `Level::{JuniorHigh, SeniorHigh, Undergraduate}`（序列化 snake_case 字符串）
  - `update(&mut state, a, b, c) -> Result<UpdateTrace, AdaptiveError>`
  - `reset_to(&mut state, level)` / `validate_loaded(state)`
  - `Params::default()` 返回生产参数（权重 0.5/0.2/0.3、`score_floor 0.6`、`alpha 0.4`、滞回阈值 200/400、`buffer 20`）

---

## 六、已知问题 / 死代码

本次文档审计发现但**未在代码层面处理**的项，留作未来清理 TODO：

| 项目 | 文件 | 说明 |
|------|------|------|
| `test-score-progress` 事件未发射 | `src-tauri/src/services/scoring.rs` | `ScoreProgress` 结构与 `SCORE_PROGRESS_EVENT` 常量已定义，但 `score_full_test` 全程未调用 `emit()`。前端无 listener。死代码。 |

---

## 七、详细需求

所有功能需求、UI 规范、评分规则、非功能性需求等请参考 [Spec.md](./Spec.md)。

**核心要点速查**：
- 19 道题分两段：1-14 选择 / 15-19 转述
- 全部使用本地/自建 OpenAI 兼容模型服务
- 5 个 Prompt 模板可在 UI 编辑 + 恢复默认（`PromptEditor`）
- 阶段时长可在 UI 编辑 + 恢复默认（`TimingPanel`，对应 `TimingConfig`，共 13 项，详见 §4.4.8）
- 5 段开场介绍（1-4 / 5-14 / 15-18 / 15-18 PLAYING #3 前 / 19 题前）纯文字 + 倒计时，文案可在 UI 编辑 + 恢复默认（`IntroPanel`，对应 `IntroConfig`，详见 §4.4.15）
- 后端驱动计时与音频播放
- 15-18 题评分：每空 LLM JSON 评分（0 或 1.5 分），详见 §4.4.12
- 总分 30（14 + 6 + 10），自动评分
- 跨平台 Windows / macOS / Linux
- 自适应难度（v1.1+）：每次测试后由 `adaptive_difficulty` crate 自动调整下次难度档位（含 EMA 能力分更新与滞回阈值）；设置 → 难度 Tab 提供「自动切换难度」开关（默认关闭），开启时手动档下拉框自动禁用。详见 Spec.md §3.6 / §5.5 / §6.5 / §7.5，技术细节见本文件 §4.4.8