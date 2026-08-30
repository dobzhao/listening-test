//! 判分相关 Tauri commands
//!
//! - `score_full_test`：完整评分入口（1-14 本地 + 15-18 LLM + 19 STT+LLM + v1.1+ 自适应更新）

use adaptive_difficulty::Params;
use crate::commands::adaptive::AdaptiveStateHandle;
use crate::commands::config::ConfigState;
use crate::commands::test_flow::FlowGlobal;
use crate::commands::test_session::SessionState;
use crate::models::result::TestResult;
use crate::services::adaptive as adaptive_svc;
use crate::services::scoring::score_full_test as run_scoring;
use tauri::AppHandle;
use tracing::info;

#[tauri::command]
pub async fn score_full_test(
    app: AppHandle,
    config_state: tauri::State<'_, ConfigState>,
    session_state: tauri::State<'_, SessionState>,
    flow: tauri::State<'_, FlowGlobal>,
    adaptive_handle: tauri::State<'_, AdaptiveStateHandle>,
    is_retest: bool,
) -> Result<TestResult, String> {
    // 1. 取配置
    let config = {
        let guard = config_state
            .inner
            .read()
            .map_err(|e| format!("锁读取失败: {e}"))?;
        guard.clone()
    };

    // 2. 取会话
    let session = {
        let guard = session_state
            .inner
            .lock()
            .map_err(|e| format!("锁读取失败: {e}"))?;
        guard.clone().ok_or_else(|| "尚未生成测试会话".to_string())?
    };

    info!(
        "score_full_test: 开始评分 session_id={} is_retest={}",
        session.session_id, is_retest
    );

    // 3. 取用户作答与正确答案
    let (user_answers, correct_answers, recording_path) = {
        let guard = flow
            .container
            .inner
            .lock()
            .map_err(|e| format!("锁读取失败: {e}"))?;
        let rec = guard.answers.get(&19).cloned().flatten();
        (guard.answers.clone(), guard.correct_answers.clone(), rec)
    };

    info!(
        "score_full_test: user_answers={} 条, 19题录音路径={:?}",
        user_answers.len(),
        recording_path
    );

    // 4. 计算 1-14 题 ID 列表（按升序）
    let mut mcq_ids: Vec<u32> = correct_answers
        .keys()
        .copied()
        .filter(|k| *k <= 14)
        .collect();
    mcq_ids.sort();

    // 5. v1.1+ 加载自适应参数（启动时已加载到内存，但命令路径上重新读盘确保最新编辑生效）
    let adaptive_params: Params = adaptive_svc::load_params_from_disk(&app);

    // 6. 取 adaptive state 写锁（update 需要 &mut）。先克隆一份 before，方便持久化前不污染
    let mut state_guard = adaptive_handle.0.write().await;

    // 7. 执行完整评分（含自适应更新）
    let result = run_scoring(
        &config,
        &session,
        &user_answers,
        &correct_answers,
        &mcq_ids,
        recording_path.as_deref(),
        &mut *state_guard,
        &adaptive_params,
        is_retest,
        Some(&app),
    )
    .await
    .map_err(|e| format!("评分失败: {e}"))?;

    // 8. 持久化自适应状态（仅在非 retest 且 update 成功的路径上 state 已被修改）
    if !is_retest {
        if let Err(e) = adaptive_svc::save_state_to_disk(&app, &state_guard) {
            // 持久化失败仅记录日志，state 已在内存中更新；下次启动会从内存恢复
            tracing::info!(
                error = %e,
                "持久化 adaptive_state.json 失败（不影响本次评分结果）"
            );
        }
    }

    info!(
        "score_full_test: 评分完成 总分={}/{} adaptive={} is_retest={}",
        result.total_score,
        result.max_score,
        result.adaptive.is_some(),
        result.is_retest
    );

    Ok(result)
}