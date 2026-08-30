// 全局 Toast 渲染容器：监听 toast store，依次渲染队列中的 Toast。
//
// 与 `components/Toast.tsx`（无状态展示组件）配对，由 store 暴露 `push()` 触发。

import { Toast } from "@/components/Toast";
import { useToastStore } from "@/store/toast";

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const remove = useToastStore((s) => s.remove);
  return (
    <>
      {toasts.map((t) => (
        <Toast
          key={t.id}
          message={t.message}
          kind={t.kind}
          durationMs={t.durationMs}
          onClose={() => remove(t.id)}
        />
      ))}
    </>
  );
}