//! 预生成题库（Pregen Pool）服务层
//!
//! 三大职责：
//! 1. **索引持久化**：`<app_data_dir>/pregen/index.json`（atomic_write_json）
//! 2. **启动恢复**：`recover_index` 扫描磁盘子目录，缺 `session.json` 或音频不全则清理
//! 3. **后台 worker**：单例串行处理 `pending_count`，每套调用
//!    `services::test_session::generate_full_session_at` 在 `pregen/{uuid}/` 下生成
//!
//! **不完整题库永不视为可用**（安全约束）：生成过程中只在写完所有 audio + session.json
//! 之后才插入索引；启动扫描发现缺文件则整目录删除。

use std::path::Path;
use std::sync::atomic::{Ordering};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tracing::{error, info, warn};

use super::super::commands::pregen::{
    PreGenFailedPayload, PreGenFinishedPayload, PreGenProgressPayload, PREGEN_FAILED_EVENT,
    PREGEN_FINISHED_EVENT, PREGEN_PROGRESS_EVENT,
};
use crate::commands::adaptive::{AdaptiveStateHandle, AdaptiveStateSnapshot};
use crate::commands::config::ConfigState;
use crate::models::config::AppConfig;
use crate::models::pregen::{PregenEntry, PregenMeta, PregenPoolState, PregenStatus, PregenSummary};
use crate::models::question::TestSession;
use crate::services::adaptive as adaptive_svc;
use crate::services::test_session::generate_full_session_at;
use crate::utils::path::{pregen_dir, pregen_index_file, pregen_root, session_cache_dir};

// ===== 索引读写 =====

/// 读 `pregen/index.json`：文件不存在或解析失败 → fallback 空索引（不报错）
pub fn load_index(app: &AppHandle) -> PregenPoolState {
    let path = match pregen_index_file(app) {
        Ok(p) => p,
        Err(e) => {
            warn!(error = %e, "pregen index 路径解析失败，回退空索引");
            return PregenPoolState::default();
        }
    };
    if !path.exists() {
        return PregenPoolState::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<PregenPoolState>(&text) {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "pregen index 解析失败，回退空索引（启动时 recover_index 会重建）");
                PregenPoolState::default()
            }
        },
        Err(e) => {
            warn!(error = %e, "pregen index 读取失败，回退空索引");
            PregenPoolState::default()
        }
    }
}

/// 原子写 `pregen/index.json`
pub fn save_index(app: &AppHandle, state: &PregenPoolState) -> Result<(), String> {
    let path = pregen_index_file(app)?;
    crate::utils::path::atomic_write_json(&path, state)
}

/// sha256(5 个模板拼接)；hex；用于记录「这套题库生成时 prompts 长什么样」
/// 当前不校验（用户选择永不过期），但保留字段以备未来迁移。
pub fn compute_prompts_hash(config: &AppConfig) -> String {
    let mut h = Sha256::new();
    let pairs: [(&str, &str); 5] = [
        ("q1_4", &config.prompts.q1_4),
        ("q5_14", &config.prompts.q5_14),
        ("q15_18", &config.prompts.q15_18),
        ("q15_18_scoring", &config.prompts.q15_18_scoring),
        ("q19_scoring", &config.prompts.q19_scoring),
    ];
    for (key, text) in pairs {
        h.update(format!("{key}=").as_bytes());
        h.update(text.as_bytes());
        h.update(b"\n");
    }
    hex::encode(h.finalize())
}

// ===== 启动恢复 =====

