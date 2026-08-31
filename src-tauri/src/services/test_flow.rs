//! 1-19 题测试流程编排：状态机 + 计时器协同
//!
//! 流程：
//! - 1-4 题（每题独立，4 段短对话）：INTRO(10s, 仅第 1 次) → PREPARE(5s) → PLAYING(1次) → ANSWERING(10s) → 下一题
//! - 5-12 题（4 段长对话，每段配 2 题）：PREPARE(10s) → PLAYING(2次间隔2s) → ANSWERING(10s) → 下一段
//! - 13-14 题（独白）：PREPARE(10s) → PLAYING(1次) → ANSWERING(10s) → 下一段
//! - 15-19 题：PREPARE(30s) → PLAYING(2次间隔3s) → FILL_BLANK(90s) → PLAYING(1次) → RECALL_PREP(120s) → RECORDING(90s)
//!
//! 计时统一由 `timer::PhaseTimer` 驱动，前端订阅 tick/phase-finished 事件。
//! 音频由后端 rodio 直接播放（避免 webview autoplay 限制与 asset protocol 跨平台问题），
//! 同时通过 `audio-play` 事件通知前端 UI 状态变化（用于显示播放指示）。
//!
//! 用户作答由前端通过 `submit_answer` command 提交，存于 FlowStateContainer 中。

use crate::commands::audio::AudioPlaybackState;
use crate::models::config::TimingConfig;
use crate::models::question::TestSession;
use crate::services::audio_player::play_wav_blocking;
use crate::services::timer::{Phase, PhaseTimer};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::task::JoinHandle;
use tokio::time::{sleep, Duration};
use tracing::{error, info};

pub const AUDIO_PLAY_EVENT: &str = "test-audio-play";
pub const FLOW_STATE_EVENT: &str = "test-flow-state";
pub const FLOW_FINISHED_EVENT: &str = "test-flow-finished";
pub const RECORD_START_EVENT: &str = "test-record-start";
pub const RECORD_STOP_EVENT: &str = "test-record-stop";

/// 测试流程中的当前题号（1-14 / 15-18 / 19）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowState {
    /// 当前阶段第几个题（1-14 / 15-18 / 19）
    pub question_index: u32,
    /// 当前阶段（intro / prepare / playing / answering / fill_blank / recall_prep / recording）
    pub phase: Phase,
    /// 1-19 题总进度（0.0 ~ 1.0）
    pub progress: f32,
    /// 当前要播放的音频路径（仅 playing 阶段；None 表示停止播放）
    pub audio_path: Option<String>,
    /// 当前题目是否在材料组内（5-12 / 13-14 为 true）
    pub is_group: bool,
    /// 当前题目在组内的索引（0 或 1，仅 is_group=true 时有意义）
    pub question_in_group: u32,
    /// 15-19 题当前是第几次播放（None = 非 playing 或 1-14 题；
    /// 仅 15-19 题的 PLAYING #1/#2/#3 阶段分别填 Some(1/2/3)）。
    /// 前端据此在 PLAYING #3 阶段禁用填空编辑（Spec §3.4）。
    pub play_count: Option<u32>,
}

/// 全部作答结果（1-14）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnswerSet {
    /// 题目 ID -> 用户答案（"A"/"B"/"C" 或 None 表示未作答）
    pub answers: HashMap<u32, Option<String>>,
}

