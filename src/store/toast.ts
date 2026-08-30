// 全局 Toast store + 便捷 push 函数。
//
// 用法：
//   push("操作失败", { kind: "error" });
//   push("已重置自适应状态", { kind: "success" });
//   push("已切换到手动档，已重置自适应变量");
//
// 由 `components/ToastHost.tsx` 渲染队列；App.tsx 把 ToastHost 挂到根节点即可。

import { create } from "zustand";

export type ToastKind = "error" | "info" | "success";

export interface ToastItem {
  id: string;
  message: string;
  kind: ToastKind;
  durationMs: number;
}

interface State {
  toasts: ToastItem[];
  push: (message: string, opts?: { kind?: ToastKind; durationMs?: number }) => string;
  remove: (id: string) => void;
}

export const useToastStore = create<State>((set) => ({
  toasts: [],
  push: (message, opts) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      toasts: [
        ...s.toasts,
        {
          id,
          message,
          kind: opts?.kind ?? "info",
          durationMs: opts?.durationMs ?? 4000,
        },
      ],
    }));
    return id;
  },
  remove: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** 不式仅 push 的便捷函数：调用方不需要关心 store 实例。 */
export function toast(
  message: string,
  opts?: { kind?: ToastKind; durationMs?: number }
): string {
  return useToastStore.getState().push(message, opts);
}