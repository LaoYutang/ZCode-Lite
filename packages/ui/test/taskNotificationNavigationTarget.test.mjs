import assert from "node:assert/strict";
import { test } from "node:test";

const { resolveTaskNotificationNavigationTarget } =
  await import("../src/lib/taskNotificationNavigationTarget.ts");

// 回归背景：通知点击原先只读 workspaceState.taskListCache，而该缓存在任务列表迁到
// task query cache 后不再被填充，非"当前激活任务"的通知点击一定会落到 not found，
// 表现为点了通知窗口回前台但界面停在原会话。这里锁定新的反查顺序与回退行为。
test("query cache 命中时用 task meta 自带的 workspacePath 与 workspaceIdentity", () => {
  const target = resolveTaskNotificationNavigationTarget({
    taskId: "sess_remote",
    taskMetaByEntityKey: {
      "remote-host::sess_remote": {
        taskId: "sess_remote",
        workspacePath: "/home/me/project",
        workspaceIdentity: "remote-host",
      },
    },
    workspaces: {},
  });

  assert.deepEqual(target, { workspacePath: "/home/me/project", workspaceIdentity: "remote-host" });
});

test("query cache 优先于 activeTaskId 回退", () => {
  const target = resolveTaskNotificationNavigationTarget({
    taskId: "sess_a",
    taskMetaByEntityKey: {
      "D:\\ProjectA::sess_a": { taskId: "sess_a", workspacePath: "D:\\ProjectA" },
    },
    workspaces: {
      "D:\\ProjectB": { activeTaskId: "sess_a" },
    },
  });

  assert.deepEqual(target, { workspacePath: "D:\\ProjectA" });
});

test("query cache 未命中时回退到该 workspace 的激活任务", () => {
  const target = resolveTaskNotificationNavigationTarget({
    taskId: "sess_draft",
    taskMetaByEntityKey: {},
    workspaces: {
      "D:\\ProjectB": { activeTaskId: "sess_other" },
      "D:\\Workspace\\现场项目": { activeTaskId: "sess_draft" },
    },
  });

  assert.deepEqual(target, { workspacePath: "D:\\Workspace\\现场项目" });
});

test("草稿提升或刚创建的任务从乐观池反查", () => {
  const target = resolveTaskNotificationNavigationTarget({
    taskId: "sess_local",
    taskMetaByEntityKey: {},
    workspaces: {
      "D:\\ProjectB": {
        activeTaskId: null,
        optimisticTaskListByTaskId: {
          sess_local: {
            taskId: "sess_local",
            workspacePath: "D:\\ProjectB",
            workspaceIdentity: "local-device",
          },
        },
      },
    },
  });

  assert.deepEqual(target, { workspacePath: "D:\\ProjectB", workspaceIdentity: "local-device" });
});

test("三处都查不到时返回 null（保持既有失败语义，不回退到最近活跃会话）", () => {
  const target = resolveTaskNotificationNavigationTarget({
    taskId: "sess_missing",
    taskMetaByEntityKey: {
      "D:\\ProjectA::sess_a": { taskId: "sess_a", workspacePath: "D:\\ProjectA" },
    },
    workspaces: {
      "D:\\ProjectB": { activeTaskId: "sess_other", optimisticTaskListByTaskId: {} },
    },
  });

  assert.equal(target, null);
});
