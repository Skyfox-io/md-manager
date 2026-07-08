#!/usr/bin/env node
// .md Manager — a fully-local viewer/editor for every agent rules file on this machine.
// Re-discovers files on every request, so nothing here is ever stale or cached.

import { marked } from "marked";
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname, basename, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "vendor"]);
const HIDDEN_ALLOW = new Set([".cursor", ".claude", ".github", ".gemini"]);
const MAX_DEPTH = 6;
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'";

// Rules files can come from repos you didn't write. Render them as markdown only:
// raw HTML blocks/inlines are escaped to visible text, and link protocols are
// restricted, so a hostile file can't script this page or its /save endpoint.
marked.use({
  renderer: {
    html(token) {
      return esc(typeof token === "string" ? token : token.text || "");
    },
  },
  walkTokens(token) {
    if (token.type === "link" || token.type === "image") {
      const href = String(token.href || "");
      const ok = /^(https?:|mailto:|#)/i.test(href) || (!href.includes(":") && !href.startsWith("//"));
      if (!ok) token.href = "#blocked";
    }
  },
});

// ── Small utils ──────────────────────────────────────────────

function tildify(p) {
  return p.startsWith(HOME + "/") || p === HOME ? "~" + p.slice(HOME.length) : p;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function relTime(d) {
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── Config file ──────────────────────────────────────────────

function loadConfig() {
  try {
    const base = process.env.XDG_CONFIG_HOME || join(HOME, ".config");
    const file = join(base, "md-manager", "config.json");
    if (!existsSync(file)) return {};
    const json = JSON.parse(readFileSync(file, "utf8"));
    const cfg = {};
    if (Array.isArray(json.roots)) cfg.roots = json.roots.filter((r) => typeof r === "string");
    if (typeof json.edit === "boolean") cfg.edit = json.edit;
    if (typeof json.port === "number" && Number.isFinite(json.port)) cfg.port = json.port;
    if (Array.isArray(json.exclude)) cfg.exclude = json.exclude.filter((x) => typeof x === "string");
    if (Array.isArray(json.files)) cfg.files = json.files.filter((x) => typeof x === "string" && x.length > 0);
    return cfg;
  } catch {
    return {};
  }
}

// ── CLI ──────────────────────────────────────────────────────

function expandTilde(p) {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return p;
}

function parseArgs(argv) {
  const out = { roots: [], edit: undefined, port: undefined, open: undefined, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help") out.help = true;
    else if (a === "--version") out.version = true;
    else if (a === "--edit") out.edit = true;
    else if (a === "--no-edit") out.edit = false;
    else if (a === "--no-open") out.open = false;
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) out.port = Number(a.slice(7));
    else if (a.startsWith("--")) console.error(`md-manager: unknown flag ${a} (see --help)`);
    else out.roots.push(a);
  }
  return out;
}

function printHelp() {
  console.log(`md-manager [roots...] [options]

One place to read and edit every agent rules file on your machine —
CLAUDE.md, AGENTS.md, .cursor/rules, and friends. Fully local.

Arguments:
  [roots...]     Directories to scan (default: current directory)

Options:
  --edit         Enable saving (default: read-only)
  --no-edit      Force read-only, even if the config file says "edit": true
  --port <N>     Port to listen on (default: 4747)
  --no-open      Don't open the browser automatically
  --help         Show this help
  --version      Show version

Config file: ~/.config/md-manager/config.json
  { "roots": ["/abs/path"], "edit": false, "port": 4747, "exclude": ["substring"], "files": ["TEAMRULES.md", "*.rules.md"] }`);
}

// ── Discovery (live — re-run on every request) ──────────────

function shouldSkipDir(name) {
  if (SKIP_DIRS.has(name)) return true;
  if (name.startsWith(".") && !HIDDEN_ALLOW.has(name)) return true;
  return false;
}

function matchesExclude(fullPath, excludes) {
  return excludes.some((x) => fullPath.includes(x));
}

function compileFilePatterns(patterns) {
  return patterns.map((p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
}

function isRuleFile(name, dirPath, userPatterns) {
  if (name === "CLAUDE.md" || name === "CLAUDE.local.md" || name === "AGENTS.md" || name === "GEMINI.md") return true;
  const parent = basename(dirPath);
  if (name === "copilot-instructions.md" && parent === ".github") return true;
  if ((name.endsWith(".md") || name.endsWith(".mdc")) && parent === "rules" && basename(dirname(dirPath)) === ".cursor") return true;
  if (userPatterns && userPatterns.some((re) => re.test(name))) return true;
  return false;
}

function walk(dir, depth, excludes, out, userPatterns) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (matchesExclude(full, excludes)) continue;
    if (e.isDirectory()) {
      if (shouldSkipDir(e.name)) continue;
      if (depth < MAX_DEPTH) walk(full, depth + 1, excludes, out, userPatterns);
    } else if (e.isFile()) {
      if (isRuleFile(e.name, dir, userPatterns)) out.push(full);
    }
  }
}

function globalFiles() {
  return [
    join(HOME, ".claude", "CLAUDE.md"),
    join(HOME, ".claude", "CLAUDE.local.md"),
    join(HOME, ".codex", "AGENTS.md"),
    join(HOME, ".gemini", "GEMINI.md"),
  ].filter((p) => existsSync(p));
}

function makeDoc(filePath, group, name) {
  const text = readFileSync(filePath, "utf8");
  const st = statSync(filePath);
  return {
    path: filePath,
    displayPath: tildify(filePath),
    group,
    name,
    filename: basename(filePath),
    lines: text.split("\n").length,
    bytes: st.size,
    mtime: st.mtime,
    html: marked.parse(text),
  };
}

function discover(roots, excludes, userPatterns) {
  const seen = new Set();
  const groups = [];

  const globalDocs = globalFiles().map((p) => {
    seen.add(p);
    return makeDoc(p, "Global", tildify(dirname(p)));
  });
  if (globalDocs.length) groups.push({ name: "Global", docs: globalDocs });

  const basenames = roots.map((r) => basename(r));
  const counts = {};
  for (const b of basenames) counts[b] = (counts[b] || 0) + 1;

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const label = counts[basenames[i]] > 1 ? root : basenames[i];
    const found = [];
    walk(root, 0, excludes, found, userPatterns);
    const docs = [];
    for (const p of found) {
      if (seen.has(p)) continue;
      seen.add(p);
      const relDir = relative(root, dirname(p));
      const name = relDir === "" ? basename(root) : relDir;
      docs.push(makeDoc(p, label, name));
    }
    docs.sort((a, b) => a.name.localeCompare(b.name) || a.filename.localeCompare(b.filename));
    if (docs.length) groups.push({ name: label, docs });
  }

  let i = 0;
  const allDocs = [];
  for (const g of groups) {
    for (const d of g.docs) {
      d.id = `doc-${i++}`;
      allDocs.push(d);
    }
  }
  return { groups, allDocs };
}

// ── Page rendering ───────────────────────────────────────────

function renderNav(groups) {
  let i = 0;
  return groups
    .map((g) => {
      const items = g.docs
        .map((d) => {
          const delay = 40 + i++ * 35;
          const badge = d.filename !== "CLAUDE.md" ? `<span class="nav-badge">${esc(d.filename)}</span>` : "";
          return `
        <a class="nav-item" href="#${d.id}" data-doc="${d.id}" style="animation-delay:${delay}ms">
          <span class="nav-name-row"><span class="nav-name">${esc(d.name)}</span>${badge}</span>
          <span class="nav-meta">${esc(d.filename)} · ${d.lines} lines · ${relTime(d.mtime)}</span>
        </a>`;
        })
        .join("");
      return `
      <div class="nav-group">
        <div class="nav-group-label">${esc(g.name)}</div>
        ${items}
      </div>`;
    })
    .join("");
}

function renderArticles(allDocs, edit) {
  return allDocs
    .map((d) => {
      const badge = d.filename !== "CLAUDE.md" ? `<span class="doc-badge">${esc(d.filename)}</span>` : "";
      const editBtn = edit ? `<button class="btn btn-edit" data-edit="${d.id}">✎ Edit</button>` : "";
      const editor = edit
        ? `
      <div class="editor" hidden>
        <div class="editor-bar">
          <span class="editor-hint">editing raw markdown · ⌘S to save</span>
          <span class="editor-status"></span>
          <button class="btn btn-cancel">Cancel</button>
          <button class="btn btn-save">Save</button>
        </div>
        <textarea spellcheck="false"></textarea>
      </div>`
        : "";
      return `
    <article class="doc" id="panel-${d.id}" data-path="${esc(d.path)}" hidden>
      <header class="doc-header">
        <div class="doc-kicker">${esc(d.group)}</div>
        <div class="doc-title-row">
          <h1 class="doc-title">${esc(d.name)}${badge}</h1>
          ${editBtn}
        </div>
        <div class="doc-meta">
          <span class="doc-path">${esc(d.displayPath)}</span>
          <span class="doc-stats">${d.lines} lines · ${(d.bytes / 1024).toFixed(1)} KB · modified ${relTime(d.mtime)}</span>
        </div>
      </header>
      <div class="md">${d.html}</div>
      ${editor}
    </article>`;
    })
    .join("");
}

function renderPage(groups, allDocs, edit, nonce) {
  const nav = renderNav(groups);
  const articles = renderArticles(allDocs, edit);
  const totalLines = allDocs.reduce((n, d) => n + d.lines, 0);
  const chip = edit
    ? `<span class="chip chip-edit">editing enabled</span>`
    : `<span class="chip chip-ro">read-only</span>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>.md Manager</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%230C1B33'/%3E%3Ccircle cx='16' cy='21' r='4.5' fill='%23FFC53D'/%3E%3C/svg%3E">
<style>
  :root {
    --bg: #0C1B33;
    --bg-raise: #112240;
    --bg-panel: #16294B;
    --line: #243655;
    --line-soft: #1E3151;
    --ink: #FBFAF7;
    --ink-dim: #A7ACB2;
    --ink-faint: #848B95;
    --signal: #FFC53D;
    --signal-soft: rgba(255, 197, 61, .12);
    --moss: #7EC896;
    --moss-soft: rgba(126, 200, 150, .12);
    --sidebar-w: 292px;
    --grotesk: "Space Grotesk", "Avenir Next", "Helvetica Neue", system-ui, sans-serif;
    --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { color-scheme: dark; }
  body { background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
  ::selection { background: var(--signal); color: var(--bg); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: var(--line); border-radius: 5px; border: 2px solid var(--bg); }
  ::-webkit-scrollbar-track { background: transparent; }

  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 999; opacity: .35;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.04 0'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E");
  }

  .layout { display: flex; min-height: 100vh; }

  aside { width: var(--sidebar-w); flex: 0 0 var(--sidebar-w); position: sticky; top: 0; height: 100vh; overflow-y: auto; background: var(--bg-raise); border-right: 1px solid var(--line); padding: 28px 18px 40px; }
  .brand { padding: 0 10px 22px; border-bottom: 1px solid var(--line-soft); margin-bottom: 18px; }
  .brand-title { display: flex; align-items: baseline; gap: 6px; font-size: 24px; }
  .brand-dotmd { font-family: var(--mono); font-weight: 700; color: var(--ink); }
  .brand-dotmd .dot { color: var(--signal); }
  .brand-manager { font-family: var(--grotesk); font-style: normal; font-weight: 500; color: var(--ink); }
  .brand-cursor { display: inline-block; width: 8px; height: 16px; background: var(--signal); margin-left: 2px; animation: blink 1.1s steps(1) infinite; vertical-align: -2px; }
  @keyframes blink { 50% { opacity: 0; } }
  .brand-sub { font-family: var(--mono); font-size: 10px; color: var(--ink-faint); margin-top: 8px; letter-spacing: .08em; text-transform: uppercase; }

  .nav-group { margin-bottom: 20px; }
  .nav-group-label { font-family: var(--mono); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .18em; color: var(--signal); padding: 0 10px; margin-bottom: 6px; }
  .nav-item { display: block; padding: 8px 10px; border-radius: 8px; text-decoration: none; color: var(--ink-dim); border-left: 2px solid transparent; transition: background .15s, color .15s; opacity: 0; transform: translateX(-8px); animation: navIn .45s cubic-bezier(.2,.7,.3,1) forwards; }
  @keyframes navIn { to { opacity: 1; transform: none; } }
  .nav-item:hover { background: var(--bg-panel); color: var(--ink); }
  .nav-item.active { background: var(--signal-soft); color: var(--ink); border-left-color: var(--signal); border-radius: 0 8px 8px 0; }
  .nav-name-row { display: flex; align-items: center; gap: 6px; }
  .nav-name { display: block; font-size: 13.5px; font-weight: 500; }
  .nav-item.active .nav-name { color: var(--signal); }
  .nav-badge { font-family: var(--mono); font-size: 9px; color: var(--ink-faint); background: var(--bg-panel); border: 1px solid var(--line-soft); border-radius: 4px; padding: 1px 5px; }
  .nav-meta { display: block; font-family: var(--mono); font-size: 10px; color: var(--ink-faint); margin-top: 1px; }
  .totals { margin-top: 26px; padding: 12px 10px 0; border-top: 1px solid var(--line-soft); font-family: var(--mono); font-size: 10px; color: var(--ink-faint); line-height: 2.1; }
  .totals b { color: var(--moss); font-weight: 600; }
  .chip { display: inline-block; margin-top: 2px; padding: 3px 9px; border-radius: 20px; font-family: var(--mono); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
  .chip-ro { background: var(--moss-soft); color: var(--moss); border: 1px solid rgba(126,200,150,.3); }
  .chip-edit { background: var(--signal-soft); color: var(--signal); border: 1px solid rgba(255,197,61,.35); }

  main { flex: 1; min-width: 0; padding: 52px clamp(28px, 6vw, 96px) 120px; }
  .doc { max-width: 860px; animation: docIn .35s ease both; }
  @keyframes docIn { from { opacity: 0; transform: translateY(10px); } }
  .doc-header { margin-bottom: 36px; padding-bottom: 24px; border-bottom: 1px solid var(--line); }
  .doc-kicker { font-family: var(--mono); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .22em; color: var(--signal); margin-bottom: 10px; }
  .doc-title-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
  .doc-title { font-family: var(--grotesk); font-size: clamp(30px, 5vw, 44px); font-weight: 700; letter-spacing: -.025em; line-height: 1.05; }
  .doc-badge { font-family: var(--mono); font-size: 12px; font-weight: 500; color: var(--ink-faint); background: var(--bg-panel); border: 1px solid var(--line-soft); border-radius: 6px; padding: 2px 8px; margin-left: 12px; vertical-align: middle; }
  .doc-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 14px; font-family: var(--mono); font-size: 11px; }
  .doc-path { color: var(--moss); }
  .doc-stats { color: var(--ink-faint); }

  .btn { font-family: var(--mono); font-size: 11.5px; font-weight: 600; letter-spacing: .05em; cursor: pointer; border-radius: 8px; padding: 7px 14px; border: 1px solid var(--line); background: var(--bg-panel); color: var(--ink-dim); transition: color .15s, border-color .15s, background .15s; flex: none; }
  .btn:hover { color: var(--ink); border-color: var(--ink-faint); }
  .btn-edit { border-color: rgba(255,197,61,.35); color: var(--signal); margin-bottom: 6px; }
  .btn-edit:hover { background: var(--signal-soft); border-color: var(--signal); color: var(--signal); }
  .btn-save { background: var(--signal); border-color: var(--signal); color: var(--bg); }
  .btn-save:hover { background: #FFD467; border-color: #FFD467; color: var(--bg); }
  .editor-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .editor-hint { font-family: var(--mono); font-size: 10.5px; color: var(--ink-faint); margin-right: auto; }
  .editor-status { font-family: var(--mono); font-size: 10.5px; color: var(--moss); }
  .editor-status.err { color: #F07D6A; }
  .editor textarea { width: 100%; min-height: 70vh; resize: vertical; background: var(--bg-raise); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 20px 22px; font-family: var(--mono); font-size: 12.5px; line-height: 1.75; outline: none; tab-size: 2; white-space: pre; overflow-x: auto; }
  .editor textarea:focus { border-color: rgba(255,197,61,.5); }

  .md { font-size: 15px; color: var(--ink); }
  .md > * + * { margin-top: 14px; }
  .md h1, .md h2, .md h3, .md h4 { font-family: var(--grotesk); letter-spacing: -.015em; line-height: 1.2; color: var(--ink); margin-top: 34px; }
  .md h1 { font-size: 27px; font-weight: 700; }
  .md h2 { font-size: 22px; font-weight: 650; padding-bottom: 8px; border-bottom: 1px solid var(--line-soft); }
  .md h3 { font-size: 18px; font-weight: 600; color: var(--signal); }
  .md h4 { font-size: 15.5px; font-weight: 600; }
  .md p { color: var(--ink-dim); }
  .md li { color: var(--ink-dim); margin: 5px 0; }
  .md ul, .md ol { padding-left: 24px; }
  .md li::marker { color: var(--signal); }
  .md strong { color: var(--ink); font-weight: 600; }
  .md a { color: var(--moss); text-decoration-color: rgba(126,200,150,.4); text-underline-offset: 3px; }
  .md code { font-family: var(--mono); font-size: 12.5px; background: var(--bg-panel); color: var(--signal); padding: 2px 6px; border-radius: 5px; border: 1px solid var(--line-soft); }
  .md pre { background: var(--bg-panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; overflow-x: auto; }
  .md pre code { background: none; border: none; padding: 0; color: #D9DDE6; font-size: 12.5px; line-height: 1.7; }
  .md blockquote { border-left: 3px solid var(--signal); background: var(--signal-soft); padding: 10px 18px; border-radius: 0 8px 8px 0; color: var(--ink-dim); }
  .md blockquote p { color: inherit; }
  .md hr { border: none; border-top: 1px dashed var(--line); margin: 30px 0; }
  .md table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; font-size: 13.5px; }
  .md th { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: .1em; color: var(--signal); text-align: left; background: var(--bg-panel); padding: 9px 14px; border: 1px solid var(--line); }
  .md td { padding: 9px 14px; border: 1px solid var(--line-soft); color: var(--ink-dim); vertical-align: top; }
  .md tr:nth-child(even) td { background: rgba(255,255,255,.015); }

  @media (max-width: 760px) {
    .layout { flex-direction: column; }
    aside { position: static; width: 100%; height: auto; flex: none; }
  }
</style>
</head>
<body>
<div class="layout">
  <aside>
    <div class="brand">
      <div class="brand-title"><span class="brand-dotmd"><span class="dot">.</span>md</span><span class="brand-manager">manager</span><span class="brand-cursor"></span></div>
      <div class="brand-sub">every agent rules file · live</div>
    </div>
    ${nav}
    <div class="totals">${allDocs.length} files · <b>${totalLines.toLocaleString()}</b> total lines<br>${chip}<br>local only · zero network egress</div>
  </aside>
  <main>${articles}</main>
</div>
<script nonce="${nonce}">
  var EDIT = ${edit ? "true" : "false"};
  var items = document.querySelectorAll(".nav-item");
  function show(id) {
    document.querySelectorAll(".doc").forEach(function (a) { a.hidden = true; });
    items.forEach(function (n) { n.classList.toggle("active", n.dataset.doc === id); });
    var panel = document.getElementById("panel-" + id);
    if (panel) { panel.hidden = false; window.scrollTo(0, 0); }
  }
  items.forEach(function (n) {
    n.addEventListener("click", function () { show(n.dataset.doc); });
  });
  var initial = location.hash.slice(1);
  if (items.length) show(document.getElementById("panel-" + initial) ? initial : items[0].dataset.doc);

  if (EDIT) {
    document.querySelectorAll(".doc").forEach(function (doc) {
      var path = doc.dataset.path;
      var md = doc.querySelector(".md");
      var editor = doc.querySelector(".editor");
      var editBtn = doc.querySelector(".btn-edit");
      if (!editor || !editBtn) return;
      var ta = editor.querySelector("textarea");
      var status = editor.querySelector(".editor-status");

      function setStatus(msg, isErr) {
        status.textContent = msg;
        status.classList.toggle("err", !!isErr);
      }

      editBtn.addEventListener("click", function () {
        setStatus("loading…");
        fetch("/raw?path=" + encodeURIComponent(path))
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
          .then(function (text) {
            ta.value = text;
            md.hidden = true;
            editBtn.hidden = true;
            editor.hidden = false;
            setStatus("");
            ta.focus();
          })
          .catch(function (e) { setStatus("load failed: " + e.message, true); });
      });

      editor.querySelector(".btn-cancel").addEventListener("click", function () {
        editor.hidden = true;
        md.hidden = false;
        editBtn.hidden = false;
        setStatus("");
      });

      function save() {
        setStatus("saving…");
        fetch("/save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: path, content: ta.value }),
        })
          .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(t); }); })
          .then(function () {
            setStatus("saved ✓");
            setTimeout(function () { location.reload(); }, 350);
          })
          .catch(function (e) { setStatus("save failed: " + e.message, true); });
      }
      editor.querySelector(".btn-save").addEventListener("click", save);
      ta.addEventListener("keydown", function (ev) {
        if ((ev.metaKey || ev.ctrlKey) && ev.key === "s") { ev.preventDefault(); save(); }
        if (ev.key === "Escape") { editor.querySelector(".btn-cancel").click(); }
      });
    });
  }
</script>
</body>
</html>`;
}

// ── HTTP server ──────────────────────────────────────────────

function isValidHost(hostHeader, port) {
  if (!hostHeader) return false;
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  return allowed.has(hostHeader);
}

function send(res, status, body, contentType, csp) {
  res.writeHead(status, { "content-type": contentType || "text/plain; charset=utf-8", "content-security-policy": csp || CSP });
  res.end(body);
}

function openBrowser(url) {
  try {
    if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "win32") spawn("cmd", ["/c", "start", '""', url], { stdio: "ignore", detached: true }).unref();
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // non-fatal — user can open the URL manually
  }
}

