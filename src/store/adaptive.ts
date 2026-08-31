// 自适应难度（v1.1+）前端 Zustand store
//
// 单一数据源：`mode` / `abilityScore` / `trend` / `currentLevel` / `updateCount` / `params`
// - 应用启动 / MainMenu 挂载 → `load()` 拉 `get_adaptive_state` + `get_config`
// - 收到 `adaptive-level-changed` → 应用 patch（不下 toast）
// - 收到 `adaptive-state-reset` → 应用 patch + 弹 toast（auto→manual 弹「已切换到手动档」）
//
// setMode(auto) 内部调 `set_adaptive_mode` 命令，后端在 auto→manual 时自动调 reset 并发 reset 事件。

import { create } from "zustand";
import {
  getAdaptiveState,
  onAdaptiveLevelChanged,
  onAdaptiveStateReset,
  resetAdaptiveState as cmdResetAdaptiveState,
  setAdaptiveMode as cmdSetAdaptiveMode,
  updateAdaptiveParams as cmdUpdateAdaptiveParams,
} from "@/lib/tauri";
import { useSettingsStore } from "@/store/settings";
import {
  type AdaptiveLevelChangedPayload,
  type AdaptiveMode,
  type AdaptiveParams,
  type AdaptiveStateResetPayload,
  type AdaptiveStateSnapshot,
  type DifficultyLevel,
  defaultAdaptiveParams,
} from "@/types/config";
import { toast } from "@/store/toast";
import type { UnlistenFn } from "@tauri-apps/api/event";

interface AdaptiveState {
  mode: AdaptiveMode;
  abilityScore: number;
  trend: number;
  currentLevel: DifficultyLevel;
  updateCount: number;
  params: AdaptiveParams;
  loaded: boolean;

  load: () => Promise<void>;
  /**
   * 切换手动 / 自动档。
   * - auto=false（关闭自动档）：后端**硬重置**到 `config.difficulty.level`，
   *   ability / trend / current_level / update_count 全部清零。
   * - auto=true 且 initialLevel 传入：后端软重置到 `initialLevel`（用户自选起始档，
   *   仅重置 ability/trend/current_level，保留 update_count）
   * - auto=true 且 initialLevel 不传：保留之前的 adaptive state（兼容 §11.6 旧路径）
   */
  setMode: (auto: boolean, initialLevel?: DifficultyLevel) => Promise<void>;
  reset: () => Promise<void>;
  updateParams: (params: AdaptiveParams) => Promise<void>;
}

export const useAdaptiveStore = create<AdaptiveState>((set, get) => ({
  mode: "manual",
  abilityScore: 100,
  trend: 0,
  currentLevel: "junior_high",
  updateCount: 0,
  params: defaultAdaptiveParams(),
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const [snap, configResp] = await Promise.all([
        getAdaptiveState(),
        // 直接用 useSettingsStore 里的 config（已经由 App.tsx 触发 load()）
        Promise.resolve(
          useSettingsStore.getState().loaded
            ? useSettingsStore.getState().config
            : null
        ),
      ]);
      const mode: AdaptiveMode = configResp?.difficulty.mode ?? "manual";
      set({
        mode,
        abilityScore: snap.ability_score,
        trend: snap.trend,
        currentLevel: snap.current_level,
        updateCount: snap.update_count,
        loaded: true,
      });
    } catch (e) {
      console.error("[adaptive] load 失败", e);
      set({ loaded: true });
    }
  },

  setMode: async (auto, initialLevel) => {
    const prevMode = get().mode;
    try {
      const snap = await cmdSetAdaptiveMode(auto, initialLevel);
      const nextMode: AdaptiveMode = auto ? "auto" : "manual";

      // 1. 同步 adaptive store 自身的运行时态
      set({
        mode: nextMode,
        abilityScore: snap.ability_score,
        trend: snap.trend,
        currentLevel: snap.current_level,
        updateCount: snap.update_count,
      });

      // 2. 同步 settings store 的 difficulty.mode 镜像：
      //    避免后续 persist()（用户在 LLM 设置页改 prompt 后点「保存配置」）把
      //    陈旧的 mode 整包发回后端，导致磁盘 mode 被反向覆盖。
      const settingsState = useSettingsStore.getState();
      if (settingsState.loaded && settingsState.config.difficulty.mode !== nextMode) {
        useSettingsStore.setState((s) => ({
          config: {
            ...s.config,
            difficulty: { ...s.config.difficulty, mode: nextMode },
          },
        }));
      }

      // auto→manual 时给提示（后端会把 update_count 一起清零）；manual→auto 时静默
      // （auto 状态下由 DifficultyPanel 自己弹 toast）
      if (prevMode === "auto" && !auto) {
        toast("已切换到手动档，自适应变量已全部清零", { kind: "info" });
      }
    } catch (e) {
      console.error("[adaptive] setMode 失败", e);
      // 后端 save_config_to_disk 失败时回滚 UI，避免 Switch 与磁盘不一致
      if (get().mode !== prevMode) {
        set({ mode: prevMode });
      }
      toast(`切换自适应模式失败: ${String(e)}`, { kind: "error" });
    }
  },

  reset: async () => {
    const level = get().currentLevel;
    try {
      const snap = await cmdResetAdaptiveState(level);
      set({
        abilityScore: snap.ability_score,
        trend: snap.trend,
        currentLevel: snap.current_level,
        updateCount: snap.update_count,
      });
      toast("已重置自适应状态", { kind: "info" });
    } catch (e) {
      console.error("[adaptive] reset 失败", e);
      toast(`重置自适应状态失败: ${String(e)}`, { kind: "error" });
    }
  },

  updateParams: async (params) => {
    // 先乐观更新本地 UI，落盘失败时回滚
    const prev = get().params;
    set({ params });
    try {
      await cmdUpdateAdaptiveParams(params);
    } catch (e) {
      console.error("[adaptive] updateParams 失败，回滚", e);
      set({ params: prev });
      toast(`保存自适应参数失败: ${String(e)}`, { kind: "error" });
    }
  },
}));

// ===== 模块级副作用：订阅后端事件 =====
//
// 仅在浏览器中执行一次（模块首次 import 时）。App.tsx 通过 `import "@/store/adaptive"`
// 或 `import { useAdaptiveStore } from "@/store/adaptive"` 触发注册。

let unlisteners: UnlistenFn[] = [];

export async function installAdaptiveEventListeners(): Promise<void> {
  if (unlisteners.length > 0) return;
  const u1 = await onAdaptiveLevelChanged((p: AdaptiveLevelChangedPayload) => {
    useAdaptiveStore.setState({
      currentLevel: p.to,
      abilityScore: p.ability,
      trend: p.trend,
      updateCount: p.update_count,
    });
  });
  const u2 = await onAdaptiveStateReset((p: AdaptiveStateResetPayload) => {
    useAdaptiveStore.setState({
      abilityScore: p.ability,
      trend: p.trend,
      currentLevel: p.new_level,
      updateCount: p.update_count,
      mode: p.new_mode,
    });
  });
  unlisteners = [u1, u2];
}

export function uninstallAdaptiveEventListeners(): void {
  unlisteners.forEach((u) => u());
  unlisteners = [];
}