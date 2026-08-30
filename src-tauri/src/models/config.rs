//! 应用配置数据结构
//!
//! 这些结构会被序列化为 JSON 保存到本地配置文件，并通过 Tauri command
//! 暴露给前端。字段顺序与默认值必须与前端 TypeScript 类型保持一致。

use serde::{Deserialize, Serialize};

/// 单个模型服务（LLM / TTS / STT）的连接配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    /// 协议："http" 或 "https"
    #[serde(default = "default_protocol")]
    pub protocol: String,
    /// 主机地址，例如 "127.0.0.1"
    pub host: String,
    /// 端口，例如 8000
    pub port: u16,
    /// API 路径，例如 "/v1/chat/completions"
    pub api_path: String,
    /// 模型名称
    pub model: String,
    /// Authorization Bearer Token
    pub api_key: String,
}

fn default_protocol() -> String {
    "http".to_string()
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            protocol: default_protocol(),
            host: "127.0.0.1".to_string(),
            port: 8000,
            api_path: String::new(),
            model: String::new(),
            api_key: String::new(),
        }
    }
}

impl ModelConfig {
    /// 拼接完整的 endpoint URL
    pub fn endpoint_url(&self) -> String {
        let proto = if self.protocol.is_empty() {
            "http"
        } else {
            &self.protocol
        };
        format!("{}://{}:{}{}", proto, self.host, self.port, self.api_path)
    }
}

/// LLM 调用参数（不同本地模型对参数最优取值不同，开放给用户配置）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmParams {
    pub temperature: f32,
    pub max_tokens: u32,
    pub top_p: f32,
    pub top_k: u32,
}

impl Default for LlmParams {
    fn default() -> Self {
        Self {
            temperature: 1.0,
            max_tokens: 81920,
            top_p: 0.95,
            top_k: 64,
        }
    }
}

/// 5 个 Prompt 模板（全部可在设置界面编辑）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptConfig {
    /// 1-4 题（短对话，每段配 1 题）
    pub q1_4: String,
    /// 5-14 题（长对话/独白，每段配 2 题）
    pub q5_14: String,
    /// 15-18 题（长文本 + 总分表格 + 挖空）
    pub q15_18: String,
    /// 第 15-18 题填空判分 Prompt
    pub q15_18_scoring: String,
    /// 第 19 题转述评分 Prompt
    pub q19_scoring: String,
}

/// 音频相关设置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioConfig {
    /// 播放音量 0.0 ~ 1.0
    pub playback_volume: f32,
    /// 麦克风录音音量增益 0.0 ~ 2.0
    pub mic_gain: f32,
    /// TTS 拼接时轮次间隔静音（毫秒）
    pub tts_silence_ms: u32,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            playback_volume: 1.0,
            mic_gain: 1.0,
            tts_silence_ms: 400,
        }
    }
}

/// 测试流程各阶段时长（毫秒）。
///
/// 所有字段都允许在设置界面调整，保留默认值与 Spec.md 第三节描述一致。
/// RECORDING 时长不在此配置：受 STT/LLM 判分稳定性约束保持 90 秒固定。
/// 每个字段使用 `#[serde(default = ...)]` 让旧配置文件缺字段时自动回退默认值。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimingConfig {
    /// 第 1 题前的开场介绍（INTRO），仅第 1 次进入测试时显示
    #[serde(default = "default_intro_ms")]
    pub intro_ms: u32,
    /// 1-4 题（短对话）PREPARE
    #[serde(default = "default_short_dialogue_prepare_ms")]
    pub short_dialogue_prepare_ms: u32,
    /// 1-4 题（短对话）ANSWERING
    #[serde(default = "default_short_dialogue_answer_ms")]
    pub short_dialogue_answer_ms: u32,
    /// 5-12 / 13-14 题（长对话/独白）PREPARE
    #[serde(default = "default_group_prepare_ms")]
    pub group_prepare_ms: u32,
    /// 5-12 / 13-14 题两次播放之间的静音间隔
    #[serde(default = "default_group_pause_ms")]
    pub group_pause_ms: u32,
    /// 5-12 / 13-14 题 ANSWERING（两题共享）
    #[serde(default = "default_group_answer_ms")]
    pub group_answer_ms: u32,
    /// 15-19 题（听后转述）PREPARE
    #[serde(default = "default_retell_prepare_ms")]
    pub retell_prepare_ms: u32,
    /// 15-19 题两次播放之间的静音间隔
    #[serde(default = "default_retell_pause_ms")]
    pub retell_pause_ms: u32,
    /// 15-19 题 FILL_BLANK（挖空作答）
    #[serde(default = "default_retell_fill_blank_ms")]
    pub retell_fill_blank_ms: u32,
    /// 15-19 题 RECALL_PREP（默读准备）
    #[serde(default = "default_retell_recall_prep_ms")]
    pub retell_recall_prep_ms: u32,
}

