// 全局关闭拦截：题库生成中 / 答题中点关闭按钮时弹应用内确认框
//
// 设计要点：
// - 拦截决策放在 **Rust 端**（`lib.rs::on_window_event`）。
//   前端绝不能监听 `tauri://close-requested` —— Tauri 在 `manager/window.rs`
//   里只要发现该事件存在 JS 监听就无条件 `prevent_close`，而后续 `destroy()`
//   又受 ACL 限制（`core:window:default` 不含 `allow-destroy`）。旧版因此卡死。
// - 改用自定义事件 `app-close-requested`。Rust 端 `prevent_close` 后 emit；
//   前端弹应用内 `ConfirmDialog`（已全局挂载于 App.tsx），确认后调
//   `confirm_close_app` 由 Rust 侧 `destroy()` 关窗（绕过 ACL）。
// - 任何前端异常都兜底走「确认关闭」分支：关不掉窗口比误关窗口严重得多。
// - Rust 端自带逃生阀：确认框弹着时再点一次 X 直接放行。
//
// 安全约束（用户要求）：
// - 题库生成中时，用户点关闭按钮必须弹确认对话框
// - 用户选「确认关闭」→ 调 `confirm_close_app`（取消生成 + abort 测试流程 + 关窗）
// - 用户选「继续生成/继续测试」→ 调 `cancel_close_app` 清标志位，worker 继续跑
// - 不在忙碌状态时不拦截，直接放行（Rust 端保证，前端无需关心）
//
// 「不完整题库永不视为可用」由 worker 实现保证：worker 仅在写完所有 audio +
// session.json 后才插入索引；中途取消 → 索引不变 → 下次启动 recover_index 清理

import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { confirm } from "@/store/confirm";
import { cancelCloseApp, confirmCloseApp, onAppCloseRequested } from "@/lib/tauri";

const PROMPT_TITLE = "确认退出";

const PROMPT_GENERATING =
  "题库正在生成中，关闭后未完成的题目将丢失。\n确定要关闭吗？";

const PROMPT_TESTING =
  "1-19 题测试正在进行中，关闭后本次成绩将丢失。\n确定要关闭吗？";

function promptFor(reason: "generating" | "testing"): string {
  return reason === "generating" ? PROMPT_GENERATING : PROMPT_TESTING;
}

export function CloseGuard({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    (async () => {
      unlisten = await onAppCloseRequested(async (payload) => {
        // 默认走「确认关闭」——任何异常都优先保证窗口能关
        let confirmed = true;
        try {
          confirmed = await confirm({
            title: PROMPT_TITLE,
            description: promptFor(payload.reason),
            confirmText: "确认关闭",
            cancelText: "继续",
            variant: "destructive",
          });
        } catch (err) {
          // 二次确认已开着、或 store 异常 —— 这种情况下绝对不能让用户
          // 困在关不掉的窗口里，直接视为已确认。
          console.error("[CloseGuard] 确认框异常，按已确认处理并强制关闭", err);
          confirmed = true;
        }

        if (confirmed) {
          try {
            await confirmCloseApp();
          } catch (err) {
            // Rust 侧 destroy 失败 —— 没有 JS 备用方案，只能 log
            console.error("[CloseGuard] confirm_close_app 失败", err);
          }
        } else {
          try {
            await cancelCloseApp();
          } catch (err) {
            console.error("[CloseGuard] cancel_close_app 失败", err);
          }
        }
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
  }, []);

  return <>{children}</>;
}