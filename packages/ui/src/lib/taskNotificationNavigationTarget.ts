interface TaskNotificationNavigationTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 结构化的 task meta：query cache（`ZCodeTaskListItem`）与乐观池（`ZCodeTaskMeta`）都满足，
 * 这里只声明反查真正需要的字段，避免把某一层的类型拉进 lib。
 */
interface TaskNotificationTaskMeta {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

interface TaskNotificationWorkspaceState {
  activeTaskId: string | null;
  optimisticTaskListByTaskId?: Record<string, TaskNotificationTaskMeta>;
}

interface TaskNotificationNavigationSources {
  taskId: string;
  /**
   * task query cache（key 为 entity key）。任务列表迁移后的唯一事实源，
   * 按钮导航、前进/后退、quickpick 都从这里取 task meta。
   */
  taskMetaByEntityKey: Record<string, TaskNotificationTaskMeta>;
  /** session store 的 workspace 快照，仅用于 query cache 尚未覆盖的本地乐观任务与当前激活任务。 */
  workspaces: Record<string, TaskNotificationWorkspaceState>;
}

/**
 * 通知点击时把 taskId 反查成它所属的 workspace。
 *
 * 旧实现只读 `workspaceState.taskListCache`，而那份缓存在任务列表迁到 task query cache 后
 * 不再被填充（写入点都要求它原本就非 null），于是只有"被点任务已经是当前激活任务"才命中，
 * 其余情况一律 not found、界面不动。这里按 query cache → 乐观池/激活任务 的顺序反查。
 */
export function resolveTaskNotificationNavigationTarget(
  params: TaskNotificationNavigationSources,
): TaskNotificationNavigationTarget | null {
  for (const task of Object.values(params.taskMetaByEntityKey)) {
    if (task.taskId === params.taskId) {
      return {
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      };
    }
  }

  for (const [workspacePath, workspaceState] of Object.entries(params.workspaces)) {
    if (workspaceState.activeTaskId === params.taskId) {
      return { workspacePath };
    }

    for (const task of Object.values(workspaceState.optimisticTaskListByTaskId ?? {})) {
      if (task.taskId !== params.taskId) {
        continue;
      }

      return {
        workspacePath: task.workspacePath ?? workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      };
    }
  }

  return null;
}
