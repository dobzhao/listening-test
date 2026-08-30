// 自适应能力值进度条（v1.1+ 视觉升级）
//
// 设计要点：
// - 整条轨道长度对应 [ability_min, ability_max] 的能力分区间（默认 0-600）
// - 三档难度区段以半透明背景色铺底，重叠部分（hysteresis buffer）自然形成
//   「两个相邻档位都能站稳」的视觉缓冲
// - 四个档位阈值（180/220/380/420 默认值）用细虚线标在轨道上方
// - 当前能力值以粗实线 + 数字标签高亮；可选显示「变化前」位置（淡色细线）用于结算页
// - 下方提示文字按当前档位选择性展示：
//   - 初中：仅显示距离升入高中还差多少分
//   - 高中：同时显示距离升入大学 / 降回初中各差多少分
//   - 大学：仅显示距离降回高中还差多少分
//
// 配色策略（与 DifficultyPanel / Result 页中已有的 emerald/rose 语义一致）：
// - 初中：sky    （冷色，入门）
// - 高中：amber  （中性，过渡）
// - 大学：emerald（暖色，进阶）
// - 升级提示：emerald（绿色积极）
// - 降级提示：rose（红色警示）

import { useMemo } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  DIFFICULTY_LEVEL_LABELS,
  type AdaptiveParams,
  type DifficultyLevel,
} from "@/types/config";
import {
  computeDistances,
  getThresholds,
  type LevelDistance,
} from "@/lib/adaptiveThresholds";

export interface AbilityProgressBarProps {
  /** 当前能力值（必填） */
  ability: number;
  /** 当前档位 */
  currentLevel: DifficultyLevel;
  /** 15 个算法参数；用于计算阈值与缩放 */
  params: AdaptiveParams;
  /** 可选：调整前能力值；传入时在轨道上额外画一条淡色 marker，用于结算页 */
  abilityBefore?: number;
  className?: string;
}

interface ZoneStyle {
  /** 背景填充色 */
  bgClass: string;
  /** 档位文字 / 标记 */
  textClass: string;
  /** 当前档位时填充条颜色 */
  fillClass: string;
}

const ZONE_STYLE: Record<DifficultyLevel, ZoneStyle> = {
  junior_high: {
    bgClass: "bg-sky-200/60",
    textClass: "text-sky-700",
    fillClass: "bg-sky-500",
  },
  senior_high: {
    bgClass: "bg-amber-200/60",
    textClass: "text-amber-700",
    fillClass: "bg-amber-500",
  },
  undergraduate: {
    bgClass: "bg-emerald-200/60",
    textClass: "text-emerald-700",
    fillClass: "bg-emerald-500",
  },
};

