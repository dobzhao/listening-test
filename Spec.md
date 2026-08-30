# 英语听力练习程序 - 详细需求规格（Spec）

> 版本：v1.1
> 最后更新：2026-08-21
> 适用代码版本：v0.1.0（已交付全部 6 个 Phase）
>
> **v1.1 新增：自适应难度（Adaptive Difficulty）** —— 详见 §3.6 / §5.5 / §6.5 / §7.5 / §九
>
> **v1.1 增量需求（待实现）**：§11 待实现的功能 — 仅新题更新能力 / 难度 Tab 暴露参数 / 关闭自动档自动重置 / 结算页升/降可视化

## 一、项目概述

### 1.1 目标

本项目开发一个**跨平台桌面英语听力练习程序**，用于模拟"英语听说考试"完整流程。系统通过本地/自建的 OpenAI 兼容 LLM 服务实时生成题目内容，TTS 服务合成语音，STT 服务转写用户口头作答，由 LLM 自动评分。

### 1.2 核心场景

用户在桌面应用中依次完成 **19 道题目**，其中：
- **第 1-14 题**：听后选择（听对话/独白，从 A/B/C 三个选项中选择正确答案）
- **第 15-19 题**：听后转述（听长材料 → 填写 4 个挖空单词 → 口头转述录音 → LLM 评分）

每次完整 19 题阅卷完成后，程序根据三段得分率自适应地调整用户的难度档位（详见第十一节）；下次测试自动使用调整后的档位生成题目。v1.1 起用户可在「设置 → 难度」开启**自动切换难度**开关；开启后系统根据每次 19 题的得分率自动调整下一次测试的难度档位（共 3 档），关闭时保留 v1.0 的手动选档行为。开关切换时手动档选择会被同步启用/禁用。

### 1.3 目标用户

- 需要练习英语听说的学生


### 1.4 平台支持

| 平台 | 最低版本 | 状态 |
|------|----------|------|
| Windows | Windows 10 | ✅ |
| macOS | 11.0 Big Sur | ✅ |
| Linux | Ubuntu 22.04 LTS | ✅ |

---

## 二、技术栈

### 2.1 前端

- **Tauri 2.0** 桌面运行时
- **React 18** + **TypeScript**（strict 模式）
- **Vite 5** 构建工具
- **Tailwind CSS 3.4** + **shadcn/ui** 组件
- **Zustand 5** 状态管理
- **React Router v6** 路由
- **@tauri-apps/api** 与后端通信

### 2.2 后端

- **Rust 2021 edition**（≥ 1.75）
- **tokio** 异步运行时（full features）
- **reqwest** HTTP 客户端（含流式 + multipart）
- **eventsource-stream** SSE 解析
- **cpal** 跨平台音频采集
- **rodio** 跨平台音频播放
- **hound** WAV 编码/解码
- **serde** + **serde_json** 序列化
- **tracing** 日志
- **uuid** 会话标识
- **thiserror** + **anyhow** 错误处理

### 2.3 数据存储

- 配置文件：`{app_data_dir}/config.json`
- 测试缓存：`{app_data_dir}/cache/{session_uuid}/`
- 设备测试录音：`{app_data_dir}/device-tests/`

---

## 三、19 题详细流程

### 3.1 第 1-4 题：短对话听后选择（每题独立流程）

**题目结构**：4 段短对话，每段配 1 道选择题。

**生成 Prompt 模板**：默认见 `src-tauri/prompts/q1_4.txt`；占位符详见第五章 5.2 占位符总表。

**每题流程**：

| 阶段 | 默认时长 | UI 显示 |
|------|---------|---------|
| INTRO | 10s | 仅第 1 题前显示一次 |
| PREPARE | 5s | 显示题干与 3 个选项（不可点） |
| PLAYING | ~8s | 后端播放对话音频 1 次（用户可提前选答案） |
| ANSWERING | 10s | 选项可点击，倒计时进度条 |

### 3.2 第 5-12 题：长对话听后选择（4 段材料，每段配 2 题）

**题目结构**：4 段长对话，每段配 2 道选择题（5+6 / 7+8 / 9+10 / 11+12）。