/// 测试流程状态（持久化于内存）
pub struct FlowStateInner {
    /// 1-14 题用户作答
    pub answers: HashMap<u32, Option<String>>,
    /// 当前 state
    pub state: Option<FlowState>,
    /// 是否已完成
    pub finished: bool,
    /// 题目 ID -> 正确答案（结算时用）
    pub correct_answers: HashMap<u32, String>,
    /// 题目 ID -> 是否属于某个材料组（5-12 / 13-14）
    pub group_membership: HashMap<u32, u32>, // question_id -> group_start_id
    /// 音频路径映射
    pub audio_paths: HashMap<String, String>,
    /// 前端点击"下一题"触发的跳转请求；各 run_* 阶段定期检查
    pub skip_requested: Arc<AtomicBool>,
    /// 用户在 Q19 点击"提前结束录音"时设置；让 RECORDING 阶段 sleep 提前返回
    pub recording_completed: Arc<AtomicBool>,
    /// 当前正在跑的 run_flow 任务的 JoinHandle。
    /// `spawn_test_flow` 时写入，`reset_test_flow` 时取出并 `abort()`。
    /// 任务在下一个 `.await` 点（`interruptible_sleep` / `play_audio` / `spawn_blocking.await`）
    /// 抛出 `JoinError::Cancelled`，run_flow 立即退出。
    /// 没有它的话旧任务的 `emit_state` 会持续污染 FlowStateContainer.state，
    /// 导致前端的「放弃 → 重做」流程读到旧 question_index。
    pub current_task: Option<JoinHandle<()>>,
}

impl Default for FlowStateInner {
    fn default() -> Self {
        Self {
            answers: HashMap::new(),
            state: None,
            finished: false,
            correct_answers: HashMap::new(),
            group_membership: HashMap::new(),
            audio_paths: HashMap::new(),
            skip_requested: Arc::new(AtomicBool::new(false)),
            recording_completed: Arc::new(AtomicBool::new(false)),
            current_task: None,
        }
    }
}

#[derive(Clone)]
pub struct FlowStateContainer {
    pub inner: Arc<Mutex<FlowStateInner>>,
}

impl Default for FlowStateContainer {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(FlowStateInner::default())),
        }
    }
}

impl FlowStateContainer {
    /// Q19 用户点击"提前结束录音"时由前端命令调用：
    /// 唤醒 `finish_recording_phases` 中的 `interruptible_sleep`，立即进入评分阶段。
    pub fn notify_recording_completed(&self) {
        if let Ok(guard) = self.inner.lock() {
            guard.recording_completed.store(true, Ordering::Relaxed);
        }
    }

    /// 重置录音完成标志（用于新一轮测试会话开始时）
    pub fn reset_recording_completed(&self) {
        if let Ok(guard) = self.inner.lock() {
            guard.recording_completed.store(false, Ordering::Relaxed);
        }
    }
}

/// 初始化 FlowStateContainer：从 TestSession 提取正确选项与音频路径
pub fn init_container_from_session(container: &FlowStateContainer, session: &TestSession) {
    let mut guard = container.inner.lock().unwrap();
    guard.audio_paths = session.audio_paths.clone();
    guard.correct_answers.clear();
    guard.group_membership.clear();

    // 1-4
    for d in &session.short_dialogues {
        guard
            .correct_answers
            .insert(d.question.id, d.question.answer.clone());
        guard.group_membership.insert(d.question.id, d.question.id);
    }
    // 5-12
    for d in &session.long_dialogues {
        for (i, q) in d.questions.iter().enumerate() {
            guard.correct_answers.insert(q.id, q.answer.clone());
            guard.group_membership.insert(q.id, d.questions[0].id);
            let _ = i; // 保留变量
        }
    }
    // 13-14
    for q in &session.monologue.questions {
        guard.correct_answers.insert(q.id, q.answer.clone());
        guard.group_membership.insert(q.id, session.monologue.questions[0].id);
    }
}

