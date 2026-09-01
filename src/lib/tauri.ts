// Tauri invoke 封装与命令常量集中管理

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AdaptiveLevelChangedPayload,
  AdaptiveMode,
  AdaptiveParams,
  AdaptiveStateResetPayload,
  AdaptiveStateSnapshot,
  AppConfig,
  ConfigResponse,
  DifficultyConfig,
  DifficultyDemand,
  DifficultyLevel,
  DifficultyDemandKey,
  TimingConfig,
} from "@/types/config";
import type { TestSession } from "@/types/question";

// ===== 配置相关 =====

export async function getConfig(): Promise<ConfigResponse> {
  return invoke<ConfigResponse>("get_config");
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await invoke("save_config", { config });
}

export async function resetConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("reset_config");
}

export async function restoreDefaultPrompt(key: string): Promise<string> {
  return invoke<string>("restore_default_prompt", { args: { key } });
}

export async function restoreDefaultTiming(): Promise<TimingConfig> {
  return invoke<TimingConfig>("restore_default_timing");
}

/**
 * 恢复单个难度文字（细粒度）。
 * `level` 取 `junior_high | senior_high | undergraduate`，
 * `key` 取 `demand_1_4 | demand_5_14 | demand_15_18`。
 */
export async function restoreDefaultDifficultyDemand(
  level: DifficultyLevel,
  key: DifficultyDemandKey
): Promise<string> {
  return invoke<string>("restore_default_difficulty_demand", {
    args: { level, key },
  });
}

/** 恢复整档难度（3 段文字一次性还原）。 */
export async function restoreDefaultDifficultyLevel(
  level: DifficultyLevel
): Promise<DifficultyDemand> {
  return invoke<DifficultyDemand>("restore_default_difficulty_level", { level });
}

/** 恢复全部难度（level + 三档文字一起还原）。 */
export async function restoreDefaultDifficulty(): Promise<DifficultyConfig> {
  return invoke<DifficultyConfig>("restore_default_difficulty");
}

export async function openConfigDir(): Promise<string> {
  return invoke<string>("open_config_dir");
}

// ===== 模型连接测试 =====

export async function testLlmConnection(llm: AppConfig["llm"]): Promise<string> {
  return invoke<string>("test_llm_connection", { config: llm });
}

export async function testTtsConnection(tts: AppConfig["tts"]): Promise<string> {
  return invoke<string>("test_tts_connection", { config: tts });
}

export async function testSttConnection(stt: AppConfig["stt"]): Promise<string> {
  return invoke<string>("test_stt_connection", { config: stt });
}


export async function transcribeAudio(
  config: AppConfig["stt"],
  wavPath: string,
  language?: string
): Promise<string> {
  return invoke<string>("transcribe_audio", {
    config,
    wavPath,
    language: language ?? null,
  });
}

// ===== 设备 =====

export interface DeviceInfo {
  /** cpal 原始设备名，测试设备时按此名查找 */
  name: string;
  is_default: boolean;
  /** 界面展示用的友好名称 */
  display_name: string;
  /** false 表示该项只是 ALSA 插件噪音，默认折叠 */
  recommended: boolean;
}

export async function listInputDevices(): Promise<DeviceInfo[]> {
  return invoke<DeviceInfo[]>("list_input_devices");
}

export async function listOutputDevices(): Promise<DeviceInfo[]> {
  return invoke<DeviceInfo[]>("list_output_devices");
}

export async function testInputDevice(args: {
  deviceName: string | null;
  durationMs?: number;
}): Promise<{ outputPath: string; durationMs: number; sampleCount: number }> {
  return invoke("test_input_device", {
    args: {
      device_name: args.deviceName,
      duration_ms: args.durationMs ?? null,
    },
  });
}

export async function testOutputDevice(args: {
  deviceName: string | null;
  durationMs?: number;
}): Promise<string> {
  return invoke("test_output_device", {
    args: {
      device_name: args.deviceName,
      duration_ms: args.durationMs ?? null,
    },
  });
}

// ===== 测试会话 =====