**生成 Prompt 模板**：默认见 `src-tauri/prompts/q5_14.txt`，无占位符。

**每段材料流程**（两题共用）：

| 阶段 | 默认时长 | UI 显示 |
|------|---------|---------|
| PREPARE | 10s | 同时显示两道题的题干与 3 个选项 |
| PLAYING #1 | ~10s | 播放第 1 次 |
| 静音间隔 | 2s | 停止播放 |
| PLAYING #2 | ~10s | 播放第 2 次 |
| ANSWERING | 10s | 两题共享作答时间（10s） |

### 3.3 第 13-14 题：独白听后选择

**题目结构**：1 段独白（150-200 词）配 2 道选择题。

**生成流程**：同 5-12 题（独白单次播放）。

### 3.4 第 15-19 题：听后转述

**题目结构**：
- 1 段较长听力材料（200-220 词）
- 总-分结构 3 行表格（Overview + Details 两列）
- Details 中挖去 4 个单词（对应第 15-18 题）
- 第 19 题：口头转述

**生成 Prompt 模板**：默认见 `src-tauri/prompts/q15_18.txt`，无占位符。

**完整流程**：

| 阶段 | 默认时长 | UI 显示 |
|------|---------|---------|
| PREPARE | 30s | 显示挖空表格（不可填） |
| PLAYING #1 | ~12s | 播放第 1 次 （此时开始挖空可填） |
| 静音间隔 | 3s | 停止播放 |
| PLAYING #2 | ~12s | 播放第 2 次 |
| FILL_BLANK | 90s | 额外给用户的填空时间（挖空可填） |
| PLAYING #3 | ~12s | 第 3 次播放（不可继续填写） |
| RECALL_PREP | 120s | 显示已填表格，默读准备 |
| RECORDING | 90s（**固定） | 自动开始录音，实时音量条 |

**第 19 题录音要求**：
- 自动开始，**固定 90 秒**（受 STT/LLM 判分稳定性约束，不可在设置中调整）
- 可提前结束但不可延长
- 麦克风权限需正确配置（macOS/Linux）
- 录音保存到 `{app_data_dir}/cache/{session_id}/recording.wav`

### 3.5 流程时长可配置说明

除 **第 19 题录音 90 秒**外，上述 10 个时长（INTRO / PREPARE / 静音间隔 / ANSWERING / FILL_BLANK / RECALL_PREP）均可在 **设置 → 流程时长** Tab 中调整，单位为秒，内部以毫秒存储：

- 适用场景：自测/教学场景下缩短等待，或为听障考生延长准备时间
- 默认值与本节表格一致
- 设置修改后立即生效，下次测试流程启动时读取
- 提供「恢复默认」按钮一键还原
- 修改后必须点击「保存时长」按钮才会写入 `config.json`

### 3.6 测试结束后的自适应难度更新（v1.1+）

每次完整 19 题阅卷完成后，系统按三段得分率自适应调整下次测试难度档位：

- **触发时机**：每次「结算页」展示前，即 `score_full_test` 完成之后
- **三个输入分数**（全部 ∈ [0, 1]）：

  | 符号 | 含义 | 计算 |
  |------|------|------|
  | `a`  | 1-14 题正确率 | `correct_count_1_to_14 / 14` |
  | `b`  | 15-18 题填空得分率 | `blanks_total_score / 6` |
  | `c`  | 19 题归一化分 | `q19_score / 10` |

- **综合得分** `S = 0.5·a + 0.2·b + 0.3·c`（默认权重；与 crate `params.rs::default()` 一致）
- **得分下限**：分数 < 0.6（`score_floor`）按"未达标"处理，但综合分不会跌破 0.6
- **输出**：下一档难度（`junior_high` / `senior_high` / `undergraduate`），传给下一次 `generate_test_session`；仅在「自动模式」开启时实际生效
- **完整算法**（EMA 能力分更新 + 滞回阈值）由 crate `adaptive_difficulty` 实现；本节仅描述对外行为，详见 §6.5 与 CLAUDE.md §4.4.8

---

## 四、模型服务集成

### 4.1 三组独立可配置服务