/// 启动 1-14 题完整测试流程（异步任务）
///
/// `timing` 在调用前由 `start_test_flow` 从 `ConfigState` 读取后传入，
/// 之后所有阶段时长都从此读取（不读盘、不读全局状态）。
pub fn spawn_test_flow(
    app: AppHandle,
    container: FlowStateContainer,
    session: TestSession,
    timing: TimingConfig,
) {
    info!(
        "spawn_test_flow: 初始化 FlowStateContainer session_id={}",
        session.session_id
    );
    init_container_from_session(&container, &session);
    let timing = Arc::new(timing);
    // 重置 skip_requested / recording_completed 标志，
    // 避免上一轮残留下一次进入流程时被识别成跳过/录音完成
    container.reset_recording_completed();

    // 先 clone 一份给 tokio 闭包（async move 会把外部变量 move 进闭包），
    // 闭包运行过程中仍然需要 container 来 emit flow_finished 和更新 finished。
    let container_for_task = container.clone();
    let handle = tokio::spawn(async move {
        let result = run_flow(app.clone(), container_for_task.clone(), session, timing).await;
        match result {
            Ok(()) => {
                info!("测试流程完成");
                let _ = app.emit(
                    FLOW_FINISHED_EVENT,
                    &serde_json::json!({ "ok": true, "completed": 19 }),
                );
            }
            Err(e) => {
                error!(error = %e, "测试流程异常终止");
                {
                    let mut guard = container_for_task.inner.lock().unwrap();
                    guard.finished = true;
                }
                let _ = app.emit(
                    FLOW_FINISHED_EVENT,
                    &serde_json::json!({ "ok": false, "error": e }),
                );
            }
        }
    });
    // 保存 JoinHandle，让 reset_test_flow 能中止这个任务。
    // 外部的 container 仍是 owner（FlowStateContainer 内部是 Arc，clone 廉价）。
    container.inner.lock().unwrap().current_task = Some(handle);
}

async fn run_flow(
    app: AppHandle,
    container: FlowStateContainer,
    session: TestSession,
    timing: Arc<TimingConfig>,
) -> Result<(), String> {
    // ===== 1-4 题 =====
    info!(
        "run_flow: 开始 1-4 题短对话，共 {} 段",
        session.short_dialogues.len()
    );
    for (idx, d) in session.short_dialogues.iter().enumerate() {
        let qnum = idx as u32 + 1;
        run_short_dialogue(&app, &container, d, qnum, timing.clone()).await?;
    }

    // ===== 5-12 题（4 段长对话，每段配 2 题） =====
    for (idx, _d) in session.long_dialogues.iter().enumerate() {
        let qnums = [5 + (idx as u32) * 2, 6 + (idx as u32) * 2];
        run_group_dialogue(&app, &container, qnums, "d", idx + 1, timing.clone()).await?;
    }

    // ===== 13-14 题（独白） =====
    run_group_dialogue(&app, &container, [13, 14], "m", 1, timing.clone()).await?;

    // ===== 15-19 题（听后转述） =====
    run_retell(&app, &container, &session.retell, timing.clone()).await?;

    {
        let mut guard = container.inner.lock().unwrap();
        guard.finished = true;
        guard.state = None;
    }
    Ok(())
}

