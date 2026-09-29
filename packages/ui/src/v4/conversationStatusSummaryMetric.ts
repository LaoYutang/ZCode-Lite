/**
 * 收起态胶囊指标的**唯一裁决**。
 *
 * 面板外壳在收起形态（`mini`，以及 `auto` 的窄容器区间）下只渲染这一颗胶囊：指标为空时
 * 外壳就只剩上下两条 1px 边框，在会话右上角显示成一条 2px 横线——「只有用量信号的新会话」
 * 冷启动后就会命中这个形状（历史同类失效：goal notSatisfied、仅剩已结束 run）。
 *
 * 因此「胶囊渲染什么」与「外壳是否值得渲染」必须来自同一份结论，不允许渲染层与闸门
 * 各自维护一套内容优先级。这里是纯函数：不碰 intl、不碰 DOM，文案与图标由渲染层按
 * `kind` 决定。
 */
import type { ConversationStatusPanelModel } from "@/v4/conversationStatusPanelModel.js";

/** 运行中后台任务恰好一类时沿用该类图标，混合才是 Activity 语义。 */
export type ConversationStatusSummaryRunningIcon = "mixed" | "workflow" | "terminal" | "agent";

/**
 * 胶囊指标描述符。字段与既有胶囊链逐档对应，次序即优先级：
 * 当前计划项 → 活跃 goal → Git 变更 → 已完成 goal → 已完成计划项 → 计划进度 →
 * 会话计划 → 运行中计数 → 已结束 run → 用量兜底。
 */
export type ConversationStatusSummaryMetric =
  | { kind: "currentPlanItem"; content: string }
  | { kind: "activeGoal"; title: string }
  | { kind: "gitChanges"; added: number; removed: number }
  | { kind: "doneGoal"; title: string }
  | { kind: "completedPlanItem"; content: string }
  | { kind: "planProgress"; completedCount: number; totalCount: number }
  | { kind: "sessionPlan"; title: string | null }
  | {
      kind: "running";
      count: number;
      hasRunningSubagent: boolean;
      icon: ConversationStatusSummaryRunningIcon;
    }
  | { kind: "endedWorkflows"; count: number }
  | { kind: "usage"; totalTokens: number };

export interface ResolveConversationStatusSummaryMetricInput {
  model: ConversationStatusPanelModel;
  /** 已结束 run 的目录计数；宿主给 0 表示目录入口不可渲染（缺会话或缺回调）。 */
  endedWorkflowRunCount: number;
  /**
   * 本会话计费口径合计；null 表示没有（或查不到），此时不占用胶囊。
   *
   * 注意与 `model.hasContent` 的差别：`hasContent` 把 `usageContextWindow` 也算内容
   * （冷恢复由 seed 回填），这里的用量档只认计费合计——两者不一致时收起形态没有内容，
   * 由渲染层按本函数的 null 结论收窄渲染，而不是让外壳留在页面上当空壳。
   */
  usageTotalTokens?: number | null;
}

function getCurrentPlanItem(plan: ConversationStatusPanelModel["plan"]) {
  return (
    plan?.items.find((item) => item.status === "inProgress") ??
    plan?.items.find((item) => item.status === "pending") ??
    null
  );
}

function getCompletedPlanItem(plan: ConversationStatusPanelModel["plan"]) {
  return [...(plan?.items ?? [])].reverse().find((item) => item.status === "completed") ?? null;
}

