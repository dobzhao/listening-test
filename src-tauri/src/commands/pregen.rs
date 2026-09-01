//! 预生成题库（Pregen Pool）Tauri commands
//!
//! 6 个 invoke：
//! - `get_pregen_summary`        → PregenSummary（前端轮询用）
//! - `list_unused_pregen`        → Vec<PregenEntry>（预留，MVP 不调用）
//! - `enqueue_pregen(count)`     → () 把 N 套加入队列
//! - `cancel_pregen`             → () 取消当前队列
//! - `pick_test_from_pregen`     → TestSession 从题库选最早 unused 并加载到 SessionState
//!                                  （**不改 status、不移动文件、不触发补题**——
//!                                  让用户在"准备开始测试"界面返回主菜单时一条题都不浪费）
//! - `activate_test_from_pregen` → TestSession 把 SessionState 里的 picked 条目 move 到 cache/、
//!                                  标 Used、enqueue(1) 补题（仅在"准备开始测试"界面真正点
//!                                  "开始测试"按钮时调用，对应 commit 描述的需求）

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

// ===== 5. 内部：解析 effective_level 并按 level 选最早一条 unused =====
//
// pick 与 activate 都要走一遍：pick 用来"挑选"，activate 不再选（按 SessionState 里
// 已记录的 session_id 激活）。两者提取共有逻辑便于保持一致。

async fn resolve_effective_level(
    config_state: &State<'_, ConfigState>,
    adaptive_handle: &State<'_, AdaptiveStateHandle>,
) -> Result<String, String> {
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
    Ok(adaptive_svc::effective_level(
        &adaptive_difficulty::AdaptiveState {
            ability_score: snap.ability_score,
            trend: snap.trend,
            current_level: adaptive_svc::parse_level(&snap.current_level),
            update_count: snap.update_count,
        },
        &config.difficulty.mode,
        &config.difficulty.level,
    ))
}

async fn pick_earliest_unused_id(
    pool: &State<'_, PregenPoolRuntime>,
    level: &str,
) -> Result<String, String> {
    let p = pool.pool.read().await;
    p.entries
        .values()
        .find(|e| e.status == PregenStatus::Unused && e.level == level)
        .map(|e| e.session_id.clone())
        .ok_or_else(|| {
            format!(
                "题库中没有 {level} 难度的可用题目，请先补充题库"
            )
        })
}

// ===== 6. 从题库挑选最早一条 unused，但不移动文件、不标 Used、不补题 =====
//
// 时机：用户在主菜单点击「开始测试（X 套 · 难度：Y）」按钮时调用。
// 加载 pregen/{uuid}/session.json 写入 SessionState 供前端 store + 后续 start_test_flow 使用。
// **不要** 让这一步把题目标记为已使用 —— 用户在"准备开始测试"界面再次点击「返回主菜单」时，
// 题目应当原封不动地留在题库池中。

#[tauri::command]
pub async fn pick_test_from_pregen(
    app: AppHandle,
    pool: State<'_, PregenPoolRuntime>,
    session_state: State<'_, SessionState>,
    config_state: State<'_, ConfigState>,
    adaptive_handle: State<'_, AdaptiveStateHandle>,
) -> Result<TestSession, String> {
    let effective_level = resolve_effective_level(&config_state, &adaptive_handle).await?;
    let picked_id = pick_earliest_unused_id(&pool, &effective_level).await?;

    info!(
        session_id = %picked_id,
        effective_level = %effective_level,
        "pick_test_from_pregen: 从题库挑选（不动文件状态）"
    );

    let session = pregen_svc::load_pregen_session_json(&app, &picked_id)?;

    {
        let mut guard = session_state
            .inner
            .lock()
            .map_err(|e| format!("SessionState lock failed: {e}"))?;
        *guard = Some(session.clone());
    }

    Ok(session)
}

// ===== 7. 激活 SessionState 里的 picked 条目：move 文件 + 标 Used + enqueue(1) =====
//
// 时机：用户在「准备开始测试」界面真正点击「开始测试」按钮时调用。
// 完成此时才把条目从 pregen/ 搬到 cache/，并标 status = Used。
// 在此之前用户从「准备开始测试」返回主菜单不会浪费任何一条题目。

#[tauri::command]
pub async fn activate_test_from_pregen(
    app: AppHandle,
    pool: State<'_, PregenPoolRuntime>,
    session_state: State<'_, SessionState>,
) -> Result<TestSession, String> {
    let picked_id = {
        let guard = session_state
            .inner
            .lock()
            .map_err(|e| format!("SessionState lock failed: {e}"))?;
        let s = guard
            .as_ref()
            .ok_or_else(|| "SessionState 为空，请先调用 pick_test_from_pregen".to_string())?;
        s.session_id.clone()
    };

    info!(
        session_id = %picked_id,
        "activate_test_from_pregen: 激活题库到 cache/"
    );

    // move pregen/{uuid}/ → cache/{uuid}/（activate_one 内部已重写 audio_paths 绝对路径）
    let session = pregen_svc::activate_one(&app, &picked_id)?;

    // 更新 SessionState（audio_paths 已重写为 cache/ 路径，后续 start_test_flow 拿到的是正确的 session）
    {
        let mut guard = session_state
            .inner
            .lock()
            .map_err(|e| format!("SessionState lock failed: {e}"))?;
        *guard = Some(session.clone());
    }

    // 标 Used + 落盘
    {
        let mut p = pool.pool.write().await;
        if let Some(entry) = p.entries.get_mut(&picked_id) {
            entry.status = PregenStatus::Used;
        }
        pregen_svc::save_index(&app, &p)?;
    }

    // 后台自动再补 1 套
    pregen_svc::enqueue(&app, 1);
    pregen_svc::ensure_worker(app.clone());

    info!(
        session_id = %picked_id,
        "activate_test_from_pregen: 已激活 + 入队 1 套补充"
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