| 服务 | 默认端点 | 默认模型 |
|------|----------|----------|
| LLM | `http://127.0.0.1:8000/v1/chat/completions` | 用户配置 |
| TTS | `http://127.0.0.1:8000/v1/audio/speech` | Kokoro-82M-bf16 |
| STT | `http://127.0.0.1:8000/v1/audio/transcriptions` | whisper-large-v3-turbo-asr-fp16 |

每组配置字段：
- **protocol**：`http` 或 `https`（默认 http）
- **host**：主机地址
- **port**：端口
- **api_path**：API 路径
- **model**：模型名称
- **api_key**：Authorization Bearer Token

### 4.2 LLM 调用细节

```json
POST /v1/chat/completions
{
  "model": "{model}",
  "messages": [{"role": "user", "content": "..."}],
  "stream": true,
  "stream_options": { "include_usage": true },
  "temperature": 1.0,
  "max_tokens": 81920,
  "top_p": 0.95,
  "top_k": 64,
  "chat_template_kwargs": { "enable_thinking": false }
}
```

**响应处理**：解析 SSE 流，拼接 `choices[0].delta.content` 得到完整文本。调用方再解析 JSON。

### 4.3 TTS 调用细节

```json
POST /v1/audio/speech
{
  "model": "{model}",
  "input": "对话文本",
  "voice": "af_heart" | "am_michael",
  "speed": 1.0,
  "lang_code": "a"
}
```

**Voice 约定**（可由用户在 Prompt 中调整）：
- 说话人 M → `am_michael`
- 说话人 W → `af_heart`

### 4.4 STT 调用细节

```bash
POST /v1/audio/transcriptions
Form-data: file=audio.wav, model=..., language=en
```

---

## 五、Prompt 模板

19 道题的题目生成与评分全部由 LLM 完成，共 5 个 Prompt 模板，均可在设置界面编辑并支持"恢复默认"。

### 5.1 模板清单与位置

5 个模板以纯文本形式存放于 `src-tauri/prompts/`，编译期由 `include_str!` 嵌入二进制，作为 `PromptConfig` 的默认值（`models::config::default_prompts()`）：

| 模板 Key | 文件 | 行数 | 适用阶段 |
|----------|------|------|----------|
| `q1_4` | `q1_4.txt` | 40 | 1-4 题出题（短对话）|
| `q5_14` | `q5_14.txt` | 86 | 5-14 题出题（长对话 + 独白）|
| `q15_18` | `q15_18.txt` | 48 | 15-19 题出题（长文本 + 表格 + 挖空）|
| `q15_18_scoring` | `q15_18_scoring.txt` | 35 | 15-18 题填空判分 |
| `q19_scoring` | `q19_scoring.txt` | 21 | 19 题口头转述评分 |

### 5.2 占位符总表

10 个占位符全部采用 `{{KEY}}` 语法。下表按"模板 → KEY"列出每条占位符的用途、值来源与是否可被用户在设置界面编辑。

| 模板 | 占位符 KEY | 用途 | 值来源 | 用户可编辑 |
|------|------------|------|--------|------------|
| `q1_4` | `{{DIALOGUE_SCENARIOS}}` | 4 段短对话的场景清单 | 按当前难度档从内置对话场景库随机抽 4 个不重复 | 否 |
| `q1_4` | `{{DIFFICULTY_DEMAND_1_4}}` | 当前档位 1-4 题难度文字要求 | `DifficultyConfig.{level}.demand_1_4` | 是（难度 Tab）|
| `q5_14` | `{{DIALOGUE_SCENARIOS}}` | 4 段长对话的场景清单 | 同 `q1_4` | 否 |
| `q5_14` | `{{MONOLOGUE_SCENARIO}}` | 1 段独白的话题与展开方向 | 按当前难度档从独白场景库随机抽 1 个 | 否 |
| `q5_14` | `{{DIFFICULTY_DEMAND_5_14}}` | 当前档位 5-14 题难度文字要求 | `DifficultyConfig.{level}.demand_5_14` | 是（难度 Tab）|
| `q15_18` | `{{MONOLOGUE_SCENARIO}}` | 较长听力材料的话题与 3 个展开方向 | 同 `q5_14` | 否 |
| `q15_18` | `{{DIFFICULTY_DEMAND_15_18}}` | 当前档位 15-18 题难度文字要求 | `DifficultyConfig.{level}.demand_15_18` | 是（难度 Tab）|
| `q15_18_scoring` | `{{ORIGINAL_TEXT}}` | 15-19 题听力原文 + 4 空标准答案 | 运行时拼接：原文 + 标准答案 | 否 |
| `q15_18_scoring` | `{{ANSWERS}}` | 用户填写的 4 空答案 | `{"15":..,"16":..,"17":..,"18":..}` pretty JSON | 否 |
| `q19_scoring` | `{{ORIGINAL_TEXT}}` | 15-19 题听力原文 | `session.retell.passage` | 否 |
| `q19_scoring` | `{{STT_RESULT}}` | 第 19 题录音经 STT 转写后的文本 | STT 服务返回的转写文本 | 否 |


