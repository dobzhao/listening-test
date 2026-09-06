// 与 Rust 后端 models/config.rs 保持字段一一对应

export interface ModelConfig {
  /** 协议："http" 或 "https" */
  protocol: "http" | "https";
  host: string;
  port: number;
  api_path: string;
  model: string;
  api_key: string;
}

export interface LlmParams {
  temperature: number;
  max_tokens: number;
  top_p: number;
  top_k: number;
}

export interface PromptConfig {
  q1_4: string;
  q5_14: string;
  q15_18: string;
  q15_18_scoring: string;
  q19_scoring: string;
}

export interface AudioConfig {
  playback_volume: number;
  mic_gain: number;
  tts_silence_ms: number;
}

/**
 * 5 段开场介绍文案（纯文字，随 INTRO 阶段展示，不合成语音）。
 * 与 Rust `models::config::IntroConfig` 字段一一对应。
 */
export interface IntroConfig {
  /** 第 1 题前（1-4 题短对话部分） */
  text_1_4: string;
  /** 第 5 题前（5-14 题长对话 + 独白部分） */
  text_5_14: string;
  /** 第 15 题前（15-18 题听后转述填空部分） */
  text_15_18: string;
  /** 15-18 题 PLAYING #3 前（FILL_BLANK 之后、第 3 次播放之前） */
  text_15_18_play3: string;
  /** 第 19 题录音前（默读准备之后） */
  text_19: string;
}

export type IntroKey = keyof IntroConfig;

/**
 * 测试流程各阶段时长（毫秒）。
 * 与 Rust `models::config::TimingConfig` 字段一一对应。
 * RECORDING 时长不在此配置，由后端固定为 90 秒。
 */
export interface TimingConfig {
  intro_ms: number;
  short_dialogue_prepare_ms: number;
  short_dialogue_answer_ms: number;
  group_intro_ms: number;
  group_prepare_ms: number;
  group_pause_ms: number;
  group_answer_ms: number;
  retell_intro_ms: number;
  retell_prepare_ms: number;
  retell_pause_ms: number;
  retell_fill_blank_ms: number;
  retell_recall_prep_ms: number;
  retell_q19_intro_ms: number;
  retell_play3_intro_ms: number;
}

/**
 * 题目难度档位（与 Rust `models::config::DifficultyDemand` 字段一一对应）。
 * 字段名对应 prompt 模板中的
 *   `{{DIFFICULTY_DEMAND_1_4}}` / `{{DIFFICULTY_DEMAND_5_14}}` / `{{DIFFICULTY_DEMAND_15_18}}`。
 */
export interface DifficultyDemand {
  demand_1_4: string;
  demand_5_14: string;
  demand_15_18: string;
}

export type DifficultyLevel = "junior_high" | "senior_high" | "undergraduate";
export type DifficultyDemandKey = "demand_1_4" | "demand_5_14" | "demand_15_18";

/**
 * 难度配置：当前选中档 + 三档文字 + 自适应模式（v1.1+）。
 * 与 Rust `models::config::DifficultyConfig` 字段一一对应。
 */
export interface DifficultyConfig {
  /** 自适应模式：`"manual"`（默认）/ `"auto"` */
  mode: AdaptiveMode;
  /** 手动档（mode = manual 时生效；mode = auto 时记录上次手动选择） */
  level: DifficultyLevel;
  junior_high: DifficultyDemand;
  senior_high: DifficultyDemand;
  undergraduate: DifficultyDemand;
}

/**
 * 自适应难度（v1.1+）
 *
 * - `mode`：`"auto"` 时使用 `adaptive_state.current_level` 出题，
 *   `"manual"` 时使用 `config.difficulty.level`
 * - `state`：`adaptive_state.json` 持久化的运行时态
 * - `params`：15 个算法参数（前端可编辑，落盘到 `adaptive_params.json`）
 */
export type AdaptiveMode = "auto" | "manual";

export interface AdaptiveStateSnapshot {
  ability_score: number;
  trend: number;
  current_level: DifficultyLevel;
  update_count: number;
}

export interface AdaptiveLevelChangedPayload {
  from: DifficultyLevel;
  to: DifficultyLevel;
  ability: number;
  trend: number;
  update_count: number;
}

export interface AdaptiveStateResetPayload {
  new_level: DifficultyLevel;
  ability: number;
  trend: number;
  update_count: number;
  /** UI 据此弹 toast：`auto → manual` 时弹「已切换到手动档，已重置自适应变量」 */
  new_mode: AdaptiveMode;
}

/**
 * 15 个算法参数（与 Rust `adaptive_difficulty::Params` 字段一一对应）。
 * 前端字段名沿用 snake_case 以便与后端 `serde::Deserialize` 直读。
 */
