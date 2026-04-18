## Windows Calendar 常驻提醒小应用（Tauri + React）实施方案

### 1. Summary
- 从零搭建 `Tauri + React + TypeScript` Windows 桌面应用，默认中文界面。
- 托盘常驻：开机自启，点击托盘图标显示/隐藏主窗口；点击窗口关闭按钮默认“最小化到托盘”。
- 主窗口按“屏幕面积约 1/12 + 4:3 比例”动态计算，并设置最小尺寸，满足小浮窗工具形态。
- 顶部滑动切换 3 页：`日历`（月/周视图）、`近期待办`、`未来 DDL`；三页都支持新增/编辑/删除。
- 提醒支持：`Windows 通知+铃声` 为默认，且支持 `5/15/30 分钟`稍后提醒（Snooze）。

### 2. Implementation Changes
- **工程与运行时**
  - 初始化 Tauri 项目（Vite + React TS）。
  - 启用系统托盘、单实例、开机自启、通知权限。
  - 约定窗口行为：`minimize/close => hide to tray`，托盘点击切换显隐。
- **数据模型（SQLite，本地）**
  - 单表统一事项模型：`items`
  - 字段：`id, type(todo|ddl|event), title, note, due_at, done, remind_enabled, remind_offsets(json), next_remind_at, created_at, updated_at`
  - 设置表：`settings`
  - 字段：`reminder_mode(toast_sound|toast_only|in_app_only), default_offsets, window_state`
- **提醒调度与执行**
  - Rust 后台调度器每 30s 扫描 `next_remind_at <= now && done=false && remind_enabled=true`。
  - 触发提醒后：
    - 按设置发送系统通知（含声音策略）。
    - 同步写入“当前提醒队列”（供前端展示可操作提醒卡）。
  - 前端提醒卡操作：`完成`、`稍后 5/15/30 分钟`、`忽略本次`，操作后更新 `next_remind_at`。
- **前端交互**
  - 顶部分段滑动切换（Calendar / Todo / DDL）。
  - 日历页：月视图+周视图切换；支持点日期后快速新增。
  - 待办/DDL 页：按时间排序（近到远），支持搜索与状态筛选（全部/未完成/已完成）。
  - 左下角设置：提醒形式、默认提前提醒时间、是否开机自启。
- **窗口尺寸规则**
  - 以当前屏幕面积 `A` 计算窗口面积 `A/12`，按 4:3 解得宽高。
  - 增加最小尺寸（例如 420x315）防止高分屏过小；记录上次位置。

### 3. Public APIs / Interfaces
- Tauri `invoke` 命令（由前端调用）：
  - `list_items(range, type, status)`
  - `create_item(payload)`
  - `update_item(id, payload)`
  - `delete_item(id)`
  - `mark_item_done(id, done)`
  - `snooze_item(id, minutes)`
  - `get_settings() / update_settings(payload)`
- 前端类型（TS）：
  - `CalendarItem`, `ReminderSettings`, `ReminderAlert`, `PageTab`

### 4. Test Plan
- **Rust 单元测试**
  - 提醒时间计算（默认偏移、跨天、过期补偿）。
  - Snooze 逻辑（5/15/30 分钟后 `next_remind_at` 正确）。
- **前端单元测试（Vitest）**
  - 事项表单校验、列表筛选排序、月/周视图切换状态。
- **端到端验收（手测清单）**
  1. 托盘图标可常驻；点击可显隐窗口。
  2. 关闭按钮不会退出，应用仍可提醒。
  3. 三个页面可滑动切换，并可各自新增/编辑/删除。
  4. DDL 到期前 1 天、1 小时、准点分别触发提醒。
  5. 点击稍后提醒后，在对应时间再次提醒。
  6. 设置修改后立即生效并持久化，重启后保持。

### 5. Assumptions / Defaults
- 初版仅本地离线，不做账号与云同步。
- 默认提醒偏移：`1 天 + 1 小时 + 准点`。
- 默认提醒模式：`Windows 通知+铃声`。
- 默认语言：中文；主题先采用浅色简洁风。
- 仅 Windows 平台作为首发目标。