/// 1-4 题：单题独立流程
async fn run_short_dialogue(
    app: &AppHandle,
    container: &FlowStateContainer,
    d: &crate::models::question::ShortDialogue,
    qnum: u32,
    timing: Arc<TimingConfig>,
) -> Result<(), String> {
    let qid = d.question.id;
    let audio_path = {
        let guard = container.inner.lock().unwrap();
        guard.audio_paths.get(&format!("q{qnum}")).cloned()
    };
    let skip_flag = skip_flag_clone(container);

    // 进入新段前清空 skip 标志（避免上题残留）
    skip_flag.store(false, Ordering::Relaxed);

    // 第一次进 1-4 题时显示开场介绍（时长从 timing 读取）
    if qnum == 1 {
        let intro_ms = timing.intro_ms;
        emit_state(app, container, FlowState {
            question_index: qnum,
            phase: Phase::Intro,
            progress: 0.0,
            audio_path: None,
            is_group: false,
            question_in_group: 0,
            play_count: None,
        });
        let _timer = PhaseTimer::start(app.clone(), Phase::Intro, intro_ms as u64, 100);
        interruptible_sleep(Duration::from_millis(intro_ms as u64 + 500), &skip_flag).await;
        if skip_flag.load(Ordering::Relaxed) {
            return Ok(());
        }
    }

    // PREPARE
    let prepare_ms = timing.short_dialogue_prepare_ms;
    emit_state(app, container, FlowState {
        question_index: qnum,
        phase: Phase::Prepare,
        progress: 0.0,
        audio_path: None,
        is_group: false,
        question_in_group: 0,
            play_count: None,
    });
    let _timer = PhaseTimer::start(app.clone(), Phase::Prepare, prepare_ms as u64, 100);
    interruptible_sleep(Duration::from_millis(prepare_ms as u64 + 500), &skip_flag).await;
    if skip_flag.load(Ordering::Relaxed) {
        return Ok(());
    }

    // PLAYING (1x, 后端 rodio 播放)
    emit_state(app, container, FlowState {
        question_index: qnum,
        phase: Phase::Playing,
        progress: 0.0,
        audio_path: audio_path.clone(),
        is_group: false,
        question_in_group: 0,
            play_count: None,
    });
    // 用真实音频时长驱动进度条；若读不到则 fallback 2 秒。
    let play_ms = compute_play_ms(audio_path.as_ref(), 2_000);
    let _timer = PhaseTimer::start(app.clone(), Phase::Playing, play_ms, 100);
    play_audio(app, audio_path.clone()).await;
    // play_audio 期间计时器已在跑；这里只需一个短缓冲等待最终 tick，
    // 不应再叠加 play_ms（否则总时长 ≈ 2 倍音频长度）。
    interruptible_sleep(Duration::from_millis(500), &skip_flag).await;
    if skip_flag.load(Ordering::Relaxed) {
        return Ok(());
    }

    // ANSWERING
    let answer_ms = timing.short_dialogue_answer_ms;
    emit_state(app, container, FlowState {
        question_index: qnum,
        phase: Phase::Answering,
        progress: 0.0,
        audio_path: None,
        is_group: false,
        question_in_group: 0,
            play_count: None,
    });
    let _timer = PhaseTimer::start(app.clone(), Phase::Answering, answer_ms as u64, 100);
    interruptible_sleep(Duration::from_millis(answer_ms as u64 + 500), &skip_flag).await;

    info!(question_id = qid, "第 {} 题流程完成", qnum);
    Ok(())
}

