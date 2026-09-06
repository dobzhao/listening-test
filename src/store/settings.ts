// 设置状态：保存当前内存中的 AppConfig，并提供加载/保存/重置 actions

import { create } from "zustand";
import {
  AppConfig,
  ConfigResponse,
  DifficultyDemandKey,
  DifficultyLevel,
  IntroKey,
  PromptKey,
  TimingConfig,
  defaultAppConfig,
} from "@/types/config";
import {
  getConfig,
  saveConfig,
  resetConfig,
  restoreDefaultDifficulty,
  restoreDefaultDifficultyDemand,
  restoreDefaultDifficultyLevel,
  restoreDefaultIntro,
  restoreDefaultIntroAll,
  restoreDefaultPrompt,
  restoreDefaultTiming,
} from "@/lib/tauri";

interface SettingsState {
  config: AppConfig;
  configPath: string;
  loaded: boolean;
  loadError: string | null;
  saving: boolean;

  // actions
  load: () => Promise<void>;
  persist: () => Promise<void>;
  reset: () => Promise<void>;
  updateLlm: (patch: Partial<AppConfig["llm"]>) => void;
  updateTts: (patch: Partial<AppConfig["tts"]>) => void;
  updateStt: (patch: Partial<AppConfig["stt"]>) => void;
  updateLlmParams: (patch: Partial<AppConfig["llm_params"]>) => void;
  updateAudio: (patch: Partial<AppConfig["audio"]>) => void;
  updateTiming: (patch: Partial<TimingConfig>) => void;
  updatePrompt: (key: PromptKey, value: string) => void;
  restoreOnePrompt: (key: PromptKey) => Promise<void>;
  restoreDefaultTiming: () => Promise<void>;
  // 开场介绍文案（命名对齐 `updatePrompt` / `restoreOnePrompt` 模式）
  updateIntro: (key: IntroKey, value: string) => void;
  restoreOneIntro: (key: IntroKey) => Promise<void>;
  restoreDefaultIntro: () => Promise<void>;
  // 难度配置（命名对齐 `updatePrompt` / `restoreOnePrompt` 模式）
  setDifficultyLevel: (level: DifficultyLevel) => void;
  updateDifficultyDemand: (
    level: DifficultyLevel,
    key: DifficultyDemandKey,
    value: string
  ) => void;
  restoreOneDifficultyDemand: (
    level: DifficultyLevel,
    key: DifficultyDemandKey
  ) => Promise<void>;
  restoreOneDifficultyLevel: (level: DifficultyLevel) => Promise<void>;
  restoreDefaultDifficulty: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  config: defaultAppConfig(),
  configPath: "",
  loaded: false,
  loadError: null,
  saving: false,

  load: async () => {
    try {
      const resp: ConfigResponse = await getConfig();
      set({
        config: resp.config,
        configPath: resp.config_path,
        loaded: true,
        loadError: null,
      });
    } catch (e) {
      set({
        loadError: String(e),
        loaded: true,
      });
    }
  },

  persist: async () => {
    set({ saving: true });
    try {
      await saveConfig(get().config);
    } finally {
      set({ saving: false });
    }
  },

  reset: async () => {
    const fresh = await resetConfig();
    set({ config: fresh });
  },

  updateLlm: (patch) =>
    set((s) => ({ config: { ...s.config, llm: { ...s.config.llm, ...patch } } })),
  updateTts: (patch) =>
    set((s) => ({ config: { ...s.config, tts: { ...s.config.tts, ...patch } } })),
  updateStt: (patch) =>
    set((s) => ({ config: { ...s.config, stt: { ...s.config.stt, ...patch } } })),
  updateLlmParams: (patch) =>
    set((s) => ({
      config: { ...s.config, llm_params: { ...s.config.llm_params, ...patch } },
    })),
  updateAudio: (patch) =>
    set((s) => ({ config: { ...s.config, audio: { ...s.config.audio, ...patch } } })),
  updateTiming: (patch) =>
    set((s) => ({ config: { ...s.config, timing: { ...s.config.timing, ...patch } } })),
  updatePrompt: (key, value) =>
    set((s) => ({
      config: { ...s.config, prompts: { ...s.config.prompts, [key]: value } },
    })),

  restoreOnePrompt: async (key) => {
    const value = await restoreDefaultPrompt(key);
    get().updatePrompt(key, value);
  },

  restoreDefaultTiming: async () => {
    const fresh = await restoreDefaultTiming();
    get().updateTiming(fresh);
  },

  updateIntro: (key, value) =>
    set((s) => ({
      config: { ...s.config, intro: { ...s.config.intro, [key]: value } },
    })),

  restoreOneIntro: async (key) => {
    const value = await restoreDefaultIntro(key);
    get().updateIntro(key, value);
  },

  restoreDefaultIntro: async () => {
    const fresh = await restoreDefaultIntroAll();
    set((s) => ({ config: { ...s.config, intro: fresh } }));
  },

  setDifficultyLevel: (level) =>
    set((s) => ({
      config: { ...s.config, difficulty: { ...s.config.difficulty, level } },
    })),

  updateDifficultyDemand: (level, key, value) =>
    set((s) => ({
      config: {
        ...s.config,
        difficulty: {
          ...s.config.difficulty,
          [level]: { ...s.config.difficulty[level], [key]: value },
        },
      },
    })),

  restoreOneDifficultyDemand: async (level, key) => {
    const value = await restoreDefaultDifficultyDemand(level, key);
    get().updateDifficultyDemand(level, key, value);
  },

  restoreOneDifficultyLevel: async (level) => {
    const fresh = await restoreDefaultDifficultyLevel(level);
    set((s) => ({
      config: { ...s.config, difficulty: { ...s.config.difficulty, [level]: fresh } },
    }));
  },

  restoreDefaultDifficulty: async () => {
    const fresh = await restoreDefaultDifficulty();
    set((s) => ({ config: { ...s.config, difficulty: fresh } }));
  },
}));
