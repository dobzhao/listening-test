//! 题目生成服务：根据 Prompt 模板调用 LLM 并解析为强类型
//!
//! 三次 LLM 调用：
//! - `q1_4`：4 段短对话，每段配 1 题
//! - `q5_14`：4 段长对话 + 1 段独白，每段/每独白配 2 题
//! - `q15_18`：1 段较长听力材料 + 总-分表格 + 4 个挖空

use crate::models::config::{
    AppConfig, DifficultyConfig, DifficultyDemand, LlmParams, ModelConfig, PromptConfig,
};
use crate::models::question::{
    LongDialogue, Monologue, MultipleChoiceQuestion, RetellMaterial, ShortDialogue,
};
use crate::services::llm_service::{call_llm_with_feedback, ChatMessage, LlmError, truncate_for_feedback};
use crate::services::prompt_engine_service::render;
use crate::services::scenario_picker::{
    pick_dialogue_scenarios_json, pick_monologue_scenario_json,
};
use crate::utils::json_extract::try_parse;
use crate::utils::retry::RetryConfig;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use thiserror::Error;
use tracing::{info, warn};

use once_cell::sync::Lazy;
use regex::Regex;

#[derive(Debug, Error)]
pub enum GenError {
    #[error("LLM 调用失败: {0}")]
    Llm(#[from] LlmError),
    #[error("Prompt 渲染失败: {0}")]
    Prompt(String),
    #[error("JSON 解析失败: {0}")]
    Json(#[from] serde_json::Error),
    #[error("文本合规检查未通过: {0}")]
    Compliance(String),
    #[error("重试多次后仍无法生成有效结果")]
    Exhausted,
}

/// 1-4 题的 LLM 输出（数组）
type Q1To4Raw = Vec<ShortDialogueRaw>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortDialogueRaw {
    pub id: u32,
    pub question: String,
    pub dialogue: Vec<DialogueTurnRaw>,
    pub options: HashMap<String, String>,
    pub answer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DialogueTurnRaw {
    pub speaker: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Q5To14Raw {
    pub dialogues: Vec<LongDialogueRaw>,
    pub monologue: MonologueRaw,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LongDialogueRaw {
    pub id: u32,
    pub dialogue: Vec<DialogueTurnRaw>,
    pub questions: Vec<MultipleChoiceQuestionRaw>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonologueRaw {
    pub text: String,
    pub questions: Vec<MultipleChoiceQuestionRaw>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultipleChoiceQuestionRaw {
    pub id: u32,
    pub question: String,
    pub options: HashMap<String, String>,
    pub answer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Q15To18Raw {
    pub passage: String,
    pub table: TableRaw,
    pub blanks: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableRaw {
    pub rows: Vec<TableRowRaw>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableRowRaw {
    pub overview: String,
    pub details: Vec<String>,
}

/// 匹配 passage 中所有 `___NN___` 占位符（NN 为 1-2 位数字）。
///
/// 编译期 `expect` 失败代表正则表达式字面量本身写错——开发期就 panic，不进运行时。
static Q15_18_BLANK_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"___(\d{1,2})___").expect("Q15_18_BLANK_RE 编译失败")
});

// ===== 1-4 题 =====

/// 生成 1-4 题：4 段短对话，每段配 1 题
///
/// `effective_level` 是「实际生效档」：手动档下等于 `config.difficulty.level`，
/// 自动档下等于 `adaptive_state.current_level`（v1.1+）。
/// 出题场景池（dialogue/monologue）的随机抽取与 `demand_*` 文字都按它走。
pub async fn generate_q1_4(
    http_client: &reqwest::Client,
    llm_cfg: &ModelConfig,
    llm_params: &LlmParams,
    prompts: &PromptConfig,
    difficulty: &DifficultyConfig,
    effective_level: &str,
) -> Result<Vec<ShortDialogue>, GenError> {
    let mut vars = HashMap::new();
    inject_difficulty_vars(&mut vars, difficulty, effective_level);
    let dialogue_json = pick_dialogue_scenarios_json(effective_level);
    vars.insert("DIALOGUE_SCENARIOS", &dialogue_json);
    let prompt = render(&prompts.q1_4, &vars).map_err(|e| GenError::Prompt(e.to_string()))?;

    let retry = RetryConfig {
        max_retries: 2,
        ..Default::default()
    };

    let http = http_client.clone();
    let cfg = llm_cfg.clone();
    let params = llm_params.clone();

    let messages = vec![ChatMessage::user(prompt)];
    let raw: Q1To4Raw = generate_with_feedback(
        &http,
        &cfg,
        &params,
        &retry,
        "generate_q1_4",
        messages,
        validate_q1_4,
    )
    .await?;

    Ok(raw.into_iter().map(into_short_dialogue).collect())
}

// ===== 5-14 题 =====

/// 生成 5-14 题：4 段长对话 + 1 段独白
///
/// 返回 (long_dialogues, monologue)。`effective_level` 语义见 `generate_q1_4`。
pub async fn generate_q5_14(
    http_client: &reqwest::Client,
    llm_cfg: &ModelConfig,
    llm_params: &LlmParams,
    prompts: &PromptConfig,
    difficulty: &DifficultyConfig,
    effective_level: &str,
) -> Result<(Vec<LongDialogue>, Monologue), GenError> {
    let mut vars = HashMap::new();
    inject_difficulty_vars(&mut vars, difficulty, effective_level);
    let dialogue_json = pick_dialogue_scenarios_json(effective_level);
    vars.insert("DIALOGUE_SCENARIOS", &dialogue_json);
    let monologue_json = pick_monologue_scenario_json(effective_level);
    vars.insert("MONOLOGUE_SCENARIO", &monologue_json);
    let prompt = render(&prompts.q5_14, &vars).map_err(|e| GenError::Prompt(e.to_string()))?;

    let retry = RetryConfig {
        max_retries: 2,
        ..Default::default()
    };

    let http = http_client.clone();
    let cfg = llm_cfg.clone();
    let params = llm_params.clone();

    let messages = vec![ChatMessage::user(prompt)];
    let raw: Q5To14Raw = generate_with_feedback(
        &http,
        &cfg,
        &params,
        &retry,
        "generate_q5_14",
        messages,
        validate_q5_14,
    )
    .await?;

    let long_dialogues: Vec<LongDialogue> = raw.dialogues.into_iter().map(into_long_dialogue).collect();
    let monologue = into_monologue(raw.monologue);
    Ok((long_dialogues, monologue))
}

// ===== 15-18 题 =====

/// 生成 15-19 题听力材料与挖空表格
///
/// `effective_level` 语义见 `generate_q1_4`。
pub async fn generate_q15_18(
    http_client: &reqwest::Client,
    llm_cfg: &ModelConfig,
    llm_params: &LlmParams,
    prompts: &PromptConfig,
    difficulty: &DifficultyConfig,
    effective_level: &str,
) -> Result<RetellMaterial, GenError> {
    let mut vars = HashMap::new();
    inject_difficulty_vars(&mut vars, difficulty, effective_level);
    let monologue_json = pick_monologue_scenario_json(effective_level);
    vars.insert("MONOLOGUE_SCENARIO", &monologue_json);
    let prompt = render(&prompts.q15_18, &vars).map_err(|e| GenError::Prompt(e.to_string()))?;

    let retry = RetryConfig {
        max_retries: 2,
        ..Default::default()
    };

    let http = http_client.clone();
    let cfg = llm_cfg.clone();
    let params = llm_params.clone();

    let messages = vec![ChatMessage::user(prompt)];
    let raw: Q15To18Raw = generate_with_feedback(
        &http,
        &cfg,
        &params,
        &retry,
        "generate_q15_18",
        messages,
        validate_q15_18,
    )
    .await?;

    Ok(into_retell_material(raw))
}

// ===== 内部辅助 =====

/// 根据 `level`（手动档 = config.difficulty.level；自动档 = adaptive_state.current_level）
/// 选择当前激活档的文字，三个 prompt 占位符同时注入。
///
/// 即使某些 prompt 只用到其中一个 demand_*，三个 key 都注入也不影响渲染
/// （`render` 函数会忽略 vars 中未被模板引用的 key）。
/// 未知 level 或缺字段时兜底到 `junior_high`，避免运行时 panic。
fn inject_difficulty_vars<'a>(
    vars: &mut HashMap<&'a str, &'a str>,
    difficulty: &'a DifficultyConfig,
    level: &'a str,
) {
    let demand: &DifficultyDemand = match level {
        "senior_high" => &difficulty.senior_high,
        "undergraduate" => &difficulty.undergraduate,
        _ => &difficulty.junior_high,
    };
    vars.insert("DIFFICULTY_DEMAND_1_4", demand.demand_1_4.as_str());
    vars.insert("DIFFICULTY_DEMAND_5_14", demand.demand_5_14.as_str());
    vars.insert("DIFFICULTY_DEMAND_15_18", demand.demand_15_18.as_str());
}

/// 解析 LLM 输出 + 自定义校验
fn parse_with_validation<T, F>(text: &str, validate: F) -> Result<T, GenError>
where
    T: serde::de::DeserializeOwned,
    F: FnOnce(&T) -> Result<(), String>,
{
    let parsed: T = try_parse(text)?;
    validate(&parsed).map_err(GenError::Compliance)?;
    Ok(parsed)
}

/// 带反馈的多轮调用重试：出题专用薄封装。
///
/// 复用 `call_llm_with_feedback`，针对 `GenError` 给出：
/// - 可重试错误：`Llm` / `Json` / `Compliance`
/// - 不可重试：`Prompt`（模板渲染失败）
async fn generate_with_feedback<T, F>(
    http: &reqwest::Client,
    cfg: &ModelConfig,
    params: &LlmParams,
    retry: &RetryConfig,
    op_name: &str,
    initial_messages: Vec<ChatMessage>,
    validate: F,
) -> Result<T, GenError>
where
    T: serde::de::DeserializeOwned,
    F: Fn(&T) -> Result<(), String>,
{
    call_llm_with_feedback(
        http,
        cfg,
        params,
        retry,
        op_name,
        initial_messages,
        |text| parse_with_validation::<T, _>(text, &validate),
        |e| matches!(e, GenError::Llm(_) | GenError::Json(_) | GenError::Compliance(_)),
        build_feedback_message,
    )
    .await
}

/// 构造发给 LLM 的反馈消息（user 角色）
///
/// 针对不同错误类型给出针对性指令，让 LLM 知道上次具体错在哪。
/// 反馈中包含被截断的上次输出（前 1500 字 + 后 500 字），便于 LLM 定位问题；
/// 同时避免长对话导致 token 爆炸。对 `Llm` 错误（未拿到 LLM 响应）则不附带原文。
fn build_feedback_message(err: &GenError, prev_output: &str) -> String {
    match err {
        GenError::Json(e) => {
            let truncated = truncate_for_feedback(prev_output, 1500, 500);
            format!(
                "你上一次的输出无法被解析为 JSON：{}.\n\n\
                 你的上一次输出（已截断）：\n```\n{truncated}\n```\n\n\
                 请严格按要求的 JSON 格式重新输出，**只输出 JSON**，不要包含任何解释性文字、注释或 Markdown 代码块标记。",
                e
            )
        }
        GenError::Compliance(msg) => {
            let truncated = truncate_for_feedback(prev_output, 1500, 500);
            format!(
                "你的上一次输出不符合要求：{}.\n\n\
                 你的上一次输出（已截断）：\n```\n{truncated}\n```\n\n\
                 请根据以上错误信息重新生成，确保完全符合所有要求。",
                msg
            )
        }
        GenError::Llm(e) => format!(
            "上一次调用 LLM 出现错误：{}. 请重新生成，注意保持格式严格符合要求。",
            e
        ),
        _ => format!("上一次生成失败：{}. 请重新生成。", err),
    }
}

/// 校验 1-4 题结构
fn validate_q1_4(raw: &Q1To4Raw) -> Result<(), String> {
    if raw.len() != 4 {
        return Err(format!("期望 4 段对话，实际 {} 段", raw.len()));
    }
    for (i, d) in raw.iter().enumerate() {
        if d.dialogue.is_empty() {
            return Err(format!("第 {} 段对话为空", i + 1));
        }
        validate_choice_question(&d.options, &d.answer, &format!("第 {} 段对话", i + 1))?;
    }
    Ok(())
}

/// 校验 5-14 题结构
fn validate_q5_14(raw: &Q5To14Raw) -> Result<(), String> {
    if raw.dialogues.len() != 4 {
        return Err(format!("期望 4 段长对话，实际 {} 段", raw.dialogues.len()));
    }
    for (i, d) in raw.dialogues.iter().enumerate() {
        if d.dialogue.is_empty() {
            return Err(format!("第 {} 段长对话内容为空", i + 1));
        }
        if d.questions.len() != 2 {
            return Err(format!(
                "第 {} 段长对话应配 2 题，实际 {} 题",
                i + 1,
                d.questions.len()
            ));
        }
        for (j, q) in d.questions.iter().enumerate() {
            validate_choice_question(&q.options, &q.answer, &format!("第 {} 段长对话第 {} 题", i + 1, j + 1))?;
        }
    }
    if raw.monologue.text.trim().is_empty() {
        return Err("独白文本为空".to_string());
    }
    if raw.monologue.questions.len() != 2 {
        return Err(format!(
            "独白应配 2 题，实际 {} 题",
            raw.monologue.questions.len()
        ));
    }
    for (j, q) in raw.monologue.questions.iter().enumerate() {
        validate_choice_question(&q.options, &q.answer, &format!("独白第 {} 题", j + 1))?;
    }
    Ok(())
}

/// 校验单道选择题：答案 ∈ {A,B,C} 且选项数 = 3
fn validate_choice_question(
    options: &HashMap<String, String>,
    answer: &str,
    label: &str,
) -> Result<(), String> {
    if !["A", "B", "C"].contains(&answer) {
        return Err(format!("{} 答案不合法: {}", label, answer));
    }
    if options.len() != 3 {
        return Err(format!(
            "{} 选项数量应为 3，实际 {}",
            label,
            options.len()
        ));
    }
    Ok(())
}

/// 校验 15-18 题结构
///
/// 硬校验（违反即 `Err` 触发重试反馈给 LLM）：
///   1. table 必须 3 行
///   2. blanks 必须包含 "15".."18" 全部 4 个 key
///   3. 每个 blank value 必须非空
///   4. 表格 Details 中 `___NN___` 占位符总数必须正好 4 个，且 NN ∈ {15,16,17,18} 互不重复
///   5. passage 必须是完整原文，**不得**包含任何 `___NN___` 占位符
///      （passage 会原样送进 TTS 与评分原文）
///
/// 软校验（WARN 不阻断）：词数偏离 150-300 区间
fn validate_q15_18(raw: &Q15To18Raw) -> Result<(), String> {
    // —— 软校验：词数 ——
    let wc = raw.passage.split_whitespace().count();
    if !(150..=300).contains(&wc) {
        warn!(words = wc, "听力材料词数偏离 200-220 范围");
    }

    // —— 硬校验 1：table 行数 ——
    if raw.table.rows.len() != 3 {
        return Err(format!("表格应为 3 行，实际 {} 行", raw.table.rows.len()));
    }

    // —— 硬校验 2 + 3：blanks key 存在性 + value 非空 ——
    for key in ["15", "16", "17", "18"] {
        match raw.blanks.get(key) {
            None => return Err(format!("缺少第 {} 题标准答案", key)),
            Some(v) if v.trim().is_empty() => {
                return Err(format!("第 {} 题标准答案为空字符串", key))
            }
            _ => {}
        }
    }

    // —— 硬校验 4：表格 Details 中 `___NN___` 占位符总数 = 4 且 NN ∈ {15,16,17,18} 互不重复 ——
    let placeholders: Vec<String> = raw
        .table
        .rows
        .iter()
        .flat_map(|r| r.details.iter())
        .flat_map(|d| Q15_18_BLANK_RE.captures_iter(d))
        .map(|cap| cap[1].to_string())
        .collect();
    let in_scope: Vec<&String> = placeholders
        .iter()
        .filter(|n| matches!(n.as_str(), "15" | "16" | "17" | "18"))
        .collect();

    if in_scope.len() != 4 {
        let found = if placeholders.is_empty() {
            "<无>".to_string()
        } else {
            placeholders
                .iter()
                .map(|n| format!("___{}___", n))
                .collect::<Vec<_>>()
                .join(", ")
        };
        return Err(format!(
            "表格 Details 中 `___NN___` 占位符必须正好 4 个且编号 ∈ {{15,16,17,18}}，\
实际在 scope 内找到 {} 个（找到的全部占位符：{}）",
            in_scope.len(),
            found
        ));
    }
    let unique: std::collections::HashSet<&str> = in_scope.iter().map(|s| s.as_str()).collect();
    if unique.len() != 4 {
        let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for n in &in_scope {
            *counts.entry(n.as_str()).or_insert(0) += 1;
        }
        let dup_list: Vec<String> = counts
            .iter()
            .filter(|(_, c)| **c > 1)
            .map(|(n, c)| format!("___{}___ 出现 {} 次", n, c))
            .collect();
        let missing: Vec<&str> = ["15", "16", "17", "18"]
            .iter()
            .copied()
            .filter(|k| !unique.contains(k))
            .collect();
        return Err(format!(
            "表格 Details 中占位符重复或缺失：重复=[{}]，缺失=[{}]",
            dup_list.join("; "),
            missing.join(", ")
        ));
    }

    // —— 硬校验 5：passage 中不得残留 `___NN___` ——
    let leaked: Vec<String> = Q15_18_BLANK_RE
        .captures_iter(&raw.passage)
        .map(|cap| format!("___{}___", &cap[1]))
        .collect();
    if !leaked.is_empty() {
        return Err(format!(
            "passage 必须是完整原文，不得包含挖空占位符（发现：{}），\
             占位符只能出现在表格 Details 中",
            leaked.join(", ")
        ));
    }

    Ok(())
}

fn into_short_dialogue(raw: ShortDialogueRaw) -> ShortDialogue {
    let id = raw.id;
    let question_text = raw.question;
    let options = raw.options;
    let answer = raw.answer;
    let dialogue = raw.dialogue;
    ShortDialogue {
        id,
        dialogue: dialogue
            .into_iter()
            .map(|t| crate::models::question::DialogueTurn {
                speaker: t.speaker,
                text: t.text,
            })
            .collect(),
        question: MultipleChoiceQuestion {
            id,
            question: question_text,
            options: normalize_options(options),
            answer: normalize_answer(answer),
        },
    }
}

fn into_long_dialogue(raw: LongDialogueRaw) -> LongDialogue {
    let id = raw.id;
    let dialogue = raw.dialogue;
    let mut qs: Vec<MultipleChoiceQuestion> = raw
        .questions
        .into_iter()
        .map(|q| MultipleChoiceQuestion {
            id: q.id,
            question: q.question,
            options: normalize_options(q.options),
            answer: normalize_answer(q.answer),
        })
        .collect();
    // 防御性：确保长度 = 2（虽然 LLM 应该输出 2 题）
    while qs.len() < 2 {
        qs.push(MultipleChoiceQuestion {
            id: 0,
            question: String::new(),
            options: default_options(),
            answer: "A".to_string(),
        });
    }
    let q1 = qs.remove(0);
    let q2 = qs.remove(0);
    LongDialogue {
        id,
        dialogue: dialogue
            .into_iter()
            .map(|t| crate::models::question::DialogueTurn {
                speaker: t.speaker,
                text: t.text,
            })
            .collect(),
        questions: [q1, q2],
    }
}

fn into_monologue(raw: MonologueRaw) -> Monologue {
    let mut qs: Vec<MultipleChoiceQuestion> = raw
        .questions
        .into_iter()
        .map(|q| MultipleChoiceQuestion {
            id: q.id,
            question: q.question,
            options: normalize_options(q.options),
            answer: normalize_answer(q.answer),
        })
        .collect();
    while qs.len() < 2 {
        qs.push(MultipleChoiceQuestion {
            id: 0,
            question: String::new(),
            options: default_options(),
            answer: "A".to_string(),
        });
    }
    let q1 = qs.remove(0);
    let q2 = qs.remove(0);
    Monologue {
        text: raw.text,
        questions: [q1, q2],
    }
}

fn into_retell_material(raw: Q15To18Raw) -> RetellMaterial {
    use crate::models::question::{SummaryTable, TableRow};

    let mut rows: Vec<TableRow> = raw
        .table
        .rows
        .into_iter()
        .map(|r| TableRow {
            overview: r.overview,
            details: r.details,
        })
        .collect();
    // 防御性补齐到 3 行
    while rows.len() < 3 {
        rows.push(TableRow {
            overview: String::new(),
            details: vec![],
        });
    }
    let r1 = rows.remove(0);
    let r2 = rows.remove(0);
    let r3 = rows.remove(0);

    let table = SummaryTable { rows: [r1, r2, r3] };

    let mut blanks_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for key in ["15", "16", "17", "18"] {
        let v = raw
            .blanks
            .get(key)
            .cloned()
            .unwrap_or_else(|| String::new());
        blanks_map.insert(key.to_string(), v);
    }

    RetellMaterial {
        passage: raw.passage,
        table,
        blanks: blanks_map,
    }
}

/// 把 LLM 输出的 options HashMap 标准化为 {"A": "...", "B": "...", "C": "..."}
fn normalize_options(
    raw: HashMap<String, String>,
) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for k in ["A", "B", "C"] {
        let v = raw.get(k).cloned().unwrap_or_default();
        out.insert(k.to_string(), v);
    }
    out
}

fn default_options() -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    out.insert("A".to_string(), String::new());
    out.insert("B".to_string(), String::new());
    out.insert("C".to_string(), String::new());
    out
}

fn normalize_answer(a: String) -> String {
    match a.to_uppercase().as_str() {
        "A" => "A".to_string(),
        "B" => "B".to_string(),
        "C" => "C".to_string(),
        _ => "A".to_string(),
    }
}

// ShortDialogueRaw 的 question 字段需要派生 id，这里手动补（实际未使用）
#[allow(dead_code)]
impl ShortDialogueRaw {
    pub fn question_id(&self) -> u32 {
        self.id
    }
}

/// Phase 2 验证辅助：用一个最小 mock config 生成
#[allow(dead_code)]
pub async fn generate_all_for_test(
    http_client: &reqwest::Client,
    config: &AppConfig,
    effective_level: &str,
) -> Result<
    (
        Vec<ShortDialogue>,
        Vec<LongDialogue>,
        Monologue,
        RetellMaterial,
    ),
    GenError,
> {
    info!("开始生成 1-4 题");
    let short = generate_q1_4(
        http_client,
        &config.llm,
        &config.llm_params,
        &config.prompts,
        &config.difficulty,
        effective_level,
    )
    .await?;

    info!("开始生成 5-14 题");
    let (long, monologue) = generate_q5_14(
        http_client,
        &config.llm,
        &config.llm_params,
        &config.prompts,
        &config.difficulty,
        effective_level,
    )
    .await?;

    info!("开始生成 15-18 题");
    let retell = generate_q15_18(
        http_client,
        &config.llm,
        &config.llm_params,
        &config.prompts,
        &config.difficulty,
        effective_level,
    )
    .await?;

    Ok((short, long, monologue, retell))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_table() -> Vec<TableRowRaw> {
        fixture_table_with(vec![
            vec!["row0 contains ___15___".to_string()],
            vec!["row1 contains ___16___".to_string()],
            vec![
                "row2a contains ___17___".to_string(),
                "row2b contains ___18___".to_string(),
            ],
        ])
    }

    fn fixture_table_with(rows: Vec<Vec<String>>) -> Vec<TableRowRaw> {
        rows.into_iter()
            .enumerate()
            .map(|(i, details)| TableRowRaw {
                overview: format!("ov{}", i),
                details,
            })
            .collect()
    }

    fn fixture_blanks() -> HashMap<String, String> {
        [
            ("15".to_string(), "young".to_string()),
            ("16".to_string(), "teacher".to_string()),
            ("17".to_string(), "colour".to_string()),
            ("18".to_string(), "rules".to_string()),
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn validate_q15_18_ok() {
        // passage 必须保持完整原文：4 个关键词原样出现，不含 ___NN___
        let passage = "The young teacher brought several fresh colour samples to class today. \
                       Students watched carefully as the teacher explained the rules. \
                       They learned about colours and rules in great detail."
            .to_string();
        let raw = Q15To18Raw {
            passage,
            table: TableRaw { rows: fixture_table() },
            blanks: fixture_blanks(),
        };
        assert!(validate_q15_18(&raw).is_ok());
    }

    /// 用户反馈的核心场景：表格 Details 只挖了 2 个空，但 blanks map 有 4 个 key
    #[test]
    fn validate_q15_18_rejects_missing_two_blanks() {
        let raw = Q15To18Raw {
            passage: "The young teacher explained rules clearly to every student today."
                .to_string(),
            table: TableRaw {
                rows: fixture_table_with(vec![
                    vec!["row0 contains ___15___".to_string()],
                    vec!["row1 contains ___16___".to_string()],
                    vec!["row2 contains no placeholder".to_string()],
                ]),
            },
            blanks: [
                ("15".to_string(), "students".to_string()),
                ("16".to_string(), "all".to_string()),
                ("17".to_string(), "students".to_string()),
                ("18".to_string(), "all".to_string()),
            ]
            .into_iter()
            .collect(),
        };
        let err = validate_q15_18(&raw).unwrap_err();
        assert!(err.contains("占位符必须正好 4 个"), "实际错误：{}", err);
        assert!(err.contains("2 个"), "实际错误：{}", err);
        assert!(err.contains("表格 Details"), "实际错误：{}", err);
    }

    #[test]
    fn validate_q15_18_rejects_empty_blank_value() {
        let raw = Q15To18Raw {
            passage: "The young teacher explained rules clearly to every student today."
                .to_string(),
            table: TableRaw { rows: fixture_table() },
            blanks: [
                ("15".to_string(), "students".to_string()),
                ("16".to_string(), "all".to_string()),
                ("17".to_string(), "".to_string()), // 空串
                ("18".to_string(), "daily".to_string()),
            ]
            .into_iter()
            .collect(),
        };
        let err = validate_q15_18(&raw).unwrap_err();
        assert!(err.contains("空字符串"), "实际错误：{}", err);
        assert!(err.contains("17"), "实际错误：{}", err);
    }

    #[test]
    fn validate_q15_18_rejects_duplicate_placeholder() {
        // 表格 Details 中 `___15___` 出现 2 次、缺 `___18___` → 进入"重复/缺失"分支
        let raw = Q15To18Raw {
            passage: "The young teacher explained rules clearly to every student today."
                .to_string(),
            table: TableRaw {
                rows: fixture_table_with(vec![
                    vec!["row0a contains ___15___".to_string()],
                    vec!["row1 contains ___16___".to_string()],
                    vec![
                        "row2a contains ___15___ again".to_string(),
                        "row2b contains ___17___".to_string(),
                    ],
                ]),
            },
            blanks: [
                ("15".to_string(), "students".to_string()),
                ("16".to_string(), "all".to_string()),
                ("17".to_string(), "students".to_string()),
                ("18".to_string(), "all".to_string()),
            ]
            .into_iter()
            .collect(),
        };
        let err = validate_q15_18(&raw).unwrap_err();
        assert!(err.contains("占位符重复或缺失"), "实际错误：{}", err);
        assert!(err.contains("___15___"), "实际错误：{}", err);
    }

    /// 反向守卫：即使表格 Details 4 个占位符齐全，passage 里出现占位符也会被硬校验 5 拒掉。
    /// 这是本次线上问题的核心——老校验只看 passage，新校验双侧约束。
    #[test]
    fn validate_q15_18_rejects_placeholder_in_passage() {
        let raw = Q15To18Raw {
            passage: "The young teacher explained rules clearly. \
                       ___15___ watched and ___16___ learned about ___17___ and ___18___."
                .to_string(),
            table: TableRaw { rows: fixture_table() },
            blanks: fixture_blanks(),
        };
        let err = validate_q15_18(&raw).unwrap_err();
        assert!(err.contains("passage"), "实际错误：{}", err);
        assert!(err.contains("___15___"), "实际错误：{}", err);
    }
}
