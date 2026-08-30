//! 自适应难度（v1.1+）集成层
//!
//! 该 crate 把 `adaptive_difficulty::update` 等纯函数包装成主程序可用的服务：
//! - `load_state_from_disk` / `save_state_to_disk`：运行时态的持久化（含合法性恢复）
//! - `load_params_from_disk` / `save_params_to_disk`：15 个算法参数的持久化
//! - `effective_level`：按 mode 解析下次出题实际使用的难度档
//! - `compute_score_rates`：把 1-14 / 15-18 / 19 段得分归一化到 [0, 1]
//! - `hard_reset_to`：调 `reset_to` 后把 `update_count` 归零（用于 UI「重置自适应状态」按钮
//!   以及 `auto → manual` 模式切换：关闭自动档时整体清零自适应变量）
//! - `build_summary`：构造结算页用的 `AdaptiveSummaryPayload`

use adaptive_difficulty::{AdaptiveError, AdaptiveState, Level, Params, UpdateTrace};
use std::fs;
use tauri::AppHandle;
use tracing::warn;

use crate::models::result::AdaptiveSummaryPayload;
use crate::utils::path::{adaptive_params_file, adaptive_state_file, atomic_write_json};

/// 启动加载 adaptive_state.json：
/// - 文件不存在或解析失败 → 回退到初始 `junior_high`，warn 日志
/// - 加载成功后做自定义合法性恢复（见 `validate_or_recover_state`）
pub fn load_state_from_disk(app: &AppHandle) -> AdaptiveState {
    let path = match adaptive_state_file(app) {
        Ok(p) => p,
        Err(e) => {
            warn!(error = %e, "无法解析 adaptive_state.json 路径，回退初始档");
            return AdaptiveState::junior_high();
        }
    };

    if !path.exists() {
        return AdaptiveState::junior_high();
    }

    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            warn!(error = %e, path = %path.display(), "读取 adaptive_state.json 失败，回退初始档");
            return AdaptiveState::junior_high();
        }
    };

    let parsed: Result<AdaptiveState, _> = serde_json::from_str(&text);
    match parsed {
        Ok(s) => validate_or_recover_state(s, &path),
        Err(e) => {
            warn!(error = %e, path = %path.display(), "解析 adaptive_state.json 失败，回退初始档");
            AdaptiveState::junior_high()
        }
    }
}

/// 原子写 adaptive_state.json
pub fn save_state_to_disk(app: &AppHandle, state: &AdaptiveState) -> Result<(), String> {
    let path = adaptive_state_file(app)?;
    atomic_write_json(&path, state)
}

/// 启动加载 adaptive_params.json（算法参数）；缺失或解析失败 → `Params::default()`
pub fn load_params_from_disk(app: &AppHandle) -> Params {
    let path = match adaptive_params_file(app) {
        Ok(p) => p,
        Err(e) => {
            warn!(error = %e, "无法解析 adaptive_params.json 路径，使用默认参数");
            return Params::default();
        }
    };

    if !path.exists() {
        return Params::default();
    }

    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            warn!(error = %e, path = %path.display(), "读取 adaptive_params.json 失败，使用默认参数");
            return Params::default();
        }
    };

    serde_json::from_str(&text).unwrap_or_else(|e| {
        warn!(error = %e, "解析 adaptive_params.json 失败，使用默认参数");
        Params::default()
    })
}

/// 原子写 adaptive_params.json
pub fn save_params_to_disk(app: &AppHandle, params: &Params) -> Result<(), String> {
    let path = adaptive_params_file(app)?;
    atomic_write_json(&path, params)
}

/// 解析下次出题实际使用的难度档：
/// - `mode == "manual"` → 返回 `manual`（必须在三档之一，否则回退 `junior_high`）
/// - `mode == "auto"`   → 返回 `state.current_level.as_str()`
/// - 其它 → 回退 `junior_high`
pub fn effective_level(state: &AdaptiveState, mode: &str, manual: &str) -> String {
    match mode {
        "manual" => parse_level(manual).as_str().to_string(),
        "auto" => state.current_level.as_str().to_string(),
        _ => Level::JuniorHigh.as_str().to_string(),
    }
}

