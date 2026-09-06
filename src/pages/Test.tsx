// 19 题测试主页面：根据 phase 切换子组件展示

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Play, FileText, SkipForward } from "lucide-react";
import { useTestStore } from "@/store/test";
import { useResultStore } from "@/store/result";
import { confirm } from "@/store/confirm";
import { toast } from "@/store/toast";
import {
  PHASE_LABELS,
  useTestFlowStore,
} from "@/store/testFlow";
import { useTestFlowEvents } from "@/hooks/useTestFlowEvents";
import { useRecorder } from "@/hooks/useRecorder";
import { GlobalHeader } from "@/components/test/GlobalHeader";
import { PhaseCountdown } from "@/components/test/PhaseCountdown";
import {
  ShortDialogueDisplay,
  GroupDialogueDisplay,
} from "@/components/test/QuestionDisplay";
import { FillBlankTable } from "@/components/test/FillBlankTable";
import { RecorderPanel } from "@/components/test/RecorderPanel";
import {
  skipToNext,
  startTestFlow,
  getFlowState,
  resetTestFlow,
  activateTestFromPregen,
} from "@/lib/tauri";

/** 判断当前段对应题目的作答是否完整（用于"下一题"按钮的 enabled 计算） */
function computeSegmentComplete(
  session: ReturnType<typeof useTestStore.getState>["session"],
  questionIndex: number,
  answers: Record<number, string | null>
): boolean {
  if (!session || questionIndex < 1) return false;
  // 1-4：单题，qid 即 questionIndex
  if (questionIndex <= 4) {
    const d = session.short_dialogues[questionIndex - 1];
    return !!d && !!answers[d.question.id];
  }
  // 5-12：每段 2 题
  if (questionIndex <= 12) {
    const idx = Math.floor((questionIndex - 5) / 2);
    const d = session.long_dialogues[idx];
    if (!d) return false;
    return d.questions.every((q) => !!answers[q.id]);
  }
  // 13-14：独白 2 题
  if (questionIndex <= 14) {
    return session.monologue.questions.every((q) => !!answers[q.id]);
  }
  // 15-19：4 个挖空均需非空文本
  const filled = [15, 16, 17, 18].every(
    (id) => typeof answers[id] === "string" && (answers[id] as string).trim().length > 0
  );
  return filled;
}

/** 判断当前阶段是否允许显示"下一题"按钮 */
function isNextVisible(questionIndex: number, phase: string | null): boolean {
  if (!phase) return false;
  // intro 阶段：尚未开始作答，按钮不显示
  if (phase === "intro") return false;
  // 15-19：仅 prepare / playing / fill_blank 可跳；recall_prep / recording 不跳
  if (questionIndex >= 15) {
    return phase === "prepare" || phase === "playing" || phase === "fill_blank";
  }
  // 1-14：除 intro 外都显示
  return true;
}

