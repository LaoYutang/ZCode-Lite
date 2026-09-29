// 收起态胶囊指标的裁决：它同时决定「胶囊渲染什么」与「外壳是否值得渲染」，
// 所以这里逐档锁定优先级次序，并单独锁定"只有用量信号的会话"不再产出空壳（2px 横线）。
import assert from "node:assert/strict";
import { test } from "node:test";

const {
  resolveConversationStatusPanelCollapsedVisibility,
  resolveConversationStatusSummaryMetric,
} = await import("../src/v4/conversationStatusSummaryMetric.ts");

function createModel(overrides = {}) {
  return {
    git: null,
    goal: null,
    sessionPlans: null,
    plan: null,
    runningBashWorks: [],
    runningSubagentWorks: [],
    runningWorkflowRuns: [],
    usageContextWindow: null,
    // 冷恢复后 contextWindow 由 seed 回填，因此外壳闸门（hasContent）可以为真，
    // 而收起形态里没有任何指标——这正是空壳线的成因。
    hasContent: true,
    ...overrides,
  };
}

function createPlanItem(status, content) {
  return { status, content };
}

test("只有用量信号的会话：没有计费合计时裁决为空（不再渲染空壳）", () => {
  const model = createModel({ usageContextWindow: 200_000 });
  assert.equal(resolveConversationStatusSummaryMetric({ model, endedWorkflowRunCount: 0 }), null);
  assert.equal(
    resolveConversationStatusSummaryMetric({
      model,
      endedWorkflowRunCount: 0,
      usageTotalTokens: null,
    }),
    null,
  );
});

test("用量兜底：有计费合计时走最低优先级那一档", () => {
  const model = createModel({ usageContextWindow: 200_000 });
  assert.deepEqual(
    resolveConversationStatusSummaryMetric({
      model,
      endedWorkflowRunCount: 0,
      usageTotalTokens: 3_500,
    }),
    { kind: "usage", totalTokens: 3_500 },
  );
});

test("优先级次序：当前计划项 → 活跃 goal → Git 变更 → 已完成 goal → 已完成计划项 → 计划进度", () => {
  const plan = {
    items: [
      createPlanItem("completed", "收尾"),
      createPlanItem("inProgress", "正在做"),
      createPlanItem("pending", "待办"),
    ],
    completedCount: 1,
    totalCount: 3,
  };
  const activeGoal = { status: "active", objective: "把桌子收拾干净" };
  const git = { added: 3, removed: 1 };

  // 计划项压过 goal 与 Git：同为"主状态"时计划项最贴近当前动作。
  assert.deepEqual(
    resolveConversationStatusSummaryMetric({
      model: createModel({ plan, goal: activeGoal, git }),
      endedWorkflowRunCount: 0,
      usageTotalTokens: 100,
    }),
    { kind: "currentPlanItem", content: "正在做" },
  );

  // 没有进行中/待办计划项时，活跃 goal 压过 Git 变更。
  assert.deepEqual(
    resolveConversationStatusSummaryMetric({
      model: createModel({
        plan: { items: [createPlanItem("completed", "收尾")], completedCount: 1, totalCount: 1 },
        goal: activeGoal,
        git,
      }),
      endedWorkflowRunCount: 0,
    }),
    { kind: "activeGoal", title: "把桌子收拾干净" },
  );

  // goal 已完成（verified）时让位给 Git 变更。
  assert.deepEqual(
    resolveConversationStatusSummaryMetric({
      model: createModel({
        goal: { status: "verified", objective: "把桌子收拾干净" },
        git,
      }),
      endedWorkflowRunCount: 0,
    }),
    { kind: "gitChanges", added: 3, removed: 1 },
  );

  // 已完成的 goal 压过"已完成计划项"。
  assert.deepEqual(
    resolveConversationStatusSummaryMetric({
      model: createModel({
        plan: { items: [createPlanItem("completed", "收尾")], completedCount: 1, totalCount: 1 },
        goal: { status: "verified", objective: "把桌子收拾干净" },
      }),
      endedWorkflowRunCount: 0,
    }),
    { kind: "doneGoal", title: "把桌子收拾干净" },
  );

  // 没有 goal 时，已完成计划项压过计划进度。
  assert.deepEqual(
    resolveConversationStatusSummaryMetric({
      model: createModel({
        plan: { items: [createPlanItem("completed", "收尾")], completedCount: 1, totalCount: 1 },
      }),
      endedWorkflowRunCount: 0,
    }),
    { kind: "completedPlanItem", content: "收尾" },
  );

  // 只剩计划进度（无进行中/待办/已完成项）时给出计数。
  assert.deepEqual(
    resolveConversationStatusSummaryMetric({
      model: createModel({
        plan: {
          items: [createPlanItem("cancelled", "换了方向")],
          completedCount: 0,
          totalCount: 1,
        },
      }),
      endedWorkflowRunCount: 0,
    }),
    { kind: "planProgress", completedCount: 0, totalCount: 1 },
  );
});