### 5.3 与场景/难度的协同

- 难度档位（`junior_high` / `senior_high` / `undergraduate`）由用户在"难度"Tab 顶部切换
- 场景库（`src-tauri/resources/dialogue_scenarios.json`、`monologue_scenarios.json`）按 3 档分组；调用方传 `level` 即可拿到对应子池的随机条目
- `inject_difficulty_vars`（`services/question_generator.rs`）按当前 `level` 取出对应的 3 段 `demand_*` 文字，一次性注入 3 个 KEY，未知 level 兜底为 `junior_high`
- 由于引擎忽略未引用 KEY，3 个 `DIFFICULTY_DEMAND_*` 同时注入是安全的


### 5.4 "恢复默认"按钮

设置界面每个 Prompt 模板都有"恢复默认"按钮，点击后将对应模板重置为 `src-tauri/prompts/<key>.txt` 编译期默认值，**仅影响该模板，不影响其他模板或难度/场景配置**。

### 5.5 自适应模式与 Prompt 占位符（v1.1+）

> **关于"是否改 Prompt 模板"**：不改。`src-tauri/prompts/*.txt` 五个文件原样不动，`{{DIFFICULTY_DEMAND_1_4}}` / `{{DIFFICULTY_DEMAND_5_14}}` / `{{DIFFICULTY_DEMAND_15_18}}` 三个占位符保留。变化只在**运行时**：`inject_difficulty_vars`（位于 `services/question_generator.rs`）选择哪一档的 `demand_*` 文字注入模板——自动档下取 `adaptive.current_level` 对应的档，手动档下取 `difficulty.level` 对应的档。
>
> **关于"兜底难度"**：兜底值 `"junior_high"` 不是新引入的——`inject_difficulty_vars` 现有代码已经写明「未知 level 兜底为 junior_high」（见 §5.3 第 4 条）。新功能只是把"未知 level"这一判断前置到上游（先决定 mode → 再决定 level），兜底值保持一致。

- **Prompt 模板本体不变**：5 个 `src-tauri/prompts/*.txt` 文件不动，三个 `DIFFICULTY_DEMAND_*` 占位符语义保留
- `difficulty.level`（String）保留语义 = 用户手动选择的档 / 初始档 / 兜底档
- 新增 `adaptive.current_level`（String，同枚举）= 下一次出题的实际档（当 mode = Auto 时）
- `inject_difficulty_vars` 取值来源（运行时决定）：
  - `mode = Manual` → 直接使用 `difficulty.level`
  - `mode = Auto`   → 使用 `adaptive.current_level`
  - 任一情况若 level 值不合法 / 缺字段 → 沿用现有兜底 `"junior_high"`（行为与 v1.0 一致）
- `DifficultyDemand` 三档文字不变（仍由用户在「设置 → 难度」Tab 编辑）
- 引擎忽略未引用 KEY，3 个 `DIFFICULTY_DEMAND_*` 同时注入是安全的

---

## 六、评分规则

### 6.1 第 1-14 题（MCQ）

- 本地比对 `user_answer` 与 `correct_answer`
- 每题 1 分，总分 14

### 6.2 第 15-18 题（填空）

由 LLM 按 `q15_18_scoring` Prompt 评分：

