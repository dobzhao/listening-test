// 开场介绍文案设置：5 个 INTRO 阶段（1-4 / 5-14 / 15-18 / 15-18 第三次播放前 / 19 题前）展示的纯文字。
// 时长在「流程时长」Tab 中配置；此处只编辑文案。

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { RotateCcw } from "lucide-react";
import type { IntroKey } from "@/types/config";
import { useSettingsStore } from "@/store/settings";
import { confirm } from "@/store/confirm";

interface IntroField {
  key: IntroKey;
  label: string;
  hint: string;
}

const INTRO_FIELDS: IntroField[] = [
  {
    key: "text_1_4",
    label: "1-4 题开场介绍",
    hint: "第 1 题前显示一次（短对话听后选择）",
  },
  {
    key: "text_5_14",
    label: "5-14 题开场介绍",
    hint: "第 5 题前显示一次（长对话 + 独白听后选择）",
  },
  {
    key: "text_15_18",
    label: "15-18 题开场介绍",
    hint: "第 15 题 PREPARE 之前显示（听后转述填空）",
  },
  {
    key: "text_15_18_play3",
    label: "15-18 题第三次播放前介绍",
    hint: "挖空填写完成后、第 3 次播放之前显示",
  },
  {
    key: "text_19",
    label: "19 题介绍",
    hint: "默读准备之后、自动开始录音之前显示",
  },
];

export function IntroPanel() {
  const intro = useSettingsStore((s) => s.config.intro);
  const timing = useSettingsStore((s) => s.config.timing);
  const updateIntro = useSettingsStore((s) => s.updateIntro);
  const restoreOneIntro = useSettingsStore((s) => s.restoreOneIntro);
  const restoreDefaultIntro = useSettingsStore((s) => s.restoreDefaultIntro);

  // 各段介绍对应的时长字段（只读展示，方便用户对照文案长度调时长）
  const durationSeconds: Record<IntroKey, number> = {
    text_1_4: Math.round(timing.intro_ms / 1000),
    text_5_14: Math.round(timing.group_intro_ms / 1000),
    text_15_18: Math.round(timing.retell_intro_ms / 1000),
    text_15_18_play3: Math.round(timing.retell_play3_intro_ms / 1000),
    text_19: Math.round(timing.retell_q19_intro_ms / 1000),
  };

  const handleRestoreOne = async (field: IntroField) => {
    if (
      !(await confirm(
        `确认将「${field.label}」恢复为默认文案？\n当前编辑内容将丢失。`
      ))
    ) {
      return;
    }
    await restoreOneIntro(field.key);
  };

  const handleRestoreAll = async () => {
    if (
      !(await confirm("确认将全部 5 段开场介绍恢复为默认文案？\n当前编辑将丢失。"))
    ) {
      return;
    }
    await restoreDefaultIntro();
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">开场介绍</CardTitle>
          <Button variant="ghost" size="sm" onClick={handleRestoreAll}>
            <RotateCcw className="w-4 h-4 mr-1" />
            全部恢复默认
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          测试流程中 5 个介绍环节展示的文字（纯文字 + 倒计时，不朗读语音）。
          <br />
          <span className="text-xs">
            各段显示时长在「流程时长」Tab 中配置；把时长设为 0
            秒即可跳过对应介绍。修改后请点击右上角「保存配置」。
          </span>
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        {INTRO_FIELDS.map((f, idx) => (
          <div key={f.key} className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor={f.key}>{f.label}</Label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-mono">
                  {durationSeconds[f.key]} 秒
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRestoreOne(f)}
                >
                  <RotateCcw className="w-3.5 h-3.5 mr-1" />
                  恢复默认
                </Button>
              </div>
            </div>
            <Textarea
              id={f.key}
              value={intro[f.key]}
              onChange={(e) => updateIntro(f.key, e.target.value)}
              rows={3}
              className="text-sm leading-relaxed"
              placeholder="留空则跳过该介绍环节"
            />
            <p className="text-xs text-muted-foreground">{f.hint}</p>
            {idx < INTRO_FIELDS.length - 1 && <Separator className="mt-3" />}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