test("goal 标题取不到时跳过 goal 档，不占位", () => {
  const model = createModel({
    goal: { status: "active", objective: "   ", summaryTitle: "  " },
    usageContextWindow: 100_000,
  });
  assert.deepEqual(
    resolveConversationStatusSummaryMetric({
      model,
      endedWorkflowRunCount: 0,
      usageTotalTokens: 7,
    }),
    { kind: "usage", totalTokens: 7 },
  );
});

test("会话计划：无 plan/goal 时展示最新一份计划的标题（缺标题交给渲染层兜底文案）", () => {
  assert.deepEqual(
    resolveConversationStatusSummaryMetric({
      model: createModel({ sessionPlans: { items: [{ title: "周末整理书桌" }] } }),
      endedWorkflowRunCount: 0,
    }),
    { kind: "sessionPlan", title: "周末整理书桌" },
  );
  assert.deepEqual(
    resolveConversationStatusSummaryMetric({
      model: createModel({
        sessionPlans: { items: [{ rowId: 1, toolCallId: "t1", markdown: "…" }] },
      }),
      endedWorkflowRunCount: 0,
    }),
    { kind: "sessionPlan", title: null },
  );
});

test("运行中计数：恰好一类沿用该类图标，混合才是 Activity 语义", () => {
  const terminalOnly = resolveConversationStatusSummaryMetric({
    model: createModel({ runningBashWorks: [{ workId: "b1" }] }),
    endedWorkflowRunCount: 0,
  });
  assert.deepEqual(terminalOnly, {
    kind: "running",
    count: 1,
    hasRunningSubagent: false,
    icon: "terminal",
  });

  const agentOnly = resolveConversationStatusSummaryMetric({
    model: createModel({ runningSubagentWorks: [{ childSessionId: "c1" }] }),
    endedWorkflowRunCount: 0,
  });
  assert.deepEqual(agentOnly, {
    kind: "running",
    count: 1,
    hasRunningSubagent: true,
    icon: "agent",
  });

  const mixed = resolveConversationStatusSummaryMetric({
    model: createModel({
      runningBashWorks: [{ workId: "b1" }],
      runningWorkflowRuns: [{ runId: "w1" }],
    }),
    endedWorkflowRunCount: 0,
  });
  assert.deepEqual(mixed, {
    kind: "running",
    count: 2,
    hasRunningSubagent: false,
    icon: "mixed",
  });
});

test("只剩已结束 run 时仍有指标（保住 run 目录入口，不回退空壳）", () => {
  const model = createModel({ usageContextWindow: 200_000 });
  assert.deepEqual(resolveConversationStatusSummaryMetric({ model, endedWorkflowRunCount: 2 }), {
    kind: "endedWorkflows",
    count: 2,
  });
  // 运行中的计数优先级高于终态 run。
  assert.deepEqual(
    resolveConversationStatusSummaryMetric({
      model: createModel({ runningBashWorks: [{ workId: "b1" }] }),
      endedWorkflowRunCount: 2,
    }),
    { kind: "running", count: 1, hasRunningSubagent: false, icon: "terminal" },
  );
});

test("收起形态可见性：无指标时 mini 不渲染、auto 只在窄容器隐藏，panel 与有指标不受影响", () => {
  // 复现路径：只有用量信号的会话 + auto（默认）形态 → 窄容器隐藏外壳，宽容器照常渲染卡片区。
  const usageOnlyModel = createModel({ usageContextWindow: 200_000 });
  const metric = resolveConversationStatusSummaryMetric({
    model: usageOnlyModel,
    endedWorkflowRunCount: 0,
    usageTotalTokens: null,
  });
  assert.equal(
    resolveConversationStatusPanelCollapsedVisibility({
      variant: "auto",
      hasSummaryMetric: Boolean(metric),
    }),
    "collapsed-only",
  );
  // mini 形态下卡片区本就不渲染，无指标时整个面板不该出现。
  assert.equal(
    resolveConversationStatusPanelCollapsedVisibility({
      variant: "mini",
      hasSummaryMetric: false,
    }),
    "hidden",
  );
  // 展开形态（panel）由卡片区分区兜底，任何指标状态都照常渲染。
  assert.equal(
    resolveConversationStatusPanelCollapsedVisibility({
      variant: "panel",
      hasSummaryMetric: false,
    }),
    "visible",
  );
  // 有指标时收起形态照常渲染（胶囊本身有内容）。
  for (const variant of ["auto", "mini"]) {
    assert.equal(
      resolveConversationStatusPanelCollapsedVisibility({ variant, hasSummaryMetric: true }),
      "visible",
    );
  }
});
