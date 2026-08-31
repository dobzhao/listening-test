import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useSettingsStore } from "@/store/settings";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ToastHost } from "@/components/ToastHost";
import { CloseGuard } from "@/components/CloseGuard";
import { usePregenStore } from "@/store/pregen";
import { usePregenEvents } from "@/hooks/usePregenEvents";
import {
  installAdaptiveEventListeners,
  uninstallAdaptiveEventListeners,
  useAdaptiveStore,
} from "@/store/adaptive";
import MainMenu from "@/pages/MainMenu";
import SettingsPage from "@/pages/Settings";
import TestPage from "@/pages/Test";
import ResultPage from "@/pages/Result";

export default function App() {
  const load = useSettingsStore((s) => s.load);
  const loaded = useSettingsStore((s) => s.loaded);
  const settingsConfig = useSettingsStore((s) => s.config);

  // 启动时主动加载一次配置 + 自适应状态 + 注册事件订阅
  useEffect(() => {
    if (!loaded) {
      load();
    }
    // 自适应 store 需要等 settings.config.difficulty.mode 拿到才能正确初始化 mode
    if (loaded && !useAdaptiveStore.getState().loaded) {
      // 把 mode 强行 set 一次（因为 store 初始化时 settings 还没 ready）
      useAdaptiveStore.setState({ mode: settingsConfig.difficulty.mode });
      void useAdaptiveStore.getState().load();
    }
    installAdaptiveEventListeners();
    // 预生成题库摘要加载 + 事件订阅
    void usePregenStore.getState().loadSummary();
    return () => uninstallAdaptiveEventListeners();
  }, [loaded, load, settingsConfig.difficulty.mode]);

  // 全局订阅 pregen 事件（progress / finished / failed）
  usePregenEvents();

  return (
    <CloseGuard>
      {/* 全局确认对话框：替代 window.confirm()，规避 macOS WKWebView 下
          wry 未实现 confirm panel 的问题。 */}
      <ConfirmDialog />
      {/* 全局 Toast 容器（v1.1+）：自适应模式切换 / 重置等动作的用户反馈 */}
      <ToastHost />
      <Routes>
        <Route path="/" element={<MainMenu />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/test" element={<TestPage />} />
        <Route path="/result" element={<ResultPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </CloseGuard>
  );
}
