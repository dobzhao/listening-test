import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
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
import { Separator } from "@/components/ui/separator";
import { Play, Settings as SettingsIcon, Headphones, Loader2, RefreshCw } from "lucide-react";
import { useSettingsStore } from "@/store/settings";
import { useTestStore, STAGE_LABELS } from "@/store/test";
import { useAdaptiveStore } from "@/store/adaptive";
import { useGenerationProgress } from "@/hooks/useGenerationProgress";
import { confirm } from "@/store/confirm";
import { DIFFICULTY_LEVEL_LABELS } from "@/types/config";

export default function MainMenu() {
  const navigate = useNavigate();
  const loaded = useSettingsStore((s) => s.loaded);
  const loadError = useSettingsStore((s) => s.loadError);
  const llm = useSettingsStore((s) => s.config.llm);
  const tts = useSettingsStore((s) => s.config.tts);
  const stt = useSettingsStore((s) => s.config.stt);

  const stage = useTestStore((s) => s.stage);
  const session = useTestStore((s) => s.session);
  const progress = useTestStore((s) => s.progress);
  const error = useTestStore((s) => s.error);
  const start = useTestStore((s) => s.start);
  const loadSession = useTestStore((s) => s.load);
  const resetSession = useTestStore((s) => s.reset);

  const adaptiveMode = useAdaptiveStore((s) => s.mode);
  const adaptiveState = useAdaptiveStore();
  const manualLevel = useSettingsStore((s) => s.config.difficulty.level);
  const effectiveLevel =
    adaptiveMode === "auto" ? adaptiveState.currentLevel : manualLevel;

  useGenerationProgress();

  // 启动时尝试恢复已有会话
  useEffect(() => {
    if (loaded && !session && stage === "idle") {
      loadSession();
    }
  }, [loaded, session, stage, loadSession]);

  const llmConfigured = !!llm.host && !!llm.model && !!llm.api_key;
  const ttsConfigured = !!tts.host && !!tts.model && !!tts.api_key;
  const sttConfigured = !!stt.host && !!stt.model && !!stt.api_key;
  const allConfigured = llmConfigured && ttsConfigured && sttConfigured;

  const handleStart = async () => {
    try {
      await start();
    } catch {
      // error 已写入 store，用户可看到
    }
  };

  const handleResetAndStart = async () => {
    // 重置会话状态后重新生成（用于生成失败后重试）
    if (await confirm("重新生成将丢弃当前已生成的题目与作答。继续？")) {
      resetSession();
      handleStart();
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 to-slate-100">
      {/* 顶部标题 */}
      <header className="border-b bg-white/80 backdrop-blur-sm">
        <div className="container max-w-5xl mx-auto py-6 flex items-center gap-3">
          <Headphones className="w-8 h-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">英语听力练习</h1>
            <p className="text-sm text-muted-foreground">
              跨平台听说考试模拟 · 19 题完整流程
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
            {/* 开始测试卡片 */}
            <Card className="md:col-span-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Play className="w-5 h-5" />
                    开始测试
                  </CardTitle>
                  {stage === "ready" && session ? (
                    <Badge variant="success">题目已就绪</Badge>
                  ) : allConfigured ? (
                    <Badge variant="secondary">配置就绪</Badge>
                  ) : (
                    <Badge variant="destructive">配置未完成</Badge>
                  )}
                </div>
                <CardDescription>
                  完整模拟 19 道题目：1-14 题听后选择，15-19 题听后转述。
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
                        ? `自动 | 当前档：${DIFFICULTY_LEVEL_LABELS[effectiveLevel]}`
                        : `手动 | 当前档：${DIFFICULTY_LEVEL_LABELS[effectiveLevel]}`
                    }
                  />
                </div>

                {loadError && (
                  <p className="text-sm text-destructive">
                    配置加载失败：{loadError}
                  </p>
                )}

                {/* 进度展示 */}
                {stage === "generating" && (
                  <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                    <div className="flex items-center gap-2 text-sm">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span className="font-medium">
                        {progress
                          ? STAGE_LABELS[progress.stage] ?? progress.message
                          : "正在预生成题目与音频…"}
                      </span>
                    </div>
                    <Progress
                      value={(progress?.progress ?? 0) * 100}
                      className="h-2"
                    />
                    <p className="text-xs text-muted-foreground">
                      {progress?.message ??
                        "首次启动可能需要数十秒，后续会从本地缓存恢复。"}
                    </p>
                  </div>
                )}

                {stage === "error" && error && (
                  <div className="space-y-2">
                    <p className="text-sm text-destructive whitespace-pre-wrap">
                      {error}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleResetAndStart}
                    >
                      <RefreshCw className="w-3 h-3 mr-1" />
                      清除并重新生成
                    </Button>
                  </div>
                )}

                {stage === "ready" && session && (
                  <p className="text-sm text-emerald-600">
                    已生成 {session.short_dialogues.length + session.long_dialogues.length * 2 + 2}
                    {" "}道选择题 + 4 个填空 + 1 道转述
                  </p>
                )}

                <Separator />

                <div className="flex gap-2">
                  <Button
                    size="lg"
                    className="flex-1"
                    disabled={!allConfigured || stage === "generating"}
                    onClick={handleStart}
                  >
                    {stage === "generating" ? (
                      <>
                        <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                        预生成中…
                      </>
                    ) : stage === "ready" && session ? (
                      <>
                        <Play className="w-5 h-5 mr-2" />
                        重新生成
                      </>
                    ) : (
                      <>
                        <Play className="w-5 h-5 mr-2" />
                        开始测试（19 题）
                      </>
                    )}
                  </Button>

                  {stage === "ready" && session && (
                    <Button
                      size="lg"
                      variant="default"
                      onClick={() => navigate("/test")}
                    >
                      进入测试
                    </Button>
                  )}
                </div>

                {!allConfigured && (
                  <p className="text-xs text-muted-foreground text-center">
                    请先在「设置」中完成模型服务配置
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
                  配置模型服务、提示词模板、麦克风/键盘测试
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
                  本程序使用本地/自建 OpenAI 兼容 LLM/TTS/STT 服务，所有题目
                  内容均由模型实时生成。
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
