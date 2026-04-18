# Windows Calendar

A lightweight desktop planner for Windows focused on deadlines and daily execution.

Windows Calendar runs as a compact always-on-top app, keeps working in the system tray, and reminds you before things are due so important tasks do not slip.

## What It Does

- Manage two task types:
  - `TODO`: near-term actionable tasks
  - `DDL`: hard deadlines
- Calendar view with month/week switch for quick planning.
- Task lists for upcoming TODOs and future DDLs.
- Reminder system with Windows notifications and optional sound.
- Quick snooze options (`5 / 15 / 30 min`) directly from reminder cards.
- DDL safety behavior:
  - Each DDL can be postponed once.
  - Expired DDLs can be converted to TODO for follow-up.
- System tray support:
  - Keep app running in tray
  - Close-to-tray behavior
  - Auto-start with Windows
- Data stored locally with SQLite.

## Download and Install

1. Open the [Releases](https://github.com/3B4T/DDL-management-Calendar/releases) page.
2. Download `Windows-Calendar-Setup.exe` from the latest release assets.
3. Run `Windows-Calendar-Setup.exe` and follow the installer.

For `v0.1.2+`, the release build uses a new app identifier and a fresh local app-data directory by default, so installer packages do not ship your existing personal task data.

If Windows SmartScreen appears, click `More info` and then `Run anyway` (only if you trust this repository).

## Quick Start

1. Create a TODO or DDL item.
2. Set due time and reminder offsets.
3. Keep the app in tray while you work.
4. When reminders pop up, choose complete, edit, or snooze.

## Privacy

- This app is local-first.
- Your tasks and settings are saved on your machine (SQLite).
- No cloud sync or analytics is required for normal use.

## Tech Stack

- Tauri (Rust backend)
- React + TypeScript (frontend)
- SQLite (local persistence)

## Local Development

### Prerequisites

- Node.js 18+
- Rust toolchain
- Tauri prerequisites for Windows

### Run

```bash
npm install
npm run dev
```

### Test

```bash
npm test
```

### Frontend Build

```bash
npm run build
```

### Desktop Build (Tauri)

```bash
cargo tauri build
```

Built executables are generated under `src-tauri/target/release/` (or copied to `artifacts/` when using project scripts).
