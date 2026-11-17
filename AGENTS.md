# Project Rules — AURA_Assistant

## 1. Git Auto-Commit & Push Workflow
Per repository owner instructions, whenever making any code update, bug fix, feature addition, or documentation change inside `D:\AURA_Assistant`:
1. Run relevant syntax checks / tests before committing (`node -c` on modified JS files, or targeted test scripts).
2. Inspect `git status` and `git diff` to verify that **zero secrets** (`.env`, API keys, tokens) and zero ignored artifacts (`node_modules/`, `runtime/`, `models/`, `logs/`, `reports/`, `bin/`, `obj/`) are staged.
3. Commit with a clear, descriptive commit message and attempt a non-interactive push (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`) to `origin main` (`https://github.com/vietthinha86-cell/AURA_Assistant.git`). Never let `git push` hang waiting for an interactive credential prompt; if blocked by authentication, report clearly and provide `git -C "D:\AURA_Assistant" push origin main` for the owner to run.

*(Note: This workflow applies to the developer / coding agent maintaining the codebase. Inside Aura's own runtime `tool_definitions.js` / `tool_executor.js`, safety guards preventing the voice assistant itself from running arbitrary `git push` commands remain enforced.)*

## 2. Architecture & Safety Conventions
- Keep all heavy local runtimes (`runtime/`, `models/`), caches (`logs/tts_cache/`), and API keys (`.env`) untracked.
- Update `.env.example` (with blank secrets) whenever new environment variables are introduced.
- Keep README documentation in sync when adding or modifying tools in `src/module_e_brain/tool_definitions.js`.
