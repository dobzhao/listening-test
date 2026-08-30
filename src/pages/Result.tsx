// 结算页：展示 1-14 选择题对错、15-18 挖空得分、19 题转述得分

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Home,
  AlertCircle,
  ArrowUp,
  ArrowDown,
  ArrowRight,
} from "lucide-react";
import { useResultStore } from "@/store/result";
import { useTestStore } from "@/store/test";
import { useTestFlowStore } from "@/store/testFlow";
import { useAdaptiveStore } from "@/store/adaptive";
import { confirm } from "@/store/confirm";
import {
  resetTestFlow,
  clearTestSession,
  startTestFlow,
} from "@/lib/tauri";
import type { McqResult, BlankResult, RetellResult, AdaptiveSummary } from "@/types/result";
import { DIFFICULTY_LEVEL_LABELS } from "@/types/config";
import { AbilityProgressBar } from "@/components/AbilityProgressBar";

export default function ResultPage() {
  const navigate = useNavigate();
  const result = useResultStore((s) => s.result);
  const loading = useResultStore((s) => s.loading);
  const error = useResultStore((s) => s.error);
  const load = useResultStore((s) => s.load);
  const resetResult = useResultStore((s) => s.reset);

  const resetSession = useTestStore((s) => s.reset);

  // 重新测试：保留当前测试会话与题目，只清空 1-19 题作答记录与本页评分结果，
  // 然后跳回 /test 触发新一轮状态机；录音文件在 RECORDING 阶段会被同名覆盖。
  //
  // 重要：必须先 navigate 再 reset。
  // ResultPage 的 useEffect 监听 result/loading/error 变化触发 load() 评分。
  // 如果 resetResult() 在 navigate("/test") 之前调用，ResultPage 仍处于挂载状态，
  // 其 useEffect 会立即调用 load()，对着空答案算一次 0 分，
  // 后续该 useEffect 见到 result 已非 null 不再触发，最终结算页显示的是这次空答案的 0 分。
  // 先导航让 ResultPage 卸载，再 reset 状态，useEffect 就不会在旧页面上重跑。
  const handleRetest = async () => {
    // 自动档下提示用户：重复做同一套题不会再更新能力分（v1.1+）
    const adaptiveMode = useAdaptiveStore.getState().mode;
    const retestHint = adaptiveMode === "auto"
      ? "\n\n提示：已启用「自动切换难度」，重复做同一套题不会更新难度分。"
      : "";
    if (
      !(await confirm(
        "确认清空上次的答题记录并重新作答？" + retestHint
      ))
    ) {
      console.log("[Result] handleRetest: 用户取消");
      return;
    }
    const sessionId = result?.session_id ?? "<unknown>";
    const clearedAnswers = Object.keys(useTestFlowStore.getState().answers).length;
    console.log(
      `[Result] handleRetest: 用户确认重新测试 session_id=${sessionId}, 清空 ${clearedAnswers} 条前端作答`
    );
    // 0. v1.1+ 标记「重新测试」：下一次评分会跳过自适应更新。
    //    该 flag 必须在 resetResult() 之前设置并跨越整个 retest 流程保留，
    //    直到下一次 Result 页挂载时 load() 把它传给 scoreFullTest(isRetest)。
    //    注意：store/result.ts::reset() 不会清此 flag（避免误清），
    //    真正的清理由 handleBackToMenu 显式调用 setIsRetest(false) 完成。
    useResultStore.getState().setIsRetest(true);

    // 1. 先导航，让 ResultPage 卸载（避免 useEffect 重跑评分）
    navigate("/test");
    // 2. 后端：清空流程状态（answers、finished、skip / recording 标志等）
    try {
      await resetTestFlow();
      console.log("[Result] handleRetest: 后端 reset_test_flow 成功");
    } catch (e) {
      console.error("[Result] handleRetest: reset_test_flow 失败", e);
    }
    // 3. 前端：清空运行时状态
    resetResult();
    useTestFlowStore.getState().reset();
    console.log("[Result] handleRetest: 前端 store 已重置");
    // 4. 自动启动 1-19 题流程（同一 session，题目不变）
    // 避免用户再次点击 "开始测试"；TestPage 挂载后通过事件订阅推进状态。
    try {
      await startTestFlow();
      console.log("[Result] handleRetest: start_test_flow 成功");
    } catch (e) {
      console.error("[Result] handleRetest: start_test_flow 失败", e);
    }
  };

  // 返回主菜单：像重新打开程序一样清空所有内存状态（不清理磁盘缓存），
  // 让用户回到主菜单后由 MainMenu.loadSession() 决定是否从缓存恢复。
  //
  // 同样先 navigate 再 reset，避免重置 result 触发 useEffect 重新评分。
  const handleBackToMenu = async () => {
    if (
      !(await confirm(
        "确认返回主菜单？\n将清空当前题目与所有作答。"
      ))
    ) {
      console.log("[Result] handleBackToMenu: 用户取消");
      return;
    }
    const sessionId = result?.session_id ?? "<unknown>";
    console.log(`[Result] handleBackToMenu: 用户确认返回 session_id=${sessionId}`);
    // 1. 先导航，让 ResultPage 卸载
    navigate("/");
    // 2. 后端：并行清空流程状态与会话
    try {
      await resetTestFlow();
      console.log("[Result] handleBackToMenu: reset_test_flow 成功");
    } catch (e) {
      console.error("[Result] handleBackToMenu: reset_test_flow 失败", e);
    }
    try {
      await clearTestSession();
      console.log("[Result] handleBackToMenu: clear_test_session 成功");
    } catch (e) {
      console.error("[Result] handleBackToMenu: clear_test_session 失败", e);
    }
    // 3. 前端：清空三个 store
    resetResult();
    // 显式清掉 isRetest：用户放弃 retest 回到主菜单后，下次从 MainMenu 重新
    // 开始测试时不应残留 retest flag（否则下一次评分会被错误地跳过自适应更新）。
    // reset() 中有意不清此 flag，理由见 store/result.ts 与 handleRetest 的注释。
    useResultStore.getState().setIsRetest(false);
    useTestFlowStore.getState().reset();
    resetSession();
    console.log("[Result] handleBackToMenu: 前端 store 已重置");
  };

  // 进入页面时自动加载评分
  useEffect(() => {
    if (!result && !loading && !error) {
      load();
    }
  }, [result, loading, error, load]);

  if (loading && !result) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center space-y-3">
            <Loader2 className="w-10 h-10 mx-auto animate-spin text-primary" />
            <p className="text-sm">正在评分（1-14 本地 + 15-19 LLM + STT 转写）…</p>
            <p className="text-xs text-muted-foreground">
              首次调用 STT 与 LLM 可能需要数十秒
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-8">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="w-5 h-5" />
              评分失败
            </CardTitle>
            <CardDescription className="text-xs whitespace-pre-wrap">
              {error}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button className="w-full" onClick={() => load()}>
              <RefreshCw className="w-4 h-4 mr-2" />
              重试评分
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => navigate("/")}
            >
              返回主菜单
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!result) return null;

  const correctCount = result.mcq_results.filter((r) => r.is_correct).length;
  const totalPct = (result.total_score / result.max_score) * 100;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white sticky top-0 z-10">
        <div className="container max-w-5xl mx-auto py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">测试结果</h1>
            <p className="text-xs text-muted-foreground">
              Session: <span className="font-mono">{result.session_id}</span>
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleRetest}>
              <RefreshCw className="w-4 h-4 mr-1" />
              重新测试
            </Button>
            <Button onClick={handleBackToMenu}>
              <Home className="w-4 h-4 mr-1" />
              返回主菜单
            </Button>
          </div>
        </div>
      </header>

      <main className="container max-w-5xl mx-auto py-6 space-y-6">
        {/* 总分卡片 */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">总分</CardTitle>
              <AbilityDeltaBadge
                isRetest={result.is_retest}
                adaptive={result.adaptive}
              />
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-5xl font-bold text-primary">
                {result.total_score.toFixed(1)}
              </span>
              <span className="text-xl text-muted-foreground">
                / {result.max_score}
              </span>
              <span className="ml-3 text-sm text-muted-foreground">
                ({totalPct.toFixed(1)}%)
              </span>
            </div>
            <Separator className="my-3" />
            <div className="grid grid-cols-3 gap-4 text-sm">
              <SummaryItem
                label="1-14 题得分"
                value={`${correctCount} / 14`}
              />
              <SummaryItem
                label="15-18 题得分"
                value={`${result.blank_total_score.toFixed(1)} / 6`}
              />
              <SummaryItem
                label="19 题得分"
                value={`${result.retell_result?.score.toFixed(1) ?? "0.0"} / 10`}
              />
            </div>
          </CardContent>
        </Card>

        {/* 自适应难度调整摘要（v1.1+）：仅在非 retest 且后端成功更新时渲染 */}
        {result.adaptive && <AdaptiveSummaryCard summary={result.adaptive} />}

        {/* 1-14 题逐题对错 */}
        <McqSection results={result.mcq_results} dialogueTexts={result.dialogue_texts} />

        {/* 15-18 题填空 */}
        <BlankSection results={result.blank_results} />

        {/* 19 题转述 */}
        <RetellSection retell={result.retell_result} passage={result.dialogue_texts.retell} />
      </main>
    </div>
  );
}