- 大小写不敏感
- 单复数必须完全正确
- 允许英式/美式拼写差异（colour/color 等）
- 允许原文中出现过的同义词
- **每空 1.5 分，总分 6 分**

### 6.3 第 19 题（口头转述）

1. 先调用 STT 将录音转写为文本
2. 由 LLM 按 `q19_scoring` Prompt 评分：
   - 内容完整度（4 分）
   - 关键信息准确性（3 分）
   - 语言表达与逻辑连贯性（3 分）
3. **总分 10 分**

### 6.4 总分

`总分 = 1-14 正确数 + 15-18 得分 + 19 得分`，满分 30。

### 6.5 自适应难度更新（v1.1+）

- `score_full_test` 在返回 `TestResult` 给前端**之前**调用一次 `adaptive_difficulty::update(&mut state, a, b, c)`
- **输入校验**：a / b / c 必须 ∈ [0, 1]，否则返回 `AdaptiveError::InvalidScoreRate` —— 前端显示 toast「自适应更新失败」，state 不被错误路径修改（crate 保证事务性）
- **输出**：`UpdateTrace` 持久化到 `session.cache.adaptive_trace`，用于结算页调试信息
- **滞回阈值**（`hysteresis buffer = 20`，默认）：
  - 当前 `junior_high`：`ability > 220` → 升 `senior_high`；否则维持
  - 当前 `senior_high`：`ability > 420` → 升 `undergraduate`；`ability ≤ 180` → 降 `junior_high`；否则维持
  - 当前 `undergraduate`：`ability ≤ 380` → 降 `senior_high`；否则维持
  - **不允许跨级跳跃**：`junior_high` ↔ `undergraduate` 之间必须经过 `senior_high`
- 完整 11 步算法详见 CLAUDE.md §4.4.8 与 crate `INTEGRATION.md`

---

## 七、UI 需求

### 7.1 设置界面

7 个 Tab：
1. **LLM**：host / port / api_path / model / api_key / protocol + 调用参数
2. **TTS**：同上
3. **STT**：同上
4. **提示词**：5 个 Prompt 模板可编辑 + 恢复默认
5. **音频**：播放音量、麦克风增益、TTS 拼接静音时长
6. **流程时长**：答题过程每个阶段等待时长 + 恢复默认
7. **难度**：三档文字模板编辑 + 档位选择 + 「自动切换难度」开关 + 「重置自适应状态」按钮（v1.1+，详见 §7.5）
8. **设备测试**：可选输入/输出设备 + 录音测试 + 测试音播放

每个模型配置都有"测试连接"按钮（最小请求验证）。

v1.1 起「难度」Tab 增加「自动切换难度」开关；开启时手动档选择下拉框自动禁用（greyed out），仅展示只读读数（当前能力分 / 趋势 / 已更新次数 / 当前自适应档）；关闭时手动档选择可用。同时新增「重置自适应状态」按钮（二次确认）。详见 §7.5。

### 7.2 主菜单

- 显示 LLM / TTS / STT 三组配置状态（已就绪 / 未完成）
- 「开始测试」按钮（配置完成才可点）
- 「设置」入口

### 7.3 测试页面

- 顶部全局进度条（第 N/19 题）
- 当前阶段说明 + 倒计时进度条
- 题目展示（题干 + 3 个选项）
- 挖空表格（15-18 题，含可填 input）
- 录音面板（19 题，倒计时 + 实时音量条）
- 「放弃并返回主菜单」按钮（带确认）

### 7.4 结算页

- 总分卡片
- 1-14 题：14 个可点击小卡片，展示对错
- 15-18 题：表格展示用户答案 vs 标准答案
- 19 题：分数 + LLM 评语 + STT 转写文本 + 听力原文
- 「重新测试」/「返回主菜单」按钮
- 自适应档位卡片（如有变化则高亮 "提升 ⬆ / 下降 ⬇" 箭头 + 旧档 → 新档）
- 当前 ability_score（保留 1 位小数）+ trend（保留 2 位小数）+ update_count
- 自适应 trace 可展开/折叠（默认折叠），展示综合得分、ability_before/after、level_before/after

### 7.5 自适应难度 UI（v1.1+）

**设置 → 难度 Tab 自适应区**：

