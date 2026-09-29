import assert from "node:assert/strict";
import test from "node:test";
import {
  needsWindowsWindowVisibilityWake,
  wakeWindowsWindowVisibility,
} from "../src/main/desktopWindowVisibilityWake.ts";

// 回归背景：点 Windows 通知把“已可见、只是被其他窗口覆盖/失焦”的窗口带回前台时，
// Chromium 已把该页按不可见处理并停帧，原实现只调用 focus()，界面会停在最后一帧。
// 这里锁定三条互斥分支：只有“可见且非最小化”才补一次同 tick 的 hide→show。
function createFakeWindow(calls) {
  return {
    hide: () => calls.push("hide"),
    show: () => calls.push("show"),
  };
}

test("Windows：可见且非最小化的窗口补一次同 tick 的 hide→show", () => {
  const calls = [];
  wakeWindowsWindowVisibility(createFakeWindow(calls), {
    platform: "win32",
    wasMinimized: false,
    wasVisible: true,
  });
  assert.deepEqual(calls, ["hide", "show"]);
});

test("Windows：最小化的窗口交给 restore()，不重复补切换", () => {
  const calls = [];
  wakeWindowsWindowVisibility(createFakeWindow(calls), {
    platform: "win32",
    wasMinimized: true,
    wasVisible: false,
  });
  assert.deepEqual(calls, []);
});

test("Windows：不可见的窗口交给 show()，不重复补切换", () => {
  const calls = [];
  wakeWindowsWindowVisibility(createFakeWindow(calls), {
    platform: "win32",
    wasMinimized: false,
    wasVisible: false,
  });
  assert.deepEqual(calls, []);
});

test("Windows：最小化同时不可见时同样不重复补切换", () => {
  const calls = [];
  wakeWindowsWindowVisibility(createFakeWindow(calls), {
    platform: "win32",
    wasMinimized: true,
    wasVisible: true,
  });
  assert.deepEqual(calls, []);
});

test("非 Windows 平台不动作", () => {
  for (const platform of ["darwin", "linux"]) {
    const calls = [];
    wakeWindowsWindowVisibility(createFakeWindow(calls), {
      platform,
      wasMinimized: false,
      wasVisible: true,
    });
    assert.deepEqual(calls, [], platform);
  }
});

test("判定与动作使用同一套条件", () => {
  assert.equal(
    needsWindowsWindowVisibilityWake({ platform: "win32", wasMinimized: false, wasVisible: true }),
    true,
  );
  assert.equal(
    needsWindowsWindowVisibilityWake({ platform: "win32", wasMinimized: true, wasVisible: true }),
    false,
  );
  assert.equal(
    needsWindowsWindowVisibilityWake({ platform: "darwin", wasMinimized: false, wasVisible: true }),
    false,
  );
});
