//! 测试会话相关 Tauri commands

use crate::commands::adaptive::AdaptiveStateHandle;
use crate::commands::config::ConfigState;
use crate::models::question::TestSession;
use crate::services::adaptive as adaptive_svc;
use crate::services::test_session::generate_full_session;
use crate::utils::path::session_cache_dir;
use std::sync::Mutex;
use tauri::{AppHandle, State};
use tracing::{info, warn};

/// 全局测试会话状态
pub struct SessionState {
    pub inner: Mutex<Option<TestSession>>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

/// 启动测试会话预生成（完整 LLM + TTS 流程）
///
/// 返回完整 TestSession（含音频路径）。
/// 进度事件通过 `test-generation-progress` 推送。
///
/// v1.1+ 解析「effective_level」：
/// - mode = "manual" → `config.difficulty.level`
/// - mode = "auto"   → `adaptive_state.current_level`
/// - 未知 mode / 无效 level  → "junior_high"（与 Spec §5.5 兜底行为一致）
#[tauri::command]
pub async fn generate_test_session(
    app: AppHandle,
    session_state: State<'_, SessionState>,
    config_state: State<'_, ConfigState>,
    adaptive_handle: State<'_, AdaptiveStateHandle>,
) -> Result<TestSession, String> {
    let config = {
        let guard = config_state
            .inner
            .read()
            .map_err(|e| format!("锁读取失败: {e}"))?;
        guard.clone()
    };

    // 读 adaptive state（共享 tokio RwLock，与 config 的 std RwLock 区分）
    let adaptive_snapshot = {
        let guard = adaptive_handle.0.read().await;
        crate::commands::adaptive::AdaptiveStateSnapshot::from(&*guard)
    };

    let effective_level = adaptive_svc::effective_level(
        &adaptive_difficulty::AdaptiveState {
            ability_score: adaptive_snapshot.ability_score,
            trend: adaptive_snapshot.trend,
            current_level: adaptive_svc::parse_level(&adaptive_snapshot.current_level),
            update_count: adaptive_snapshot.update_count,
        },
        &config.difficulty.mode,
        &config.difficulty.level,
    );

    info!(
        "generate_test_session: mode={}, effective_level={}",
        config.difficulty.mode, effective_level
    );

    let session = generate_full_session(&app, &config, &effective_level)
        .await
        .map_err(|e| format!("测试会话预生成失败: {e}"))?;

    {
        let mut guard = session_state
            .inner
            .lock()
            .map_err(|e| format!("锁写入失败: {e}"))?;
        *guard = Some(session.clone());
    }

    info!(
        "generate_test_session: 内存中已保存测试会话 session_id={}",
        session.session_id
    );

    Ok(session)
}

/// 获取当前内存中的测试会话（前端进入 /test 页面时调用）
#[tauri::command]
pub fn get_test_session(
    session_state: State<'_, SessionState>,
) -> Result<Option<TestSession>, String> {
    let guard = session_state
        .inner
        .lock()
        .map_err(|e| format!("锁读取失败: {e}"))?;
    Ok(guard.clone())
}

/// 清除当前测试会话（用户主动退出或重新开始时）
///
/// v1.1+ 题库系统：同时删除磁盘上的 `cache/{uuid}/` 目录，
/// 因为 `cache/{uuid}/` 既可能是 `generate_test_session` 生成的，也可能是
/// 从 `pregen/{uuid}/` 激活（activate_one）的——两种情况都用同一目录。
/// 删除后释放磁盘空间，与「已使用的题库自动删除」语义一致。
#[tauri::command]
pub fn clear_test_session(
    app: AppHandle,
    session_state: State<'_, SessionState>,
) -> Result<(), String> {
    let cleared_session_id = {
        let mut guard = session_state
            .inner
            .lock()
            .map_err(|e| format!("锁写入失败: {e}"))?;
        let id = guard.as_ref().map(|s| s.session_id.clone());
        *guard = None;
        id
    };

    if let Some(ref sid) = cleared_session_id {
        match session_cache_dir(&app, sid) {
            Ok(cache_dir) => {
                if cache_dir.exists() {
                    if let Err(e) = std::fs::remove_dir_all(&cache_dir) {
                        warn!(
                            error = %e,
                            session_id = %sid,
                            "clear_test_session: 删除 cache 目录失败"
                        );
                    } else {
                        info!(
                            session_id = %sid,
                            "clear_test_session: 已删除 cache 目录（题库自动清理）"
                        );
                    }
                }
            }
            Err(e) => {
                warn!(error = %e, "clear_test_session: 解析 cache 目录失败");
            }
        }
    }

    info!(
        "clear_test_session: 已清空内存中的测试会话（被清空的 session_id={:?}）",
        cleared_session_id
    );
    Ok(())
}