- 「自动切换难度」开关（默认关闭）
  - 开启：手动档下拉框自动禁用（greyed out），下拉框内显示提示「已启用自动档」
  - 关闭：手动档下拉框恢复可用
- 「重置自适应状态」按钮（二次确认对话框）
  - 重置后 `ability_score = 100`、`trend = 0`、`current_level` = 当前手动档（开关关闭后保留当前手动档值；开关开启时回退 `junior_high`）
  - `update_count` 归零
- 只读读数（无论开关状态都展示，便于用户参考）：
  - 当前 `ability_score`（1 位小数）
  - 当前 `trend`（2 位小数）
  - 已更新次数 `update_count`
  - 当前自适应档（`current_level` 的中文字幕）

**主菜单（首页）**：

- 在 LLM / TTS / STT 三组配置状态下方追加「难度模式：自动 / 手动 | 当前档：X」一行

---

## 八、非功能性需求

### 8.1 计时精度

- 后端 Rust `tokio::time::Instant` 计算真实剩余时间
- 每 100ms 通过 Tauri Event 推送 `test-timer-tick`
- 阶段结束推送 `test-phase-finished`

### 8.2 容错与重试

- LLM/TTS/STT 调用失败自动重试（指数退避，最多 3 次）
- 关键路径失败提示用户重试/跳过
- React ErrorBoundary 兜底前端崩溃
- 题目生成失败可一键清除并重新生成

### 8.3 预加载机制

- 测试开始前预生成全部 19 题内容（含音频）
- 单次测试内容缓存到 `cache/{session_id}/`

### 8.4 跨平台兼容

- 音频播放统一用后端 rodio（无 webview autoplay 限制）
- assetProtocol 已启用 + `protocol-asset` feature
- cpal 在 macOS / Linux / Windows 自动适配

### 8.5 异常处理

- 用户关闭窗口释放音频流
- 网络中断有清晰错误提示
- 配置缺失有占位默认

### 8.6 自适应算法非功能性约束（v1.1+）

- **算子纯函数 + 内部状态机**：单次 `update` 调用 O(1) 时间，无 I/O、无 tokio、无锁
- **失败语义**：参数非法 / NaN → `AdaptiveError` 返回，state 保持原值不变（事务性，crate 保证）
- **持久化原子写入**：`adaptive_state.json` 使用 `tempfile + rename`（详见 CLAUDE.md §4.4.8）
- **启动加载**：`validate_loaded` 校验；越界或损坏字段 → 自动 `reset_to(junior_high)`，不向用户报错
- **性能**：每次结算多耗时 < 1ms（纯计算），不影响 90 秒录音后的体感

---


## 九、配置兼容性

`config.json` 中新增字段（如 `protocol`）通过 `#[serde(default = ...)]` 自动回退到默认值，向后兼容旧配置文件，无需用户手动迁移。

v1.1 起新增 `difficulty.mode` 字段（`"auto" | "manual"`，默认 `"manual"`）。运行时态独立存放在 `{app_data_dir}/adaptive_state.json`（结构：`{ ability_score, trend, current_level, update_count }`），缺失或损坏时自动以默认初始档（`junior_high`，`ability = 100`）重建。所有新字段使用 `#[serde(default)]`，旧 `config.json` 无需迁移。

---

## 十、已知约束

1. **单次测试题目内容不可恢复**：缓存清理后无法重新查看
2. **TTS 输出采样率依赖服务**：当前代码假定所有 TTS 输出采样率一致，拼接 wav 时统一
3. **录音固定采样率 16kHz**：简化 STT 处理，重采样在保存时完成
4. **同时只能运行一个测试会话**：未实现多会话隔离
5. **19 题录音时长固定 90 秒**：受 STT/LLM 判分稳定性约束，不可在 UI 中调整；其余 10 个流程时长均可在「设置 → 流程时长」中调整
6. **自适应模式开启时，手动档下拉框被禁用**，仅展示只读读数；用户需关闭自动档才能手动切档（v1.1+）
7. **`adaptive_state.json` 损坏或字段越界时，下次启动自动回退到默认初始档**（不抛错，v1.1+）
8. **自适应状态独立于「难度 Tab」文字配置**：用户编辑 `demand_*` 文字不影响算法（v1.1+）