/// 5-12 / 13-14：组题共用 ANSWERING 阶段
async fn run_group_dialogue(
    app: &AppHandle,
    container: &FlowStateContainer,
    qnums: [u32; 2],
    audio_prefix: &str,
    audio_idx: usize,
    timing: Arc<TimingConfig>,
) -> Result<(), String> {
    let first = qnums[0];
    let audio_key = format!("{audio_prefix}{audio_idx}");
    let audio_path = {
        let guard = container.inner.lock().unwrap();
        guard.audio_paths.get(&audio_key).cloned()
    };
    let skip_flag = skip_flag_clone(container);
    skip_flag.store(false, Ordering::Relaxed);

    // PREPARE
    let prepare_ms = timing.group_prepare_ms;
    emit_state(
        app,
        container,
        FlowState {
            question_index: first,
            phase: Phase::Prepare,
            progress: 0.0,
            audio_path: None,
            is_group: true,
            question_in_group: 0,
            play_count: None,
        },
    );
    let _timer = PhaseTimer::start(app.clone(), Phase::Prepare, prepare_ms as u64, 100);
    interruptible_sleep(Duration::from_millis(prepare_ms as u64 + 500), &skip_flag).await;
    if skip_flag.load(Ordering::Relaxed) {
        return Ok(());
    }

    // PLAYING #1 (后端 rodio 播放)
    emit_state(
        app,
        container,
        FlowState {
            question_index: first,
            phase: Phase::Playing,
            progress: 0.0,
            audio_path: audio_path.clone(),
            is_group: true,
            question_in_group: 0,
            play_count: None,
        },
    );
    let play_ms = compute_play_ms(audio_path.as_ref(), 2_000);
    let _timer = PhaseTimer::start(app.clone(), Phase::Playing, play_ms, 100);
    play_audio(app, audio_path.clone()).await;
    interruptible_sleep(Duration::from_millis(500), &skip_flag).await;
    if skip_flag.load(Ordering::Relaxed) {
        return Ok(());
    }

    // 静音间隔（两次播放之间）
    let pause_ms = timing.group_pause_ms;
    let _ = app.emit(
        AUDIO_PLAY_EVENT,
        &serde_json::json!({ "path": null, "loop": false }),
    );
    interruptible_sleep(Duration::from_millis(pause_ms as u64 + 500), &skip_flag).await;
    if skip_flag.load(Ordering::Relaxed) {
        return Ok(());
    }

    // PLAYING #2 — 显式重置进度并先启动计时器再播音频，
    // 否则音频播完之前没有 timer-tick，前端进度条不会动。
    emit_state(
        app,
        container,
        FlowState {
            question_index: first,
            phase: Phase::Playing,
            progress: 0.0,
            audio_path: audio_path.clone(),
            is_group: true,
            question_in_group: 0,
            play_count: None,
        },
    );
    let _timer = PhaseTimer::start(app.clone(), Phase::Playing, play_ms, 100);
    play_audio(app, audio_path.clone()).await;
    interruptible_sleep(Duration::from_millis(500), &skip_flag).await;
    if skip_flag.load(Ordering::Relaxed) {
        return Ok(());
    }

    // ANSWERING
    let answer_ms = timing.group_answer_ms;
    emit_state(
        app,
        container,
        FlowState {
            question_index: first,
            phase: Phase::Answering,
            progress: 0.0,
            audio_path: None,
            is_group: true,
            question_in_group: 0,
            play_count: None,
        },
    );
    let _timer = PhaseTimer::start(app.clone(), Phase::Answering, answer_ms as u64, 100);
    interruptible_sleep(Duration::from_millis(answer_ms as u64 + 500), &skip_flag).await;

    info!(qnums = ?qnums, "组题流程完成");
    Ok(())
}

fn emit_state(app: &AppHandle, container: &FlowStateContainer, state: FlowState) {
    {
        let mut guard = container.inner.lock().unwrap();
        guard.state = Some(state.clone());
    }
    if let Err(e) = app.emit(FLOW_STATE_EVENT, &state) {
        error!(error = %e, "发送 flow state 失败");
    }
}

/// 取出当前实例的 skip_requested 引用（Arc clone）
fn skip_flag_clone(container: &FlowStateContainer) -> Arc<AtomicBool> {
    container.inner.lock().unwrap().skip_requested.clone()
}

/// 计算音频文件的实际播放时长（毫秒）。
///
/// 用于在测试流程的 PLAYING 阶段启动对应时长的计时器，让前端进度条
/// 在音频播放期间能真实反映剩余时间，而不是卡在"剩余 0 秒"。
///
/// 读不到时长（路径为 None、文件缺失/损坏）时返回 fallback_ms。
fn compute_play_ms(path: Option<&String>, fallback_ms: u64) -> u64 {
    let Some(p) = path else {
        return fallback_ms;
    };
    let pb = PathBuf::from(p);
    if !pb.exists() {
        return fallback_ms;
    }
    crate::utils::wav::duration_ms(&pb)
        .ok()
        .filter(|&ms| ms > 0)
        .unwrap_or(fallback_ms)
}

/// 取出当前实例的 recording_completed 引用（Arc clone）
fn recording_completed_clone(container: &FlowStateContainer) -> Arc<AtomicBool> {
    container.inner.lock().unwrap().recording_completed.clone()
}

