//! 预生成题库（Pregen Pool）数据模型
//!
//! 设计目标：让用户进入测试时无需等待 LLM/TTS；worker 在后台提前生成多套题目存到磁盘。
//!
//! **不完整题库永不视为可用**（核心安全约束）：
//! - 单套题目必须先写完所有 `audio/*.wav` → 写 `session.json.tmp` → 原子 rename → 才插入索引
//! - 启动时 `services::pregen::recover_index` 扫描 `pregen/{uuid}/` 严格校验，缺文件则删目录
//! - 关闭程序时由 `CloseGuard` 拦截 + `cancel_pregen` 让 worker 停在下一套前

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 单套题库的元数据（不含题目正文；正文读 `pregen/{uuid}/session.json`）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PregenEntry {
    pub session_id: String,
    pub created_at: String, // ISO8601，本地时间
    /// 5 个 prompt 模板拼接的 sha256 hex；仅用于将来可能的「prompts 变更新建题库」迁移，
    /// 当前不校验（旧题库永远可用，用户已确认永不过期）。
    pub prompts_hash: String,
    /// 生成时的 effective_level：`junior_high | senior_high | undergraduate`
    pub level: String,
    /// 生成时的难度模式：`auto | manual`
    pub mode: String,
    pub status: PregenStatus,
}

/// 题库条目状态
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PregenStatus {
    Unused,
    Used,
}

/// 整个题库的持久化索引（`<app_data_dir>/pregen/index.json`）
///
/// 用 BTreeMap 让 JSON key 顺序稳定，便于排查与 diff。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PregenPoolState {
    /// schema 版本（仅用于将来迁移，当前固定 1）
    pub schema_version: u32,
    pub entries: BTreeMap<String, PregenEntry>,
}

impl Default for PregenPoolState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            entries: BTreeMap::new(),
        }
    }
}

/// 内存运行时态：索引缓存 + worker 单例 + 队列计数 + 取消信号
pub struct PregenPoolRuntime {
    /// 索引的内存缓存；启动时从磁盘加载，每次变更后落盘
    pub pool: tokio::sync::RwLock<PregenPoolState>,
    /// 后台 worker 单例；同时只跑一个串行队列
    /// 用 `tauri::async_runtime::JoinHandle` 而非 `tokio::task::JoinHandle`，
    /// 让 spawn 能在 sync / async Tauri command 任意上下文调用（sync 命令默认无 tokio runtime）
    pub worker: tokio::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// 取消信号：用户点「取消补充题库」或「关闭程序确认」时置 true；
    /// worker 在「下一套开始前」检查（生成中的那套仍会跑完，避免半成品文件）
    pub cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// 待生成总套数（worker 每完成一套 `-= 1`；用户每次 enqueue 时 `+= count`）
    pub pending_count: std::sync::Arc<std::sync::atomic::AtomicU32>,
    /// 当前正在生成的套号（1-based；0 表示空闲），仅供 UI 进度展示
    pub current_index: std::sync::Arc<std::sync::atomic::AtomicU32>,
    /// 本轮总套数（来自最近一次 enqueue）；仅供 UI 进度展示
    pub current_total: std::sync::Arc<std::sync::atomic::AtomicU32>,
    /// 最近一次失败的错误信息（供下次 `get_pregen_summary` 返回给前端）
    pub last_error: std::sync::Mutex<Option<String>>,
}

/// 前端轮询用的摘要（不带题目正文 / 完整 audio_paths，payload 小）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PregenSummary {
    /// 所有难度档的 unused 总数（兼容旧 UI；不区分难度时可用）
    pub unused_count: u32,
    /// 全部条目数（unused + used）
    pub total_count: u32,
    /// 当前是否有 worker 在跑
    pub generating_now: bool,
    /// 当前生成到第几套（1-based；空闲时 0）
    pub current_index: u32,
    /// 本轮计划生成几套
    pub current_total: u32,
    /// 最近一次生成失败的错误信息
    pub last_error: Option<String>,
    /// **按难度档分布的 unused 数**（key = level 字符串）—— 前端主菜单按钮
    /// 「开始测试（X 套 · 难度：Y）」直接读 `unusedByLevel[currentLevel]`
    pub unused_by_level: BTreeMap<String, u32>,
}

/// 单套题库的磁盘 metadata：写到 `pregen/{uuid}/meta.json`
///
/// 启动时 `recover_index` 优先读这个文件以确定 level / mode / prompts_hash；
/// 没有 meta.json 的旧目录（v1.1 之前生成）走兜底逻辑（按当前 effective_level 推断）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PregenMeta {
    pub level: String,
    pub mode: String,
    pub created_at: String,
    pub prompts_hash: String,
}

impl PregenSummary {
    /// 从索引 + worker 状态构造摘要
    pub fn from_state(
        state: &PregenPoolState,
        generating_now: bool,
        current_index: u32,
        current_total: u32,
        last_error: Option<String>,
    ) -> Self {
        let mut by_level: BTreeMap<String, u32> = BTreeMap::new();
        let mut unused_total = 0u32;
        for entry in state.entries.values() {
            if entry.status == PregenStatus::Unused {
                unused_total += 1;
                *by_level.entry(entry.level.clone()).or_insert(0) += 1;
            }
        }
        Self {
            unused_count: unused_total,
            total_count: state.entries.len() as u32,
            generating_now,
            current_index,
            current_total,
            last_error,
            unused_by_level: by_level,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(level: &str, status: PregenStatus) -> PregenEntry {
        PregenEntry {
            session_id: format!("sid-{level}-{}", rand_suffix()),
            created_at: "2026-08-31T10:00:00+08:00".to_string(),
            prompts_hash: "abcd".to_string(),
            level: level.to_string(),
            mode: "manual".to_string(),
            status,
        }
    }

    fn rand_suffix() -> u32 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .subsec_nanos()
    }

    #[test]
    fn summary_counts_unused_per_level() {
        let mut state = PregenPoolState::default();
        state.entries.insert("a".into(), entry("junior_high", PregenStatus::Unused));
        state.entries.insert("b".into(), entry("junior_high", PregenStatus::Unused));
        state.entries.insert("c".into(), entry("senior_high", PregenStatus::Unused));
        state.entries.insert("d".into(), entry("senior_high", PregenStatus::Used));
        state.entries.insert("e".into(), entry("undergraduate", PregenStatus::Unused));

        let summary = PregenSummary::from_state(&state, false, 0, 0, None);

        assert_eq!(summary.unused_count, 4);
        assert_eq!(summary.total_count, 5);
        assert_eq!(summary.unused_by_level.get("junior_high"), Some(&2));
        assert_eq!(summary.unused_by_level.get("senior_high"), Some(&1));
        assert_eq!(summary.unused_by_level.get("undergraduate"), Some(&1));
    }

    #[test]
    fn default_pool_is_empty() {
        let s = PregenPoolState::default();
        assert_eq!(s.schema_version, 1);
        assert_eq!(s.entries.len(), 0);
    }
}