/// 启动扫描 `pregen/{uuid}/` 每个子目录，严格校验：
/// - 缺 `session.json` → 视为不完整，整目录删除
/// - `session.json` 解析失败 → 整目录删除
/// - `audio_paths` 中任一文件不存在 → 整目录删除
/// - 全部完整 → 插入 `PregenPoolState.entries`（status = Unused）
///
/// level/mode/prompts_hash 优先读 `meta.json`（v1.1+ 写入）；
/// 缺失时（v1.1 之前的旧题库）回退到当前 effective_level（更友好的兜底，比
/// 固定为 "junior_high" 更接近用户预期）。
pub fn recover_index(app: &AppHandle) -> PregenPoolState {
    let root = match pregen_root(app) {
        Ok(p) => p,
        Err(e) => {
            warn!(error = %e, "pregen_root 解析失败，跳过 recover_index");
            return PregenPoolState::default();
        }
    };

    let current_effective_level = resolve_current_effective_level(app);
    let current_effective_level = current_effective_level.unwrap_or_else(|_| "junior_high".to_string());
    info!(
        current_effective_level = %current_effective_level,
        "recover_index: 兜底 level 用当前 effective_level"
    );

    let mut new_state = PregenPoolState::default();
    let entries = match std::fs::read_dir(&root) {
        Ok(rd) => rd,
        Err(e) => {
            warn!(error = %e, "读取 pregen/ 失败，跳过 recover_index");
            return new_state;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let session_json = path.join("session.json");
        if !session_json.exists() {
            warn!(path = %path.display(), "recover_index: 缺 session.json，删除整个目录");
            let _ = std::fs::remove_dir_all(&path);
            continue;
        }
        let text = match std::fs::read_to_string(&session_json) {
            Ok(t) => t,
            Err(e) => {
                warn!(error = %e, path = %path.display(), "recover_index: session.json 读取失败，删除目录");
                let _ = std::fs::remove_dir_all(&path);
                continue;
            }
        };
        let session: TestSession = match serde_json::from_str(&text) {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, path = %path.display(), "recover_index: session.json 解析失败，删除目录");
                let _ = std::fs::remove_dir_all(&path);
                continue;
            }
        };
        let mut complete = true;
        for (key, wav_path) in &session.audio_paths {
            if !Path::new(wav_path).exists() {
                warn!(
                    path = %path.display(),
                    key = %key,
                    wav = %wav_path,
                    "recover_index: 缺音频文件，删除目录"
                );
                complete = false;
                break;
            }
        }
        if !complete {
            let _ = std::fs::remove_dir_all(&path);
            continue;
        }
        // 读取 meta.json（如有）→ 用真实 level / mode / prompts_hash；缺失则兜底到当前 effective_level
        let meta_path = path.join("meta.json");
        let meta = std::fs::read_to_string(&meta_path)
            .ok()
            .and_then(|t| serde_json::from_str::<PregenMeta>(&t).ok());
        let (level, mode, prompts_hash) = match meta {
            Some(m) => (m.level, m.mode, m.prompts_hash),
            None => (
                current_effective_level.clone(),
                "manual".to_string(),
                String::new(),
            ),
        };
        let dir_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&session.session_id)
            .to_string();
        let entry = PregenEntry {
            session_id: dir_name,
            created_at: chrono::Local::now().to_rfc3339(),
            prompts_hash,
            level,
            mode,
            status: PregenStatus::Unused,
        };
        new_state.entries.insert(entry.session_id.clone(), entry);
    }

    if let Err(e) = save_index(app, &new_state) {
        warn!(error = %e, "recover_index 写盘失败");
    }
    info!(
        recovered_count = new_state.entries.len(),
        "pregen recover_index 完成"
    );
    new_state
}

/// 同步读当前 effective_level（用于 recover_index 兜底）
fn resolve_current_effective_level(app: &AppHandle) -> Result<String, String> {
    let config = {
        let cfg_state = app.state::<ConfigState>();
        let guard = cfg_state
            .inner
            .read()
            .map_err(|e| format!("ConfigState 读锁失败: {e}"))?;
        guard.clone()
    };
    // 这里无法 .await（recover_index 是同步函数），所以用 try_read 拿 adaptive state 快照；
    // 取不到就用 config.difficulty.level 兜底
    let adaptive = app.state::<AdaptiveStateHandle>();
    let snap = if let Ok(g) = adaptive.0.try_read() {
        AdaptiveStateSnapshot::from(&*g)
    } else {
        return Ok(config.difficulty.level.clone());
    };
    let eff = adaptive_svc::effective_level(
        &adaptive_difficulty::AdaptiveState {
            ability_score: snap.ability_score,
            trend: snap.trend,
            current_level: adaptive_svc::parse_level(&snap.current_level),
            update_count: snap.update_count,
        },
        &config.difficulty.mode,
        &config.difficulty.level,
    );
    Ok(eff)
}

// ===== activate_one =====