// ===== 自适应（v1.1+）辅助组件 =====

/**
 * 总分卡片右上角的能力分变化徽章：
 * - is_retest=true → secondary「本次为重新测试，未调整能力」
 * - delta > 0 → 绿色 ↑ +X.X
 * - delta < 0 → 红色 ↓ -X.X
 * - delta ≈ 0 → 灰色 → 0.0
 */
function AbilityDeltaBadge({
  isRetest,
  adaptive,
}: {
  isRetest: boolean;
  adaptive: AdaptiveSummary | null;
}) {
  if (isRetest) {
    return (
      <Badge variant="secondary" className="text-xs">
        本次为重新测试，未调整能力
      </Badge>
    );
  }
  if (!adaptive) {
    return null;
  }
  const delta = adaptive.ability_after - adaptive.ability_before;
  const abs = Math.abs(delta);
  const formatted = abs.toFixed(1);
  if (delta > 1e-9) {
    return (
      <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-100 text-xs">
        <ArrowUp className="w-3 h-3 mr-1" />
        +{formatted}
      </Badge>
    );
  }
  if (delta < -1e-9) {
    return (
      <Badge className="bg-rose-100 text-rose-700 border-rose-200 hover:bg-rose-100 text-xs">
        <ArrowDown className="w-3 h-3 mr-1" />
        -{formatted}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs text-muted-foreground">
      <ArrowRight className="w-3 h-3 mr-1" />
      0.0
    </Badge>
  );
}

/**
 * 自适应难度调整卡片（v1.1+）：
 * - 顶部：旧档 → 新档 + ⬆/⬇/→ 箭头；档位变化时 Card 加 `border-primary` 高亮
 * - 进度条：可视化能力分前后位置；下方按当前档显示升级/降级距离
 * - 一行只读：ability_score 变化量、update_count
 */
function AdaptiveSummaryCard({ summary }: { summary: AdaptiveSummary }) {
  const levelChanged = summary.level_before !== summary.level_after;
  const promoted = levelChanged && levelOrdinal(summary.level_after) > levelOrdinal(summary.level_before);
  const LevelArrow = !levelChanged ? ArrowRight : promoted ? ArrowUp : ArrowDown;
  const arrowClass = !levelChanged
    ? "text-muted-foreground"
    : promoted
      ? "text-emerald-600"
      : "text-rose-600";
  const delta = summary.ability_after - summary.ability_before;
  const adaptiveParams = useAdaptiveStore((s) => s.params);

  return (
    <Card className={levelChanged ? "border-primary" : undefined}>
      <CardHeader>
        <CardTitle className="text-lg">自适应难度调整</CardTitle>
        <CardDescription>
          本次评分对能力分与档位的更新
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 text-base">
          <span className="font-medium">
            {DIFFICULTY_LEVEL_LABELS[summary.level_before]}
          </span>
          <LevelArrow className={`w-4 h-4 ${arrowClass}`} />
          <span className="font-medium">
            {DIFFICULTY_LEVEL_LABELS[summary.level_after]}
          </span>
          <Badge
            variant={levelChanged ? "default" : "outline"}
            className="ml-2 text-xs"
          >
            {levelChanged ? "档位变化" : "档位不变"}
          </Badge>
        </div>

        {/* 能力值进度条（含前后位置标记） */}
        <div className="rounded-md border bg-muted/20 p-4">
          <AbilityProgressBar
            ability={summary.ability_after}
            currentLevel={summary.level_after}
            params={adaptiveParams}
            abilityBefore={summary.ability_before}
          />
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-2">
            <span>调整前：{summary.ability_before.toFixed(1)}</span>
            <span className={`font-mono font-semibold ml-auto ${
              delta > 1e-9 ? "text-emerald-700" : delta < -1e-9 ? "text-rose-700" : "text-muted-foreground"
            }`}>
              {delta > 1e-9 ? "+" : ""}
              {delta.toFixed(1)}
            </span>
          </div>
        </div>

        <Separator />
        <div className="grid grid-cols-1 gap-4 text-sm">
          <SummaryItem
            label="练习次数"
            value={`${summary.update_count_after}`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-mono font-medium">{value}</p>
    </div>
  );
}

/** 难度档的相对顺序：junior_high < senior_high < undergraduate */
function levelOrdinal(level: "junior_high" | "senior_high" | "undergraduate"): number {
  switch (level) {
    case "junior_high":
      return 0;
    case "senior_high":
      return 1;
    case "undergraduate":
      return 2;
  }
}

// === 1-14 题 ===

function McqSection({
  results,
  dialogueTexts,
}: {
  results: McqResult[];
  dialogueTexts: Record<string, string>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">1-14 题（听后选择）</CardTitle>
        <CardDescription>
          点击展开对话原文与正确答案
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-7 gap-2">
          {results.map((r) => (
            <McqCard key={r.question_id} result={r} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function McqCard({ result }: { result: McqResult }) {
  const [open, setOpen] = useState(false);
  const userLabel = result.user_answer ?? "未作答";
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full rounded-md border p-2.5 text-left transition-colors ${
          result.is_correct
            ? "border-emerald-200 bg-emerald-50 hover:bg-emerald-100"
            : "border-rose-200 bg-rose-50 hover:bg-rose-100"
        }`}
      >
        <div className="flex items-center justify-between">
          <span className="font-mono text-sm font-semibold">
            Q{result.question_id}
          </span>
          {result.is_correct ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          ) : (
            <XCircle className="w-4 h-4 text-rose-600" />
          )}
        </div>
        <p className="mt-1 text-xs">
          {result.is_correct ? (
            <span className="text-emerald-700">正确 ({userLabel})</span>
          ) : (
            <span className="text-rose-700">
              错（你：{userLabel} / 正：{result.correct_answer}）
            </span>
          )}
        </p>
      </button>
    </div>
  );
}

// === 15-18 题 ===

function BlankSection({ results }: { results: BlankResult[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">15-18 题（听后填词）</CardTitle>
        <CardDescription>
          由 LLM 评分（大小写不敏感、单复数要求严格、允许英式英语与美式英语拼写差异）
        </CardDescription>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="text-left py-2 w-16">题号</th>
              <th className="text-left py-2">你的答案</th>
              <th className="text-left py-2">标准答案</th>
              <th className="text-right py-2 w-20">得分</th>
              <th className="text-right py-2 w-16">结果</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.blank_id} className="border-b">
                <td className="py-2 font-mono font-semibold">{r.blank_id}</td>
                <td className="py-2 font-mono">
                  {r.user_answer || <span className="text-muted-foreground">空</span>}
                </td>
                <td className="py-2 font-mono">{r.correct_answer}</td>
                <td className="py-2 text-right font-mono">{r.score.toFixed(1)}</td>
                <td className="py-2 text-right">
                  {r.is_correct ? (
                    <Badge variant="success" className="text-xs">
                      对
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="text-xs">
                      错
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="py-2 text-right font-semibold">
                小计
              </td>
              <td className="py-2 text-right font-mono font-bold">
                {results.reduce((sum, r) => sum + r.score, 0).toFixed(1)} / 6
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </CardContent>
    </Card>
  );
}

// === 19 题转述 ===

function RetellSection({
  retell,
  passage,
}: {
  retell: RetellResult | null;
  passage?: string;
}) {
  if (!retell) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">19 题（听后转述）</CardTitle>
        <CardDescription>
          STT 转写 → LLM 评分
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-bold text-primary">
            {retell.score.toFixed(1)}
          </span>
          <span className="text-muted-foreground">
            / {retell.max_score} 分
          </span>
        </div>

        {retell.comment && (
          <div>
            <p className="text-xs text-muted-foreground mb-1">LLM 评语</p>
            <p className="text-sm leading-relaxed p-3 bg-muted/30 rounded">
              {retell.comment}
            </p>
          </div>
        )}

        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            STT 转写文本
          </summary>
          <ScrollArea className="mt-2 max-h-60 rounded border bg-muted/30 p-3">
            <p className="whitespace-pre-wrap text-xs leading-relaxed">
              {retell.stt_text || "（空）"}
            </p>
          </ScrollArea>
        </details>

        {passage && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              参考听力原文
            </summary>
            <p className="mt-2 text-xs leading-relaxed p-3 bg-muted/30 rounded whitespace-pre-wrap">
              {passage}
            </p>
          </details>
        )}
      </CardContent>
    </Card>
  );
}