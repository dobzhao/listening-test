// 设置主页面：6 个 Tab 组织所有配置

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Save, RotateCcw } from "lucide-react";
import { useSettingsStore } from "@/store/settings";
import { confirm } from "@/store/confirm";
import { ModelConfigForm } from "@/components/settings/ModelConfigForm";
import { PromptEditor } from "@/components/settings/PromptEditor";
import { AudioSettingsPanel } from "@/components/settings/AudioSettingsPanel";
import { LlmParamsPanel } from "@/components/settings/LlmParamsPanel";
import { MicTest } from "@/components/settings/MicTest";
import { KeyboardTest } from "@/components/settings/KeyboardTest";
import { TimingPanel } from "@/components/settings/TimingPanel";
import { IntroPanel } from "@/components/settings/IntroPanel";
import { DifficultyPanel } from "@/components/settings/DifficultyPanel";
import {
  DEFAULT_LLM_API_PATH,
  DEFAULT_TTS_API_PATH,
  DEFAULT_STT_API_PATH,
  DEFAULT_TTS_MODEL,
  DEFAULT_STT_MODEL,
} from "@/types/config";

export default function SettingsPage() {
  const navigate = useNavigate();
  const loaded = useSettingsStore((s) => s.loaded);
  const configPath = useSettingsStore((s) => s.configPath);
  const saving = useSettingsStore((s) => s.saving);
  const persist = useSettingsStore((s) => s.persist);
  const reset = useSettingsStore((s) => s.reset);
  const updateLlm = useSettingsStore((s) => s.updateLlm);
  const updateTts = useSettingsStore((s) => s.updateTts);
  const updateStt = useSettingsStore((s) => s.updateStt);
  const config = useSettingsStore((s) => s.config);

  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  // 离开页面时如果未保存，提示用户
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const handleSave = async () => {
    try {
      await persist();
      setSaveStatus("✓ 已保存");
      setTimeout(() => setSaveStatus(null), 2000);
    } catch (e) {
      setSaveStatus(`✗ ${String(e)}`);
    }
  };

  const handleReset = async () => {
    if (!(await confirm("确认重置全部配置为默认值？\n此操作不可撤销。"))) return;
    await reset();
    setSaveStatus("✓ 已重置");
    setTimeout(() => setSaveStatus(null), 2000);
  };

  if (!loaded) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        加载中…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* 顶部导航 */}
      <header className="border-b bg-white sticky top-0 z-10">
        <div className="container max-w-5xl mx-auto py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
              <ArrowLeft className="w-4 h-4 mr-1" />
              返回
            </Button>
            <h1 className="text-lg font-semibold">设置</h1>
            {configPath && (
              <span className="text-xs text-muted-foreground font-mono hidden md:inline">
                {configPath}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {saveStatus && (
              <span className="text-sm text-muted-foreground">{saveStatus}</span>
            )}
            <Button variant="outline" onClick={handleReset} size="sm">
              <RotateCcw className="w-4 h-4 mr-1" />
              重置全部
            </Button>
            <Button onClick={handleSave} disabled={saving} size="sm">
              <Save className="w-4 h-4 mr-1" />
              {saving ? "保存中…" : "保存配置"}
            </Button>
          </div>
        </div>
      </header>

      <main className="container max-w-5xl mx-auto py-6">
        <Tabs defaultValue="llm" className="space-y-4">
          <TabsList className="grid grid-cols-3 md:grid-cols-9 w-full">
            <TabsTrigger value="llm">LLM</TabsTrigger>
            <TabsTrigger value="tts">TTS</TabsTrigger>
            <TabsTrigger value="stt">STT</TabsTrigger>
            <TabsTrigger value="prompts">提示词</TabsTrigger>
            <TabsTrigger value="difficulty">题目难度</TabsTrigger>
            <TabsTrigger value="audio">音频</TabsTrigger>
            <TabsTrigger value="timing">流程时长</TabsTrigger>
            <TabsTrigger value="intro">开场介绍</TabsTrigger>
            <TabsTrigger value="device">设备测试</TabsTrigger>
          </TabsList>

          {/* LLM 配置 */}
          <TabsContent value="llm" className="space-y-4">
            <ModelConfigForm
              kind="llm"
              title="LLM（大语言模型）"
              description="用于实时生成听力材料、题目、评分。所有提示词的最终执行方。"
              config={config.llm}
              defaultPath={DEFAULT_LLM_API_PATH}
              defaultModel="default-llm"
              onChange={updateLlm}
            />
            <LlmParamsPanel />
          </TabsContent>

          {/* TTS 配置 */}
          <TabsContent value="tts" className="space-y-4">
            <ModelConfigForm
              kind="tts"
              title="TTS（语音合成）"
              description="用于把对话/独白文本转为 wav。"
              config={config.tts}
              defaultPath={DEFAULT_TTS_API_PATH}
              defaultModel={DEFAULT_TTS_MODEL}
              onChange={updateTts}
            />
          </TabsContent>

          {/* STT 配置 */}
          <TabsContent value="stt" className="space-y-4">
            <ModelConfigForm
              kind="stt"
              title="STT（语音识别）"
              description="用于第 19 题转录音频并转写为文本。"
              config={config.stt}
              defaultPath={DEFAULT_STT_API_PATH}
              defaultModel={DEFAULT_STT_MODEL}
              onChange={updateStt}
            />
          </TabsContent>

          {/* Prompt 配置 */}
          <TabsContent value="prompts" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">提示词模板</CardTitle>
                <p className="text-sm text-muted-foreground">
                  以下 5 个 Prompt 模板均可在设置界面编辑，使用{" "}
                  <code className="px-1.5 py-0.5 rounded bg-muted font-mono text-xs">
                    {"{{KEY}}"}
                  </code>{" "}
                  占位符语法。运行时由 Rust 后端{" "}
                  <code className="px-1.5 py-0.5 rounded bg-muted font-mono text-xs">
                    prompt_engine
                  </code>{" "}
                  替换为实际变量值。3 个{" "}
                  <code className="px-1.5 py-0.5 rounded bg-muted font-mono text-xs">
                    {"{{DIFFICULTY_DEMAND_*}}"}
                  </code>{" "}
                  占位符的取值在「题目难度」Tab 中编辑。
                </p>
              </CardHeader>
            </Card>

            <PromptEditor
              promptKey="q1_4"
              title="1-4 题出题 Prompt"
              description="生成 4 段短对话，每段配 1 道选择题。"
            />

            <Separator />

            <PromptEditor
              promptKey="q5_14"
              title="5-14 题出题 Prompt"
              description="生成 4 段长对话 + 1 段独白，每段/每独白配 2 道选择题。"
            />

            <Separator />

            <PromptEditor
              promptKey="q15_18"
              title="15-18 题出题 Prompt"
              description="生成 1 段较长的听力材料 + 总-分结构表格 + 4 个挖空。"
            />

            <Separator />

            <PromptEditor
              promptKey="q15_18_scoring"
              title="15-18 题填空判分 Prompt"
              description="把用户填写的 4 个答案与标准答案交给 LLM 评分。"
            />

            <Separator />

            <PromptEditor
              promptKey="q19_scoring"
              title="19 题转述评分 Prompt"
              description="把 STT 转写文本与原文交给 LLM 评分（满分 10）。"
            />

            <Card>
              <CardContent className="py-4 text-xs text-muted-foreground">
                修改提示词后请点击右上角「保存配置」按钮。
              </CardContent>
            </Card>
          </TabsContent>

          {/* 题目难度 */}
          <TabsContent value="difficulty" className="space-y-4">
            <DifficultyPanel />
          </TabsContent>

          {/* 音频设置 */}
          <TabsContent value="audio" className="space-y-4">
            <AudioSettingsPanel />
          </TabsContent>

          {/* 流程时长 */}
          <TabsContent value="timing" className="space-y-4">
            <TimingPanel />
          </TabsContent>

          {/* 开场介绍文案 */}
          <TabsContent value="intro" className="space-y-4">
            <IntroPanel />
          </TabsContent>

          {/* 设备测试 */}
          <TabsContent value="device" className="space-y-4">
            <MicTest />
            <KeyboardTest />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
