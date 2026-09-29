// 副屏（selection side chat）继承历史的 UI 投影判据（specs/selection-side-chat 第五节）。
//
// 2026-09-29 实测：副屏首屏出现「上下文已压缩」分隔线，以及父会话两条后台任务标题行。根因是
// 判据先按 semantics.kind / providerVisibility 分类、晚一步才看可见性，于是压缩载体
// （kind=timeline_event）拿到 timelineOnly 继续合成分隔线，后台唤醒载体拿到 providerContextOnly
// 仍算 model-only 唤醒触发、投影追加带 originMeta 的 turnHeader。修复后 fork 复制来的 UI 双隐藏
// 历史一律判 inheritedHistoryOnly，hydration 整条跳过。
//
// 判据自带两条回归约束，测试里逐一固定：
//   1. 普通会话的同形载体（无 forkOrigin）判据不变——压缩分隔线与后台结果标题行照常渲染；
//   2. legacy / stable fork 复制来的可见历史（有 forkOrigin 但不改可见性）照常渲染。
import assert from "node:assert/strict";
import { test } from "node:test";

const {
  getConversationMessageProjectionPolicy,
  getConversationModelOnlyTurnTriggerSource,
  isConversationRealUserTurnStarter,
} = await import("../src/conversation-message-projection-policy.ts");

const FORK_ORIGIN = { sessionId: "sess_parent", messageId: "msg_parent" };

/** 父会话自己的消息：无 forkOrigin、可见性保持原样。 */
function ordinary(info, parts = []) {
  return { info: { role: "assistant", ...info }, parts };
}

/** fork 复制进子会话的消息：叠加 forkOrigin + model-only + UI 双隐藏，保留父会话的 kind / source。 */
function inherited(info, parts = []) {
  return {
    info: {
      role: "assistant",
      ...info,
      visibility: "model-only",
      metadata: { ...info.metadata, forkOrigin: FORK_ORIGIN },
      semantics: {
        ...info.semantics,
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
    },
    parts,
  };
}

const VISIBLE_ASSISTANT_SEMANTICS = {
  origin: "system",
  kind: "timeline_event",
  uiVisibility: "visible",
  providerVisibility: "visible",
  transcriptVisibility: "visible",
};

const COMPACT_PARTS = [
  { type: "timeline", timelineType: "context_compaction", status: "completed" },
  { type: "compaction", timelineStatus: "completed", tail_start_id: "msg_tail" },
];

test("继承历史：压缩载体不再判成 timelineOnly（副屏「上下文已压缩」的开关）", () => {
  const carrier = inherited(
    { role: "assistant", semantics: VISIBLE_ASSISTANT_SEMANTICS },
    COMPACT_PARTS,
  );
  assert.equal(getConversationMessageProjectionPolicy(carrier), "inheritedHistoryOnly");
});

test("继承历史：后台唤醒载体不再是唤醒触发（副屏后台标题行的开关）", () => {
  const wake = inherited(
    {
      role: "user",
      synthetic: true,
      source: "background_task",
      semantics: {
        origin: "agent_runtime",
        kind: "background_notification",
        source: "background_task",
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
    },
    [{ type: "text", text: "<task-notification>\n<status>completed</status>" }],
  );
  assert.equal(getConversationMessageProjectionPolicy(wake), "inheritedHistoryOnly");
  assert.equal(getConversationModelOnlyTurnTriggerSource(wake), null);
});

test("继承历史：复制来的用户输入与提醒不进可见投影", () => {
  const copiedPrompt = inherited({
    role: "user",
    semantics: {
      origin: "real_user",
      kind: "user_prompt",
      uiVisibility: "visible",
      providerVisibility: "visible",
      transcriptVisibility: "visible",
    },
  });
  const copiedReminder = inherited({
    role: "user",
    synthetic: true,
    source: "todo_reminder",
    semantics: {
      origin: "agent_runtime",
      kind: "system_reminder",
      source: "todo_reminder",
      uiVisibility: "hidden",
      providerVisibility: "visible",
      transcriptVisibility: "hidden",
    },
  });
  const copiedSummary = inherited({
    role: "user",
    summary: { title: "Compact summary", body: "…" },
    semantics: {
      origin: "agent_runtime",
      kind: "compact_summary",
      uiVisibility: "hidden",
      providerVisibility: "visible",
      transcriptVisibility: "hidden",
    },
  });
  for (const message of [copiedPrompt, copiedReminder, copiedSummary]) {
    assert.equal(getConversationMessageProjectionPolicy(message), "inheritedHistoryOnly");
  }
  assert.equal(isConversationRealUserTurnStarter(copiedPrompt), false);
});

test("回归：普通会话的同形载体判据不变", () => {
  // 父会话自己的压缩载体仍产出分隔线。
  assert.equal(
    getConversationMessageProjectionPolicy(
      ordinary({ role: "assistant", semantics: VISIBLE_ASSISTANT_SEMANTICS }, COMPACT_PARTS),
    ),
    "timelineOnly",
  );

  const ordinaryWake = ordinary(
    {
      role: "user",
      synthetic: true,
      source: "background_task",
      visibility: "model-only",
      semantics: {
        origin: "agent_runtime",
        kind: "background_notification",
        source: "background_task",
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
    },
    [{ type: "text", text: "<task-notification>\n<status>completed</status>" }],
  );
  assert.equal(getConversationMessageProjectionPolicy(ordinaryWake), "providerContextOnly");
  assert.equal(getConversationModelOnlyTurnTriggerSource(ordinaryWake), "background_task");
});

test("回归：legacy / stable fork 的可见继承历史照常渲染", () => {
  const visibleCopy = {
    info: {
      role: "assistant",
      metadata: { forkOrigin: FORK_ORIGIN },
      semantics: VISIBLE_ASSISTANT_SEMANTICS,
    },
    parts: COMPACT_PARTS,
  };
  const visibleUserCopy = {
    info: {
      role: "user",
      metadata: { forkOrigin: FORK_ORIGIN },
      semantics: {
        origin: "real_user",
        kind: "user_prompt",
        uiVisibility: "visible",
        providerVisibility: "visible",
        transcriptVisibility: "visible",
      },
    },
    parts: [],
  };
  assert.equal(getConversationMessageProjectionPolicy(visibleCopy), "timelineOnly");
  assert.equal(getConversationMessageProjectionPolicy(visibleUserCopy), "realUserInput");
  assert.equal(isConversationRealUserTurnStarter(visibleUserCopy), true);
});