fn default_intro_ms() -> u32 {
    10_000
}
fn default_short_dialogue_prepare_ms() -> u32 {
    5_000
}
fn default_short_dialogue_answer_ms() -> u32 {
    10_000
}
fn default_group_prepare_ms() -> u32 {
    10_000
}
fn default_group_pause_ms() -> u32 {
    2_000
}
fn default_group_answer_ms() -> u32 {
    10_000
}
fn default_retell_prepare_ms() -> u32 {
    30_000
}
fn default_retell_pause_ms() -> u32 {
    3_000
}
fn default_retell_fill_blank_ms() -> u32 {
    90_000
}
fn default_retell_recall_prep_ms() -> u32 {
    120_000
}

impl Default for TimingConfig {
    fn default() -> Self {
        Self {
            intro_ms: default_intro_ms(),
            short_dialogue_prepare_ms: default_short_dialogue_prepare_ms(),
            short_dialogue_answer_ms: default_short_dialogue_answer_ms(),
            group_prepare_ms: default_group_prepare_ms(),
            group_pause_ms: default_group_pause_ms(),
            group_answer_ms: default_group_answer_ms(),
            retell_prepare_ms: default_retell_prepare_ms(),
            retell_pause_ms: default_retell_pause_ms(),
            retell_fill_blank_ms: default_retell_fill_blank_ms(),
            retell_recall_prep_ms: default_retell_recall_prep_ms(),
        }
    }
}

/// 整个应用配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub llm: ModelConfig,
    pub tts: ModelConfig,
    pub stt: ModelConfig,
    pub llm_params: LlmParams,
    pub prompts: PromptConfig,
    pub audio: AudioConfig,
    pub timing: TimingConfig,
    /// 题目难度配置：当前选中档 + 三档 prompt 文字
    ///
    /// 缺字段时回退 `DifficultyConfig::default()`，旧配置文件无需迁移。
    #[serde(default)]
    pub difficulty: DifficultyConfig,
}

impl AppConfig {
    /// 默认 LLM api_path
    pub fn default_llm_path() -> &'static str {
        "/v1/chat/completions"
    }

    /// 默认 TTS api_path
    pub fn default_tts_path() -> &'static str {
        "/v1/audio/speech"
    }

    /// 默认 STT api_path
    pub fn default_stt_path() -> &'static str {
        "/v1/audio/transcriptions"
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        let mut llm = ModelConfig::default();
        llm.api_path = AppConfig::default_llm_path().to_string();
        llm.model = "default-llm".to_string();

        let mut tts = ModelConfig::default();
        tts.api_path = AppConfig::default_tts_path().to_string();
        tts.model = "mlx-community/Kokoro-82M-bf16".to_string();

        let mut stt = ModelConfig::default();
        stt.api_path = AppConfig::default_stt_path().to_string();
        stt.model = "mlx-community/whisper-large-v3-turbo-asr-fp16".to_string();

        Self {
            llm,
            tts,
            stt,
            llm_params: LlmParams::default(),
            prompts: default_prompts(),
            audio: AudioConfig::default(),
            timing: TimingConfig::default(),
            difficulty: DifficultyConfig::default(),
        }
    }
}

/// 第九节「LLM Prompt 设计（默认模板）」的默认值
///
/// 这些 Prompt 都可以在设置界面编辑，运行时通过 `prompt_engine::render`
/// 替换 `{{PLACEHOLDER}}`。
pub fn default_prompts() -> PromptConfig {
    PromptConfig {
        q1_4: include_str!("../../prompts/q1_4.txt").to_string(),
        q5_14: include_str!("../../prompts/q5_14.txt").to_string(),
        q15_18: include_str!("../../prompts/q15_18.txt").to_string(),
        q15_18_scoring: include_str!("../../prompts/q15_18_scoring.txt").to_string(),
        q19_scoring: include_str!("../../prompts/q19_scoring.txt").to_string(),
    }
}

