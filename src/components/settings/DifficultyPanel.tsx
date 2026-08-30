// 题目难度设置：当前激活档下拉框 + 三档文字编辑（每档独立编辑，独立恢复默认）
//
// 顶层 Card 放激活档下拉框；下方三个 Card 分别对应三档难度（始终全部展示，
// 便于跨档对照）。每段文字旁有「恢复默认」按钮，每档标题旁有「恢复整档」按钮。
// 文本编辑直接绑 store，与 PromptEditor 行为一致。
//
// v1.1+ 在顶部追加自适应控制区：
//   1. 固定只读卡片：ability_score / trend / update_count / current_level
//   2. 「自动切换难度」Switch：on/off 调 useAdaptiveStore.setMode()
//   3. 「重置自适应状态」按钮：仅 mode=Auto 可见，二次确认
//   4. 可折叠「自适应参数」子区域：15 个数字输入框 + 「恢复默认」按钮

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import {
  defaultAdaptiveParams,
  DIFFICULTY_DEMAND_KEYS,
  DIFFICULTY_DEMAND_LABELS,
  DIFFICULTY_LEVELS,
  DIFFICULTY_LEVEL_LABELS,
  type AdaptiveParams,
  type DifficultyDemandKey,
  type DifficultyLevel,
} from "@/types/config";
import { useSettingsStore } from "@/store/settings";
import { useAdaptiveStore } from "@/store/adaptive";
import { confirm } from "@/store/confirm";
import { toast } from "@/store/toast";
import { AbilityProgressBar } from "@/components/AbilityProgressBar";

const SELECT_CLASS =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60";

/** 15 个算法参数的中文 label，便于 DifficultyPanel 折叠区域展示 */
const ADAPTIVE_PARAMS_META: Array<{ key: keyof AdaptiveParams; label: string }> = [
  { key: "weight_a", label: "权重 a（1-14 题）" },
  { key: "weight_b", label: "权重 b（15-18 题）" },
  { key: "weight_c", label: "权重 c（19 题）" },
  { key: "score_floor", label: "得分下限（combined < 此值按未达标）" },
  { key: "alpha", label: "EMA 系数 α" },
  { key: "base_magnitude", label: "基础调整幅度" },
  { key: "k", label: "趋势幅度乘子 k" },
  { key: "max_magnitude", label: "调整幅度上限" },
  { key: "b1", label: "档位阈值 b1（初中↔高中）" },
  { key: "b2", label: "档位阈值 b2（高中↔大学）" },
  { key: "buffer", label: "滞回缓冲" },
  { key: "ability_min", label: "能力分下限" },
  { key: "ability_max", label: "能力分上限" },
  { key: "trend_min", label: "趋势下限" },
  { key: "trend_max", label: "趋势上限" },
];