/// 可中断睡眠：每 100ms 检查一次 skip_flag，若被设置则提前返回
async fn interruptible_sleep(duration: Duration, skip_flag: &Arc<AtomicBool>) {
    let step = Duration::from_millis(100);
    let mut remaining = duration;
    while !remaining.is_zero() {
        if skip_flag.load(Ordering::Relaxed) {
            return;
        }
        let chunk = step.min(remaining);
        sleep(chunk).await;
        remaining = remaining.saturating_sub(chunk);
    }
}

/// 后端播放音频：使用 rodio 同步播放（阻塞当前 tokio task 直到播放完成或 stop_flag 被设置）
///
/// 同时通过 audio-play 事件通知前端 UI 更新（仅用于显示指示器）。
/// stop_flag 注册到全局 AudioPlaybackState，使得 `stop_audio` 与 `skip_to_next` 可即时切歌。
async fn play_audio(app: &AppHandle, path: Option<String>) {
    let Some(p) = path else {
        return;
    };
    // 通知前端"开始播放"（用于 UI 指示器）
    let _ = app.emit(
        AUDIO_PLAY_EVENT,
        &serde_json::json!({ "path": p, "loop": false }),
    );

    let pb = PathBuf::from(&p);
    if !pb.exists() {
        error!(path = %p, "音频文件不存在，跳过播放");
        return;
    }

    // 创建本轮播放的停止信号，注册到全局 state 以便外部 stop_audio 可切歌
    let stop_flag = Arc::new(AtomicBool::new(false));
    {
        let audio_state = app.state::<AudioPlaybackState>();
        let mut slot = audio_state.active_stop_flag.lock().unwrap();
        *slot = Some(stop_flag.clone());
    }

    let flag_for_play = stop_flag.clone();
    let result = tokio::task::spawn_blocking(move || play_wav_blocking(&pb, flag_for_play)).await;

    // 播放结束（无论自然完成还是被切歌）后清空全局 stop_flag 引用
    {
        let audio_state = app.state::<AudioPlaybackState>();
        let mut slot = audio_state.active_stop_flag.lock().unwrap();
        *slot = None;
    }

    match result {
        Ok(Ok(())) => info!(path = %p, "音频播放完成"),
        Ok(Err(e)) => error!(error = %e, path = %p, "音频播放失败"),
        Err(e) => error!(error = %e, path = %p, "spawn_blocking 失败"),
    }
}