/// 把 snake_case 字符串解析为 `Level`；失败回退 `JuniorHigh`
pub fn parse_level(s: &str) -> Level {
    match s {
        "junior_high" => Level::JuniorHigh,
        "senior_high" => Level::SeniorHigh,
        "undergraduate" => Level::Undergraduate,
        _ => {
            warn!(input = %s, "未知 Level 字符串，回退 JuniorHigh");
            Level::JuniorHigh
        }
    }
}

/// 把 1-14 / 15-18 / Q19 三段得分归一化到 `[0, 1]` 的得分率
/// - `a = mcq_correct / 14.0`（最多 14 题，每题 1 分）
/// - `b = blank_total / 6.0`（每空 1.5，4 空共 6）
/// - `c = q19_score / 10.0`（4 + 3 + 3 = 10）
pub fn compute_score_rates(mcq_correct: usize, blank_total: f32, q19_score: f32) -> (f64, f64, f64) {
    let a = (mcq_correct as f64 / 14.0).clamp(0.0, 1.0);
    let b = ((blank_total as f64) / 6.0).clamp(0.0, 1.0);
    let c = ((q19_score as f64) / 10.0).clamp(0.0, 1.0);
    (a, b, c)
}

/// 硬重置：调 `adaptive_difficulty::reset_to` 后把 `update_count` 归零
///
/// 与 `manual → auto` 模式切换的「软重置」（保留 update_count）区分开：
/// 本函数用于两处：
/// 1. UI「重置自适应状态」按钮（仅 mode=Auto 可见），按 §7.5 要求归零 update_count
/// 2. `auto → manual` 模式切换：关闭自动档意味着「整体停用」自适应，下次再开启前
///    不保留任何累计历史，因此 ability / trend / current_level / update_count 全部清零
pub fn hard_reset_to(state: &mut AdaptiveState, level: Level) {
    adaptive_difficulty::reset_to(state, level);
    state.update_count = 0;
}

/// 构造结算页用的 `AdaptiveSummaryPayload`
pub fn build_summary(
    before: &AdaptiveState,
    after: &AdaptiveState,
    trace: &UpdateTrace,
) -> AdaptiveSummaryPayload {
    AdaptiveSummaryPayload {
        ability_before: before.ability_score,
        ability_after: after.ability_score,
        trend_before: before.trend,
        trend_after: after.trend,
        update_count_before: before.update_count,
        update_count_after: after.update_count,
        level_before: before.current_level.as_str().to_string(),
        level_after: after.current_level.as_str().to_string(),
        trace: serde_json::to_value(trace).unwrap_or(serde_json::Value::Null),
    }
}

/// 自定义合法性恢复（替代 crate 的 `validate_loaded`）：
/// - `ability_score` 越界或非有限 → 设回 `current_level.initial_ability()`，warn
/// - `trend` 越界或非有限 → 设回 0，warn
/// - `current_level` 与 `update_count` 保持原值（用户配置 / 计数器）
fn validate_or_recover_state(mut state: AdaptiveState, path: &std::path::Path) -> AdaptiveState {
    if !state.ability_score.is_finite()
        || state.ability_score < 0.0
        || state.ability_score > 600.0
    {
        warn!(
            old = state.ability_score,
            path = %path.display(),
            "ability_score 越界，恢复为 current_level.initial_ability()"
        );
        state.ability_score = state.current_level.initial_ability();
    }
    if !state.trend.is_finite() || state.trend < -1.0 || state.trend > 1.0 {
        warn!(
            old = state.trend,
            path = %path.display(),
            "trend 越界，恢复为 0"
        );
        state.trend = 0.0;
    }
    state
}