export function AbilityProgressBar({
  ability,
  currentLevel,
  params,
  abilityBefore,
  className,
}: AbilityProgressBarProps) {
  const range = params.ability_max - params.ability_min;
  const toPct = (v: number) =>
    Math.max(0, Math.min(100, ((v - params.ability_min) / range) * 100));

  const thresholds = useMemo(() => getThresholds(params), [params]);
  const distances = useMemo(
    () => computeDistances(currentLevel, ability, params),
    [currentLevel, ability, params],
  );

  const lowerSeniorPct = toPct(thresholds.lower_senior);
  const upperSeniorPct = toPct(thresholds.upper_senior);
  const lowerUndergradPct = toPct(thresholds.lower_undergrad);
  const upperUndergradPct = toPct(thresholds.upper_undergrad);
  const abilityPct = toPct(ability);
  const abilityBeforePct =
    abilityBefore !== undefined ? toPct(abilityBefore) : null;

  const activeStyle = ZONE_STYLE[currentLevel];

  return (
    <div className={className}>
      {/* 顶部：能力值数字 + 档位名 */}
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">能力值</span>
          <span className={`text-xs ${activeStyle.textClass}`}>
            （当前：{DIFFICULTY_LEVEL_LABELS[currentLevel]}）
          </span>
        </div>
        <div className="font-mono">
          <span className="text-lg font-semibold">{ability.toFixed(1)}</span>
          <span className="text-xs text-muted-foreground ml-1">
            / {params.ability_max}
          </span>
        </div>
      </div>

      {/* 轨道 */}
      <div className="relative h-3 w-full rounded-full bg-muted overflow-visible">
        {/* 三档区段背景（叠加形成 buffer） */}
        <div
          className={`absolute inset-y-0 left-0 rounded-l-full ${ZONE_STYLE.junior_high.bgClass}`}
          style={{ width: `${upperSeniorPct}%` }}
        />
        <div
          className={`absolute inset-y-0 ${ZONE_STYLE.senior_high.bgClass}`}
          style={{
            left: `${lowerSeniorPct}%`,
            width: `${upperUndergradPct - lowerSeniorPct}%`,
          }}
        />
        <div
          className={`absolute inset-y-0 right-0 rounded-r-full ${ZONE_STYLE.undergraduate.bgClass}`}
          style={{ width: `${100 - lowerUndergradPct}%` }}
        />

        {/* 当前能力值填充 */}
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-all ${activeStyle.fillClass}`}
          style={{ width: `${abilityPct}%` }}
        />

        {/* 四个档位阈值细虚线 */}
        <ThresholdTick position={upperSeniorPct} />
        <ThresholdTick position={lowerSeniorPct} />
        <ThresholdTick position={upperUndergradPct} />
        <ThresholdTick position={lowerUndergradPct} />

        {/* 「调整前」marker（淡色） */}
        {abilityBeforePct !== null && abilityBefore !== undefined && (
          <div
            className="absolute -top-1.5 h-6 w-px bg-slate-400"
            style={{ left: `${abilityBeforePct}%` }}
            aria-label={`调整前能力值 ${abilityBefore.toFixed(1)}`}
          />
        )}

        {/* 「当前」marker（粗实线 + 顶部小三角） */}
        <div
          className="absolute -top-2 h-7 w-0.5 bg-slate-900"
          style={{ left: `${abilityPct}%`, transform: "translateX(-1px)" }}
          aria-label={`当前能力值 ${ability.toFixed(1)}`}
        >
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-slate-900" />
        </div>
      </div>

      {/* 轴标尺：四个阈值 + 两端 */}
      <div className="relative h-4 mt-1.5 text-[10px] text-muted-foreground font-mono">
        <TickLabel position={0} align="start" value={params.ability_min} />
        <TickLabel
          position={lowerSeniorPct}
          value={thresholds.lower_senior}
          hint="↓"
        />
        <TickLabel
          position={upperSeniorPct}
          value={thresholds.upper_senior}
          hint="↑"
        />
        <TickLabel
          position={lowerUndergradPct}
          value={thresholds.lower_undergrad}
          hint="↓"
        />
        <TickLabel
          position={upperUndergradPct}
          value={thresholds.upper_undergrad}
          hint="↑"
        />
        <TickLabel
          position={100}
          align="end"
          value={params.ability_max}
        />
      </div>

      {/* 三档图例 */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mt-1 text-[10px] text-muted-foreground">
        <LegendDot
          colorClass={ZONE_STYLE.junior_high.fillClass}
          label={`初中 ≤ ${thresholds.upper_senior.toFixed(0)}`}
        />
        <LegendDot
          colorClass={ZONE_STYLE.senior_high.fillClass}
          label={`高中 ${thresholds.lower_senior.toFixed(0)}–${thresholds.upper_undergrad.toFixed(0)}`}
        />
        <LegendDot
          colorClass={ZONE_STYLE.undergraduate.fillClass}
          label={`大学 ≥ ${thresholds.lower_undergrad.toFixed(0)}`}
        />
      </div>

      {/* 距离升级 / 降级提示 */}
      {(distances.upgrade || distances.downgrade) && (
        <div className="mt-3 space-y-1.5">
          {distances.upgrade && (
            <DistanceHint direction="up" distance={distances.upgrade} />
          )}
          {distances.downgrade && (
            <DistanceHint direction="down" distance={distances.downgrade} />
          )}
        </div>
      )}
    </div>
  );
}

// ===== 子组件 =====

function ThresholdTick({ position }: { position: number }) {
  return (
    <div
      className="absolute -top-1 h-5 w-px bg-slate-500/70"
      style={{ left: `${position}%` }}
      aria-hidden
    />
  );
}

function TickLabel({
  position,
  value,
  hint,
  align,
}: {
  position: number;
  value: number;
  hint?: string;
  align?: "start" | "end";
}) {
  // 默认居中对齐，避免与相邻 tick 重叠
  const style: React.CSSProperties =
    align === "start"
      ? { left: 0 }
      : align === "end"
      ? { right: 0 }
      : { left: `${position}%`, transform: "translateX(-50%)" };

  return (
    <span
      className="absolute whitespace-nowrap"
      style={style}
      title={`${value.toFixed(0)} 分${hint ? `（${hint}）` : ""}`}
    >
      {value.toFixed(0)}
      {hint && <span className="ml-0.5 opacity-60">{hint}</span>}
    </span>
  );
}

function LegendDot({ colorClass, label }: { colorClass: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${colorClass}`} />
      {label}
    </span>
  );
}

function DistanceHint({
  direction,
  distance,
}: {
  direction: "up" | "down";
  distance: LevelDistance;
}) {
  const reached = distance.points <= 0.05;
  const isUp = direction === "up";
  const Icon = isUp ? ArrowUp : ArrowDown;
  const accentClass = reached
    ? "text-slate-500"
    : isUp
    ? "text-emerald-700"
    : "text-rose-700";
  const verb = isUp ? "升入" : "降回";

  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon className={`w-4 h-4 shrink-0 ${accentClass}`} />
      <span className="text-muted-foreground">
        距离{verb}「
        <span className="text-foreground font-medium">
          {DIFFICULTY_LEVEL_LABELS[distance.nextLevel]}
        </span>
        」还差
        <span className={`font-mono font-semibold ml-1 ${accentClass}`}>
          {Math.max(0, distance.points).toFixed(1)}
        </span>
        分
        {hintSuffix(distance.threshold, direction)}
        {reached && (
          <span className="ml-2 text-xs text-muted-foreground">
            （已达阈值，下次评分将切换）
          </span>
        )}
      </span>
    </div>
  );
}

/** 在分数后面补充一句小字「（能力值需达到 / 低于 X）」，让数字更有上下文 */
function hintSuffix(threshold: number, direction: "up" | "down"): React.ReactNode {
  return (
    <span className="ml-1 text-xs text-muted-foreground">
      （能力值{direction === "up" ? `需 > ${threshold.toFixed(0)}` : `需 ≤ ${threshold.toFixed(0)}`}）
    </span>
  );
}
