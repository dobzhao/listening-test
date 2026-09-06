// 流程时长设置：测试流程中各阶段的可等待时长。
// 全部以"秒"为单位展示，落库前 *1000 转毫秒。
// RECORDING 录音时长不在此处配置（固定 90 秒）。

import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { RotateCcw } from "lucide-react";
import { useSettingsStore } from "@/store/settings";
import { confirm } from "@/store/confirm";

interface TimingField {
  key:
    | "intro_ms"
    | "short_dialogue_prepare_ms"
    | "short_dialogue_answer_ms"
    | "group_intro_ms"
    | "group_prepare_ms"
    | "group_pause_ms"
    | "group_answer_ms"
    | "retell_intro_ms"
    | "retell_prepare_ms"
    | "retell_pause_ms"
    | "retell_fill_blank_ms"
    | "retell_recall_prep_ms"
    | "retell_q19_intro_ms"
    | "retell_play3_intro_ms";
  label: string;
  hint: string;
}

const TIMING_FIELDS: TimingField[] = [
  {
    key: "intro_ms",
    label: "1-4 题开场介绍",
    hint: "仅在第 1 题前显示一次；设为 0 秒可跳过",
  },
  {
    key: "short_dialogue_prepare_ms",
    label: "1-4 题 PREPARE",
    hint: "短对话：展示题干与选项",
  },
  {
    key: "short_dialogue_answer_ms",
    label: "1-4 题 ANSWERING",
    hint: "短对话：选项可点击倒计时",
  },
  {
    key: "group_intro_ms",
    label: "5-14 题开场介绍",
    hint: "仅在第 5 题前显示一次；设为 0 秒可跳过",
  },
  {
    key: "group_prepare_ms",
    label: "5-14 题 PREPARE",
    hint: "长对话/独白：同时显示两道题",
  },
  {
    key: "group_pause_ms",
    label: "5-14 题静音间隔",
    hint: "两次播放之间的停顿",
  },
  {
    key: "group_answer_ms",
    label: "5-14 题 ANSWERING",
    hint: "长对话/独白：两题共享作答时间",
  },
  {
    key: "retell_intro_ms",
    label: "15-18 题开场介绍",
    hint: "在 PREPARE 之前显示；设为 0 秒可跳过",
  },
  {
    key: "retell_prepare_ms",
    label: "15-19 题 PREPARE",
    hint: "听后转述：展示挖空表格",
  },
  {
    key: "retell_pause_ms",
    label: "15-19 题静音间隔",
    hint: "两次播放之间的停顿",
  },
  {
    key: "retell_fill_blank_ms",
    label: "15-19 题 FILL_BLANK",
    hint: "用户填写 4 个挖空",
  },
  {
    key: "retell_play3_intro_ms",
    label: "15-19 题播放 #3 前介绍",
    hint: "挖空完成后、第 3 次播放之前显示；设为 0 秒可跳过",
  },
  {
    key: "retell_recall_prep_ms",
    label: "15-19 题 RECALL_PREP",
    hint: "默读准备时间",
  },
  {
    key: "retell_q19_intro_ms",
    label: "19 题介绍",
    hint: "默读准备之后、开始录音之前；设为 0 秒可跳过",
  },
];

export function TimingPanel() {
  const timing = useSettingsStore((s) => s.config.timing);
  const updateTiming = useSettingsStore((s) => s.updateTiming);
  const restoreDefaultTiming = useSettingsStore((s) => s.restoreDefaultTiming);
  const persist = useSettingsStore((s) => s.persist);

  // 暂存编辑中的值（"秒"字符串），用户保存时才写回 store 并落库
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      TIMING_FIELDS.map((f) => [
        f.key,
        String(Math.round(timing[f.key] / 1000)),
      ])
    )
  );

  const handleChange = (key: TimingField["key"], value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleBlur = (key: TimingField["key"]) => {
    const seconds = Number(draft[key]);
    if (!Number.isFinite(seconds) || seconds < 0) return;
    updateTiming({ [key]: Math.round(seconds * 1000) } as Partial<
      typeof timing
    >);
  };

  const handleRestore = async () => {
    if (
      !(await confirm(
        "确认将所有流程时长恢复为默认值？\n当前编辑将丢失。"
      ))
    ) {
      return;
    }
    await restoreDefaultTiming();
    // 同步刷新本地 draft
    const fresh = useSettingsStore.getState().config.timing;
    setDraft(
      Object.fromEntries(
        TIMING_FIELDS.map((f) => [
          f.key,
          String(Math.round(fresh[f.key] / 1000)),
        ])
      )
    );
  };

  const handleSave = async () => {
    // 先把所有 draft 写回 store（确保最后一次输入未失焦也能保存）
    const patch: Partial<typeof timing> = {};
    for (const f of TIMING_FIELDS) {
      const seconds = Number(draft[f.key]);
      if (Number.isFinite(seconds) && seconds >= 0) {
        patch[f.key] = Math.round(seconds * 1000);
      }
    }
    updateTiming(patch);
    await persist();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">流程时长</CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleRestore}>
              <RotateCcw className="w-4 h-4 mr-1" />
              恢复默认
            </Button>
            <Button size="sm" onClick={handleSave}>
              保存时长
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          各阶段等待时长（单位：秒）。修改后点击「保存时长」生效。
          <br />
          <span className="text-xs">
            注：第 19 题录音时长固定 90 秒，由 STT/LLM 判分稳定性约束，不在此处配置。
            5 个开场介绍的文案在「开场介绍」Tab 中编辑。
          </span>
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {TIMING_FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={f.key} className="flex items-center justify-between">
                <span>{f.label}</span>
                <span className="text-xs text-muted-foreground font-mono">
                  {draft[f.key]} 秒
                </span>
              </Label>
              <Input
                id={f.key}
                type="number"
                min={0}
                max={3600}
                step={1}
                value={draft[f.key]}
                onChange={(e) => handleChange(f.key, e.target.value)}
                onBlur={() => handleBlur(f.key)}
              />
              <p className="text-xs text-muted-foreground">{f.hint}</p>
              <Separator className="mt-2" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}