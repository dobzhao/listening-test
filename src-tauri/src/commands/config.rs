//! 配置读写相关 Tauri commands

use crate::models::config::{
    default_difficulty_demands, default_prompts, AppConfig, DifficultyConfig, DifficultyDemand,
    TimingConfig,
};
use crate::utils::path::{atomic_write_json, config_file};
use serde::{Deserialize, Serialize};
use std::fs;
use std::sync::RwLock;
use tauri::{AppHandle, State};

/// 全局配置状态：缓存当前内存中的 AppConfig，避免反复读盘
pub struct ConfigState {
    pub inner: RwLock<AppConfig>,
    /// 标记是否已经从磁盘加载过（避免每次 invoke 都重新读盘）
    pub initialized: RwLock<bool>,
}

impl Default for ConfigState {
    fn default() -> Self {
        Self {
            inner: RwLock::new(AppConfig::default()),
            initialized: RwLock::new(false),
        }
    }
}

/// 读取本地配置文件（不存在则返回默认值）
fn load_config_from_disk(app: &AppHandle) -> Result<AppConfig, String> {
    let path = config_file(app)?;
    if !path.exists() {
        let defaults = AppConfig::default();
        atomic_write_json(&path, &defaults).map_err(|e| format!("写入默认配置失败: {e}"))?;
        return Ok(defaults);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
    let cfg: AppConfig =
        serde_json::from_str(&text).map_err(|e| format!("解析配置失败: {e}"))?;
    Ok(cfg)
}

/// 写入本地配置文件（走原子写，崩溃时不会留下半截 JSON）
pub(crate) fn save_config_to_disk(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_file(app)?;
    atomic_write_json(&path, config).map_err(|e| format!("写入配置失败: {e}"))?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    pub config: AppConfig,
    /// 配置文件路径，方便调试
    pub config_path: String,
}

/// 获取应用配置（前端启动时调用）
#[tauri::command]
pub fn get_config(
    app: AppHandle,
    state: State<'_, ConfigState>,
) -> Result<ConfigResponse, String> {
    // 第一次调用时从磁盘加载到内存
    {
        let initialized = state
            .initialized
            .read()
            .map_err(|e| format!("锁读取失败: {e}"))?;
        if *initialized {
            let guard = state.inner.read().map_err(|e| format!("锁读取失败: {e}"))?;
            let path = config_file(&app)?;
            return Ok(ConfigResponse {
                config: guard.clone(),
                config_path: path.to_string_lossy().to_string(),
            });
        }
    }

    let cfg = load_config_from_disk(&app)?;
    {
        let mut guard = state.inner.write().map_err(|e| format!("锁写入失败: {e}"))?;
        *guard = cfg.clone();
    }
    {
        let mut init = state.initialized.write().map_err(|e| format!("锁写入失败: {e}"))?;
        *init = true;
    }
    let path = config_file(&app)?;
    Ok(ConfigResponse {
        config: cfg,
        config_path: path.to_string_lossy().to_string(),
    })
}

/// 保存应用配置
#[tauri::command]
pub fn save_config(
    app: AppHandle,
    state: State<'_, ConfigState>,
    config: AppConfig,
) -> Result<(), String> {
    save_config_to_disk(&app, &config)?;
    {
        let mut guard = state.inner.write().map_err(|e| format!("锁写入失败: {e}"))?;
        *guard = config;
    }
    Ok(())
}

/// 重置所有配置为默认值
#[tauri::command]
pub fn reset_config(
    app: AppHandle,
    state: State<'_, ConfigState>,
) -> Result<AppConfig, String> {
    let defaults = AppConfig::default();
    save_config_to_disk(&app, &defaults)?;
    {
        let mut guard = state.inner.write().map_err(|e| format!("锁写入失败: {e}"))?;
        *guard = defaults.clone();
    }
    Ok(defaults)
}

/// 单个 Prompt 恢复默认值
#[derive(Debug, Deserialize)]
pub struct RestorePromptArgs {
    /// "q1_4" | "q5_14" | "q15_18" | "q15_18_scoring" | "q19_scoring"
    pub key: String,
}

#[tauri::command]
pub fn restore_default_prompt(args: RestorePromptArgs) -> Result<String, String> {
    let defaults = default_prompts();
    match args.key.as_str() {
        "q1_4" => Ok(defaults.q1_4),
        "q5_14" => Ok(defaults.q5_14),
        "q15_18" => Ok(defaults.q15_18),
        "q15_18_scoring" => Ok(defaults.q15_18_scoring),
        "q19_scoring" => Ok(defaults.q19_scoring),
        other => Err(format!("未知 Prompt key: {other}")),
    }
}

/// 恢复流程时长为默认值（一次性还原全部 10 个阶段时长）
#[tauri::command]
pub fn restore_default_timing() -> Result<TimingConfig, String> {
    Ok(TimingConfig::default())
}

// ===== 难度（difficulty）相关 =====

/// 单个难度文字恢复（细粒度，对齐 `restore_default_prompt` 的形态）
#[derive(Debug, Deserialize)]
pub struct RestoreDifficultyDemandArgs {
    /// "junior_high" | "senior_high" | "undergraduate"
    pub level: String,
    /// "demand_1_4" | "demand_5_14" | "demand_15_18"
    pub key: String,
}

#[tauri::command]
pub fn restore_default_difficulty_demand(
    args: RestoreDifficultyDemandArgs,
) -> Result<String, String> {
    let defaults = default_difficulty_demands();
    let demand = match args.level.as_str() {
        "junior_high" => &defaults.junior_high,
        "senior_high" => &defaults.senior_high,
        "undergraduate" => &defaults.undergraduate,
        other => return Err(format!("未知难度档: {other}")),
    };
    Ok(match args.key.as_str() {
        "demand_1_4" => demand.demand_1_4.clone(),
        "demand_5_14" => demand.demand_5_14.clone(),
        "demand_15_18" => demand.demand_15_18.clone(),
        other => return Err(format!("未知 demand key: {other}")),
    })
}

/// 恢复整档（3 段文字一次性还原）
#[tauri::command]
pub fn restore_default_difficulty_level(level: String) -> Result<DifficultyDemand, String> {
    let defaults = default_difficulty_demands();
    Ok(match level.as_str() {
        "junior_high" => defaults.junior_high,
        "senior_high" => defaults.senior_high,
        "undergraduate" => defaults.undergraduate,
        other => return Err(format!("未知难度档: {other}")),
    })
}

/// 恢复全部（level + 三档文字一起还原）
#[tauri::command]
pub fn restore_default_difficulty() -> Result<DifficultyConfig, String> {
    Ok(DifficultyConfig::default())
}

/// 打开配置文件所在目录（调试用）
#[tauri::command]
pub fn open_config_dir(app: AppHandle) -> Result<String, String> {
    let path = config_file(&app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "无法获取配置文件父目录".to_string())?;
    Ok(dir.to_string_lossy().to_string())
}