export function resolveConversationStatusSummaryMetric(
  input: ResolveConversationStatusSummaryMetricInput,
): ConversationStatusSummaryMetric | null {
  const { model } = input;

  const currentPlanItem = getCurrentPlanItem(model.plan);
  if (currentPlanItem) {
    return { kind: "currentPlanItem", content: currentPlanItem.content };
  }

  const goalTitle = model.goal
    ? model.goal.summaryTitle?.trim() || model.goal.objective.trim() || null
    : null;
  const goalStatus = model.goal?.status ?? null;
  // V4 goal 在 verifier 判定未完成后会进入 notSatisfied；漏掉这个合法开放态会让胶囊无内容，
  // 只剩 2px 空 shell，也失去重新展开入口。
  const isActiveGoal =
    goalStatus === "active" ||
    goalStatus === "notSatisfied" ||
    goalStatus === "paused" ||
    goalStatus === "verifying";
  if (goalTitle && isActiveGoal) {
    return { kind: "activeGoal", title: goalTitle };
  }

  // Git 变更行与 `model.git` 同源（`buildGitModel` 在 added + removed <= 0 时返回 null），
  // 这里仍逐项判断，避免模型侧放宽后让干净仓库继续占用胶囊。
  const git = model.git;
  if (git && git.added + git.removed > 0) {
    return { kind: "gitChanges", added: git.added, removed: git.removed };
  }

  if (goalTitle && goalStatus === "verified") {
    return { kind: "doneGoal", title: goalTitle };
  }

  const completedPlanItem = getCompletedPlanItem(model.plan);
  if (completedPlanItem) {
    return { kind: "completedPlanItem", content: completedPlanItem.content };
  }
  if (model.plan) {
    return {
      kind: "planProgress",
      completedCount: model.plan.completedCount,
      totalCount: model.plan.totalCount,
    };
  }

  const latestSessionPlan = model.sessionPlans?.items[0] ?? null;
  if (latestSessionPlan) {
    return { kind: "sessionPlan", title: latestSessionPlan.title ?? null };
  }

  const hasRunningBash = model.runningBashWorks.length > 0;
  const hasRunningSubagent = model.runningSubagentWorks.length > 0;
  const hasRunningWorkflow = model.runningWorkflowRuns.length > 0;
  const runningCount =
    model.runningBashWorks.length +
    model.runningSubagentWorks.length +
    model.runningWorkflowRuns.length;
  if (runningCount > 0) {
    // 胶囊摘要过去把所有后台任务都写死成 Activity，纯 Subagent 因而没有复用 Running 明细的
    // Bot 语义。规则是三类的：**恰好一类**沿用该类图标，混合才是 Activity。
    const runningKindCount = [hasRunningWorkflow, hasRunningBash, hasRunningSubagent].filter(
      Boolean,
    ).length;
    const icon: ConversationStatusSummaryRunningIcon =
      runningKindCount > 1
        ? "mixed"
        : hasRunningWorkflow
          ? "workflow"
          : hasRunningBash
            ? "terminal"
            : "agent";
    return { kind: "running", count: runningCount, hasRunningSubagent, icon };
  }

  if (input.endedWorkflowRunCount > 0) {
    // 终态 run 是兜底链里唯一"没有活动也还在"的一档：面板级闸门为了保住 run 目录入口会在
    // 只剩已结束 run 时继续渲染外壳，缺了这一档胶囊就又会退回空壳线。
    return { kind: "endedWorkflows", count: input.endedWorkflowRunCount };
  }

  // 兜底链最后一档：用量是"有数据就希望看得见"的常驻信息，但必须让位给
  // Goal/Todo/Git/活动计数这些主状态，所以排在终态 run 之后。
  const usageTotalTokens = input.usageTotalTokens ?? null;
  if (usageTotalTokens === null) {
    return null;
  }
  return { kind: "usage", totalTokens: usageTotalTokens };
}

/**
 * 外壳在收起形态下的可见性。
 *
 * - `hidden`：整个面板不该渲染（`mini` 形态下卡片区本就不渲染，外壳里只剩胶囊）。
 * - `collapsed-only`：只在窄容器（`< 1280px`）隐藏、宽容器（`≥ 1280px` 的卡片区）照常渲染。
 *   窄/宽必须由既有 container query 断点裁决，React 不把容器宽度翻译成状态，因此这里只给
 *   可见性结论，类名由渲染层按同一断点拼。
 * - `visible`：不受影响（有指标，或展开形态 `panel`）。
 */
export type ConversationStatusPanelCollapsedVisibility = "hidden" | "collapsed-only" | "visible";

export function resolveConversationStatusPanelCollapsedVisibility(input: {
  variant: "auto" | "mini" | "panel";
  hasSummaryMetric: boolean;
}): ConversationStatusPanelCollapsedVisibility {
  if (input.hasSummaryMetric || input.variant === "panel") {
    return "visible";
  }
  return input.variant === "mini" ? "hidden" : "collapsed-only";
}