---

## 十一、待实现的功能（v1.1+）

> 本节是 v1.1 自适应难度的**增量需求**，与 §3.6 / §5.5 / §6.5 / §7.5 互补；既有章节描述初步设计，本节描述需要进一步实现的细节与行为修正。每条都给出**与既有节的冲突/增量说明**，方便实现方定位。
>
> 注：本节文档阶段不修改 Rust / TS 代码，仅作需求记录。

### 11.1 触发条件细化：仅「新题」更新能力

> **冲突说明**：§6.5 描述「每次 `score_full_test` 完成后调用 `adaptive::update`」是粗粒度；本节细化**触发条件**。

- `score_full_test` 必须新增接收 `is_retest: bool` 参数
  - `is_retest = false`（来自主菜单「开始测试」`MainMenu::handleStart`）：正常调用 `adaptive::update`
  - `is_retest = true`（来自结算页 `Result.tsx::handleRetest`）：**跳过** `adaptive::update` 调用；ability / trend / current_level / update_count 全部不变；trace 不写、`UpdateTrace` 不返回
- **前端标记**：
  - `src/store/result.ts::load(is_retest)` 新增 `is_retest` 参数
  - `Result.tsx::handleRetest` 在 `await startTestFlow()` 之前调用 `useResultStore.getState().setIsRetest(true)`，下次进入结算页时由 `useResultStore.load(is_retest)` 透传给 `scoreFullTest(is_retest=true)`
- **后端接收**：
  - `commands/scoring.rs::score_full_test(is_retest: bool)` 同步新增参数
  - `services/scoring.rs::score_full_test(is_retest)` 根据 `is_retest` 分支：true → 跳过 adaptive；false → 调用 `adaptive_difficulty::update(&mut state, &params, a, b, c)`

### 11.2 难度 Tab 暴露自适应参数

> **冲突说明**：§7.5 仅描述「开关 + 重置按钮 + 只读读数」，未涉及算法参数；本节新增**自适应参数配置区**。

- 参数全部来自 crate `adaptive_difficulty::Params` 的 15 个 `f64` 字段，UI 全部暴露：

  | 字段 | 默认 | 含义（来源 `params.rs` 注释） |
  |------|------|-------------------------------|
  | `weight_a` | 0.5 | 1-14 题权重（选择题） |
  | `weight_b` | 0.2 | 15-18 题权重（填空） |
  | `weight_c` | 0.3 | 19 题权重（口头转述） |
  | `score_floor` | 0.6 | 综合得分下限，低于此按"未达标"处理 |
  | `alpha` | 0.4 | EMA 平滑系数，越大越看重最近一次表现 |
  | `base_magnitude` | 3.0 | 单次调整最小幅度 |
  | `k` | 10.0 | 趋势放大系数（`|trend|` → 额外幅度） |
  | `max_magnitude` | 8.0 | 单次调整幅度上限 |
  | `b1` | 200.0 | junior ↔ senior 档的能力阈值 |
  | `b2` | 400.0 | senior ↔ undergraduate 档的能力阈值 |
  | `buffer` | 20.0 | 滞回缓冲区宽度（防止抖动） |
  | `ability_min` | 0.0 | 能力分下限 |
  | `ability_max` | 600.0 | 能力分上限 |
  | `trend_min` | -1.0 | 趋势下限 |
  | `trend_max` | 1.0 | 趋势上限 |

- **持久化**：作为 `AppConfig.adaptive_params: AdaptiveParams` 字段加到 `config.json`，`#[serde(default)]` 回退到 `Params::default()`
- **前端类型**：`src/types/config.ts::AppConfig` 增加 `adaptive_params: AdaptiveParams`；`defaultAppConfig()` 用 `Params::default()` 同步
- **后端类型**：`src-tauri/src/models/config.rs` 新增 `AdaptiveParams` 结构，字段名一一对应 `adaptive_difficulty::Params`
- **UI 组件**：`src/components/settings/DifficultyPanel.tsx` 增加「自适应参数」可折叠子区域；展开显示 15 个数字输入框 + 「恢复默认」按钮（一键还原为 crate `Params::default()` 值）
- **运行时使用**：`score_full_test` 调用前从全局只读位置读取 `Params`（启动加载一次）；不暴露新后端命令，UI 直接编辑 `config.json::adaptive_params`
- **约束**：修改后必须点击「保存配置」才会生效；保存前仅在内存中预览