/// 把 `pregen/{uuid}/` 整个目录 move 到 `cache/{uuid}/`：
/// - 目标存在（cache 中残留）则先 `remove_dir_all` 兜底
/// - **关键修复**：读 `session.json` 后把所有 `audio_paths` 键里的绝对路径从
///   `.../pregen/{uuid}/audio/<file>.wav` 改写成 `.../cache/{uuid}/audio/<file>.wav`，
///   然后落盘。audio_paths 是绝对路径，目录一旦移动必须同步重写，
///   否则 test_flow 播放时会找不到 wav 文件。
///
/// 返回值：重写 audio_paths 之后的 `TestSession`，方便 caller 直接复用
/// （避免再次读盘 + 二次解析）。
pub fn activate_one(app: &AppHandle, session_id: &str) -> Result<TestSession, String> {
    let src = pregen_dir(app, session_id)?;
    if !src.exists() {
        return Err(format!("题库目录不存在: {session_id}"));
    }
    let dst = session_cache_dir(app, session_id)?;
    if dst.exists() {
        std::fs::remove_dir_all(&dst).map_err(|e| format!("清理旧 cache 失败: {e}"))?;
    }
    if std::fs::rename(&src, &dst).is_err() {
        copy_dir_recursive(&src, &dst)?;
        std::fs::remove_dir_all(&src).map_err(|e| format!("清理源目录失败: {e}"))?;
    }

    // 重写 session.json 中的 audio_paths 绝对路径
    let session_json_path = dst.join("session.json");
    let text = std::fs::read_to_string(&session_json_path)
        .map_err(|e| format!("读取 session.json 失败: {e}"))?;
    let mut session: TestSession = serde_json::from_str(&text)
        .map_err(|e| format!("解析 session.json 失败: {e}"))?;
    let new_audio_dir_str = dst.join("audio").to_string_lossy().to_string();
    for (_key, wav_path) in session.audio_paths.iter_mut() {
        let file_name = Path::new(wav_path)
            .file_name()
            .ok_or_else(|| format!("非法 audio 路径: {wav_path}"))?;
        *wav_path = format!(
            "{}/{}",
            new_audio_dir_str.trim_end_matches('/'),
            file_name.to_string_lossy()
        );
    }
    let updated_json = serde_json::to_string_pretty(&session)
        .map_err(|e| format!("序列化 session.json 失败: {e}"))?;
    std::fs::write(&session_json_path, updated_json)
        .map_err(|e| format!("写 session.json 失败: {e}"))?;

    info!(
        session_id = %session_id,
        "题库已激活到 cache/（audio_paths 已重写）"
    );
    Ok(session)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目标目录失败: {e}"))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("读取源目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("目录项读取失败: {e}"))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("复制文件失败: {e}"))?;
        }
    }
    Ok(())
}

