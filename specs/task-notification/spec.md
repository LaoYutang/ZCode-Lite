# 任务通知点击唤起窗口

## 背景

会话完成或需要用户输入时，主进程通过系统通知提醒（`desktopNotifications.ts`）。用户点击通知后，主进程依次做三件事：把目标窗口带回前台、向 renderer 发送 `PlatformChannels.TaskNotificationClick`（renderer 据此切换到对应会话）、写一条点击日志。

本机实测存在一类故障：**点击 Windows 通知回到客户端后界面完全冻结**。冻结期间窗口状态一切正常——非最小化、可见、未被系统判定挂起、已在前台——但画面停在点击瞬间：秒表停在"1 秒"，转圈动画不动；同期 renderer 进程 42 秒只消耗 0.17s CPU，GPU 进程 0.01s；窗口区域连拍 14 张（7.2 秒）逐像素完全相同。用户双击页面任意位置、或"再最小化一次再打开"之后立刻恢复正常。

根因（Electron 41.0.3 实机探针）：

1. Windows 上窗口被其他窗口完全覆盖时，Chromium 会把该页判定为不可见（实测 `document.visibilityState === "hidden"`，rAF 从 143 只涨到 154，等同停止）。这是正常行为，问题在于激活后并不总会恢复。
2. 唤醒它需要的是一次**真实的窗口状态/可见性切换**。最小化→恢复之所以有效（用户手动验证、同段取证里两次点击的 A/B 也印证：最小化那次走了 `restore()`，恢复后画面正常；仅 `focus()` 的那次，激活瞬间出了 2 帧之后一直冻结），是因为它就是真实状态切换。
3. `focus()` 本身不带来任何可见性变化，所以"窗口已经可见、只是被覆盖或失焦"这一状态下，原有的 `restore/show/focus` 三步一步都不产生切换，页面留在不可见状态。

## 规则

### 一、唤起动作按窗口进入时的状态三选一，互斥

| 进入时状态 | 动作 | 理由 |
| --- | --- | --- |
| 最小化 | `restore()` | 已经是真实状态切换，实测恢复后画面正常 |
| 不可见（隐藏） | `show()` | 同上，`show` 本身就是可见性切换 |
| 可见且非最小化 | Windows 上补 `hide()` + `show()` | 这个组合原先只会走到 `focus()`，没有任何切换 |

三类判定一律用**动作执行前**读取的窗口状态，避免 `restore()`/`show()` 改变状态后误判成第三类、白做一次切换。

### 二、`hide()` 与 `show()` 必须同一 tick 完成，不得插入延迟

实测页面在 3ms 内先后收到 `hidden`/`visible`（真实送达，不是被合并掉），而 DWM 合成一帧需要 16.7ms，因此屏幕上不会出现中间态，任务栏按钮也来不及重绘。

明确否决 `hide() → 延迟 80ms → show()`：页面同样能收到切换，但窗口区域会在这 80ms 里露出后面的内容（被完整覆盖时看不到），任务栏按钮会消失约 80ms。

### 三、动作边界

- 只在 Windows 分支动作；macOS 仍走 `app.dock.show()/app.show()/app.focus({ steal: true })`，Linux 不动作。
- 该动作只切换可见性，不接管焦点；焦点仍由调用方在最后统一 `focus()`。
- 只在"点通知把窗口带回前台"这一条路径上使用。托盘恢复（`primaryWindowCoordinator.ts`）与深链回跳（`desktopWorkspaceDeepLink.ts`）的窗口状态组合不同，需要单独验证后再决定是否复用。

## 否决的替代方案

- **只补 `webContents.invalidate()`**：冻结点是"页面被判定不可见"，请求一帧不恢复 rAF/定时器。真实复现里激活瞬间本来就出了 2 帧，随后照样冻结 7 秒。
- **给 `attachWindowsWindowRepaint` 挂 `focus`/`restore` 重绘钩子**：同上，请求一帧解决不了可见性状态；`restore()` 实测既不触发 `show` 也不触发 `resized`，挂载点本身也覆盖不到该路径。
- **常开 `webContents.setBackgroundThrottling(false)`**：实测在 hidden 状态下能把 rAF 拉回 60fps（3 秒 +182 帧），但会让被遮挡的窗口持续满帧渲染，功耗代价不可接受（`createBrowserWindow` 的注释已说明同一取舍）。仅作为本方案失效时的后备手段。
- **直接 `minimize()` + `restore()`**：用户可见的窗口抖动，等于把用户的手动 workaround 自动化。

## 验收场景

1. Windows：窗口可见但被其他窗口覆盖/非前台时点通知 → 窗口回到前台，且画面立即继续刷新（秒表/动画继续走）。
2. Windows：窗口处于最小化时点通知 → 行为与改动前一致（`restore()` 路径不变）。
3. Windows：窗口隐藏在托盘时点通知 → 行为与改动前一致（`show()` 路径不变）。
4. macOS / Linux：行为不变。

## 证据与验证

- 单测：`packages/desktop/test/windowVisibilityWake.test.mjs` 锁定三条互斥分支与 `hide`→`show` 顺序。
- 复现取证与探针（probe9：遮挡 → hidden → rAF 停止；同 tick hide/show → 页面 3ms 内收到 hidden/visible；节流开关在 hidden 下恢复 60fps）都在临时目录的探针工程里，**不改动仓库代码**。
- 冻结是否彻底消除需要重建桌面端后在真实通知路径上验证（探针未能复现"激活后切不回来"这一步）。
