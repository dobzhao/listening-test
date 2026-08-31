// 预生成题库（Pregen Pool）前端类型，与 Rust models/pregen.rs 对齐

export type PregenStatus = "unused" | "used";

export interface PregenEntry {
  sessionId: string;
  /** ISO8601 本地时间 */
  createdAt: string;
  /** sha256 hex；当前不校验，仅记录 */
  promptsHash: string;
  /** 生成时的 effective_level：junior_high | senior_high | undergraduate */
  level: string;
  /** 生成时的 mode：auto | manual */
  mode: string;
  status: PregenStatus;
}

export interface PregenSummary {
  /** 所有难度 unused 总数 */
  unusedCount: number;
  /** 全部条目数（unused + used） */
  totalCount: number;
  /** 当前是否有 worker 在跑 */
  generatingNow: boolean;
  /** 当前生成到第几套（1-based；空闲时 0） */
  currentIndex: number;
  /** 本轮计划生成几套 */
  currentTotal: number;
  /** 最近一次生成失败的错误信息 */
  lastError: string | null;
  /**
   * 按难度档分布的 unused 数（key = level 字符串）。
   * 主菜单按钮「开始测试（X 套 · 难度：Y）」直接读 `unusedByLevel[currentLevel]`。
   */
  unusedByLevel: Record<string, number>;
}

export interface PregenProgressPayload {
  sessionId: string;
  current: number;
  total: number;
  stage: string;
  message: string;
  progress: number;
}

export interface PregenFinishedPayload {
  requested: number;
  succeeded: number;
  failed: number;
}

export interface PregenFailedPayload {
  sessionId: string;
  error: string;
}