/// 从 `cache/{uuid}/session.json` 加载 TestSession
pub fn load_session_json(app: &AppHandle, session_id: &str) -> Result<TestSession, String> {
    let dir = session_cache_dir(app, session_id)?;
    let text = std::fs::read_to_string(dir.join("session.json"))
        .map_err(|e| format!("读取 session.json 失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("解析 session.json 失败: {e}"))
}

/// 从 `pregen/{uuid}/session.json` 加载 TestSession（题库池中的元数据，audio_paths 指向 pregen/）
///
/// 用法：`pick_test_from_pregen` 在不动文件状态的前提下把题库条目加载到 SessionState。
/// `activate_one` 之后 audio_paths 会被重写到 cache/，再走 `load_session_json`。
pub fn load_pregen_session_json(
    app: &AppHandle,
    session_id: &str,
) -> Result<TestSession, String> {
    let dir = pregen_dir(app, session_id)?;
    let text = std::fs::read_to_string(dir.join("session.json"))
        .map_err(|e| format!("读取 pregen session.json 失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("解析 pregen session.json 失败: {e}"))
}

// ===== worker =====

/// 确保后台 worker 在跑：若已存在则复用，否则 spawn
///
/// 用 `tauri::async_runtime::spawn` 而不是 `tokio::spawn`：前者由 Tauri 抽象保证
/// 在任意上下文（sync Tauri command / async Tauri command / setup hook）都能跑；
/// 后者要求当前线程已 attach 到 tokio runtime，sync Tauri command 默认没有。
pub fn ensure_worker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let rt = app.state::<crate::models::pregen::PregenPoolRuntime>();
        let mut guard = rt.worker.lock().await;
        if guard.is_some() {
            return;
        }
        let handle = tauri::async_runtime::spawn(worker_loop(app.clone()));
        *guard = Some(handle);
    });
}

/// worker 主循环：串行处理 pending_count
async fn worker_loop(app: AppHandle) {
    loop {
        let rt = app.state::<crate::models::pregen::PregenPoolRuntime>();
        if rt.cancel_flag.load(Ordering::SeqCst) {
            info!("pregen worker: 检测到取消信号，退出");
            rt.cancel_flag.store(false, Ordering::SeqCst);
            rt.pending_count.store(0, Ordering::SeqCst);
            break;
        }
        let pending = rt.pending_count.load(Ordering::SeqCst);
        if pending == 0 {
            break;
        }
        rt.pending_count.fetch_sub(1, Ordering::SeqCst);
        let total = rt.current_total.load(Ordering::SeqCst);
        let next_index = {
            let cur = rt.current_index.load(Ordering::SeqCst);
            rt.current_index.store(cur + 1, Ordering::SeqCst);
            cur + 1
        };

        match generate_one_pregen(&app, next_index, total).await {
            Ok(entry) => {
                let rt = app.state::<crate::models::pregen::PregenPoolRuntime>();
                let mut pool = rt.pool.write().await;
                let session_id = entry.session_id.clone();
                pool.entries.insert(session_id.clone(), entry);
                if let Err(e) = save_index(&app, &pool) {
                    warn!(error = %e, "pregen index 落盘失败");
                }
                info!(session_id = %session_id, "pregen: 完成一套");
            }
            Err(e) => {
                error!(error = %e, "pregen: 单套生成失败");
                let rt = app.state::<crate::models::pregen::PregenPoolRuntime>();
                *rt.last_error.lock().unwrap() = Some(e.clone());
                let payload = PreGenFailedPayload {
                    session_id: String::new(),
                    error: e,
                };
                let _ = app.emit(PREGEN_FAILED_EVENT, &payload);
            }
        }

        let payload = PreGenProgressPayload {
            session_id: String::new(),
            current: next_index,
            total,
            stage: "done".to_string(),
            message: "本套生成完成".to_string(),
            progress: 1.0,
        };
        let _ = app.emit(PREGEN_PROGRESS_EVENT, &payload);
    }

    let rt = app.state::<crate::models::pregen::PregenPoolRuntime>();
    rt.current_index.store(0, Ordering::SeqCst);
    rt.current_total.store(0, Ordering::SeqCst);
    *rt.worker.lock().await = None;
    info!("pregen worker: 已退出");

    let payload = PreGenFinishedPayload {
        requested: 0,
        succeeded: 0,
        failed: 0,
    };
    let _ = app.emit(PREGEN_FINISHED_EVENT, &payload);
}

async fn generate_one_pregen(
    app: &AppHandle,
    current_index: u32,
    total: u32,
) -> Result<PregenEntry, String> {
    use uuid::Uuid;

    let session_id = Uuid::new_v4().to_string();
    let dir = pregen_dir(app, &session_id)?;
    let (config, effective_level) = resolve_effective_level(app).await?;

    info!(
        session_id = %session_id,
        current = current_index,
        total = total,
        effective_level = %effective_level,
        "pregen: 开始生成一套"
    );

    let payload = PreGenProgressPayload {
        session_id: session_id.clone(),
        current: current_index,
        total,
        stage: "started".to_string(),
        message: format!("开始生成第 {current_index}/{total} 套"),
        progress: 0.0,
    };
    let _ = app.emit(PREGEN_PROGRESS_EVENT, &payload);

    let session = generate_full_session_at(app, &config, &effective_level, &session_id, &dir)
        .await
        .map_err(|e| format!("生成失败: {e}"))?;

    // **不完整题库永不视为可用** —— 最后一道防线
    let session_json = dir.join("session.json");
    if !session_json.exists() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!(
            "{session_id}: session.json 缺失（生成流程异常），目录已清理"
        ));
    }
    for (key, wav_path) in &session.audio_paths {
        if !Path::new(wav_path).exists() {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!(
                "{session_id}: 音频 {key} ({wav_path:?}) 缺失，目录已清理"
            ));
        }
    }

    // 写 meta.json（v1.1+）：recover_index 启动时优先读这个文件以恢复真实 level / mode / prompts_hash
    let prompts_hash = compute_prompts_hash(&config);
    let meta = PregenMeta {
        level: effective_level.clone(),
        mode: config.difficulty.mode.clone(),
        created_at: chrono::Local::now().to_rfc3339(),
        prompts_hash: prompts_hash.clone(),
    };
    let meta_json = serde_json::to_string_pretty(&meta)
        .map_err(|e| format!("序列化 meta.json 失败: {e}"))?;
    std::fs::write(dir.join("meta.json"), meta_json)
        .map_err(|e| format!("写 meta.json 失败: {e}"))?;

    Ok(PregenEntry {
        session_id: session_id.clone(),
        created_at: meta.created_at,
        prompts_hash,
        level: effective_level.clone(),
        mode: config.difficulty.mode.clone(),
        status: PregenStatus::Unused,
    })
}