export function DifficultyPanel() {
  const difficulty = useSettingsStore((s) => s.config.difficulty);
  const setDifficultyLevel = useSettingsStore((s) => s.setDifficultyLevel);
  const updateDifficultyDemand = useSettingsStore((s) => s.updateDifficultyDemand);
  const restoreOneDifficultyDemand = useSettingsStore(
    (s) => s.restoreOneDifficultyDemand
  );
  const restoreOneDifficultyLevel = useSettingsStore(
    (s) => s.restoreOneDifficultyLevel
  );

  const adaptiveMode = useAdaptiveStore((s) => s.mode);
  const adaptiveState = useAdaptiveStore();
  const setMode = useAdaptiveStore((s) => s.setMode);
  const resetAdaptive = useAdaptiveStore((s) => s.reset);
  const params = useAdaptiveStore((s) => s.params);
  const updateParams = useAdaptiveStore((s) => s.updateParams);

  const [paramsOpen, setParamsOpen] = useState(false);

  // 用户在切换到自动档前选的「起始档」；仅在 manual 状态下展示与使用
  const manualLevel = difficulty.level;
  const [pendingInitialLevel, setPendingInitialLevel] = useState<DifficultyLevel>(manualLevel);

  // 当用户在手动档 dropdown 改了档位、或从 auto 切回 manual 时，同步跟随更新起始档默认；
  // 用户也可在「起始档」radio 里手动覆盖（覆盖后不再被 manualLevel 跟随）。
  useEffect(() => {
    setPendingInitialLevel(manualLevel);
  }, [manualLevel, adaptiveMode]);

  const handleSwitchChange = async (next: boolean) => {
    if (next === (adaptiveMode === "auto")) return;
    if (next) {
      // manual → auto：先二次确认，让用户选择起始档，再调用
      const ok = await confirm(
        "切换到自动档后，下一次评分将根据您的得分率自动调整难度档位。\n请先选择起始档（程序会把能力分重置为该档的初始分，并保留累计更新次数）。"
      );
      if (!ok) return;
      await setMode(true, pendingInitialLevel);
      toast(`已切换到自动档，从 ${DIFFICULTY_LEVEL_LABELS[pendingInitialLevel]} 开始`, {
        kind: "info",
      });
    } else {
      // auto → manual：先二次确认，再调用（后端会自动硬重置并弹 toast）
      // 后端会把 ability / trend / current_level / update_count 全部清零。
      const ok = await confirm(
        "关闭自动档将把自适应变量全部清零：能力分回到当前手动档对应的初始分，趋势归零，累计更新次数也会清零。\n继续？"
      );
      if (!ok) return;
      await setMode(false);
    }
  };

  const handleRestoreDemand = async (level: DifficultyLevel, key: DifficultyDemandKey) => {
    if (
      !(await confirm(
        `确认将「${DIFFICULTY_LEVEL_LABELS[level]} / ${DIFFICULTY_DEMAND_LABELS[key]}」恢复为默认文字？\n当前编辑内容将丢失。`
      ))
    ) {
      return;
    }
    await restoreOneDifficultyDemand(level, key);
  };

  const handleRestoreLevel = async (level: DifficultyLevel) => {
    if (
      !(await confirm(
        `确认将「${DIFFICULTY_LEVEL_LABELS[level]}」整档恢复为默认文字？\n该档 3 段文字均会还原，当前编辑内容将丢失。`
      ))
    ) {
      return;
    }
    await restoreOneDifficultyLevel(level);
  };

  const handleReset = async () => {
    if (
      !(await confirm(
        "确认重置自适应状态？\n将把能力分重置为 100、趋势归零、档位回到初中。\n累计更新次数也会归零。"
      ))
    ) {
      return;
    }
    await resetAdaptive();
  };

  const handleParamsReset = async () => {
    if (
      !(await confirm(
        "确认恢复所有 15 个算法参数为默认值？\n当前编辑内容将丢失。"
      ))
    ) {
      return;
    }
    await updateParams(defaultAdaptiveParams());
  };

  return (
    <div className="space-y-4">
      {/* ===== v1.1+ 自适应区 ===== */}

      {/* 1. 自适应状态固定只读卡片：进度条 + 趋势/更新次数 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">自适应状态</CardTitle>
          <CardDescription>
            每次 19 题评分后自动更新（仅在「自动切换难度」开启时实际生效）
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <AbilityProgressBar
            ability={adaptiveState.abilityScore}
            currentLevel={adaptiveState.currentLevel}
            params={params}
          />
          <div className="grid grid-cols-2 gap-4 text-sm pt-2 border-t">
            <SummaryCell
              label="趋势"
              value={adaptiveState.trend.toFixed(2)}
            />
            <SummaryCell
              label="更新次数"
              value={String(adaptiveState.updateCount)}
            />
          </div>
        </CardContent>
      </Card>

      {/* 2. 「自动切换难度」Switch */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">自适应模式</CardTitle>
          <CardDescription>
            开启后系统根据每次 19 题的得分率自动调整下次测试的难度档位；关闭时使用下方手动选档。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="adaptive-mode" className="text-sm font-medium">
                自动切换难度
              </Label>
              <p className="text-xs text-muted-foreground">
                开启后手动档下拉框被禁用；关闭后立即重置自适应变量。
              </p>
            </div>
            <button
              id="adaptive-mode"
              type="button"
              role="switch"
              aria-checked={adaptiveMode === "auto"}
              data-state={adaptiveMode === "auto" ? "checked" : "unchecked"}
              onClick={() => handleSwitchChange(adaptiveMode !== "auto")}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                adaptiveMode === "auto" ? "bg-primary" : "bg-input"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
                  adaptiveMode === "auto" ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>

          {/* 起始档选择器：仅手动档下展示，让用户先选好起始档再切到自动档 */}
          {adaptiveMode === "manual" && (
            <div className="rounded-md border border-dashed p-3 space-y-2">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">起始档（切到自动档时生效）</Label>
                <p className="text-xs text-muted-foreground">
                  开启自动档时，会把自适应能力分重置为该档的初始分（100 / 300 / 500），
                  并保留累计更新次数。默认跟随「手动档位」。
                </p>
              </div>
              <div className="flex flex-wrap gap-3 pt-1">
                {DIFFICULTY_LEVELS.map((lv) => (
                  <label
                    key={lv}
                    className="flex items-center gap-2 cursor-pointer text-sm"
                  >
                    <input
                      type="radio"
                      name="adaptive-initial-level"
                      value={lv}
                      checked={pendingInitialLevel === lv}
                      onChange={() => setPendingInitialLevel(lv)}
                      className="accent-primary"
                    />
                    <span>{DIFFICULTY_LEVEL_LABELS[lv]}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* 3. 「重置自适应状态」按钮：仅 mode=Auto 时可见 */}
          {adaptiveMode === "auto" && (
            <div className="flex items-center justify-between rounded-md border border-dashed p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">重置自适应状态</p>
                <p className="text-xs text-muted-foreground">
                  把能力分重置为该档位默认、趋势归零、更新次数也会归零。
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleReset}>
                <RotateCcw className="w-4 h-4 mr-1" />
                重置
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 4. 可折叠「自适应参数」子区域 */}
      <Card>
        <CardHeader>
          <button
            type="button"
            className="flex items-center justify-between w-full text-left"
            onClick={() => setParamsOpen((v) => !v)}
          >
            <CardTitle className="text-lg flex items-center gap-2">
              {paramsOpen ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              自适应参数（高级）
            </CardTitle>
            <span className="text-xs text-muted-foreground">
              {paramsOpen ? "收起" : "展开"}
            </span>
          </button>
          <CardDescription>
            15 个算法参数，调整后下一次评分生效（不影响已落盘的 adaptive_state.json）
          </CardDescription>
        </CardHeader>
        {paramsOpen && (
          <CardContent className="space-y-4">
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleParamsReset}
              >
                <RotateCcw className="w-4 h-4 mr-1" />
                恢复默认
              </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {ADAPTIVE_PARAMS_META.map(({ key, label }) => (
                <div key={key} className="space-y-1">
                  <Label htmlFor={`param-${key}`} className="text-xs">
                    {label} ({key})
                  </Label>
                  <Input
                    id={`param-${key}`}
                    type="number"
                    step="any"
                    value={params[key]}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isFinite(v)) return;
                      updateParams({ ...params, [key]: v });
                    }}
                    className="font-mono text-sm"
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              保存方式：任意输入框失焦后自动调 <code>update_adaptive_params</code> 命令落盘。
            </p>
          </CardContent>
        )}
      </Card>

      {/* ===== v1.0 手动档 + 三档文字 ===== */}

      {/* 顶部：当前激活档下拉框 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">手动档位</CardTitle>
          <p className="text-sm text-muted-foreground">
            选择手动激活档。「自动切换难度」开启时此下拉框被禁用，仅展示只读读数；
            出题 prompt 中的{" "}
            <code className="px-1.5 py-0.5 rounded bg-muted font-mono text-xs">
              {"{{DIFFICULTY_DEMAND_*}}"}
            </code>{" "}
            占位符按实际生效档（mode=Auto → 自适应档 / mode=Manual → 本档）取值。
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="difficulty-level">难度档位</Label>
          {adaptiveMode === "auto" ? (
            <>
              <select
                id="difficulty-level"
                className={SELECT_CLASS}
                value={difficulty.level}
                disabled
                aria-label="当前档位（自动档下只读）"
              >
                <option value="">已启用自动档</option>
                {DIFFICULTY_LEVELS.map((lv) => (
                  <option key={lv} value={lv}>
                    {DIFFICULTY_LEVEL_LABELS[lv]}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                已启用自动档 · 当前档位随自适应能力自动调整；下方三档文字仍按手动档展示。
              </p>
            </>
          ) : (
            <select
              id="difficulty-level"
              className={SELECT_CLASS}
              value={difficulty.level}
              onChange={(e) => setDifficultyLevel(e.target.value as DifficultyLevel)}
            >
              {DIFFICULTY_LEVELS.map((lv) => (
                <option key={lv} value={lv}>
                  {DIFFICULTY_LEVEL_LABELS[lv]}
                </option>
              ))}
            </select>
          )}
        </CardContent>
      </Card>

      {/* 三档文字编辑 */}
      {DIFFICULTY_LEVELS.map((lv) => (
        <Card key={lv}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">
                {DIFFICULTY_LEVEL_LABELS[lv]}
                {difficulty.level === lv && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    （手动激活）
                  </span>
                )}
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => handleRestoreLevel(lv)}>
                <RotateCcw className="w-4 h-4 mr-1" />
                恢复整档
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {DIFFICULTY_DEMAND_KEYS.map((k, idx) => (
              <div key={k} className="space-y-1">
                {idx > 0 && <Separator className="my-3" />}
                <div className="flex items-center justify-between">
                  <Label htmlFor={`${lv}-${k}`}>{DIFFICULTY_DEMAND_LABELS[k]}</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRestoreDemand(lv, k)}
                  >
                    <RotateCcw className="w-3 h-3 mr-1" />
                    恢复默认
                  </Button>
                </div>
                <Textarea
                  id={`${lv}-${k}`}
                  value={difficulty[lv][k]}
                  onChange={(e) => updateDifficultyDemand(lv, k, e.target.value)}
                  rows={Math.min(6, Math.max(2, Math.ceil(difficulty[lv][k].length / 60)))}
                  className="font-mono text-xs leading-relaxed"
                />
                <p className="text-xs text-muted-foreground">
                  占位符：{" "}
                  <code className="px-1 py-0.5 rounded bg-muted font-mono text-[10px]">
                    {`{{DIFFICULTY_DEMAND_${k.replace(/^demand_/, "").toUpperCase()}}}`}
                  </code>
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardContent className="py-4 text-xs text-muted-foreground">
          修改难度档位或文字后请点击右上角「保存配置」按钮。
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-mono font-medium text-base">{value}</p>
    </div>
  );
}