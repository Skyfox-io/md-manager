<img src="https://raw.githubusercontent.com/Skyfox-io/md-manager/main/assets/logo.svg" width="96">

# .md Manager

A local web viewer and editor for every agent rules file on your machine.

![.md Manager](https://raw.githubusercontent.com/Skyfox-io/md-manager/main/docs/screenshot.png)

## Why

Every coding agent reads some kind of instruction file: `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/`, `copilot-instructions.md`. They multiply across repos fast, and nobody has one place to read all of them — now you do.

## Quick start

View the current directory:

```
npx md-manager
```

View a specific folder:

```
npx md-manager path/to/your/code
```

Opens `http://localhost:4747` and launches your browser automatically; pass `--no-open` to skip that. Requires Node 18+ or Bun.

## Editing

Read-only by default. Pass `--edit` to allow saving:

```
npx md-manager path/to/your/code --edit
```

Click into a file, edit it, hit Cmd+S or Ctrl+S — it writes straight to disk. No formatting, linting, or auto-commit; if the file is tracked in git, your edit shows up as a normal uncommitted diff.

## Options

| Flag | Effect |
|---|---|
| `[roots...]` | Directories to scan (positional, default: current directory) |
| `--edit` | Allow saving changes back to disk |
| `--no-edit` | Force read-only, even if the config file says `"edit": true` |
| `--port <N>` | Listen on port `<N>` (default: `4747`) |
| `--no-open` | Don't open a browser tab on start |
| `--help` | Print usage |
| `--version` | Print the installed version |

Optional config file at `~/.config/md-manager/config.json`, used in place of CLI arguments:

```json
{
  "roots": ["~/your-code-folder"],
  "edit": false,
  "port": 4747,
  "exclude": ["archive"],
  "files": ["TEAMRULES.md", "*.rules.md"]
}
```

`roots` accepts `~` — it expands to your home directory. `edit` turns on saving. `port` changes what it binds to. `exclude` is a list of substrings; any discovered path containing one is dropped. `files` adds extra rules-file names to look for alongside the built-ins, matched against each file's basename (`*` is the only wildcard) — use whatever names your setup actually has, the ones above are just examples. CLI arguments always override the config file.

Other ways to run it: `bunx md-manager path/to/your/code --edit` with Bun, `npx github:Skyfox-io/md-manager` straight from GitHub, or `git clone https://github.com/Skyfox-io/md-manager && cd md-manager && npm install && node server.js path/to/your/code --edit`.

## Set it up with your agent

Read-only:

```
Set up md-manager (npm package "md-manager", https://github.com/Skyfox-io/md-manager).
Find the folders where I keep my code, write them as "roots" in
~/.config/md-manager/config.json. Show me the config, then run `npx md-manager` and give me the URL.
```

With editing:

```
Set up md-manager (npm package "md-manager", https://github.com/Skyfox-io/md-manager).
Find the folders where I keep my code, write them as "roots" in
~/.config/md-manager/config.json, with "edit": true so saves from the browser work.
Show me the config, then run `npx md-manager` and give me the URL.
```

The whole setup is one small JSON file — open `~/.config/md-manager/config.json` to see exactly what was configured.

## What it finds

Per root, up to 6 levels deep, skipping `node_modules`, `.git`, and hidden directories (except `.cursor`, `.claude`, `.gemini`, and `.github`):

- `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`
- `.github/copilot-instructions.md`
- `.cursor/rules/*.md` and `*.mdc`
- `~/.claude/CLAUDE.md`, `~/.claude/CLAUDE.local.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` — always included, regardless of roots

It re-scans on every page load — no restart needed to see a new file.

## Security

- Binds to `127.0.0.1` — nothing outside your machine can reach it.
- Zero network requests. No fonts, CDNs, analytics, or telemetry.
- Read-only unless you pass `--edit`.
- Serves and saves only the files it discovered — nothing else on disk.
- Rendered markdown can't run scripts: raw HTML is escaped, CSP on every response.
- Foreign `Host` headers are rejected (blocks DNS rebinding).

One file, one dependency (`marked`), about 600 lines. Read it: `server.js`.

## License

MIT.