/// 15-19 题：听后转述完整流程
///
/// 阶段（时长从 `timing` 读取，RECORDING 保持 90s 固定）：
/// 1. PREPARE：展示挖空表格，提示"准备聆听"
/// 2. PLAYING #1 → 静音 → PLAYING #2（共 2 次播放）
/// 3. FILL_BLANK：用户填写 15-18 题空格
/// 4. PLAYING #3（第 3 次播放），挖空表格保持可见
/// 5. RECALL_PREP：默读准备（不可听音频）
/// 6. RECORDING（90s 固定）：自动开始录音
///
/// "下一题"按钮（skip_requested）在 1-3 阶段可触发：直接跳到 PLAYING #3，
/// 4-6 阶段不接受跳过（用户需要听第三遍 / 默读 / 录音）。
async fn run_retell(
    app: &AppHandle,
    container: &FlowStateContainer,
    _retell: &crate::models::question::RetellMaterial,
    timing: Arc<TimingConfig>,
) -> Result<(), String> {
    let audio_path = {
        let guard = container.inner.lock().unwrap();
        guard.audio_paths.get("retell").cloned()
    };
    let skip_flag = skip_flag_clone(container);
    skip_flag.store(false, Ordering::Relaxed);

    let base_progress = 14.0 / 19.0; // 14 题已完成

    // 1. PREPARE — 可跳过
    // 注意：每个阶段的计时器必须限定在自己的 { ... } block 内，
    // 这样在 skip 触发进入 goto_playing_3 之前旧计时器就被 drop，
    // 避免和 PLAYING #3 的新计时器并发 tick 造成进度条跳变。
    let prepare_ms = timing.retell_prepare_ms;
    emit_state(
        app,
        container,
        FlowState {
            question_index: 15,
            phase: Phase::Prepare,
            progress: base_progress,
            audio_path: None,
            is_group: true,
            question_in_group: 0,
            play_count: None,
        },
    );
    let prepare_skipped = {
        let _timer = PhaseTimer::start(app.clone(), Phase::Prepare, prepare_ms as u64, 100);
        interruptible_sleep(Duration::from_millis(prepare_ms as u64 + 500), &skip_flag).await;
        skip_flag.load(Ordering::Relaxed)
    }; // _timer 在此 drop，取消 PREPARE 阶段的计时任务
    if prepare_skipped {
        // 跳到 PLAYING #3 之前先清零，让 PLAYING #3 顺利完成
        skip_flag.store(false, Ordering::Relaxed);
        goto_playing_3(app, container, audio_path.as_ref()).await;
        finish_recording_phases(app, container, timing.clone()).await;
        return Ok(());
    }

    // 2. PLAYING #1 (后端 rodio 播放) — 可跳过
    emit_state(
        app,
        container,
        FlowState {
            question_index: 15,
            phase: Phase::Playing,
            progress: base_progress + 0.05,
            audio_path: audio_path.clone(),
            is_group: true,
            question_in_group: 0,
            play_count: Some(1),
        },
    );
    let play_ms = compute_play_ms(audio_path.as_ref(), 2_000);
    let playing1_skipped = {
        let _timer = PhaseTimer::start(app.clone(), Phase::Playing, play_ms, 100);
        play_audio(app, audio_path.clone()).await;
        interruptible_sleep(Duration::from_millis(500), &skip_flag).await;
        skip_flag.load(Ordering::Relaxed)
    }; // _timer 在此 drop
    if playing1_skipped {
        skip_flag.store(false, Ordering::Relaxed);
        goto_playing_3(app, container, audio_path.as_ref()).await;
        finish_recording_phases(app, container, timing.clone()).await;
        return Ok(());
    }

    // 静音间隔 — 可跳过（无计时器，无需 block 限定）
    let pause_ms = timing.retell_pause_ms;
    let _ = app.emit(
        AUDIO_PLAY_EVENT,
        &serde_json::json!({ "path": null, "loop": false }),
    );
    let pause_skipped = {
        interruptible_sleep(Duration::from_millis(pause_ms as u64 + 500), &skip_flag).await;
        skip_flag.load(Ordering::Relaxed)
    };
    if pause_skipped {
        skip_flag.store(false, Ordering::Relaxed);
        goto_playing_3(app, container, audio_path.as_ref()).await;
        finish_recording_phases(app, container, timing.clone()).await;
        return Ok(());
    }

    // PLAYING #2 — 可跳过；先启动计时器再播音频，并显式重置进度。
    emit_state(
        app,
        container,
        FlowState {
            question_index: 15,
            phase: Phase::Playing,
            progress: base_progress + 0.05,
            audio_path: audio_path.clone(),
            is_group: true,
            question_in_group: 0,
            play_count: Some(2),
        },
    );
    let playing2_skipped = {
        let _timer = PhaseTimer::start(app.clone(), Phase::Playing, play_ms, 100);
        play_audio(app, audio_path.clone()).await;
        interruptible_sleep(Duration::from_millis(500), &skip_flag).await;
        skip_flag.load(Ordering::Relaxed)
    }; // _timer 在此 drop
    if playing2_skipped {
        skip_flag.store(false, Ordering::Relaxed);
        goto_playing_3(app, container, audio_path.as_ref()).await;
        finish_recording_phases(app, container, timing.clone()).await;
        return Ok(());
    }

    // 3. FILL_BLANK — 可跳过
    let fill_ms = timing.retell_fill_blank_ms;
    emit_state(
        app,
        container,
        FlowState {
            question_index: 15,
            phase: Phase::FillBlank,
            progress: base_progress + 0.2,
            audio_path: None,
            is_group: true,
            question_in_group: 0,
            play_count: None,
        },
    );
    let fill_blank_skipped = {
        let _timer = PhaseTimer::start(app.clone(), Phase::FillBlank, fill_ms as u64, 100);
        interruptible_sleep(Duration::from_millis(fill_ms as u64 + 500), &skip_flag).await;
        skip_flag.load(Ordering::Relaxed)
    }; // _timer 在此 drop，FILL_BLANK 计时器在进入 PLAYING #3 之前已停止
    if fill_blank_skipped {
        skip_flag.store(false, Ordering::Relaxed);
        goto_playing_3(app, container, audio_path.as_ref()).await;
        finish_recording_phases(app, container, timing.clone()).await;
        return Ok(());
    }

    // 4-6 阶段按正常顺序跑完（不允许再跳过）
    skip_flag.store(false, Ordering::Relaxed);
    goto_playing_3(app, container, audio_path.as_ref()).await;
    finish_recording_phases(app, container, timing.clone()).await;
    Ok(())
}

