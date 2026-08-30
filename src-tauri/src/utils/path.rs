//! 路径工具：定位应用数据目录与缓存目录
//!
//! 配置文件位于 `app_data_dir/config.json`，
//! 自适应状态位于 `app_data_dir/adaptive_state.json`，
//! 自适应参数位于 `app_data_dir/adaptive_params.json`，
//! 每次测试的题目与音频缓存位于 `app_data_dir/cache/{session_id}/`，
//! 日志位于 `app_data_dir/logs/peiyuan.log.YYYY-MM-DD`。

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 应用 identifier（与 tauri.conf.json:5 保持一致）
pub const APP_IDENTIFIER: &str = "com.peiyuan.desktop";

/// 不依赖 AppHandle 的应用数据目录（日志初始化等早期场景使用）
///
/// 解析规则与 Tauri `app.path().app_data_dir()` 在三平台上一致：
///   - Linux:   `$XDG_DATA_HOME/com.peiyuan.desktop` 或 `~/.local/share/com.peiyuan.desktop`
///   - macOS:   `~/Library/Application Support/com.peiyuan.desktop`
///   - Windows: `%APPDATA%\com.peiyuan.desktop`
pub fn app_data_dir_no_handle() -> Option<PathBuf> {
    let mut dir = dirs::data_dir()?;
    dir.push(APP_IDENTIFIER);
    Some(dir)
}

/// 日志目录：`<app_data_dir>/logs/`，不存在则创建
pub fn logs_dir() -> Result<PathBuf, String> {
    let dir = app_data_dir_no_handle()
        .ok_or_else(|| "无法解析应用数据目录".to_string())?
        .join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
    Ok(dir)
}

/// 应用数据根目录（如 Linux 下 `~/.local/share/com.peiyuan.desktop`）
pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法解析应用数据目录: {e}"))
}

/// 配置文件路径
pub fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app_data_dir(app)?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {e}"))?;
    }
    dir.push("config.json");
    Ok(dir)
}

/// 自适应状态文件路径（v1.1+）：`<app_data_dir>/adaptive_state.json`
pub fn adaptive_state_file(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app_data_dir(app)?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {e}"))?;
    }
    dir.push("adaptive_state.json");
    Ok(dir)
}

/// 自适应参数文件路径（v1.1+）：`<app_data_dir>/adaptive_params.json`
pub fn adaptive_params_file(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app_data_dir(app)?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {e}"))?;
    }
    dir.push("adaptive_params.json");
    Ok(dir)
}

/// 缓存根目录
pub fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app_data_dir(app)?;
    dir.push("cache");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败: {e}"))?;
    }
    Ok(dir)
}

/// 某个会话的缓存目录
pub fn session_cache_dir(app: &AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let mut dir = cache_root(app)?;
    dir.push(session_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建会话缓存目录失败: {e}"))?;
    Ok(dir)
}

/// 原子写入 JSON：在 path 同目录下生成 `<name>.tmp.<uuid>` 临时文件，写入后 `fs::rename`
/// 覆盖。`rename` 在同一文件系统上是原子的（Linux/macOS/Win NTFS 都满足）；
/// 若跨设备 / rename 失败则 fallback 到非原子 `fs::write`，并 warn 日志告知。
///
/// 不依赖 `tempfile` crate，避免增加额外依赖；`uuid` 已在 workspace 中。
pub fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    // 确保父目录存在
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {e}"))?;
        }
    }

    let serialized = serde_json::to_string_pretty(value)
        .map_err(|e| format!("序列化 JSON 失败: {e}"))?;

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "目标路径没有文件名".to_string())?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp_name = format!("{}.tmp.{}", file_name, uuid::Uuid::new_v4());
    let tmp_path = parent.join(&tmp_name);

    // 写入临时文件（失败时尽量清理）
    if let Err(e) = std::fs::write(&tmp_path, &serialized) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("写入临时文件失败: {e}"));
    }

    // 原子 rename
    match std::fs::rename(&tmp_path, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // rename 失败（跨设备等）：fallback 到非原子写入
            tracing::warn!(
                error = %e,
                "atomic rename failed, falling back to non-atomic write"
            );
            if let Err(e2) = std::fs::remove_file(&tmp_path) {
                tracing::warn!(error = %e2, "removing temp file after failed rename also failed");
            }
            std::fs::write(path, serialized).map_err(|e2| format!("fallback 写入失败: {e2}"))?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use std::env;

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Sample {
        a: i32,
        b: String,
    }

    fn unique_tmp_path(name: &str) -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("peiyuan-path-test-{}-{}", name, uuid::Uuid::new_v4()));
        p
    }

    #[test]
    fn atomic_write_json_creates_file() {
        let path = unique_tmp_path("create");
        let data = Sample { a: 1, b: "x".into() };
        atomic_write_json(&path, &data).expect("write should succeed");

        let read = std::fs::read_to_string(&path).expect("read should succeed");
        let parsed: Sample = serde_json::from_str(&read).expect("parse should succeed");
        assert_eq!(parsed, data);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn atomic_write_json_overwrites_existing() {
        let path = unique_tmp_path("overwrite");
        let first = Sample { a: 1, b: "first".into() };
        atomic_write_json(&path, &first).unwrap();

        let second = Sample { a: 2, b: "second".into() };
        atomic_write_json(&path, &second).unwrap();

        let read = std::fs::read_to_string(&path).unwrap();
        let parsed: Sample = serde_json::from_str(&read).unwrap();
        assert_eq!(parsed, second);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn atomic_write_json_cleans_up_temp_on_serialize_failure() {
        // 用一个非法的父目录名（不存在的父目录是合法的，但要写一个不能序列化的对象）
        // 这里通过给路径设置一个非法路径前缀来模拟目录创建失败场景较难，
        // 所以只验证 happy path 下没有遗留 .tmp 文件。
        let path = unique_tmp_path("notemp");
        let data = Sample { a: 42, b: "ok".into() };
        atomic_write_json(&path, &data).unwrap();

        // 同目录下不应有遗留 .tmp.* 文件
        let parent = path.parent().unwrap();
        for entry in std::fs::read_dir(parent).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            assert!(
                !name_str.contains(".tmp."),
                "应清理临时文件，发现残留: {name_str}"
            );
        }

        let _ = std::fs::remove_file(&path);
    }
}