/// 单个难度档下三个 prompt 占位符对应文字
///
/// 字段名对应 prompt 模板中的 `{{DIFFICULTY_DEMAND_1_4}}` /
/// `{{DIFFICULTY_DEMAND_5_14}}` / `{{DIFFICULTY_DEMAND_15_18}}`。
/// `#[serde(default)]` 让旧配置文件缺字段时回退空字符串。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DifficultyDemand {
    #[serde(default)]
    pub demand_1_4: String,
    #[serde(default)]
    pub demand_5_14: String,
    #[serde(default)]
    pub demand_15_18: String,
}

impl Default for DifficultyDemand {
    fn default() -> Self {
        Self {
            demand_1_4: String::new(),
            demand_5_14: String::new(),
            demand_15_18: String::new(),
        }
    }
}

/// 难度配置：当前选中档 + 三档文字 + 自适应模式（v1.1+）
///
/// `level` 取值 `"junior_high" | "senior_high" | "undergraduate"`，
/// 表示「手动档」；`mode = "auto"` 时由自适应算法决定实际出题档。
/// 出题时按 `effective_level(state, mode, level)` 解析后注入对应 `demand_*` 文字。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DifficultyConfig {
    /// 自适应模式开关：`"manual"`（默认，使用 `level`）/ `"auto"`（使用自适应 state.current_level）
    #[serde(default = "default_difficulty_mode")]
    pub mode: String,
    /// 手动档（mode = "manual" 时生效；mode = "auto" 时仍记录上次手动选择，auto→manual 重置会用到）
    #[serde(default = "default_difficulty_level")]
    pub level: String,
    #[serde(default)]
    pub junior_high: DifficultyDemand,
    #[serde(default)]
    pub senior_high: DifficultyDemand,
    #[serde(default)]
    pub undergraduate: DifficultyDemand,
}

fn default_difficulty_level() -> String {
    "junior_high".to_string()
}

fn default_difficulty_mode() -> String {
    "manual".to_string()
}

impl Default for DifficultyConfig {
    fn default() -> Self {
        let defaults = default_difficulty_demands();
        Self {
            mode: default_difficulty_mode(),
            level: default_difficulty_level(),
            junior_high: defaults.junior_high,
            senior_high: defaults.senior_high,
            undergraduate: defaults.undergraduate,
        }
    }
}

/// 三档难度的默认文字模板（与前端 `defaultAppConfig().difficulty` 保持一字一致）
///
/// 文字体量小、不含占位符、不需多语言，直接硬编码而非 `include_str!`。
pub fn default_difficulty_demands() -> DifficultyConfig {
    DifficultyConfig {
        mode: default_difficulty_mode(),
        level: default_difficulty_level(),
        junior_high: DifficultyDemand {
            demand_1_4: "对话时M和W每人最多说两次话，对话时不要使用从句和虚拟语气，只能使用简单句。"
                .to_string(),
            demand_5_14: "对话时M和W每人说四次话，独白平均句长控制在8个单词左右。对话/独白不要使用从句和虚拟语气，只能使用简单句。"
                .to_string(),
            demand_15_18: "独白平均句长控制在8个单词左右，独白不要使用从句和虚拟语气，只能使用简单句。"
                .to_string(),
        },
        senior_high: DifficultyDemand {
            demand_1_4: "对话时M和W每人最多说三次话，对话时可以使用从句和虚拟语气，但从句不要嵌套使用。"
                .to_string(),
            demand_5_14: "对话时M和W每人说五次话，独白平均句长控制在12个单词左右。对话/独白可以使用从句和虚拟语气，但从句不要嵌套使用。"
                .to_string(),
            demand_15_18: "独白平均句长控制在12个单词左右，独白可以使用从句和虚拟语气，但从句不要嵌套使用。"
                .to_string(),
        },
        undergraduate: DifficultyDemand {
            demand_1_4: "对话时M和W每人最多说三次话，对话时可以符合语法地任意使用从句和虚拟语气，可适当出现一些专业领域术语，但不要刻意堆砌复杂语法导致影响对话自然度。"
                .to_string(),
            demand_5_14: "对话时M和W每人说六次话，独白平均句长控制在16个单词左右。对话/独白可以符合语法地任意使用从句和虚拟语气，可适当出现一些专业领域术语，但不要刻意堆砌复杂语法导致影响对话自然度。"
                .to_string(),
            demand_15_18: "独白平均句长控制在16个单词左右，独白可以符合语法地任意使用从句和虚拟语气，可适当出现一些专业领域术语，但不要刻意堆砌复杂语法导致影响对话自然度。"
                .to_string(),
        },
    }
}
