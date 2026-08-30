// 自适应难度的档位阈值与「距离升级/降级」换算工具
//
// 阈值定义（来自 adaptive_difficulty crate 的 hysteresis.rs）：
// - promotion（升级）：ability > b1 + buffer（初中→高中）/ ability > b2 + buffer（高中→大学）
// - demotion（降级）：ability <= b1 - buffer（高中→初中）/ ability <= b2 - buffer（大学→高中）
//
// 重置后的能力分（level.rs::initial_ability）：
// - 初中：100；高中：300；大学：500
//
// 能力分范围：ability_min (默认 0) ~ ability_max (默认 600)

import type { AdaptiveParams, DifficultyLevel } from "@/types/config";

export interface AdaptiveThresholds {
  /** 高中下限：低于此值从高中降回初中 */
  lower_senior: number;
  /** 高中上限：高于此值从初中升入高中 */
  upper_senior: number;
  /** 大学下限：低于此值从大学降回高中 */
  lower_undergrad: number;
  /** 大学上限：高于此值从高中升入大学 */
  upper_undergrad: number;
}

export function getThresholds(params: AdaptiveParams): AdaptiveThresholds {
  return {
    lower_senior: params.b1 - params.buffer,
    upper_senior: params.b1 + params.buffer,
    lower_undergrad: params.b2 - params.buffer,
    upper_undergrad: params.b2 + params.buffer,
  };
}

export interface LevelDistance {
  nextLevel: DifficultyLevel;
  /** 距离触发下一次档位变化所需的能力分变化量（绝对值，已 clamp 到 [0, +∞)） */
  points: number;
  /** 触发档位变化的能力分阈值 */
  threshold: number;
}

export interface LevelDistances {
  upgrade: LevelDistance | null;
  downgrade: LevelDistance | null;
}

/**
 * 计算「距离升级 / 距离降级」所需的能力分。
 *
 * 规则（与 §4.4.8 / hysteresis.rs 完全一致）：
 * - 初中 → 仅升级（升入高中）
 * - 高中 → 同时显示升级（大学）与降级（初中）
 * - 大学 → 仅降级（回到高中）
 */
export function computeDistances(
  level: DifficultyLevel,
  ability: number,
  params: AdaptiveParams,
): LevelDistances {
  const { b1, b2, buffer } = params;
  const upgradeThreshold = level === "junior_high" ? b1 + buffer : b2 + buffer;
  const downgradeThreshold = level === "undergraduate" ? b2 - buffer : b1 - buffer;

  if (level === "junior_high") {
    return {
      upgrade: {
        nextLevel: "senior_high",
        points: Math.max(0, upgradeThreshold - ability),
        threshold: upgradeThreshold,
      },
      downgrade: null,
    };
  }
  if (level === "undergraduate") {
    return {
      upgrade: null,
      downgrade: {
        nextLevel: "senior_high",
        points: Math.max(0, ability - downgradeThreshold),
        threshold: downgradeThreshold,
      },
    };
  }
  // senior_high：升级到大学、降级到初中都展示
  return {
    upgrade: {
      nextLevel: "undergraduate",
      points: Math.max(0, upgradeThreshold - ability),
      threshold: upgradeThreshold,
    },
    downgrade: {
      nextLevel: "junior_high",
      points: Math.max(0, ability - downgradeThreshold),
      threshold: downgradeThreshold,
    },
  };
}