function startServer({ roots, edit, port, exclude, open, filePatterns }) {
  const server = createServer((req, res) => {
    try {
      const hostHeader = req.headers.host || "";
      if (!isValidHost(hostHeader, port)) return send(res, 403, "forbidden host");

      const url = new URL(req.url, `http://${hostHeader}`);
      const pathname = url.pathname;

      if (pathname === "/raw" && req.method === "GET") {
        const { allDocs } = discover(roots, exclude, filePatterns);
        const allowed = new Set(allDocs.map((d) => d.path));
        const p = url.searchParams.get("path") || "";
        if (!allowed.has(p)) return send(res, 403, "path not allowed");
        return send(res, 200, readFileSync(p, "utf8"));
      }

      if (pathname === "/save" && req.method === "POST") {
        if (!edit) return send(res, 403, "read-only mode — restart with --edit");
        let body = "";
        let tooBig = false;
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 10_000_000) {
            tooBig = true;
            req.destroy();
          }
        });
        req.on("end", () => {
          if (tooBig) return send(res, 413, "payload too large");
          let json;
          try {
            json = JSON.parse(body);
          } catch {
            return send(res, 400, "bad request");
          }
          if (typeof json.path !== "string" || typeof json.content !== "string") return send(res, 400, "bad request");
          const { allDocs } = discover(roots, exclude, filePatterns);
          const allowed = new Set(allDocs.map((d) => d.path));
          if (!allowed.has(json.path)) return send(res, 403, "path not allowed");
          writeFileSync(json.path, json.content, "utf8");
          return send(res, 200, "ok");
        });
        return;
      }

      if (pathname === "/" && req.method === "GET") {
        const { groups, allDocs } = discover(roots, exclude, filePatterns);
        // Per-request script nonce: even if hostile markup ever slipped past the
        // renderer, an injected <script> without this nonce will not execute.
        const nonce = randomBytes(16).toString("base64");
        const csp = `${CSP}; script-src 'nonce-${nonce}'`;
        return send(res, 200, renderPage(groups, allDocs, edit, nonce), "text/html; charset=utf-8", csp);
      }

      return send(res, 404, "not found");
    } catch (err) {
      return send(res, 500, "server error: " + (err && err.message ? err.message : String(err)));
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}/`;
    console.log(`.md Manager → ${url}${edit ? " (editing enabled)" : " (read-only)"}`);
    if (open) openBrowser(url);
  });

  return server;
}

// ── Main ─────────────────────────────────────────────────────

function main() {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.help) {
    printHelp();
    return;
  }
  if (cli.version) {
    console.log(getVersion());
    return;
  }

  const config = loadConfig();
  const rootArgs = cli.roots.length ? cli.roots : config.roots && config.roots.length ? config.roots : [process.cwd()];
  const roots = rootArgs.map((r) => resolve(expandTilde(r)));
  for (const r of roots) {
    if (!existsSync(r)) console.warn(`warning: root does not exist: ${r}`);
  }
  const edit = cli.edit !== undefined ? cli.edit : !!config.edit;
  const port = cli.port !== undefined && Number.isFinite(cli.port) ? cli.port : config.port || 4747;
  const exclude = Array.isArray(config.exclude) ? config.exclude : [];
  const open = cli.open !== undefined ? cli.open : true;
  const filePatterns = compileFilePatterns(Array.isArray(config.files) ? config.files : []);

  startServer({ roots, edit, port, exclude, open, filePatterns });
}

main();
