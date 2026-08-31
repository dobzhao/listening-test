//! 测试会话编排：串联 LLM 题目生成 + TTS 音频合成 + 进度事件
//!
//! 流程：
//! 1. 调用方提供 `session_id` 与 `base_dir`
//! 2. 调用 `question_generator` 生成 3 组题目
//! 3. 调用 `audio_pipeline` 合成所有音频（写入 `base_dir/audio/`）
//! 4. 拼装 TestSession，写入 `base_dir/session.json`
//! 5. 通过 Tauri Event 推送进度，前端可订阅

use crate::models::config::AppConfig;
use crate::models::question::TestSession;
use crate::services::audio_pipeline::synthesize_all;
use crate::services::http_client::build_client;
use crate::services::question_generator::{generate_q15_18, generate_q1_4, generate_q5_14};
use crate::utils::path::session_cache_dir;
use crate::utils::retry::RetryConfig;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use thiserror::Error;
use tracing::{error, info};
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("HTTP 客户端构建失败: {0}")]
    HttpClient(String),
    #[error("题目生成失败: {0}")]
    Generator(#[from] crate::services::question_generator::GenError),
    #[error("音频合成失败: {0}")]
    Audio(#[from] crate::services::audio_pipeline::AudioPipelineError),
    #[error("I/O 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("缓存目录创建失败: {0}")]
    CacheDir(String),
}

/// 进度事件 payload
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub stage: String, // "llm_q1_4" | "llm_q5_14" | "llm_q15_18" | "tts" | "done"
    pub message: String,
    pub progress: f32, // 0.0 ~ 1.0
}

pub const PROGRESS_EVENT: &str = "test-generation-progress";

/// 完整预生成测试会话（向后兼容的便捷封装）：
/// - 生成 UUID session_id
/// - 创建 `<app_data_dir>/cache/{session_id}/` 作为 base_dir
/// - 调用 `generate_full_session_at` 完成实际生成
///
/// `effective_level` 由调用方（`commands::test_session::generate_test_session`）按
/// mode（manual → `config.difficulty.level`；auto → `adaptive_state.current_level`）解析后传入，
/// 三个生成器内部用它选场景池 + 注入 `{{DIFFICULTY_DEMAND_*}}` 占位符文字（v1.1+）。
pub async fn generate_full_session(
    app: &AppHandle,
    config: &AppConfig,
    effective_level: &str,
) -> Result<TestSession, SessionError> {
    let session_id = Uuid::new_v4().to_string();
    let cache_dir = session_cache_dir(app, &session_id).map_err(SessionError::CacheDir)?;
    generate_full_session_at(app, config, effective_level, &session_id, &cache_dir).await
}

/// 在指定 base_dir 下完整预生成一套测试会话（v1.1+：预生成题库复用此函数）
///
/// - `session_id` 由调用方生成（pregen worker 也用 UUID v4）；通过参数传入便于前端跨进程关联
/// - `base_dir` 必须已存在；`audio/` 子目录由 `synthesize_all` 自动创建
/// - 所有题目与音频写入 `base_dir/{session.json, audio/*.wav}`
/// - 进度事件仍发 `test-generation-progress`；调用方（pregen worker）会在此基础上
///   再发自己的 `pregen-progress` 事件，含 session_id / current / total 字段
pub async fn generate_full_session_at(
    app: &AppHandle,
    config: &AppConfig,
    effective_level: &str,
    session_id: &str,
    base_dir: &Path,
) -> Result<TestSession, SessionError> {
    let http_client =
        build_client().map_err(|e| SessionError::HttpClient(e.to_string()))?;

    info!(
        session_id = %session_id,
        effective_level = %effective_level,
        base_dir = %base_dir.display(),
        "开始预生成测试会话"
    );

    // 1. 1-4 题
    emit_progress(app, "llm_q1_4", "正在生成 1-4 题对话与选项", 0.1);
    let short_dialogues = generate_q1_4(
        &http_client,
        &config.llm,
        &config.llm_params,
        &config.prompts,
        &config.difficulty,
        effective_level,
    )
    .await?;
    info!("1-4 题生成完成，共 {} 段", short_dialogues.len());

    // 2. 5-14 题
    emit_progress(app, "llm_q5_14", "正在生成 5-14 题长对话与独白", 0.35);
    let (long_dialogues, monologue) = generate_q5_14(
        &http_client,
        &config.llm,
        &config.llm_params,
        &config.prompts,
        &config.difficulty,
        effective_level,
    )
    .await?;
    info!(
        "5-14 题生成完成：{} 段长对话 + 1 段独白",
        long_dialogues.len()
    );

    // 3. 15-18 题
    emit_progress(app, "llm_q15_18", "正在生成 15-18 题听力材料与表格", 0.55);
    let retell = generate_q15_18(
        &http_client,
        &config.llm,
        &config.llm_params,
        &config.prompts,
        &config.difficulty,
        effective_level,
    )
    .await?;
    info!("15-18 题生成完成");

    // 4. TTS 合成所有音频
    emit_progress(app, "tts", "正在合成对话与听力材料语音", 0.7);
    let audio_paths = synthesize_all(
        &http_client,
        &config.tts,
        &short_dialogues,
        &long_dialogues,
        &monologue,
        &retell,
        base_dir,
        config.audio.tts_silence_ms,
    )
    .await?;
    info!("音频合成完成，共 {} 个文件", audio_paths.len());

    // 5. 拼装 TestSession
    let session = TestSession {
        session_id: session_id.to_string(),
        short_dialogues,
        long_dialogues,
        monologue,
        retell,
        audio_paths,
    };

    // 6. 序列化保存到磁盘，方便断电恢复与结算页查询
    let session_json = serde_json::to_string_pretty(&session)
        .map_err(|e| SessionError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
    std::fs::write(base_dir.join("session.json"), session_json)?;

    emit_progress(app, "done", "预生成完成", 1.0);
    info!(session_id = %session_id, "测试会话预生成完成");

    Ok(session)
}

fn emit_progress(app: &AppHandle, stage: &str, message: &str, progress: f32) {
    let payload = ProgressPayload {
        stage: stage.to_string(),
        message: message.to_string(),
        progress,
    };
    if let Err(e) = app.emit(PROGRESS_EVENT, &payload) {
        error!(error = %e, "进度事件发送失败");
    }
}

/// 从磁盘恢复会话（应用重启后使用）
#[allow(dead_code)]
pub fn load_session_from_cache(
    cache_dir: &PathBuf,
) -> Result<TestSession, SessionError> {
    let text = std::fs::read_to_string(cache_dir.join("session.json"))?;
    let session: TestSession = serde_json::from_str(&text)
        .map_err(|e| SessionError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
    Ok(session)
}

#[allow(dead_code)]
pub fn _suppress_unused_warning(_retry: &RetryConfig) {}