export default function TestPage() {
  const navigate = useNavigate();

  // 整体测试会话
  const session = useTestStore((s) => s.session);
  const reset = useTestStore((s) => s.reset);

  // 流程运行时状态
  const questionIndex = useTestFlowStore((s) => s.questionIndex);
  const phase = useTestFlowStore((s) => s.phase);
  const isGroup = useTestFlowStore((s) => s.isGroup);
  const finished = useTestFlowStore((s) => s.finished);
  const error = useTestFlowStore((s) => s.error);
  const answers = useTestFlowStore((s) => s.answers);
  // 15-19 题当前播放轮次：1=PLAYING#1, 2=PLAYING#2, 3=PLAYING#3（其余 null）。
  // PLAYING #3 阶段挖空应禁用（Spec §3.4）。
  const playCount = useTestFlowStore((s) => s.playCount);
  // 开场介绍文案：4 个 INTRO 阶段（1-4 / 5-14 / 15-18 / 19 题前）由后端下发，
  // 内容在「设置 → 开场介绍」中可编辑，前端只负责显示。
  const introText = useTestFlowStore((s) => s.introText);
  const applyFlowState = useTestFlowStore((s) => s.applyFlowState);
  const applyFinished = useTestFlowStore((s) => s.applyFinished);

  // 订阅所有后端事件
  useTestFlowEvents();

  // 音频播放由后端 test_flow 直接驱动（play_wav_blocking），
  // 前端通过 store.audioPath 仅作 UI 指示，不再重复触发后端播放。
  // 修复历史：之前前端 useAudioPlayer + useAudioPlayHandler 同时调用了
  // playAudioBackground，导致与后端播放叠加，第二轮播放时尤为明显。

  // 录音
  const recorder = useRecorder();

  // 放弃本次测试并返回主菜单：完全清理后端流程 + 所有前端 store，
  // 避免后端 run_flow 继续运行、音频继续播放、下次进入直接跳结算页。
  // 与 Result.tsx::handleBackToMenu 同模式（commit 8273b1a），后端
  // reset_test_flow 现在会自己 abort run_flow 任务 + 停 rodio 音频，
  // 所以这里不再需要先调 skipToNext()。
  const handleAbandon = async () => {
    if (!(await confirm("确认放弃本次测试？所有作答将被清空。"))) {
      console.log("[Test] handleAbandon: 用户取消");
      return;
    }
    console.log("[Test] handleAbandon: 用户确认放弃");

    // 1. 若正在录音，先收尾（stopRecording + submit_answer(q19) + notifyRecordingCompleted）
    if (recorder.isRecording) {
      try {
        await recorder.stopLocalRecording();
        console.log("[Test] handleAbandon: 已停止录音");
      } catch (e) {
        console.error("[Test] handleAbandon: 停止录音失败", e);
      }
    }

    // 2. 先导航，让 TestPage 卸载（避免 useEffect 在重置后又跑一遍）
    navigate("/");

    // 3. 后端：reset_test_flow 内部会 abort 旧 run_flow 任务 + 停 rodio 音频
    try {
      await resetTestFlow();
      console.log("[Test] handleAbandon: reset_test_flow 成功");
    } catch (e) {
      console.error("[Test] handleAbandon: reset_test_flow 失败", e);
    }

    // 4. 前端：清空三个 store（与 Result.tsx::handleBackToMenu 一致）
    try {
      await reset(); // useTestStore.reset → clear_test_session
      console.log("[Test] handleAbandon: useTestStore.reset 成功");
    } catch (e) {
      console.error("[Test] handleAbandon: useTestStore.reset 失败", e);
    }
    useResultStore.getState().reset();
    useResultStore.getState().setIsRetest(false);
    useTestFlowStore.getState().reset();
    console.log("[Test] handleAbandon: 前端 store 已重置");
  };

  // 计算当前应展示的题目
  const currentDialogue = useMemo(() => {
    if (!session || questionIndex < 1) return null;

    if (questionIndex <= 4) {
      const idx = questionIndex - 1;
      const d = session.short_dialogues[idx];
      if (!d) return null;
      return { kind: "short" as const, data: d };
    }
    if (questionIndex <= 12) {
      const idx = (questionIndex - 5) / 2;
      const d = session.long_dialogues[idx];
      if (!d) return null;
      return { kind: "group" as const, data: d };
    }
    if (questionIndex <= 14) {
      return { kind: "monologue" as const, data: session.monologue };
    }
    return null; // 15-19 不走 dialogue 流
  }, [session, questionIndex]);

  // "下一题"按钮的可点击状态：本段题目作答完整才允许跳转
  const nextEnabled = useMemo(
    () => computeSegmentComplete(session, questionIndex, answers),
    [session, questionIndex, answers]
  );
  const nextVisible = isNextVisible(questionIndex, phase);

  // 完成后跳转结算页（Phase 5 实现）
  useEffect(() => {
    if (finished && !error) {
      const t = setTimeout(() => navigate("/result"), 1500);
      return () => clearTimeout(t);
    }
  }, [finished, error, navigate]);

  // 挂载时主动拉一次后端状态，避免以下竞态：
  // - "重新测试"流程中，ResultPage 先 navigate("/test")，再后端 reset_test_flow + start_test_flow。
  //   此时后端会在 TestPage 还未挂载订阅时 emit `test-flow-state`，事件被丢弃。
  // - 拉一次 get_flow_state 能拿到后端当前的 phase/questionIndex 并补齐 store，
  //   后续事件订阅再覆盖也不会出错。
  // 仅在尚未开始（phase=null / questionIndex=0）时拉取，避免重复 work。
  useEffect(() => {
    let cancelled = false;
    const phaseNow = useTestFlowStore.getState().phase;
    const idxNow = useTestFlowStore.getState().questionIndex;
    if (phaseNow !== null && idxNow > 0) return;
    getFlowState()
      .then(({ state, finished: backendFinished }) => {
        if (cancelled) return;
        if (state) {
          applyFlowState(state);
        }
        if (backendFinished) {
          applyFinished({ ok: true });
        }
      })
      .catch((e) => {
        console.error("[Test] get_flow_state 失败", e);
      });
    return () => {
      cancelled = true;
    };
  }, [applyFlowState, applyFinished]);

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>尚未生成测试会话</CardTitle>
            <CardDescription>
              请先返回主菜单，点击「开始测试」完成题目预生成。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate("/")} className="w-full">
              返回主菜单
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!phase || questionIndex === 0) {
    return <TestStartCard onStart={startTestFlow} />;
  }

  // 开场介绍阶段：仅展示介绍文案与倒计时，不显示题目/选项/挖空/下一题，
  // 避免提前暴露后续题目内容。
  if (phase === "intro") {
    return <IntroScreen introText={introText} />;
  }

  // 15-19 题专用视图
  if (questionIndex >= 15) {
    return (
      <div className="min-h-screen flex flex-col bg-slate-50">
        <GlobalHeader />
        <main className="flex-1 container max-w-5xl mx-auto py-8 space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                <span>{PHASE_LABELS[phase]}</span>
                {phase === "fill_blank" && (
                  <span className="text-xs text-amber-600 font-normal">
                    请在 90 秒内完成 4 个挖空
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <PhaseCountdown />
              {phase === "prepare" && (
                <p className="text-sm text-muted-foreground">
                  请阅读下方表格，音频即将播放（共 3 次）
                </p>
              )}
              {phase === "playing" && (
                <p className="text-sm text-muted-foreground">
                  正在播放听力材料（可同时填写挖空）…
                </p>
              )}
              {phase === "fill_blank" && (
                <p className="text-sm text-amber-600 font-medium">
                  ⏱ 请使用键盘在下方空格中输入答案
                </p>
              )}
              {phase === "recall_prep" && (
                <p className="text-sm text-amber-600 font-medium">
                  ⏱ 默读时间，整理转述思路（不可再听音频）
                </p>
              )}
              {phase === "recording" && (
                <p className="text-sm text-red-600 font-medium">
                  🎙 录音中，请用清晰的英语口头转述刚才听到的听力材料
                </p>
              )}
            </CardContent>
          </Card>

          {/* "下一题"按钮 — 15-19 仅在 prepare/playing/fill_blank 显示 */}
          <NextQuestionButton
            visible={nextVisible}
            enabled={nextEnabled}
          />

          {/* 挖空表格 - 始终可见；PLAYING #3（playCount===3）期间不可继续填写（Spec §3.4） */}
          <FillBlankTable
            table={session.retell.table}
            enabled={
              phase === "fill_blank" ||
              (phase === "playing" && playCount !== 3)
            }
          />

          {/* 录音面板 - 仅 recall_prep / recording 时 */}
          {(phase === "recall_prep" || phase === "recording") && (
            <RecorderPanel
              isRecording={recorder.isRecording}
              audioLevel={recorder.audioLevel}
              onStop={recorder.stopLocalRecording}
            />
          )}

          {error && (
            <Card>
              <CardContent className="py-4 text-destructive text-sm">
                {error}
              </CardContent>
            </Card>
          )}

          {finished && !error && (
            <Card>
              <CardContent className="py-6 text-center text-emerald-600">
                ✓ 全部 19 题已完成，正在跳转到结算页…
              </CardContent>
            </Card>
          )}
        </main>
        <footer className="border-t bg-white py-2 text-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleAbandon}
          >
            放弃并返回主菜单
          </Button>
        </footer>
      </div>
    );
  }

  // 1-14 题主视图
  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <GlobalHeader />
      <main className="flex-1 container max-w-5xl mx-auto py-8 space-y-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between">
              <span>{PHASE_LABELS[phase]}</span>
              {phase === "answering" && (
                <span className="text-xs text-amber-600 font-normal">
                  点击下方选项作答（{isGroup ? "两题共享作答时间" : "本题独立作答"}）
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <PhaseCountdown />
            {phase === "prepare" && (
              <p className="text-sm text-muted-foreground">
                {isGroup ? "请阅读两组题目，音频即将播放 2 次" : "请阅读题目，音频即将播放"}
              </p>
            )}
            {phase === "playing" && (
              <p className="text-sm text-muted-foreground">
                {isGroup ? "正在播放对话音频（将播放 2 次），可提前选择答案…" : "正在播放对话音频，可提前选择答案…"}
              </p>
            )}
            {phase === "answering" && (
              <p className="text-sm text-amber-600 font-medium">
                ⏱ 请尽快作答，倒计时结束后自动进入下一题
              </p>
            )}
          </CardContent>
        </Card>

        {/* "下一题"按钮 — 完成本段作答后可直接跳到下一段 */}
        <NextQuestionButton
          visible={nextVisible}
          enabled={nextEnabled}
        />

        {currentDialogue && (
          <div className="space-y-4">
            {currentDialogue.kind === "short" && (
              <ShortDialogueDisplay
                dialogue={currentDialogue.data}
                showQuestion
                showAnswer={phase === "playing" || phase === "answering"}
              />
            )}
            {(currentDialogue.kind === "group" ||
              currentDialogue.kind === "monologue") && (
              <GroupDialogueDisplay
                dialogue={currentDialogue.data}
                showQuestion
                showAnswer={phase === "playing" || phase === "answering"}
                groupStartId={questionIndex}
              />
            )}
          </div>
        )}

        {error && (
          <Card>
            <CardContent className="py-4 text-destructive text-sm">{error}</CardContent>
          </Card>
        )}

        {finished && !error && (
          <Card>
            <CardContent className="py-6 text-center text-emerald-600">
              ✓ 第 1-14 题已完成，正在跳转到结算页…
            </CardContent>
          </Card>
        )}
      </main>
      <footer className="border-t bg-white py-2 text-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleAbandon}
        >
          放弃并返回主菜单
        </Button>
      </footer>
    </div>
  );
}

function TestStartCard({ onStart }: { onStart: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const resetSession = useTestStore((s) => s.reset);

  // 进入测试：先把题库条目从 pregen/ 搬到 cache/、标 Used、补题（这一步才真正"占用"题目），
  // 然后再启动测试流程（start_test_flow 读 SessionState 拿已激活的 session）。
  // 任一步失败都不应误导用户 —— 给出 toast 后 busy=false 让其重试。
  const handleStart = async () => {
    setBusy(true);
    try {
      await activateTestFromPregen();
      await onStart();
    } catch (e) {
      console.error("[Test] handleStart: 启动失败", e);
      toast(`启动测试失败: ${String(e)}`, { kind: "error" });
      setBusy(false);
    }
  };

  // 返回主菜单：清掉主菜单 pick 后留在 SessionState 的占位条目，避免下次再 pick 时与旧 session 冲突。
  // 这一步**不会**触碰 pregen/ 题库目录 —— 因为题目从未 activate，题库条目原封不动地留在 pool 里。
  const handleReturn = async () => {
    try {
      await resetSession(); // useTestStore.reset → clear_test_session: 清 SessionState + 删除 cache/{uuid}/
    } catch (e) {
      console.error("[Test] handleReturn: clear_test_session 失败", e);
    }
    useResultStore.getState().reset();
    useResultStore.getState().setIsRetest(false);
    useTestFlowStore.getState().reset();
    navigate("/");
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-8 bg-slate-50">
      <Card className="max-w-md w-full">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Play className="w-5 h-5" />
            准备开始测试
          </CardTitle>
          <CardDescription>
            测试共 19 题，分两部分：1-14 题（听后选择）+ 15-19 题（听后转述）。
            开始后将自动播放音频与计时，请保持专注。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            className="w-full"
            size="lg"
            disabled={busy}
            onClick={handleStart}
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                启动中…
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                开始测试
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={handleReturn}
          >
            返回主菜单
          </Button>
          <p className="text-xs text-muted-foreground text-center flex items-center justify-center gap-1">
            <FileText className="w-3 h-3" />
            15-18 题将使用键盘输入答案，第 19 题需要麦克风录音
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * "下一题"按钮：根据当前阶段与作答情况控制 enabled。
 *
 * - 1-14 题：当前题目作答完整可点击（组题需两题都答）
 * - 15-19 题：4 个挖空均填写内容，且当前阶段属于可跳段（prepare/playing/fill_blank）
 * - 点击后调用 skipToNext：后端停止当前播放并跳过剩余计时
 */
function NextQuestionButton({
  visible,
  enabled,
}: {
  visible: boolean;
  enabled: boolean;
}) {
  const [submitting, setSubmitting] = useState(false);
  if (!visible) return null;
  return (
    <div className="flex justify-end">
      <Button
        variant="default"
        disabled={!enabled || submitting}
        title={
          enabled
            ? "停止当前音频并直接进入下一段录音"
            : "请先完成本段题目作答"
        }
        onClick={async () => {
          if (submitting) return;
          setSubmitting(true);
          try {
            await skipToNext();
          } catch (e) {
            console.error("skip_to_next 失败", e);
          } finally {
            // 防止连点；后端状态机会在 200ms 内推进
            setTimeout(() => setSubmitting(false), 800);
          }
        }}
      >
        <SkipForward className="w-4 h-4 mr-2" />
        下一题
      </Button>
    </div>
  );
}

/**
 * 开场介绍视图（Phase::Intro）。
 *
 * 4 个 INTRO 阶段（1-4 / 5-14 / 15-18 / 19 题前）共用此视图：
 * - 仅展示介绍文案与倒计时，不渲染题目/选项/挖空表格
 * - 不显示"下一题"按钮（run_intro 内部允许 skip，但前端不在此处暴露入口）
 * - 底部保留"放弃并返回主菜单"以匹配其他阶段
 *
 * introText 由后端在 test-flow-state 事件中下发（FlowState.introText），
 * 内容在「设置 → 开场介绍」中可编辑。
 */
function IntroScreen({ introText }: { introText: string | null }) {
  const navigate = useNavigate();
  const recorder = useRecorder();
  const reset = useTestStore((s) => s.reset);

  const handleAbandon = async () => {
    if (!(await confirm("确认放弃本次测试？所有作答将被清空。"))) {
      return;
    }
    // 介绍阶段通常不会在录音中，但保险起见仍先停录音
    if (recorder.isRecording) {
      try {
        await recorder.stopLocalRecording();
      } catch (e) {
        console.error("[Intro] stopLocalRecording 失败", e);
      }
    }
    navigate("/");
    try {
      await resetTestFlow();
    } catch (e) {
      console.error("[Intro] resetTestFlow 失败", e);
    }
    try {
      await reset();
    } catch (e) {
      console.error("[Intro] reset 失败", e);
    }
    useResultStore.getState().reset();
    useResultStore.getState().setIsRetest(false);
    useTestFlowStore.getState().reset();
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <GlobalHeader />
      <main className="flex-1 container max-w-5xl mx-auto py-8 space-y-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{PHASE_LABELS["intro"]}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <PhaseCountdown />
            {introText && (
              <p className="text-sm text-muted-foreground leading-relaxed">
                {introText}
              </p>
            )}
          </CardContent>
        </Card>
      </main>
      <footer className="border-t bg-white py-2 text-center">
        <Button variant="ghost" size="sm" onClick={handleAbandon}>
          放弃并返回主菜单
        </Button>
      </footer>
    </div>
  );
}
