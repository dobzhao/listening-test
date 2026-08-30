// 自适应能力值进度条（v1.1+ 视觉升级）
//
// 设计要点：
// - 整条轨道长度对应 [ability_min, ability_max] 的能力分区间（默认 0-600）
// - 轨道底色统一为白色，加 1px 边框便于在白底上识别边界
// - 档位阈值（180/220/380/420 默认值）按当前档位选择性用黑色细虚线标在轨道上方：
//   - 初中：只显示升入高中的线（upper_senior）
//   - 高中：只显示定义高中区间的两条线（lower_senior / upper_undergrad）
//   - 大学：只显示降到高中的线（lower_undergrad）
// - 当前能力值以黑色填充条展示；与「变化前」对比时，差异段着色：
//   - 得分（ability > abilityBefore）：稳定段黑色 + 增长段绿色
//   - 扣分（ability < abilityBefore）：当前段黑色 + 扣分段红色
// - 下方距离升级 / 降级提示按当前档位选择性展示：
//   - 初中：仅显示距离升入高中还差多少分
//   - 高中：同时显示距离升入大学 / 降回初中各差多少分
//   - 大学：仅显示距离降回高中还差多少分
//
// 配色策略（极简 + 对比可视化）：
// - 轨道底色：white + 边框
// - 分数填充：黑色（稳定段）+ 绿/红（得分/扣分段）
// - 升降级节点：black

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
  /** 档位文字 / 标记 */
  textClass: string;
}

const ZONE_STYLE: Record<DifficultyLevel, ZoneStyle> = {
  junior_high: {
    textClass: "text-sky-700",
  },
  senior_high: {
    textClass: "text-amber-700",
  },
  undergraduate: {
    textClass: "text-emerald-700",
  },
};

/** 得分/扣分配色（与绿色 / 红色 500 对齐） */
const COLOR_GAIN = "#22c55e"; // tailwind green-500
const COLOR_LOSS = "#ef4444"; // tailwind red-500

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

  // 分数条配色逻辑（基于 abilityBefore 对比）：
  // - 无 before（设置面板）：纯黑色填充（0 → 当前能力值）
  // - 得分（ability > abilityBefore）：黑色稳定段（0 → before）+ 绿色增长段（before → ability）
  // - 扣分（ability < abilityBefore）：黑色当前段（0 → ability）+ 红色扣分段（ability → before）
  // 用单个 div + linear-gradient 实现，避免 3px 高的条上相邻 div 拼接产生可见缝隙
  const hasBefore = abilityBefore !== undefined;
  const beforePct = hasBefore ? abilityBeforePct! : 0;
  const fillEndPct = hasBefore
    ? Math.max(abilityPct, beforePct)
    : abilityPct;
  const stableEndPct = hasBefore
    ? Math.min(abilityPct, beforePct)
    : abilityPct;
  const gained = hasBefore && ability > abilityBefore!;
  const lost = hasBefore && ability < abilityBefore!;
  const stableRatio =
    fillEndPct > 0 ? (stableEndPct / fillEndPct) * 100 : 0;
  const fillStyle: React.CSSProperties = gained
    ? {
        width: `${fillEndPct}%`,
        background: `linear-gradient(to right, #000 0%, #000 ${stableRatio}%, ${COLOR_GAIN} ${stableRatio}%, ${COLOR_GAIN} 100%)`,
      }
    : lost
    ? {
        width: `${fillEndPct}%`,
        background: `linear-gradient(to right, #000 0%, #000 ${stableRatio}%, ${COLOR_LOSS} ${stableRatio}%, ${COLOR_LOSS} 100%)`,
      }
    : {
        width: `${fillEndPct}%`,
        backgroundColor: "#000",
      };

  // 按当前档位选择性展示阈值线：
  // - 初中：只显示升入高中的线（upper_senior）
  // - 高中：只显示定义高中区间的两条线（lower_senior / upper_undergrad）
  // - 大学：只显示降到高中的线（lower_undergrad）
  const visibleThresholds = {
    lower_senior: currentLevel === "senior_high",
    upper_senior: currentLevel === "junior_high",
    lower_undergrad: currentLevel === "undergraduate",
    upper_undergrad: currentLevel === "senior_high",
  } as const;

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

      {/* 轨道（白底） */}
      <div className="relative h-3 w-full rounded-full bg-white border overflow-visible">
        {/* 分数填充：黑色稳定 + 绿色得分 / 红色扣分 */}
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all"
          style={fillStyle}
        />

        {/* 档位阈值细虚线（按当前档位选择性展示） */}
        {visibleThresholds.upper_senior && (
          <ThresholdTick position={upperSeniorPct} />
        )}
        {visibleThresholds.lower_senior && (
          <ThresholdTick position={lowerSeniorPct} />
        )}
        {visibleThresholds.upper_undergrad && (
          <ThresholdTick position={upperUndergradPct} />
        )}
        {visibleThresholds.lower_undergrad && (
          <ThresholdTick position={lowerUndergradPct} />
        )}
      </div>

      {/* 轴标尺：阈值分数（按当前档位选择性展示）+ 两端 */}
      <div className="relative h-4 mt-1.5 text-[10px] text-muted-foreground font-mono">
        <TickLabel position={0} align="start" value={params.ability_min} />
        {visibleThresholds.lower_senior && (
          <TickLabel
            position={lowerSeniorPct}
            value={thresholds.lower_senior}
            hint="↓"
          />
        )}
        {visibleThresholds.upper_senior && (
          <TickLabel
            position={upperSeniorPct}
            value={thresholds.upper_senior}
            hint="↑"
          />
        )}
        {visibleThresholds.lower_undergrad && (
          <TickLabel
            position={lowerUndergradPct}
            value={thresholds.lower_undergrad}
            hint="↓"
          />
        )}
        {visibleThresholds.upper_undergrad && (
          <TickLabel
            position={upperUndergradPct}
            value={thresholds.upper_undergrad}
            hint="↑"
          />
        )}
        <TickLabel
          position={100}
          align="end"
          value={params.ability_max}
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
      className="absolute -top-1 h-5 w-px bg-black"
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