export interface AdaptiveParams {
  weight_a: number;
  weight_b: number;
  weight_c: number;
  score_floor: number;
  alpha: number;
  base_magnitude: number;
  k: number;
  max_magnitude: number;
  b1: number;
  b2: number;
  buffer: number;
  ability_min: number;
  ability_max: number;
  trend_min: number;
  trend_max: number;
}

export const DIFFICULTY_LEVELS: DifficultyLevel[] = [
  "junior_high",
  "senior_high",
  "undergraduate",
];

export const DIFFICULTY_LEVEL_LABELS: Record<DifficultyLevel, string> = {
  junior_high: "初中（Junior High）",
  senior_high: "高中（Senior High）",
  undergraduate: "大学（Undergraduate）",
};

export const DIFFICULTY_DEMAND_KEYS: DifficultyDemandKey[] = [
  "demand_1_4",
  "demand_5_14",
  "demand_15_18",
];

export const DIFFICULTY_DEMAND_LABELS: Record<DifficultyDemandKey, string> = {
  demand_1_4: "1-4 题对话难度要求",
  demand_5_14: "5-14 题对话/独白难度要求",
  demand_15_18: "15-18 题独白难度要求",
};

export interface AppConfig {
  llm: ModelConfig;
  tts: ModelConfig;
  stt: ModelConfig;
  llm_params: LlmParams;
  prompts: PromptConfig;
  audio: AudioConfig;
  timing: TimingConfig;
  intro: IntroConfig;
  difficulty: DifficultyConfig;
}

export interface ConfigResponse {
  config: AppConfig;
  config_path: string;
}

export type PromptKey =
  | "q1_4"
  | "q5_14"
  | "q15_18"
  | "q15_18_scoring"
  | "q19_scoring";

export const PROMPT_KEY_LABELS: Record<PromptKey, string> = {
  q1_4: "1-4 题出题 Prompt（短对话）",
  q5_14: "5-14 题出题 Prompt（长对话/独白）",
  q15_18: "15-18 题出题 Prompt（长文本+表格+挖空）",
  q15_18_scoring: "15-18 题填空判分 Prompt",
  q19_scoring: "19 题转述评分 Prompt",
};

export const PROMPT_PLACEHOLDERS: Record<PromptKey, Array<{ key: string; desc: string }>> = {
  q1_4: [
    { key: "DIALOGUE_SCENARIOS", desc: "4 段短对话的场景清单（运行时随机抽取）" },
    { key: "DIFFICULTY_DEMAND_1_4", desc: "当前档位 1-4 题难度文字要求（在难度 Tab 编辑）" },
  ],
  q5_14: [
    { key: "DIALOGUE_SCENARIOS", desc: "4 段长对话的场景清单（运行时随机抽取）" },
    { key: "MONOLOGUE_SCENARIO", desc: "1 段独白的话题与展开方向（运行时随机抽取）" },
    { key: "DIFFICULTY_DEMAND_5_14", desc: "当前档位 5-14 题难度文字要求（在难度 Tab 编辑）" },
  ],
  q15_18: [
    { key: "MONOLOGUE_SCENARIO", desc: "较长听力材料的话题与 3 个展开方向（运行时随机抽取）" },
    { key: "DIFFICULTY_DEMAND_15_18", desc: "当前档位 15-18 题难度文字要求（在难度 Tab 编辑）" },
  ],
  q15_18_scoring: [
    { key: "ORIGINAL_TEXT", desc: "15-19 题听力材料原文 + 4 空标准答案" },
    { key: "ANSWERS", desc: "用户填写的 4 空答案（pretty JSON 字符串）" },
  ],
  q19_scoring: [
    { key: "ORIGINAL_TEXT", desc: "15-19 题听力材料原文" },
    { key: "STT_RESULT", desc: "第 19 题录音经 STT 转写后的文本" },
  ],
};

export const DEFAULT_LLM_API_PATH = "/v1/chat/completions";
export const DEFAULT_TTS_API_PATH = "/v1/audio/speech";
export const DEFAULT_STT_API_PATH = "/v1/audio/transcriptions";

export const DEFAULT_TTS_MODEL = "mlx-community/Kokoro-82M-bf16";
export const DEFAULT_STT_MODEL = "mlx-community/whisper-large-v3-turbo-asr-fp16";

