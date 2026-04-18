---
name: auto-wrap-exe
description: Build a Windows Tauri project and package the result into a single app.exe artifact. Use when the user asks to wrap up, package, export, or compile a desktop program into an exe file (especially app.exe).
---

# Auto Wrap EXE

Use this skill to produce `app.exe` in a predictable location for Windows desktop builds.

## Workflow

1. Verify the project is a Tauri app by checking `src-tauri/tauri.conf.json`.
2. Run the build script from repo root:
   `powershell -ExecutionPolicy Bypass -File skills/auto-wrap-exe/scripts/build-app-exe.ps1`
3. If the user asks for a custom artifact folder, pass:
   `-OutputDir "<absolute-or-relative-path>"`
4. If build output is locked by a running app process, rerun with:
   `-ForceStopRunningApp`
5. Read script output and report:
   - `SOURCE_EXE`
   - `TARGET_EXE`
6. If build fails, return the exact failing command and the minimum required fix.

## Notes

- Default output is `<repo>/artifacts/app.exe`.
- The script prefers `src-tauri/target/release/app.exe`, then falls back to the newest release `.exe`.
- Keep logs concise and do not add telemetry or network calls.