/// 15-19 题第 4 步 PLAYING #3
async fn goto_playing_3(
    app: &AppHandle,
    container: &FlowStateContainer,
    audio_path: Option<&String>,
) {
    let base_progress = 14.0 / 19.0;
    emit_state(
        app,
        container,
        FlowState {
            question_index: 15,
            phase: Phase::Playing,
            progress: base_progress + 0.5,
            audio_path: audio_path.cloned(),
            is_group: true,
            question_in_group: 0,
            play_count: Some(3),
        },
    );
    let play_ms = compute_play_ms(audio_path, 2_000);
    let _timer = PhaseTimer::start(app.clone(), Phase::Playing, play_ms, 100);
    play_audio(app, audio_path.cloned()).await;
    // 此处 sleep 不再受 skip_flag 影响（已清零）；仅给一个小余量确保最终 tick 发出。
    sleep(Duration::from_millis(500)).await;
}

/// 15-19 题第 5-6 步：RECALL_PREP + RECORDING
///
/// RECORDING 时长固定 90 秒（不受 TimingConfig 控制）：
/// Spec 十三节明确约束，录音时长受 STT/LLM 判分稳定性限制。
async fn finish_recording_phases(
    app: &AppHandle,
    container: &FlowStateContainer,
    timing: Arc<TimingConfig>,
) {
    let base_progress = 14.0 / 19.0;
    // 5. RECALL_PREP
    let recall_ms = timing.retell_recall_prep_ms;
    emit_state(
        app,
        container,
        FlowState {
            question_index: 19,
            phase: Phase::RecallPrep,
            progress: base_progress + 0.7,
            audio_path: None,
            is_group: false,
            question_in_group: 0,
            play_count: None,
        },
    );
    let _timer = PhaseTimer::start(app.clone(), Phase::RecallPrep, recall_ms as u64, 100);
    sleep(Duration::from_millis(recall_ms as u64 + 500)).await;

    // 6. RECORDING（固定 90 秒，不读取 TimingConfig）
    // 可被"提前结束录音"中断（前端调用 notify_recording_completed 命令）
    let recording_ms: u64 = 90_000;
    let recording_flag = recording_completed_clone(container);
    recording_flag.store(false, Ordering::Relaxed);
    let _ = app.emit(
        RECORD_START_EVENT,
        &serde_json::json!({ "durationMs": recording_ms }),
    );
    emit_state(
        app,
        container,
        FlowState {
            question_index: 19,
            phase: Phase::Recording,
            progress: base_progress + 0.85,
            audio_path: None,
            is_group: false,
            question_in_group: 0,
            play_count: None,
        },
    );
    let _timer = PhaseTimer::start(app.clone(), Phase::Recording, recording_ms, 100);
    interruptible_sleep(Duration::from_millis(recording_ms + 500), &recording_flag).await;

    let _ = app.emit(RECORD_STOP_EVENT, &serde_json::json!({}));
    info!("15-19 题流程完成");
}
