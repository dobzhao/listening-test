// 测试结果数据结构，与 Rust models/result.rs 保持一致

import type { DifficultyLevel } from "@/types/config";

export interface McqResult {
  question_id: number;
  user_answer: "A" | "B" | "C" | null;
  correct_answer: "A" | "B" | "C";
  is_correct: boolean;
}

export interface BlankResult {
  blank_id: "15" | "16" | "17" | "18";
  user_answer: string;
  correct_answer: string;
  is_correct: boolean;
  score: number;
}

export interface RetellResult {
  score: number;
  max_score: number;
  comment: string;
  stt_text: string;
}

/**
 * 自适应难度调整摘要（v1.1+）。
 * `is_retest = true` 时 `TestResult.adaptive` 为 `null`，前端不渲染此卡片。
 */
export interface AdaptiveSummary {
  ability_before: number;
  ability_after: number;
  trend_before: number;
  trend_after: number;
  update_count_before: number;
  update_count_after: number;
  level_before: DifficultyLevel;
  level_after: DifficultyLevel;
  /** `adaptive_difficulty::UpdateTrace` 序列化结果，前端只读展示 */
  trace: Record<string, unknown>;
}

export interface TestResult {
  session_id: string;
  mcq_results: McqResult[];
  blank_results: BlankResult[];
  retell_result: RetellResult | null;
  blank_total_score: number;
  total_score: number;
  max_score: number;
  dialogue_texts: Record<string, string>;
  /** 自适应难度调整摘要；`is_retest=true` 时为 `null` */
  adaptive: AdaptiveSummary | null;
  /** 当前评分是否为「重新测试」触发的 */
  is_retest: boolean;
}