export interface ProgressPayload {
  stage: "llm_q1_4" | "llm_q5_14" | "llm_q15_18" | "tts" | "done" | string;
  message: string;
  /** 0.0 ~ 1.0 */
  progress: number;
}

export async function generateTestSession(): Promise<TestSession> {
  return invoke<TestSession>("generate_test_session");
}

export async function getTestSession(): Promise<TestSession | null> {
  return invoke<TestSession | null>("get_test_session");
}

export async function clearTestSession(): Promise<void> {
  await invoke("clear_test_session");
}

/**
 * 订阅测试会话预生成进度事件。
 * 返回 unlisten 函数用于取消订阅。
 */
export async function onGenerationProgress(
  handler: (payload: ProgressPayload) => void
): Promise<UnlistenFn> {
  return listen<ProgressPayload>("test-generation-progress", (e) =>
    handler(e.payload)
  );
}

// ===== 测试流程（1-14 题） =====

export type TestPhase =
  | "intro"
  | "prepare"
  | "playing"
  | "answering"
  | "fill_blank"
  | "recall_prep"
  | "recording";

export interface TimerTickPayload {
  phase: TestPhase;
  elapsedMs: number;
  durationMs: number;
  remainingMs: number;
  progress: number;
}

export interface FlowStatePayload {
  questionIndex: number;
  phase: TestPhase;
  progress: number;
  audioPath: string | null;
  isGroup: boolean;
  questionInGroup: number;
  /** 15-19 题当前是第几次播放（null = 非 playing 或 1-14 题）。
   * 仅 PLAYING #1/#2/#3 分别取值 1/2/3，前端据此在 PLAYING #3 禁用填空（Spec §3.4）。 */
  playCount: number | null;
}

export interface AudioPlayPayload {
  path: string | null;
  loop: boolean;
}

export interface FlowFinishedPayload {
  ok: boolean;
  completed?: number;
  error?: string;
}

export async function startTestFlow(): Promise<{ ok: boolean }> {
  return invoke("start_test_flow");
}

export async function submitAnswer(
  questionId: number,
  answer: string | null
): Promise<void> {
  await invoke("submit_answer", { args: { questionId, answer } });
}

export async function getFlowState(): Promise<{
  state: FlowStatePayload | null;
  finished: boolean;
}> {
  return invoke("get_flow_state");
}

export async function getAnswerSet(): Promise<{
  answers: Record<number, string | null>;
  correctAnswers: Record<number, string>;
}> {
  return invoke("get_answer_set");
}

export async function resetTestFlow(): Promise<void> {
  await invoke("reset_test_flow");
}

/**
 * 用户在测试过程中点击"下一题"按钮：
 * - 立即停止当前 rodio 播放（切歌）
 * - 让后端 run_* 流程跳出当前 sleep 并进入下一段
 */
export async function skipToNext(): Promise<void> {
  await invoke("skip_to_next");
}

/**
 * Q19 用户点击"提前结束录音"按钮：
 * - 通知后端 finish_recording_phases 立即跳出剩余录音等待
 * - 进入评分阶段，无需再等满 90 秒
 */
export async function notifyRecordingCompleted(): Promise<void> {
  await invoke("notify_recording_completed");
}

export async function onTimerTick(
  handler: (payload: TimerTickPayload) => void
): Promise<UnlistenFn> {
  return listen<TimerTickPayload>("test-timer-tick", (e) =>
    handler(e.payload)
  );
}

export async function onPhaseFinished(
  handler: (phase: TestPhase) => void
): Promise<UnlistenFn> {
  return listen<TestPhase>("test-phase-finished", (e) => handler(e.payload));
}

export async function onFlowState(
  handler: (payload: FlowStatePayload) => void
): Promise<UnlistenFn> {
  return listen<FlowStatePayload>("test-flow-state", (e) =>
    handler(e.payload)
  );
}

export async function onAudioPlay(
  handler: (payload: AudioPlayPayload) => void
): Promise<UnlistenFn> {
  return listen<AudioPlayPayload>("test-audio-play", (e) =>
    handler(e.payload)
  );
}

