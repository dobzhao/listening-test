//! 预生成题库（Pregen Pool）Tauri commands
//!
//! 5 个 invoke：
//! - `get_pregen_summary`   → PregenSummary（前端轮询用）
//! - `list_unused_pregen`   → Vec<PregenEntry>（预留，MVP 不调用）
//! - `enqueue_pregen(count)`→ () 把 N 套加入队列
//! - `cancel_pregen`        → () 取消当前队列
//! - `start_test_from_pregen` → TestSession 选中最早 unused 并激活到 cache/

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::sync::{Mutex, RwLock};
use tracing::info;

use crate::commands::adaptive::AdaptiveStateHandle;
use crate::commands::config::ConfigState;
use crate::commands::test_session::SessionState;
use crate::models::pregen::{
    PregenEntry, PregenPoolRuntime, PregenPoolState, PregenStatus, PregenSummary,
};
use crate::models::question::TestSession;
use crate::services::adaptive as adaptive_svc;
use crate::services::pregen as pregen_svc;

// ===== 事件 payload 与常量 =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreGenProgressPayload {
    pub session_id: String,
    pub current: u32,
    pub total: u32,
    pub stage: String,
    pub message: String,
    pub progress: f32,
}
pub const PREGEN_PROGRESS_EVENT: &str = "pregen-progress";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreGenFinishedPayload {
    pub requested: u32,
    pub succeeded: u32,
    pub failed: u32,
}
pub const PREGEN_FINISHED_EVENT: &str = "pregen-finished";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreGenFailedPayload {
    pub session_id: String,
    pub error: String,
}
pub const PREGEN_FAILED_EVENT: &str = "pregen-failed";

// ===== 1. 拉题库摘要 =====

#[tauri::command]
pub async fn get_pregen_summary(
    app: AppHandle,
    pool: State<'_, PregenPoolRuntime>,
) -> Result<PregenSummary, String> {
    let _ = pool; // 仅用作类型断言，证明 State 已注入
    Ok(pregen_svc::build_summary(&app).await)
}

// ===== 2. 列出 unused =====

#[tauri::command]
pub async fn list_unused_pregen(
    pool: State<'_, PregenPoolRuntime>,
) -> Result<Vec<PregenEntry>, String> {
    let p = pool.pool.read().await;
    Ok(p.entries
        .values()
        .filter(|e| e.status == PregenStatus::Unused)
        .cloned()
        .collect())
}

// ===== 3. 入队 N 套 =====

#[tauri::command]
pub fn enqueue_pregen(
    app: AppHandle,
    pool: State<'_, PregenPoolRuntime>,
    count: u32,
) -> Result<(), String> {
    let _ = pool;
    if count == 0 || count > 20 {
        return Err("count 必须在 1..=20".into());
    }
    pregen_svc::enqueue(&app, count);
    pregen_svc::ensure_worker(app.clone());
    info!(count, "已入队预生成任务");
    Ok(())
}

// ===== 4. 取消当前队列 =====

#[tauri::command]
pub fn cancel_pregen(
    app: AppHandle,
    pool: State<'_, PregenPoolRuntime>,
) -> Result<(), String> {
    let _ = pool;
    pregen_svc::request_cancel(&app);
    info!("已请求取消预生成队列");
    Ok(())
}

// ===== 5. 从题库激活最早一条 unused，进入测试 =====

#[tauri::command]
pub async fn start_test_from_pregen(
    app: AppHandle,
    pool: State<'_, PregenPoolRuntime>,
    session_state: State<'_, SessionState>,
    config_state: State<'_, ConfigState>,
    adaptive_handle: State<'_, AdaptiveStateHandle>,
) -> Result<TestSession, String> {
    // 1. 解析 effective_level（与 commands/test_session::generate_test_session 同样的逻辑）
    let config = {
        let guard = config_state
            .inner
            .read()
            .map_err(|e| format!("ConfigState 读锁失败: {e}"))?;
        guard.clone()
    };
    let snap = {
        let guard = adaptive_handle.0.read().await;
        crate::commands::adaptive::AdaptiveStateSnapshot::from(&*guard)
    };
    let effective_level = adaptive_svc::effective_level(
        &adaptive_difficulty::AdaptiveState {
            ability_score: snap.ability_score,
            trend: snap.trend,
            current_level: adaptive_svc::parse_level(&snap.current_level),
            update_count: snap.update_count,
        },
        &config.difficulty.mode,
        &config.difficulty.level,
    );

    // 2. 选该难度最早 unused
    let picked_id = {
        let p = pool.pool.read().await;
        p.entries
            .values()
            .find(|e| e.status == PregenStatus::Unused && e.level == effective_level)
            .map(|e| e.session_id.clone())
            .ok_or_else(|| {
                format!(
                    "题库中没有 {} 难度的可用题目，请先补充题库",
                    effective_level
                )
            })?
    };

    info!(
        session_id = %picked_id,
        effective_level = %effective_level,
        "start_test_from_pregen: 激活题库"
    );

    // 3. move pregen/{uuid}/ → cache/{uuid}/（activate_one 内部已重写 audio_paths 绝对路径）
    let session = pregen_svc::activate_one(&app, &picked_id)?;

    // 4. 写 SessionState
    {
        let mut guard = session_state
            .inner
            .lock()
            .map_err(|e| format!("SessionState lock failed: {e}"))?;
        *guard = Some(session.clone());
    }

    // 6. 把 entry.status 标为 Used 并落盘
    {
        let mut p = pool.pool.write().await;
        if let Some(entry) = p.entries.get_mut(&picked_id) {
            entry.status = PregenStatus::Used;
        }
        pregen_svc::save_index(&app, &p)?;
    }

    // 7. 后台自动再补 1 套
    pregen_svc::enqueue(&app, 1);
    pregen_svc::ensure_worker(app.clone());

    info!(
        session_id = %picked_id,
        "start_test_from_pregen: 已激活 + 入队 1 套补充"
    );
    Ok(session)
}

// ===== PregenPoolRuntime Default =====

impl Default for PregenPoolRuntime {
    fn default() -> Self {
        Self {
            pool: RwLock::new(PregenPoolState::default()),
            worker: Mutex::new(None),
            cancel_flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            pending_count: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            current_index: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            current_total: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            last_error: StdMutex::new(None),
        }
    }
}

// 「Ordering::SeqCst」在某些 warnings 下会被报为 unused；这里防止编译告警
#[allow(dead_code)]
const _UNUSED_ORDERING: Ordering = Ordering::SeqCst;