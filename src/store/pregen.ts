// 预生成题库（Pregen Pool）前端 zustand store

import { create } from "zustand";
import {
  cancelPregen,
  enqueuePregen,
  getPregenSummary,
} from "@/lib/tauri";
import type {
  PregenFailedPayload,
  PregenFinishedPayload,
  PregenProgressPayload,
  PregenSummary,
} from "@/types/pregen";

interface PregenState {
  summary: PregenSummary | null;
  progress: PregenProgressPayload | null;
  error: string | null;
  loaded: boolean;

  loadSummary: () => Promise<void>;
  enqueue: (count: number) => Promise<void>;
  cancel: () => Promise<void>;
  setProgress: (p: PregenProgressPayload) => void;
  setFinished: (f: PregenFinishedPayload) => void;
  setFailed: (f: PregenFailedPayload) => void;
  reset: () => void;
}

export const usePregenStore = create<PregenState>((set, get) => ({
  summary: null,
  progress: null,
  error: null,
  loaded: false,

  loadSummary: async () => {
    try {
      const s = await getPregenSummary();
      set({ summary: s, loaded: true });
    } catch (e) {
      console.error("[pregen] loadSummary 失败", e);
      set({ loaded: true });
    }
  },

  enqueue: async (count) => {
    set({ error: null });
    try {
      await enqueuePregen(count);
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
    // 立刻刷新一次摘要，让 UI 看到 generatingNow=true
    void get().loadSummary();
  },

  cancel: async () => {
    try {
      await cancelPregen();
    } catch (e) {
      console.error("[pregen] cancel 失败", e);
    }
  },

  setProgress: (p) => set({ progress: p }),
  setFinished: () => {
    set({ progress: null });
    void get().loadSummary();
  },
  setFailed: (f) => set({ error: f.error }),
  reset: () => set({ summary: null, progress: null, error: null }),
}));