export async function onFlowFinished(
  handler: (payload: FlowFinishedPayload) => void
): Promise<UnlistenFn> {
  return listen<FlowFinishedPayload>("test-flow-finished", (e) =>
    handler(e.payload)
  );
}

// ===== 音频播放 =====

export async function playAudioBackground(path: string): Promise<string> {
  return invoke<string>("play_audio_background", { path });
}

export async function playAudioFile(path: string): Promise<string> {
  return invoke<string>("play_audio_file", { path });
}

// ===== 录音 =====

export async function startRecording(): Promise<void> {
  await invoke("start_recording");
}

// ===== 评分 =====

import type { TestResult } from "@/types/result";

/**
 * 触发完整评分（1-14 本地 + 15-18 LLM + 19 STT+LLM）。
 *
 * `is_retest = true` 跳过自适应更新（用于「重新测试」按钮场景，前端 store 需在调用前
 * 通过 `useResultStore.getState().setIsRetest(true)` 标记），同时 `TestResult.adaptive`
 * 为 `null`，`TestResult.is_retest = true`，Result 页徽章显示「本次为重新测试，未调整能力」。
 */
export async function scoreFullTest(isRetest = false): Promise<TestResult> {
  return invoke<TestResult>("score_full_test", { isRetest });
}

export async function stopRecording(outputPath: string): Promise<{ outputPath: string }> {
  return invoke("stop_recording", { args: { outputPath } });
}

export async function getAudioLevel(): Promise<{ level: number; isRecording: boolean }> {
  return invoke("get_audio_level");
}

export interface RecordStartPayload {
  durationMs: number;
}

export async function onRecordStart(
  handler: (payload: RecordStartPayload) => void
): Promise<UnlistenFn> {
  return listen<RecordStartPayload>("test-record-start", (e) =>
    handler(e.payload)
  );
}

export async function onRecordStop(
  handler: () => void
): Promise<UnlistenFn> {
  return listen("test-record-stop", () => handler());
}

// ===== v1.1+ 自适应难度 =====

/**
 * 拉取当前 AdaptiveState 快照（前端 store 初始化用）。
 */
export async function getAdaptiveState(): Promise<AdaptiveStateSnapshot> {
  return invoke<AdaptiveStateSnapshot>("get_adaptive_state");
}

/**
 * UI「重置自适应状态」按钮：硬重置（归零 update_count），档位重置为 `manualLevel`。
 */
export async function resetAdaptiveState(
  manualLevel: DifficultyLevel
): Promise<AdaptiveStateSnapshot> {
  return invoke<AdaptiveStateSnapshot>("reset_adaptive_state", { manualLevel });
}

/**
 * 切换手动 / 自动档：
 * - `auto = false`（auto → manual）：把 adaptive state 软重置到 `config.difficulty.level`（§11.4）
 * - `auto = true`（manual → auto）：
 *   - 传 `initialLevel` → 把 adaptive state 软重置到该档（用户主动选择起始档，update_count 保留）
 *   - 不传 → 不动 adaptive state（保留之前的自动档状态，§11.6）
 */
export async function setAdaptiveMode(
  auto: boolean,
  initialLevel?: DifficultyLevel
): Promise<AdaptiveStateSnapshot> {
  return invoke<AdaptiveStateSnapshot>("set_adaptive_mode", {
    auto,
    initialLevel: initialLevel ?? null,
  });
}

/**
 * 落盘 15 个算法参数。ScoreFullTest 命令每次会从磁盘重新读取，
 * 因此 UI 编辑后下一次评分立即生效，无需重启应用。
 */
export async function updateAdaptiveParams(params: AdaptiveParams): Promise<void> {
  await invoke("update_adaptive_params", { params });
}

export async function onAdaptiveLevelChanged(
  handler: (payload: AdaptiveLevelChangedPayload) => void
): Promise<UnlistenFn> {
  return listen<AdaptiveLevelChangedPayload>("adaptive-level-changed", (e) =>
    handler(e.payload)
  );
}

export async function onAdaptiveStateReset(
  handler: (payload: AdaptiveStateResetPayload) => void
): Promise<UnlistenFn> {
  return listen<AdaptiveStateResetPayload>("adaptive-state-reset", (e) =>
    handler(e.payload)
  );
}

