import { useNavigate } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Play,
  Settings as SettingsIcon,
  Headphones,
  Loader2,
  Database,
  X,
} from "lucide-react";
import { useSettingsStore } from "@/store/settings";
import { useTestStore, STAGE_LABELS } from "@/store/test";
import { useAdaptiveStore } from "@/store/adaptive";
import { usePregenStore } from "@/store/pregen";
import { useGenerationProgress } from "@/hooks/useGenerationProgress";
import { DIFFICULTY_LEVEL_LABELS, type DifficultyLevel } from "@/types/config";
import { toast } from "@/store/toast";
import { pickTestFromPregen } from "@/lib/tauri";

export default function MainMenu() {
  const navigate = useNavigate();

  const loaded = useSettingsStore((s) => s.loaded);
  const loadError = useSettingsStore((s) => s.loadError);
  const llm = useSettingsStore((s) => s.config.llm);
  const tts = useSettingsStore((s) => s.config.tts);
  const stt = useSettingsStore((s) => s.config.stt);
  const manualLevel = useSettingsStore((s) => s.config.difficulty.level);

  const stage = useTestStore((s) => s.stage);
  const session = useTestStore((s) => s.session);
  const legacyProgress = useTestStore((s) => s.progress);
  const setLegacySession = useTestStore((s) => s.setSession);

  const adaptiveMode = useAdaptiveStore((s) => s.mode);
  const adaptiveLevel = useAdaptiveStore((s) => s.currentLevel);
  const effectiveLevel: DifficultyLevel =
    adaptiveMode === "auto" ? adaptiveLevel : manualLevel;

  // 题库摘要与进度（新增）
  const pregenSummary = usePregenStore((s) => s.summary);
  const pregenProgress = usePregenStore((s) => s.progress);
  const pregenError = usePregenStore((s) => s.error);
  const loadSummary = usePregenStore((s) => s.loadSummary);
  const enqueue = usePregenStore((s) => s.enqueue);
  const cancel = usePregenStore((s) => s.cancel);

  const [pregenCount, setPregenCount] = useState(1);

  useGenerationProgress();

  // 每次主菜单挂载都重新拉题库摘要：
  // - App.tsx 只在启动时拉一次；
  // - 用户从 /test 返回主菜单后，`activate_test_from_pregen` 已把题目标记为 Used
  //   并 enqueue(1) 补题，但前端 store 没有任何事件触发 loadSummary
  //   （pregen-finished 仅在 worker 跑完全部入队条目时才发，且 activate 路径根本不发），
  //   会导致「开始测试（X 套 · 难度：Y）」按钮上的剩余套数显示陈旧值。
  // - 配合 store/pregen.setProgress 的 stage="done" 分支，可在批量补题过程中
  //   实时看到 unusedCount 增长。
  useEffect(() => {
    if (loaded) {
      void loadSummary();
    }
  }, [loaded, loadSummary]);

  // 兼容旧的 generation progress 事件路径（保留以防旧 generate_test_session 被触发）
  useEffect(() => {
    if (!pregenSummary) {
      // 还没有拉过摘要时显示旧 stage 的 progress
    }
  }, [pregenSummary, legacyProgress]);

  const llmConfigured = !!llm.host && !!llm.model && !!llm.api_key;
  const ttsConfigured = !!tts.host && !!tts.model && !!tts.api_key;
  const sttConfigured = !!stt.host && !!stt.model && !!stt.api_key;
  const allConfigured = llmConfigured && ttsConfigured && sttConfigured;

  const unusedCount = pregenSummary?.unusedByLevel[effectiveLevel] ?? 0;
  const totalUnused = pregenSummary?.unusedCount ?? 0;
  const generatingNow = pregenSummary?.generatingNow ?? false;

  // 已就绪的 session 可能由旧的 generate_test_session 留下（MVP 期不应该，但兜底）
  const bankEmpty = unusedCount === 0;

  const levelLabel = DIFFICULTY_LEVEL_LABELS[effectiveLevel] ?? effectiveLevel;

  const handleEnqueue = async () => {
    if (pregenCount < 1 || pregenCount > 20) {
      toast("请输入 1-20 之间的整数", { kind: "info" });
      return;
    }
    try {
      await enqueue(pregenCount);
    } catch (e) {
      toast(`入队失败: ${String(e)}`, { kind: "error" });
    }
  };

  const handleCancel = async () => {
    await cancel();
    toast("已请求取消（当前套会跑完）", { kind: "info" });
  };

  const handleStartFromBank = async () => {
    try {
      // 仅「预选」题库条目：不动文件、不标 Used、不触发补题 —— 真正激活（move + 标 Used + 补题）
      // 在「准备开始测试」界面点「开始测试」按钮时由 activateTestFromPregen 完成。
      // 这样即使用户在准备界面点「返回主菜单」，题库条目依然在 pool 里，下次再点可以复用。
      const s = await pickTestFromPregen();
      setLegacySession(s);
      navigate("/test");
    } catch (e) {
      toast(`开始测试失败: ${String(e)}`, { kind: "error" });
      // 重新拉摘要以反映 used/unused 变化
      void loadSummary();
    }
  };

  // 进度文案（题库生成中）
  const progressLabel = useMemo(() => {
    if (pregenProgress) {
      const total = pregenProgress.total;
      const current = pregenProgress.current;
      if (pregenProgress.stage === "started") {
        return `正在生成第 ${current}/${total} 套 · ${pregenProgress.message}`;
      }
      return `第 ${current}/${total} 套 · ${pregenProgress.message || "生成中…"}`;
    }
    if (generatingNow) {
      return "正在生成…";
    }
    return null;
  }, [pregenProgress, generatingNow]);

  // 进度条 value：worker 阶段会发 test-generation-progress（llm_q1_4 等）；
  // pregen-progress 的 progress 字段在生成中可能没值（只有 done 时是 1.0），
  // 这里取两者最大值让 UI 至少有反馈。
  const progressValue = useMemo(() => {
    if (pregenProgress?.progress != null) return pregenProgress.progress * 100;
    if (legacyProgress?.progress != null) return legacyProgress.progress * 100;
    return 0;
  }, [pregenProgress, legacyProgress]);

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 to-slate-100">
      {/* 顶部标题 */}
      <header className="border-b bg-white/80 backdrop-blur-sm">
        <div className="container max-w-5xl mx-auto py-6 flex items-center gap-3">
          <Headphones className="w-8 h-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">英语听力练习</h1>
            <p className="text-sm text-muted-foreground">
              听说考试模拟
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 container max-w-5xl mx-auto py-12">
        {!loaded ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              正在加载配置…
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {/* 题库卡片 */}
            <Card className="md:col-span-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Database className="w-5 h-5" />
                    题库
                  </CardTitle>
                  {generatingNow ? (
                    <Badge variant="secondary">
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      生成中
                    </Badge>
                  ) : totalUnused > 0 ? (
                    <Badge variant="success">题目就绪</Badge>
                  ) : allConfigured ? (
                    <Badge variant="outline">题库为空</Badge>
                  ) : (
                    <Badge variant="destructive">配置未完成</Badge>
                  )}
                </div>
                <CardDescription>
                  当前难度「{levelLabel}」可用{" "}
                  <strong className={unusedCount === 0 ? "text-rose-600" : "text-emerald-600"}>
                    {unusedCount}
                  </strong>{" "}
                  套
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2 text-sm">
                  <ConfigStatusRow
                    label="LLM（大语言模型）"
                    configured={llmConfigured}
                    detail={`${llm.host}:${llm.port} · ${llm.model || "<未设置>"}`}
                  />
                  <ConfigStatusRow
                    label="TTS（语音合成）"
                    configured={ttsConfigured}
                    detail={`${tts.host}:${tts.port} · ${tts.model || "<未设置>"}`}
                  />
                  <ConfigStatusRow
                    label="STT（语音识别）"
                    configured={sttConfigured}
                    detail={`${stt.host}:${stt.port} · ${stt.model || "<未设置>"}`}
                  />
                  <ConfigStatusRow
                    label="难度模式"
                    configured={true}
                    detail={
                      adaptiveMode === "auto"
                        ? `自动 | 当前档：${levelLabel}`
                        : `手动 | 当前档：${levelLabel}`
                    }
                  />
                </div>

                {loadError && (
                  <p className="text-sm text-destructive">
                    配置加载失败：{loadError}
                  </p>
                )}

                {/* 补充题库控件 */}
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="pregen-count" className="text-xs">
                      补充套数
                    </Label>
                    <Input
                      id="pregen-count"
                      type="number"
                      min={1}
                      max={20}
                      value={pregenCount}
                      onChange={(e) =>
                        setPregenCount(Math.max(1, Number(e.target.value) || 1))
                      }
                      disabled={generatingNow}
                      className="w-24"
                    />
                  </div>
                  <Button
                    onClick={handleEnqueue}
                    disabled={!allConfigured || generatingNow}
                  >
                    {generatingNow ? "生成中…" : `补充 ${pregenCount} 套（${levelLabel}）`}
                  </Button>
                  {generatingNow && (
                    <Button variant="outline" onClick={handleCancel}>
                      <X className="w-4 h-4 mr-1" />
                      取消
                    </Button>
                  )}
                </div>

                {/* 进度展示 */}
                {generatingNow && progressLabel && (
                  <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                    <div className="flex items-center gap-2 text-sm">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span className="font-medium">{progressLabel}</span>
                    </div>
                    <Progress value={progressValue} className="h-2" />
                    {legacyProgress && (
                      <p className="text-xs text-muted-foreground">
                        阶段：{STAGE_LABELS[legacyProgress.stage as keyof typeof STAGE_LABELS] ??
                          legacyProgress.message}
                      </p>
                    )}
                  </div>
                )}

                {pregenError && (
                  <p className="text-sm text-destructive whitespace-pre-wrap">
                    {pregenError}
                  </p>
                )}

                <Separator />

                {/* 开始测试按钮 */}
                <Button
                  size="lg"
                  className="w-full"
                  disabled={
                    !allConfigured ||
                    bankEmpty ||
                    generatingNow ||
                    (stage === "generating" && !session)
                  }
                  onClick={handleStartFromBank}
                >
                  <Play className="w-5 h-5 mr-2" />
                  开始测试（{unusedCount} 套 · 难度：{levelLabel}）
                </Button>

                {bankEmpty && allConfigured && !generatingNow && (
                  <p className="text-xs text-muted-foreground text-center">
                    当前难度（{levelLabel}）题库为空，请先补充题库
                  </p>
                )}
                {!allConfigured && (
                  <p className="text-xs text-muted-foreground text-center">
                    请先在「设置」中完成模型服务配置
                  </p>
                )}

                {/* 兼容旧 generate_test_session 残留的 session */}
                {session && stage === "ready" && (
                  <p className="text-xs text-amber-600 text-center">
                    内存中存在上次的测试会话（来自旧版本），可前往
                    <button
                      type="button"
                      className="underline mx-1"
                      onClick={() => navigate("/test")}
                    >
                      /test
                    </button>
                    继续。
                  </p>
                )}
              </CardContent>
            </Card>

            {/* 设置卡片 */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <SettingsIcon className="w-5 h-5" />
                  设置
                </CardTitle>
                <CardDescription>
                  配置模型服务、提示词模板、难度设置、设备测试
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => navigate("/settings")}
                >
                  进入设置
                </Button>
              </CardContent>
            </Card>

            {/* 项目信息 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">关于本程序</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground space-y-2">
                <p>
                  本程序使用OpenAI兼容LLM/TTS/STT服务，所有题目文本及音频均由模型实时生成。
                </p>
              </CardContent>
            </Card>
          </div>
        )}
      </main>

      <footer className="border-t bg-white/80 backdrop-blur-sm py-3">
        <div className="container max-w-5xl mx-auto text-center text-xs text-muted-foreground">
          Tauri 2.0 + React 18 + TypeScript + Tailwind CSS + shadcn/ui
        </div>
      </footer>
    </div>
  );
}

function ConfigStatusRow({
  label,
  configured,
  detail,
}: {
  label: string;
  configured: boolean;
  detail: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${
            configured ? "bg-emerald-500" : "bg-slate-300"
          }`}
        />
        <span className="font-medium">{label}</span>
      </div>
      <span className="text-xs text-muted-foreground font-mono">{detail}</span>
    </div>
  );
}