/// 解析 effective_level：复用 `services::adaptive::effective_level`
async fn resolve_effective_level(app: &AppHandle) -> Result<(AppConfig, String), String> {
    let config = {
        let cfg_state = app.state::<ConfigState>();
        let guard = cfg_state
            .inner
            .read()
            .map_err(|e| format!("ConfigState 读锁失败: {e}"))?;
        guard.clone()
    };
    let snap: AdaptiveStateSnapshot = {
        let adaptive = app.state::<AdaptiveStateHandle>();
        let g = adaptive.0.read().await;
        AdaptiveStateSnapshot::from(&*g)
    };
    let eff = adaptive_svc::effective_level(
        &adaptive_difficulty::AdaptiveState {
            ability_score: snap.ability_score,
            trend: snap.trend,
            current_level: adaptive_svc::parse_level(&snap.current_level),
            update_count: snap.update_count,
        },
        &config.difficulty.mode,
        &config.difficulty.level,
    );
    Ok((config, eff))
}

// ===== 摘要（异步，因为 pool 是 tokio RwLock） =====

/// 是否有 worker 在跑或队列非空。
///
/// **同步**（不碰 `pool`，只读 worker 锁与原子计数），因此可以在
/// `lib.rs` 的 `on_window_event` 主线程闭包里直接调用 —— `build_summary`
/// 因为要 `await` 读 `pool` 而不行。
///
/// worker 锁竞争时保守返回 `true`（视为生成中），与 `build_summary` 语义一致。
pub fn is_generating(app: &AppHandle) -> bool {
    let rt = app.state::<crate::models::pregen::PregenPoolRuntime>();
    let worker_alive = rt.worker.try_lock().map(|g| g.is_some()).unwrap_or(true);
    worker_alive || rt.pending_count.load(Ordering::SeqCst) > 0
}

/// 构造 PregenSummary：必须 async（读 pool 需 await）
pub async fn build_summary(app: &AppHandle) -> PregenSummary {
    let generating_now = is_generating(app);
    let rt = app.state::<crate::models::pregen::PregenPoolRuntime>();
    let current_index = rt.current_index.load(Ordering::SeqCst);
    let current_total = rt.current_total.load(Ordering::SeqCst);
    let last_error = rt.last_error.lock().unwrap().clone();
    let pool = rt.pool.read().await;
    PregenSummary::from_state(
        &pool,
        generating_now,
        current_index,
        current_total,
        last_error,
    )
}

// ===== 取消 / 入队 =====

/// 设置取消信号 + 清零队列
pub fn request_cancel(app: &AppHandle) {
    let rt = app.state::<crate::models::pregen::PregenPoolRuntime>();
    rt.cancel_flag.store(true, Ordering::SeqCst);
    rt.pending_count.store(0, Ordering::SeqCst);
}

/// 把 pending_count 增加 count，current_total 设为累计目标
pub fn enqueue(app: &AppHandle, count: u32) {
    let rt = app.state::<crate::models::pregen::PregenPoolRuntime>();
    rt.cancel_flag.store(false, Ordering::SeqCst);
    let new_total = rt.pending_count.fetch_add(count, Ordering::SeqCst) + count;
    rt.current_total.store(new_total, Ordering::SeqCst);
}