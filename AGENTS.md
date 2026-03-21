# Repository Working Rules

## Environment
- Default to WSL for all repository work.
- Use WSL for reading files, editing files, running tests, and running git/node/npm commands.
- Use PowerShell only for Windows-only tasks such as launching Chrome, configuring netsh, or Windows firewall changes.

## Editing
- Do not use apply_patch in this repository.
- For non-trivial edits, write a temporary script into the WSL filesystem and execute it from WSL.
- Prefer direct WSL file edits over shell one-liners that depend on fragile cross-shell quoting.
- Do not use patch-style string-splicing edits for content with nested quotes, Chinese text, or Windows paths. In those cases, write a WSL temp script that rewrites the target block directly, then read the file back to verify the result.
- If an exact multiline marker replacement fails once, stop and inspect the current file contents from WSL before trying again. Then switch to a smaller stable anchor or direct insertion point instead of retrying the same full-block replacement.
- Treat exact whole-block string matching as fragile after any prior edits, formatting drift, BOM/newline differences, or partial changes. Do not assume the file still matches the original marker text.

## State Management
- After context compression or interruptions, treat the most recently confirmed successful state as the baseline. Do not rerun or re-debug steps that were already confirmed unless there is new evidence they regressed.
- Before doing new investigation, first read the current file state or current terminal output from WSL and continue from that state instead of replaying stale reasoning.

## Validation
- Run tests from WSL.
- After edits, verify the changed files or behavior from WSL before reporting completion.
- When code search tooling like `rg` fails in the current environment, fall back to simpler WSL-native reads such as `grep`, `sed`, or direct file slices instead of retrying fragile search commands.

## Command Patterns
- Before doing any repository work, read AGENTS.md first and then use only the canonical `wsl.exe -d Ubuntu-24.04 --cd /home/tank/job-search-2026/jobs-filter ...` path for commands. If a command path deviates from that rule, stop and reset instead of experimenting with alternate shells or quoting layers.
- Preferred cross-boundary pattern: use PowerShell only to invoke `wsl.exe -d Ubuntu-24.04 --cd /home/tank/job-search-2026/jobs-filter ...` and do the real work inside WSL.
- Do not experiment with alternate Windows/UNC workdir shells once a WSL command pattern has already been proven to work for the current task.
- If a Windows-WSL issue is solved with a reusable workflow, add a short repository rule for it here before moving on.

## Git Workflow
- Before committing, run git status --short from WSL and confirm which files should be included.
- Stage intended files explicitly, then commit from WSL.
- After committing, immediately run git log -1 --oneline and git status --short from WSL to confirm the commit actually landed and the worktree is clean.
- If a commit message is getting mangled by Windows/WSL quoting, do not keep retrying nested shell quoting. Either use a simple safe message without spaces or create the message inside WSL and use git commit -F <message-file>.

## Documentation
- Treat README and other Chinese text files as encoding-sensitive.
- Edit those files using stable WSL-based methods only.