// ===== 预生成题库（v1.1+） =====

import type {
  PregenEntry,
  PregenSummary,
  PregenProgressPayload,
  PregenFinishedPayload,
  PregenFailedPayload,
} from "@/types/pregen";

/** 拉取题库摘要（轮询用） */
export async function getPregenSummary(): Promise<PregenSummary> {
  return invoke<PregenSummary>("get_pregen_summary");
}

/** 列出所有 unused 题库（预留，MVP 不调用） */
export async function listUnusedPregen(): Promise<PregenEntry[]> {
  return invoke<PregenEntry[]>("list_unused_pregen");
}

/** 把 N 套加入预生成队列 */
export async function enqueuePregen(count: number): Promise<void> {
  await invoke("enqueue_pregen", { count });
}

/** 取消当前队列（worker 在下一套前停下） */
export async function cancelPregen(): Promise<void> {
  await invoke("cancel_pregen");
}

/**
 * 从题库挑选最早一条 unused（按当前 effective_level 过滤）并加载到 SessionState。
 *
 * **不会**移动文件、**不会**把条目标为 Used、**不会**触发 enqueue(1) 补题。
 * 用于主菜单「开始测试（X 套 · 难度：Y）」按钮 —— 仅是"预选"，用户在
 * "准备开始测试"界面若点「返回主菜单」则题目原封不动地留在题库池中。
 *
 * 真正激活（move 文件 + 标 Used + 补题）需再调用 `activateTestFromPregen`。
 */
export async function pickTestFromPregen(): Promise<TestSession> {
  return invoke<TestSession>("pick_test_from_pregen");
}

/**
 * 激活 SessionState 里已 picked 的题库条目（move pregen/{uuid}/ → cache/{uuid}/、
 * 标 Used + save_index、enqueue(1) 补题）。
 *
 * 用于「准备开始测试」界面点「开始测试」按钮 —— 只有这一步才会让题目从题库池中"离开"。
 */
export async function activateTestFromPregen(): Promise<TestSession> {
  return invoke<TestSession>("activate_test_from_pregen");
}

export async function onPregenProgress(
  handler: (payload: PregenProgressPayload) => void
): Promise<UnlistenFn> {
  return listen<PregenProgressPayload>("pregen-progress", (e) =>
    handler(e.payload)
  );
}

export async function onPregenFinished(
  handler: (payload: PregenFinishedPayload) => void
): Promise<UnlistenFn> {
  return listen<PregenFinishedPayload>("pregen-finished", (e) =>
    handler(e.payload)
  );
}

export async function onPregenFailed(
  handler: (payload: PregenFailedPayload) => void
): Promise<UnlistenFn> {
  return listen<PregenFailedPayload>("pregen-failed", (e) =>
    handler(e.payload)
  );
}

// ===== 关窗拦截 =====
//
// ⚠️ 这里的事件名是 **自定义** 的 `app-close-requested`，**不是**
// `tauri://close-requested`。后者只要前端注册监听，Tauri 就会无条件
// `prevent_close`，导致窗口只能由前端主动 destroy 关掉，而 destroy 还要
// ACL 授权（`core:window:allow-destroy`，默认不在）—— 这正是旧
// CloseGuard.tsx 关不掉窗口的根因。详见 src-tauri/src/commands/app_close.rs。

export type CloseReason = "generating" | "testing";

export interface CloseRequestedPayload {
  reason: CloseReason;
}

/** 用户在确认框点「确认关闭」：取消生成 + abort 测试流程 + 关窗 */
export async function confirmCloseApp(): Promise<void> {
  await invoke("confirm_close_app");
}

/** 用户在确认框点「继续」：清标志位，下次再点 X 还能再弹 */
export async function cancelCloseApp(): Promise<void> {
  await invoke("cancel_close_app");
}

export async function onAppCloseRequested(
  handler: (payload: CloseRequestedPayload) => void
): Promise<UnlistenFn> {
  return listen<CloseRequestedPayload>("app-close-requested", (e) =>
    handler(e.payload)
  );
}
