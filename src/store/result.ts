// 结算页状态

import { create } from "zustand";
import type { TestResult } from "@/types/result";
import { scoreFullTest } from "@/lib/tauri";

interface ResultState {
  result: TestResult | null;
  loading: boolean;
  error: string | null;
  /**
   * 当前评分是否由「重新测试」触发（v1.1+）：
   * - true 时传给后端的 `score_full_test(isRetest=true)` 跳过自适应更新，
   *   返回的 `TestResult.is_retest = true`、`adaptive = null`
   * - 由 `Result.tsx::handleRetest` 在 navigate 之前调 `setIsRetest(true)` 标记
   * - **不在 `reset()` 中清零**：retest 流程需要该 flag 跨越 reset 保留到
   *   下一次 Result 页挂载时 `load()` 读取；由 `handleBackToMenu` 显式
   *   调 `setIsRetest(false)` 清掉（避免下次从 MainMenu 开始新测试时残留）。
   */
  isRetest: boolean;

  load: () => Promise<void>;
  reset: () => void;
  setIsRetest: (b: boolean) => void;
}

/**
 * 进行中的评分 Promise：用来在并发调用时复用同一次后端请求。
 *
 * 背景：Result.tsx 的 useEffect 在 React 18 StrictMode 下会在同一次挂载中
 * 执行两次（mount → fake unmount → re-mount）。两次 effect 都会读到的
 * `loading=false`（组件闭包里的旧值），guard 都会通过，从而触发两次
 * `score_full_test`，导致 LLM 被并发调用两次（15-18 + 19 各自重复一次）。
 *
 * 用模块级 Promise 跟踪在飞请求，让第二次及以后的调用直接复用同一 Promise，
 * 不再发出新的后端命令。
 */
let loadInFlight: Promise<void> | null = null;

export const useResultStore = create<ResultState>((set, get) => ({
  result: null,
  loading: false,
  error: null,
  isRetest: false,

  load: async () => {
    // 并发互斥：如果已经在跑，直接返回同一 Promise
    if (loadInFlight) {
      console.log("[result] load: 已有在飞评分请求，复用同一 Promise");
      return loadInFlight;
    }
    const isRetest = get().isRetest;
    console.log(`[result] load: 发起 score_full_test 后端命令 is_retest=${isRetest}`);
    set({ loading: true, error: null });
    loadInFlight = (async () => {
      try {
        const r = await scoreFullTest(isRetest);
        set({ result: r, loading: false });
        console.log(
          `[result] load: 评分完成 总分=${r.total_score}/${r.max_score} is_retest=${r.is_retest}`
        );
      } catch (e) {
        const msg = String(e);
        console.error("[result] load: 评分失败", msg);
        set({ error: msg, loading: false });
      } finally {
        loadInFlight = null;
      }
    })();
    return loadInFlight;
  },

  reset: () => {
    // 重置时丢弃在飞请求的引用，避免重置后残留状态导致下次 load 被错误复用。
    // 注意：此处**不**清 `isRetest`，否则 `handleRetest` 中
    //   setIsRetest(true) → resetResult() → setIsRetest(false)
    // 会让 retest flag 在导航前就被清零，导致下次 Result 页 load() 时
    // scoreFullTest 收到 isRetest=false，后端继续更新能力值。
    // 真正的清理时机在 Result.tsx::handleBackToMenu（返回主菜单时）。
    const prev = useResultStore.getState().result;
    console.log(
      `[result] reset: 清空 result 前总分=${prev?.total_score ?? "<none>"}`
    );
    loadInFlight = null;
    set({ result: null, loading: false, error: null });
  },

  setIsRetest: (b) => set({ isRetest: b }),
}));