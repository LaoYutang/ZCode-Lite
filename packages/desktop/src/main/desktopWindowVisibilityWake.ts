import type { BrowserWindow } from "electron";

interface WindowVisibilityWakeState {
  platform: NodeJS.Platform;
  /** 动作执行前的窗口状态：此时 restore/show 已经覆盖了这两种情况的真实状态切换。 */
  wasMinimized: boolean;
  wasVisible: boolean;
}

export function needsWindowsWindowVisibilityWake(state: WindowVisibilityWakeState): boolean {
  return state.platform === "win32" && !state.wasMinimized && state.wasVisible;
}

/**
 * Windows 专用：给“本来就可见、只是被其他窗口覆盖或失焦”的窗口补一次真实可见性切换。
 *
 * 这种状态下 Chromium 已经把该窗口的页面按不可见处理（实测 `document.visibilityState === "hidden"`，
 * rAF 停止、定时器节流），此时只调用 `focus()` 不产生任何可见性变化，页面会停在最后一帧，
 * 表现成“窗口回来了但界面冻结”；restore/show 之所以能救活，是因为它们本身就是真实状态切换。
 *
 * 两个调用必须同一 tick 完成：实测页面在 3ms 内先后收到 hidden/visible，而 DWM 合成一帧需要 16.7ms，
 * 屏幕上不会出现中间态；插入延迟则会让窗口区域露出后面的内容、任务栏按钮消失同样长的时间。
 */
export function wakeWindowsWindowVisibility(
  targetWindow: Pick<BrowserWindow, "hide" | "show">,
  state: WindowVisibilityWakeState,
): void {
  if (!needsWindowsWindowVisibilityWake(state)) {
    return;
  }

  targetWindow.hide();
  targetWindow.show();
}
