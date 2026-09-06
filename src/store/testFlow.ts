// 测试流程运行时状态：当前题号、阶段、剩余时间、用户作答

import { create } from "zustand";
import type {
  FlowStatePayload,
  TestPhase,
  TimerTickPayload,
} from "@/lib/tauri";

interface AnswerMap {
  [questionId: number]: string | null;
}

interface TestFlowState {
  // 当前题号（1-14，未开始时为 0）
  questionIndex: number;
  // 当前阶段
  phase: TestPhase | null;
  // 进度 0.0 ~ 1.0
  progress: number;
  // 剩余毫秒
  remainingMs: number;
  // 总毫秒
  durationMs: number;
  // 当前播放路径
  audioPath: string | null;
  // 是否在材料组内
  isGroup: boolean;
  // 组内索引（0/1）
  questionInGroup: number;
  // 15-19 题当前是第几次播放（null = 非 playing 或 1-14 题；
  // 仅 15-19 题的 PLAYING #1/#2/#3 阶段分别取值 1/2/3）。
  // 由 applyFlowState 写入，applyTick 不触碰（保持阶段内值稳定）。
  playCount: number | null;
  // 开场介绍文案（仅 intro 阶段有值，其余阶段为 null）。
  // 由后端随 flow-state 下发（4 个 INTRO 阶段各自对应 IntroConfig 里的一段文案）。
  introText: string | null;
  // 用户作答
  answers: AnswerMap;
  // 是否已完成
  finished: boolean;
  // 错误信息
  error: string | null;

  // actions
  applyTick: (p: TimerTickPayload) => void;
  applyFlowState: (p: FlowStatePayload) => void;
  applyFinished: (p: { ok: boolean; error?: string }) => void;
  setAnswer: (questionId: number, answer: string | null) => void;
  reset: () => void;
}

export const useTestFlowStore = create<TestFlowState>((set) => ({
  questionIndex: 0,
  phase: null,
  progress: 0,
  remainingMs: 0,
  durationMs: 0,
  audioPath: null,
  isGroup: false,
  questionInGroup: 0,
  playCount: null,
  introText: null,
  answers: {},
  finished: false,
  error: null,

  applyTick: (p) =>
    set({
      remainingMs: p.remainingMs,
      durationMs: p.durationMs,
      progress: p.progress,
    }),

  applyFlowState: (p) =>
    set({
      questionIndex: p.questionIndex,
      phase: p.phase,
      progress: p.progress,
      audioPath: p.audioPath,
      isGroup: p.isGroup,
      questionInGroup: p.questionInGroup,
      playCount: p.playCount ?? null,
      introText: p.introText ?? null,
    }),

  applyFinished: (p) =>
    set({
      finished: p.ok,
      error: p.error ?? null,
    }),

  setAnswer: (questionId, answer) =>
    set((s) => ({
      answers: { ...s.answers, [questionId]: answer },
    })),

  reset: () => {
    const prev = useTestFlowStore.getState();
    const prevAnswers = Object.keys(prev.answers).length;
    console.log(
      `[testFlow] reset: 清空 ${prevAnswers} 条前端作答，重置 questionIndex/phase/finished 等`
    );
    set({
      questionIndex: 0,
      phase: null,
      progress: 0,
      remainingMs: 0,
      durationMs: 0,
      audioPath: null,
      isGroup: false,
      questionInGroup: 0,
      playCount: null,
      introText: null,
      answers: {},
      finished: false,
      error: null,
    });
  },
}));

export const PHASE_LABELS: Record<TestPhase, string> = {
  intro: "题目介绍",
  prepare: "准备中",
  playing: "音频播放中",
  answering: "作答中",
  fill_blank: "填写挖空",
  recall_prep: "默读准备",
  recording: "录音中",
};