### 11.3 难度 Tab 显示当前能力分

> **冲突说明**：§7.5 第 4 条提到「只读读数」但未明确字段与位置；本节明确。

- **字段**：
  - `ability_score`（1 位小数）
  - `trend`（2 位小数）
  - `update_count`
  - `current_level`（中文标签：初中 / 高中 / 大学）
- **位置**：难度 Tab 的自适应参数子区域**之上**，作为**固定卡片**（不可折叠），无论开关状态都可见
- **数据来源**：后端 `commands/adaptive.rs::get_adaptive_state` → 返回 `AdaptiveStatePayload { ability_score, trend, current_level, update_count }`；前端在 `DifficultyPanel` 挂载时调一次，并在收到 `adaptive-level-changed` / `adaptive-state-reset` 事件时刷新

### 11.4 关闭自动模式时自动重置

> **冲突说明**：§7.5 「重置自适应状态」按钮行为保留；本节描述**开关切换动作本身**的副作用。

- 「自动切换难度」开关从 `auto` → `manual` 的瞬间，**自动**执行一次硬重置
  （走 `services::adaptive::hard_reset_to`，语义与「重置自适应状态」按钮一致）：
  - `ability_score = current_manual_level.initial_ability()`（即 100 / 300 / 500）
  - `trend = 0.0`
  - `current_level = current_manual_level`
  - `update_count = 0`（关闭自动档意味着「整体停用」自适应，下次再开启前不保留任何累计历史）
- 「重置自适应状态」按钮行为保留，仅在 `mode = Auto` 时**可见**（手动模式下不渲染）；供用户在自动模式下手动清零
- **持久化**：切换 / 重置后立即落盘 `adaptive_state.json`（与 §4.4.8 一致）
- **UI 反馈**：
  - 切换瞬间弹 toast「已切换到手动档，自适应变量已全部清零」
  - 按钮点击弹 toast「已重置自适应状态」

### 11.5 结算页能力分升 / 降可视化

> **冲突说明**：§7.4 已提「自适应档位卡片」与 trace 折叠；本节新增视觉规则。

- 总分卡片**右侧**增加一枚「能力分变化」徽章：
  - `ability_after > ability_before` → 绿色 `↑ +{Δability}`（保留 1 位小数）
  - `ability_after < ability_before` → 红色 `↓ -{Δability}`
  - `ability_after == ability_before` → 灰色 `→ 0.0`
  - `is_retest = true` → 徽章显示「本次为重新测试，未调整能力」
- 现有「自适应档位卡片」同步增加「升 ⬆ / 降 ⬇ / 维持 →」箭头
- **数据来源**：`TestResult.adaptive: Option<AdaptiveSummary>` 已有能力分变化；前端在 `Result.tsx` 渲染时读取 `adaptive.ability_before` / `adaptive.ability_after` / `result.is_retest`
- **is_retest 透传**：`useResultStore::load(is_retest)` → `scoreFullTest(is_retest)` → 后端写入 `TestResult.is_retest`，前端据此决定徽章文案

### 11.6 模式切换时不清空 AdaptiveState 的旧规则不变

> **冲突说明**：CLAUDE.md §4.4.8 已说「切换瞬间不重置 AdaptiveState」；本节**进一步明确**方向性 —— 仅 `auto → manual` 重置，`manual → auto` 不重置，与 11.4 互补。

- 从 `manual` → `auto` 时**不**重置 —— 保留前一次自动档下的 ability_score / trend（手动模式下算法不调用 `update`，但 `adaptive_state.json` 中的旧值仍在）
- 实际效果：用户在手动档下做几套题（不更新 ability），切回自动档后下一次 `score_full_test` 用切换前最后一次的 ability / trend 继续
- 与 11.4 不冲突：11.4 描述 `auto → manual` 触发重置；本节描述 `manual → auto` 不触发