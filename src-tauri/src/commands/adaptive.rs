//! 自适应难度（v1.1+）相关 Tauri commands
//!
//! - `get_adaptive_state`：返回当前 AdaptiveState 镜像（前端初始化用）
//! - `reset_adaptive_state`：UI「重置自适应状态」按钮，硬重置（归零 update_count）
//! - `set_adaptive_mode`：切换手动 / 自动档；auto→manual 时软重置到当前手动档（保留 update_count）
//! - `update_adaptive_params`：把 15 个算法参数落盘，下次评分生效

use adaptive_difficulty::{AdaptiveState, Params};
use crate::commands::config::ConfigState;
use crate::services::adaptive as adaptive_svc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;
use tracing::{info, warn};

/// 启动注册的全局自适应状态（运行时态，独立于 `ConfigState`）
///
/// 用 `tokio::sync::RwLock` 而非 `std::sync::RwLock`，因为持有 `std::sync::RwLockWriteGuard`
/// 跨越 `.await` 会违反 `Send`，无法在 async Tauri command 里使用。
/// Default 仅在 setup 失败时使用兜底；正常启动路径在 `lib.rs::run()` 的
/// setup 回调里通过 `app.manage(AdaptiveStateHandle::new(loaded))` 注入真实值。
pub struct AdaptiveStateHandle(pub Arc<RwLock<AdaptiveState>>);

impl Default for AdaptiveStateHandle {
    fn default() -> Self {
        Self(Arc::new(RwLock::new(AdaptiveState::junior_high())))
    }
}

/// `adaptive-state-reset` 事件 payload（前端 listen 用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdaptiveStateResetPayload {
    pub new_level: String,
    pub ability: f64,
    pub trend: f64,
    pub update_count: u64,
    /// `auto | manual`（UI 据此弹 toast：「auto→manual」时弹「已切换到手动档，已重置自适应变量」）
    pub new_mode: String,
}

pub const ADAPTIVE_STATE_RESET_EVENT: &str = "adaptive-state-reset";

/// 获取当前自适应状态快照
#[tauri::command]
pub async fn get_adaptive_state(
    state: State<'_, AdaptiveStateHandle>,
) -> Result<AdaptiveStateSnapshot, String> {
    let guard = state.0.read().await;
    Ok(AdaptiveStateSnapshot::from(&*guard))
}

/// 前端用快照结构（与 crate `AdaptiveState` 字段一一对应）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdaptiveStateSnapshot {
    pub ability_score: f64,
    pub trend: f64,
    pub current_level: String,
    pub update_count: u64,
}

impl From<&AdaptiveState> for AdaptiveStateSnapshot {
    fn from(s: &AdaptiveState) -> Self {
        Self {
            ability_score: s.ability_score,
            trend: s.trend,
            current_level: s.current_level.as_str().to_string(),
            update_count: s.update_count,
        }
    }
}

/// UI「重置自适应状态」按钮：硬重置（归零 update_count），并把档位重置为传入的 manual_level
#[tauri::command]
pub async fn reset_adaptive_state(
    app: AppHandle,
    state: State<'_, AdaptiveStateHandle>,
    manual_level: String,
) -> Result<AdaptiveStateSnapshot, String> {
    let level = adaptive_svc::parse_level(&manual_level);
    {
        let mut guard = state.0.write().await;
        adaptive_svc::hard_reset_to(&mut *guard, level);
    }
    let snapshot = {
        let guard = state.0.read().await;
        AdaptiveStateSnapshot::from(&*guard)
    };

    let to_persist = AdaptiveState {
        ability_score: snapshot.ability_score,
        trend: snapshot.trend,
        current_level: adaptive_svc::parse_level(&snapshot.current_level),
        update_count: snapshot.update_count,
    };
    if let Err(e) = adaptive_svc::save_state_to_disk(&app, &to_persist) {
        warn!(error = %e, "硬重置后持久化 adaptive_state.json 失败");
    }

    let payload = AdaptiveStateResetPayload {
        new_level: snapshot.current_level.clone(),
        ability: snapshot.ability_score,
        trend: snapshot.trend,
        update_count: snapshot.update_count,
        new_mode: "auto".to_string(), // 按钮仅在 mode=Auto 时可见
    };
    if let Err(e) = app.emit(ADAPTIVE_STATE_RESET_EVENT, &payload) {
        warn!(error = %e, "adaptive-state-reset 事件发送失败");
    }

    info!(
        ability = snapshot.ability_score,
        trend = snapshot.trend,
        level = snapshot.current_level,
        update_count = snapshot.update_count,
        "硬重置自适应状态完成"
    );

    Ok(snapshot)
}