/// 把 `AdaptiveError` 翻译成对用户友好的字符串（前端 toast 用）
pub fn format_adaptive_error(err: &AdaptiveError) -> String {
    format!("自适应更新失败: {err}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_score_rates_in_unit_interval() {
        let (a, b, c) = compute_score_rates(14, 6.0, 10.0);
        assert!((a - 1.0).abs() < 1e-9);
        assert!((b - 1.0).abs() < 1e-9);
        assert!((c - 1.0).abs() < 1e-9);

        let (a, b, c) = compute_score_rates(0, 0.0, 0.0);
        assert_eq!(a, 0.0);
        assert_eq!(b, 0.0);
        assert_eq!(c, 0.0);
    }

    #[test]
    fn compute_score_rates_clamps_overflow() {
        let (a, b, c) = compute_score_rates(100, 99.0, 99.0);
        assert_eq!(a, 1.0);
        assert_eq!(b, 1.0);
        assert_eq!(c, 1.0);
    }

    #[test]
    fn effective_level_manual_returns_manual_when_valid() {
        let s = AdaptiveState::junior_high();
        assert_eq!(effective_level(&s, "manual", "senior_high"), "senior_high");
        assert_eq!(effective_level(&s, "manual", "undergraduate"), "undergraduate");
        assert_eq!(effective_level(&s, "manual", "junior_high"), "junior_high");
    }

    #[test]
    fn effective_level_manual_falls_back_on_invalid() {
        let s = AdaptiveState::junior_high();
        assert_eq!(effective_level(&s, "manual", "garbage"), "junior_high");
        assert_eq!(effective_level(&s, "manual", ""), "junior_high");
    }

    #[test]
    fn effective_level_auto_returns_state_level() {
        let mut s = AdaptiveState::junior_high();
        s.ability_score = 500.0;
        s.trend = 1.0;
        // 即使 ability 拉到 500，current_level 仍由上一次的 update 决定
        assert_eq!(effective_level(&s, "auto", "anything"), "junior_high");

        // 模拟一次 update 后的 senior_high state
        let s2 = AdaptiveState::senior_high();
        assert_eq!(effective_level(&s2, "auto", "junior_high"), "senior_high");
    }

    #[test]
    fn effective_level_unknown_mode_falls_back() {
        let s = AdaptiveState::senior_high();
        assert_eq!(effective_level(&s, "weird", "junior_high"), "junior_high");
    }

    #[test]
    fn hard_reset_to_zeros_update_count() {
        let mut s = AdaptiveState::senior_high();
        s.update_count = 42;
        s.ability_score = 250.0;
        s.trend = 0.7;
        hard_reset_to(&mut s, Level::Undergraduate);
        assert_eq!(s.current_level, Level::Undergraduate);
        assert_eq!(s.ability_score, 500.0);
        assert_eq!(s.trend, 0.0);
        assert_eq!(s.update_count, 0);
    }

    /// 回归测试：关闭自动档（auto → manual）时必须清零 update_count。
    ///
    /// 历史 bug：之前 `set_adaptive_mode` 在 auto→manual 分支直接调
    /// `adaptive_difficulty::reset_to`，该函数按文档「保留 update_count」，
    /// 导致关闭自动档后累计更新次数依然存在。修复后改走 `hard_reset_to`。
    #[test]
    fn auto_to_manual_resets_update_count() {
        let mut s = AdaptiveState::senior_high();
        // 模拟用户跑了 7 次自动档测试
        s.update_count = 7;
        s.ability_score = 280.0;
        s.trend = 0.15;
        // 用户在 UI 选了「大学」档并关闭自动档
        hard_reset_to(&mut s, Level::Undergraduate);
        assert_eq!(s.update_count, 0, "auto→manual 必须清零 update_count");
        assert_eq!(s.current_level, Level::Undergraduate);
        assert_eq!(s.ability_score, 500.0);
        assert_eq!(s.trend, 0.0);
    }

    #[test]
    fn parse_level_recognises_known_and_unknown() {
        assert_eq!(parse_level("junior_high"), Level::JuniorHigh);
        assert_eq!(parse_level("senior_high"), Level::SeniorHigh);
        assert_eq!(parse_level("undergraduate"), Level::Undergraduate);
        assert_eq!(parse_level("xyz"), Level::JuniorHigh);
    }
}