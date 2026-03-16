# Repository Working Rules

## Environment
- Default to WSL for all repository work.
- Use WSL for reading files, editing files, running tests, and running git/node/npm commands.
- Use PowerShell only for Windows-only tasks such as launching Chrome, configuring netsh, or Windows firewall changes.

## Editing
- Do not use apply_patch in this repository.
- For non-trivial edits, write a temporary script into the WSL filesystem and execute it from WSL.
- Prefer direct WSL file edits over shell one-liners that depend on fragile cross-shell quoting.

## Validation
- Run tests from WSL.
- After edits, verify the changed files or behavior from WSL before reporting completion.

## Documentation
- Treat README and other Chinese text files as encoding-sensitive.
- Edit those files using stable WSL-based methods only.