/// 切换手动 / 自动档：
/// - `auto = true`（manual → auto）：若传 `initial_level`，把 adaptive state 软重置到该档
///   （保留 update_count）。不传则不动 adaptive state（向后兼容旧调用）。
/// - `auto = false`（auto → manual）：把 adaptive state **硬重置**到
///   `config.difficulty.level` 对应的档（**清零 update_count**）。关闭自动档意味着
///   「整体停用」自适应逻辑，下次再开启前不保留任何累计历史。
#[tauri::command]
pub async fn set_adaptive_mode(
    app: AppHandle,
    config_state: State<'_, ConfigState>,
    adaptive_handle: State<'_, AdaptiveStateHandle>,
    auto: bool,
    initial_level: Option<String>,
) -> Result<AdaptiveStateSnapshot, String> {
    // 1. 写 config.difficulty.mode
    let updated_config = {
        let mut cfg_guard = config_state
            .inner
            .write()
            .map_err(|e| format!("锁写入失败: {e}"))?;
        cfg_guard.difficulty.mode = if auto { "auto".to_string() } else { "manual".to_string() };
        cfg_guard.clone()
    };

    // 同步落盘 config.json
    if let Err(e) = crate::commands::config::save_config_to_disk(&app, &updated_config) {
        warn!(error = %e, "set_adaptive_mode: 保存 config.json 失败");
    }

    // 2. auto → manual 时硬重置到当前手动档（清零 update_count）
    // 关闭自动档意味着「整体停用」自适应：能力分 / 趋势 / 当前档 / 累计更新次数
    // 全部回到初始状态，下次再开启自动档时也以全新起点开始。
    if !auto {
        let manual_level_str = updated_config.difficulty.level.clone();
        let manual_level = adaptive_svc::parse_level(&manual_level_str);

        {
            let mut guard = adaptive_handle.0.write().await;
            // 用服务层 hard_reset_to：与「重置自适应状态」按钮同语义，
            // 在 reset_to 的基础上额外把 update_count 归零。
            adaptive_svc::hard_reset_to(&mut *guard, manual_level);
        }

        let snapshot = {
            let guard = adaptive_handle.0.read().await;
            AdaptiveStateSnapshot::from(&*guard)
        };

        let to_persist = AdaptiveState {
            ability_score: snapshot.ability_score,
            trend: snapshot.trend,
            current_level: adaptive_svc::parse_level(&snapshot.current_level),
            update_count: snapshot.update_count,
        };
        if let Err(e) = adaptive_svc::save_state_to_disk(&app, &to_persist) {
            warn!(error = %e, "auto→manual 硬重置后持久化失败");
        }

        let payload = AdaptiveStateResetPayload {
            new_level: snapshot.current_level.clone(),
            ability: snapshot.ability_score,
            trend: snapshot.trend,
            update_count: snapshot.update_count,
            new_mode: "manual".to_string(),
        };
        if let Err(e) = app.emit(ADAPTIVE_STATE_RESET_EVENT, &payload) {
            warn!(error = %e, "adaptive-state-reset 事件发送失败");
        }

        info!(
            ability = snapshot.ability_score,
            trend = snapshot.trend,
            level = snapshot.current_level,
            update_count = snapshot.update_count,
            "auto→manual 硬重置完成（update_count 已清零）"
        );

        Ok(snapshot)
    } else {
        // manual → auto：
        // - 传了 initial_level → 软重置到该档（用户明确选择起始档，§11.6 + 增量需求）
        // - 不传 initial_level → 不动 adaptive state（向后兼容 / 保留之前的自动档状态）
        if let Some(initial_str) = initial_level {
            let initial_level_enum = adaptive_svc::parse_level(&initial_str);

            {
                let mut guard = adaptive_handle.0.write().await;
                // 用 crate 自带的 reset_to（保留 update_count），符合 Spec §11.6「保留累计历史」
                adaptive_difficulty::reset_to(&mut *guard, initial_level_enum);
            }

            let snapshot = {
                let guard = adaptive_handle.0.read().await;
                AdaptiveStateSnapshot::from(&*guard)
            };

            let to_persist = AdaptiveState {
                ability_score: snapshot.ability_score,
                trend: snapshot.trend,
                current_level: adaptive_svc::parse_level(&snapshot.current_level),
                update_count: snapshot.update_count,
            };
            if let Err(e) = adaptive_svc::save_state_to_disk(&app, &to_persist) {
                warn!(error = %e, "manual→auto 自选起始档后持久化失败");
            }

            let payload = AdaptiveStateResetPayload {
                new_level: snapshot.current_level.clone(),
                ability: snapshot.ability_score,
                trend: snapshot.trend,
                update_count: snapshot.update_count,
                new_mode: "auto".to_string(),
            };
            if let Err(e) = app.emit(ADAPTIVE_STATE_RESET_EVENT, &payload) {
                warn!(error = %e, "adaptive-state-reset 事件发送失败");
            }

            info!(
                ability = snapshot.ability_score,
                trend = snapshot.trend,
                level = snapshot.current_level,
                update_count = snapshot.update_count,
                "manual→auto：用户选定起始档，软重置完成（update_count 保留）"
            );

            Ok(snapshot)
        } else {
            // 兼容旧路径：不动 adaptive state，仅发事件让前端 store 刷新
            let snapshot = {
                let guard = adaptive_handle.0.read().await;
                AdaptiveStateSnapshot::from(&*guard)
            };

            let payload = AdaptiveStateResetPayload {
                new_level: snapshot.current_level.clone(),
                ability: snapshot.ability_score,
                trend: snapshot.trend,
                update_count: snapshot.update_count,
                new_mode: "auto".to_string(),
            };
            if let Err(e) = app.emit(ADAPTIVE_STATE_RESET_EVENT, &payload) {
                warn!(error = %e, "adaptive-state-reset 事件发送失败");
            }

            info!("manual→auto：adaptive state 保持不变（兼容旧调用）");
            Ok(snapshot)
        }
    }
}

/// 落盘 15 个算法参数
#[tauri::command]
pub fn update_adaptive_params(app: AppHandle, params: Params) -> Result<(), String> {
    adaptive_svc::save_params_to_disk(&app, &params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_roundtrip() {
        let s = AdaptiveState::senior_high();
        let snap = AdaptiveStateSnapshot::from(&s);
        assert_eq!(snap.ability_score, 300.0);
        assert_eq!(snap.trend, 0.0);
        assert_eq!(snap.current_level, "senior_high");
        assert_eq!(snap.update_count, 0);
    }
}