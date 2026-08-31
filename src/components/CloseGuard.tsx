// 全局关闭拦截：题库生成中时关闭程序需弹原生确认对话框
//
// 安全约束（用户要求）：
// - 题库生成中时，用户点关闭按钮必须弹确认对话框
// - 用户选「确认关闭」→ 调 `cancel_pregen` → 等 worker 收尾 → 关窗
// - 用户选「继续生成」→ 拦截关闭，worker 继续跑
// - 不在生成中时不拦截，直接放行
//
// 「不完整题库永不视为可用」由 worker 实现保证：worker 仅在写完所有 audio +
// session.json 后才插入索引；中途取消 → 索引不变 → 下次启动 recover_index 清理

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { usePregenStore } from "@/store/pregen";
import { cancelPregen } from "@/lib/tauri";

export function CloseGuard({ children }: { children: React.ReactNode }) {
  const generatingNow = usePregenStore((s) => s.summary?.generatingNow ?? false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    (async () => {
      unlisten = await win.onCloseRequested(async (event) => {
        // 同步读最新值，避免闭包陈旧
        const isGenerating = usePregenStore.getState().summary?.generatingNow ?? false;
        if (!isGenerating) {
          return; // 不在生成中 → 直接放行
        }
        event.preventDefault();
        const confirmed = await ask(
          "题库正在生成中，关闭后未完成的题目将丢失。\n确定要关闭吗？",
          {
            title: "生成进行中",
            kind: "warning",
            okLabel: "确认关闭",
            cancelLabel: "继续生成",
          }
        );
        if (!confirmed) {
          return;
        }
        // 用户确认关闭：取消 worker，等其收尾，再 destroy
        try {
          await cancelPregen();
        } catch (e) {
          console.error("[CloseGuard] cancel_pregen 失败", e);
        }
        // 给 worker 0.5s 处理收尾
        await new Promise((r) => setTimeout(r, 500));
        await win.destroy();
      });
      if (cancelled) {
        unlisten?.();
        unlisten = null;
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // 仅在 generatingNow 变化时重新注册监听（避免每次状态变化都重新订阅）
  }, [generatingNow]);

  return <>{children}</>;
}