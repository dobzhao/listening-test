//! 关窗拦截 Tauri commands
//!
//! ## 为什么拦截逻辑在 Rust 而不在前端
//!
//! Tauri 的 `manager/window.rs::on_window_event` 里有这么一段：
//!
//! ```ignore
//! WindowEvent::CloseRequested { api } => {
//!     if window.has_js_listener(WINDOW_CLOSE_REQUESTED_EVENT) {
//!         api.prevent_close();          // 只要前端注册了监听就无条件拦截
//!     }
//!     window.emit_to_window(WINDOW_CLOSE_REQUESTED_EVENT, &())?;
//! }
//! ```
//!
//! 也就是说：**前端一旦 `listen('tauri://close-requested')`（`Window.onCloseRequested`
//! 内部就是它），原生关窗就被永久禁用**，唯一出路变成前端主动调 `destroy()`。
//! 而 `plugin:window|destroy` 受 ACL 管控，`core:window:default` 只含只读 getter，
//! 不含 `allow-destroy` —— 于是 `destroy()` 被驳回，窗口彻底关不掉。
//!
//! 因此本模块把决策放回 Rust：
//! - 空闲 → 不 `prevent_close`，原生关窗，零权限依赖
//! - 忙碌 → `prevent_close` + emit **自定义事件** `app-close-requested`，
//!   前端弹应用内 `ConfirmDialog`，确认后调 `confirm_close_app` 由 Rust 关窗
//!
//! ⚠️ 前端**绝不能**监听 `tauri://close-requested`，否则上面那段逻辑会让
//! 每一次关窗都被无条件拦截，bug 原样复现。只能监听 `CLOSE_REQUESTED_EVENT`。

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::{error, info, warn};

use crate::commands::audio::AudioPlaybackState;
use crate::commands::test_flow::{reset_test_flow, FlowGlobal};
use crate::services::pregen as pregen_svc;

/// 关窗确认事件名。**不是** `tauri://close-requested`，原因见模块文档。
pub const CLOSE_REQUESTED_EVENT: &str = "app-close-requested";

/// 拦截原因，前端据此选择提示文案
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseReason {
    /// 题库预生成 worker 在跑或队列非空
    Generating,
    /// 1-19 题测试流程运行中
    Testing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseRequestedPayload {
    pub reason: CloseReason,
}

/// 关窗确认的运行时状态
#[derive(Default)]
pub struct CloseGuardState {
    /// 确认框是否已弹出且尚未收到用户答复。
    /// 用于逃生阀：确认框弹着时再点一次 X 直接放行，避免前端卡住时用户被困。
    pub prompt_pending: AtomicBool,
}

/// 判断本次 `CloseRequested` 是否需要拦截；需要则 emit 确认事件并返回 `true`。
///
/// 由 `lib.rs` 的 `on_window_event` 在主线程闭包中调用，因此全程非阻塞：
/// 两个忙碌判定都走 `try_lock` / 原子读。
///
/// 所有异常路径一律**放行**（返回 `false`）——关不掉窗口比误关窗口严重得多。
pub fn intercept_close(app: &AppHandle) -> bool {
    let reason = if pregen_svc::is_generating(app) {
        CloseReason::Generating
    } else if app.state::<FlowGlobal>().container.is_running() {
        CloseReason::Testing
    } else {
        info!("关窗请求：无进行中的任务，直接放行");
        return false;
    };

    let guard = app.state::<CloseGuardState>();
    // 逃生阀：确认框已经弹着还再点一次 X → 不再拦截
    if guard.prompt_pending.swap(true, Ordering::SeqCst) {
        warn!("关窗请求：确认框已在等待中，第二次请求强制放行");
        return false;
    }

    if let Err(e) = app.emit(CLOSE_REQUESTED_EVENT, CloseRequestedPayload { reason }) {
        // 事件都发不出去说明前端不可用，此时拦截只会把用户困住
        error!("关窗确认事件发送失败，直接放行关闭: {e}");
        guard.prompt_pending.store(false, Ordering::SeqCst);
        return false;
    }

    info!(?reason, "关窗请求：已拦截，等待用户确认");
    true
}

/// 用户在确认框点「确认关闭」
///
/// 收尾顺序：
/// 1. 取消预生成队列。半成品目录不用管——worker 只在写完所有 audio + session.json
///    后才插入索引，中途中断的目录会被下次启动的 `recover_index` 清掉。
/// 2. 复用 `reset_test_flow`：abort `run_flow` 任务 + 置 `audio.active_stop_flag`。
///    后者是必要的：rodio 跑在 detached `std::thread` 上，不随 tokio runtime 结束，
///    不停会拖住音频设备的释放。
/// 3. Rust 侧 `destroy()` 关窗。ACL 只管 IPC 命令，Rust 直接调不受限。
///    用 `destroy()` 而非 `app.exit()`，让事件循环自然结束、`run()` 正常返回，
///    `lib.rs` 里的 `_log_guard` 才会 drop 并 flush 日志。
#[tauri::command]
pub fn confirm_close_app(
    app: AppHandle,
    audio: State<'_, AudioPlaybackState>,
    flow: State<'_, FlowGlobal>,
) -> Result<(), String> {
    info!("用户确认关闭程序，开始收尾");

    pregen_svc::request_cancel(&app);

    if let Err(e) = reset_test_flow(flow, audio) {
        // 收尾失败不能阻止关闭，否则又把用户困住
        warn!("关闭前重置测试流程失败（继续关闭）: {e}");
    }

    match app.get_webview_window("main") {
        Some(window) => {
            info!("收尾完成，销毁主窗口");
            window.destroy().map_err(|e| format!("关闭窗口失败: {e}"))
        }
        None => {
            warn!("未找到 main 窗口，回退到 app.exit(0)");
            app.exit(0);
            Ok(())
        }
    }
}

/// 用户在确认框点「继续」/ESC/点遮罩：清标志位，让下次点 X 还能再弹
#[tauri::command]
pub fn cancel_close_app(guard: State<'_, CloseGuardState>) {
    guard.prompt_pending.store(false, Ordering::SeqCst);
    info!("用户取消关闭，继续运行");
}
