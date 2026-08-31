// 测试状态：保存当前测试会话 + 生成进度

import { create } from "zustand";
import type { TestSession } from "@/types/question";
import type { ProgressPayload } from "@/lib/tauri";
import {
  generateTestSession,
  getTestSession,
  clearTestSession,
} from "@/lib/tauri";

type Stage = "idle" | "generating" | "ready" | "error";

interface TestState {
  session: TestSession | null;
  stage: Stage;
  progress: ProgressPayload | null;
  error: string | null;

  start: () => Promise<void>;
  load: () => Promise<void>;
  reset: () => Promise<void>;
  /**
   * 直接注入一个 session（v1.1+ 题库系统：从题库激活后调用，避免走 generate 路径）
   */
  setSession: (session: TestSession) => void;
  setProgress: (p: ProgressPayload) => void;
  setError: (e: string) => void;
}

export const useTestStore = create<TestState>((set, get) => ({
  session: null,
  stage: "idle",
  progress: null,
  error: null,

  start: async () => {
    console.log("[test] start: 开始生成测试会话（LLM + TTS）");
    set({ stage: "generating", error: null, progress: null });
    try {
      const session = await generateTestSession();
      console.log(
        `[test] start: 预生成完成 session_id=${session.session_id}`
      );
      set({ session, stage: "ready" });
    } catch (e) {
      console.error("[test] start: 预生成失败", e);
      set({ stage: "error", error: String(e) });
      throw e;
    }
  },

  load: async () => {
    const session = await getTestSession();
    console.log(
      `[test] load: 从后端恢复 session=${session?.session_id ?? "<none>"}`
    );
    set({
      session,
      stage: session ? "ready" : "idle",
    });
  },

  reset: async () => {
    const prev = get().session;
    console.log(
      `[test] reset: 即将清空测试会话 session_id=${prev?.session_id ?? "<none>"}`
    );
    await clearTestSession();
    set({ session: null, stage: "idle", progress: null, error: null });
    console.log("[test] reset: 前端 store 已重置（session 清空到 null）");
  },

  setSession: (session) => {
    console.log(`[test] setSession: 注入 session_id=${session.session_id}`);
    set({ session, stage: "ready", progress: null, error: null });
  },

  setProgress: (p) => set({ progress: p }),
  setError: (e) => set({ error: e, stage: "error" }),
}));

export const STAGE_LABELS: Record<ProgressPayload["stage"], string> = {
  llm_q1_4: "生成 1-4 题对话与选项",
  llm_q5_14: "生成 5-14 题长对话与独白",
  llm_q15_18: "生成 15-18 题听力材料与表格",
  tts: "合成对话与听力语音",
  done: "预生成完成",
};
