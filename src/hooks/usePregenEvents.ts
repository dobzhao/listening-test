// 订阅后端预生成题库相关事件（pregen-progress / pregen-finished / pregen-failed）

import { useEffect } from "react";
import {
  onPregenFailed,
  onPregenFinished,
  onPregenProgress,
} from "@/lib/tauri";
import { usePregenStore } from "@/store/pregen";
import type { UnlistenFn } from "@tauri-apps/api/event";

export function usePregenEvents() {
  const setProgress = usePregenStore((s) => s.setProgress);
  const setFinished = usePregenStore((s) => s.setFinished);
  const setFailed = usePregenStore((s) => s.setFailed);

  useEffect(() => {
    const unsubs: UnlistenFn[] = [];
    let cancelled = false;

    (async () => {
      const u1 = await onPregenProgress((p) => setProgress(p));
      if (cancelled) {
        u1();
        return;
      }
      unsubs.push(u1);
      const u2 = await onPregenFinished((f) => setFinished(f));
      if (cancelled) {
        u2();
        return;
      }
      unsubs.push(u2);
      const u3 = await onPregenFailed((f) => setFailed(f));
      if (cancelled) {
        u3();
        return;
      }
      unsubs.push(u3);
    })();

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [setProgress, setFinished, setFailed]);
}