export function defaultAppConfig(): AppConfig {
  return {
    llm: {
      protocol: "http",
      host: "127.0.0.1",
      port: 8000,
      api_path: DEFAULT_LLM_API_PATH,
      model: "default-llm",
      api_key: "",
    },
    tts: {
      protocol: "http",
      host: "127.0.0.1",
      port: 8000,
      api_path: DEFAULT_TTS_API_PATH,
      model: DEFAULT_TTS_MODEL,
      api_key: "",
    },
    stt: {
      protocol: "http",
      host: "127.0.0.1",
      port: 8000,
      api_path: DEFAULT_STT_API_PATH,
      model: DEFAULT_STT_MODEL,
      api_key: "",
    },
    llm_params: {
      temperature: 1.0,
      max_tokens: 81920,
      top_p: 0.95,
      top_k: 64,
    },
    prompts: {
      q1_4: "",
      q5_14: "",
      q15_18: "",
      q15_18_scoring: "",
      q19_scoring: "",
    },
    audio: {
      playback_volume: 1.0,
      mic_gain: 1.0,
      tts_silence_ms: 400,
    },
    timing: {
      intro_ms: 10000,
      short_dialogue_prepare_ms: 5000,
      short_dialogue_answer_ms: 10000,
      group_intro_ms: 10000,
      group_prepare_ms: 10000,
      group_pause_ms: 2000,
      group_answer_ms: 10000,
      retell_intro_ms: 10000,
      retell_prepare_ms: 30000,
      retell_pause_ms: 3000,
      retell_fill_blank_ms: 90000,
      retell_recall_prep_ms: 120000,
      retell_q19_intro_ms: 10000,
      retell_play3_intro_ms: 10000,
    },
    intro: defaultIntroConfig(),
    difficulty: defaultDifficultyConfig(),
  };
}

/**
 * 5 段开场介绍默认文案（与 Rust `models::config::default_intro_texts()` 一字一致）。
 */
export function defaultIntroConfig(): IntroConfig {
  return {
    text_1_4:
      "听下面四段对话，每段对话后有一道小题，从每题所给的A、B、C三个选项中选出最佳选项，并用鼠标点击该选项。听对话前，你将有时间阅读每小题。听完后，每小题将有作答时间，每段对话你将听一遍。",
    text_5_14:
      "听下面五段对话或独白，每段对话或独白后有两道小题，从每题所给的A、B、C三个选项中选出最佳选项，并用鼠标点击该选项。听每段对话或独白前，你将有时间阅读每小题。听完后，每小题将有作答时间。每段对话或独白你将听两遍。",
    text_15_18:
      "听两遍短文，根据所听内容和提示，将所缺的关键信息填写在相应位置上，每空只需填写一个词。",
    text_15_18_play3: "现在，请开始做转述准备。",
    text_19: "下面，请准备录音。倒计时结束后，在90秒内完成转述。",
  };
}

/**
 * 三档难度默认文字（与 Rust `models::config::default_difficulty_demands()` 一字一致）。
 */
export function defaultDifficultyConfig(): DifficultyConfig {
  return {
    mode: "manual",
    level: "junior_high",
    junior_high: {
      demand_1_4:
        "对话时M和W每人最多说两次话，对话时不要使用从句和虚拟语气，只能使用简单句。",
      demand_5_14:
        "对话时M和W每人说四次话，独白平均句长控制在8个单词左右。对话/独白不要使用从句和虚拟语气，只能使用简单句。",
      demand_15_18:
        "独白平均句长控制在8个单词左右，独白不要使用从句和虚拟语气，只能使用简单句。",
    },
    senior_high: {
      demand_1_4:
        "对话时M和W每人最多说三次话，对话时可以使用从句和虚拟语气，但从句不要嵌套使用。",
      demand_5_14:
        "对话时M和W每人说五次话，独白平均句长控制在12个单词左右。对话/独白可以使用从句和虚拟语气，但从句不要嵌套使用。",
      demand_15_18:
        "独白平均句长控制在12个单词左右，独白可以使用从句和虚拟语气，但从句不要嵌套使用。",
    },
    undergraduate: {
      demand_1_4:
        "对话时M和W每人最多说三次话，对话时可以符合语法地任意使用从句和虚拟语气，可适当出现一些专业领域术语，但不要刻意堆砌复杂语法导致影响对话自然度。",
      demand_5_14:
        "对话时M和W每人说六次话，独白平均句长控制在16个单词左右。对话/独白可以符合语法地任意使用从句和虚拟语气，可适当出现一些专业领域术语，但不要刻意堆砌复杂语法导致影响对话自然度。",
      demand_15_18:
        "独白平均句长控制在16个单词左右，独白可以符合语法地任意使用从句和虚拟语气，可适当出现一些专业领域术语，但不要刻意堆砌复杂语法导致影响对话自然度。",
    },
  };
}

/**
 * 15 个算法参数默认值（与 Rust `adaptive_difficulty::Params::default()` 一字一致）。
 */
export function defaultAdaptiveParams(): AdaptiveParams {
  return {
    weight_a: 0.5,
    weight_b: 0.2,
    weight_c: 0.3,
    score_floor: 0.6,
    alpha: 0.4,
    base_magnitude: 3.0,
    k: 10.0,
    max_magnitude: 8.0,
    b1: 200.0,
    b2: 400.0,
    buffer: 20.0,
    ability_min: 0.0,
    ability_max: 600.0,
    trend_min: -1.0,
    trend_max: 1.0,
  };
}
