#!/usr/bin/env node
// Black-box tests: spawn the real server as a child process against fixture
// trees and assert over HTTP. No mocking of server internals — this exercises
// the same code paths a real client would hit.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "server.js");

function randomPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

function request(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: { host: `localhost:${port}`, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitReady(port, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await request(port, "/");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`server on port ${port} did not become ready within ${timeoutMs}ms`);
}

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "mdmgr-fixture-"));
  const home = mkdtempSync(join(tmpdir(), "mdmgr-home-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, ".config", "md-manager"), { recursive: true });

  writeFileSync(
    join(project, "CLAUDE.md"),
    "# Project Rules\n\nFollow these guidelines.\n\n<script>alert(1)</script>\n\n[click me](javascript:alert(1))\n"
  );
  writeFileSync(join(project, "AGENTS.md"), "# Agents rules\n");
  writeFileSync(join(project, "GEMINI.md"), "# Gemini rules\n");
  writeFileSync(join(project, "TEAMRULES.md"), "# Team rules (custom pattern)\n");
  writeFileSync(join(project, "NOTES.md"), "# Just notes, not a rules file\n");

  writeFileSync(join(home, ".config", "md-manager", "config.json"), JSON.stringify({ files: ["TEAMRULES.md"] }));

  return { root, home, project };
}

function spawnServer(fixture, port, extraArgs) {
  return spawn(process.execPath, [SERVER_PATH, fixture.project, "--port", String(port), "--no-open", ...extraArgs], {
    env: { ...process.env, HOME: fixture.home },
    stdio: "ignore",
  });
}

let fixture, roPort, editPort, roProc, editProc;

before(async () => {
  fixture = buildFixture();
  roPort = randomPort();
  editPort = randomPort() + 1;
  roProc = spawnServer(fixture, roPort, []);
  editProc = spawnServer(fixture, editPort, ["--edit"]);
  await Promise.all([waitReady(roPort), waitReady(editPort)]);
});

after(() => {
  roProc.kill();
  editProc.kill();
});

test("GET / serves 200 with CSP header and script nonce", async () => {
  const res = await request(roPort, "/");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-security-policy"], /script-src 'nonce-[^']+'/);
  assert.match(res.body, /<script nonce="[^"]+">/);
  assert.match(res.body, /CLAUDE\.md/);
});

test("discovery: built-ins, GEMINI.md, and custom pattern found; decoy excluded", async () => {
  const res = await request(roPort, "/");
  for (const name of ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "TEAMRULES.md"]) {
    assert.ok(res.body.includes(name), `expected ${name} in discovered index`);
  }
  assert.ok(!res.body.includes("NOTES.md"), "decoy NOTES.md must not be discovered");
});

test("/raw: 200 with exact content for a discovered file, 403 outside the allowlist", async () => {
  const claudePath = join(fixture.project, "CLAUDE.md");
  const expected = readFileSync(claudePath, "utf8");
  const ok = await request(roPort, `/raw?path=${encodeURIComponent(claudePath)}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body, expected);

  const passwd = await request(roPort, `/raw?path=${encodeURIComponent("/etc/passwd")}`);
  assert.equal(passwd.status, 403);

  const traversal = await request(roPort, `/raw?path=${encodeURIComponent(join(fixture.project, "..", "..", "etc", "passwd"))}`);
  assert.equal(traversal.status, 403);
});

test("read-only instance: /save is rejected even for a discovered file", async () => {
  const claudePath = join(fixture.project, "CLAUDE.md");
  const res = await request(roPort, "/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: claudePath, content: "nope" }),
  });
  assert.equal(res.status, 403);
});

test("--edit instance: /save writes a discovered file, rejects a path outside the set", async () => {
  const agentsPath = join(fixture.project, "AGENTS.md");
  const newContent = "# updated agents rules\n";
  const res = await request(editPort, "/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: agentsPath, content: newContent }),
  });
  assert.equal(res.status, 200);
  assert.equal(readFileSync(agentsPath, "utf8"), newContent);

  const outside = await request(editPort, "/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: join(fixture.project, "NOTES.md"), content: "x" }),
  });
  assert.equal(outside.status, 403);
});

test("rejects a request with a mismatched Host header", async () => {
  const res = await request(roPort, "/", { headers: { host: "evil.example.com" } });
  assert.equal(res.status, 403);
});

test("hostile markdown is neutralized: no live <script>, javascript: link blocked", async () => {
  const res = await request(roPort, "/");
  assert.ok(!res.body.includes("<script>alert(1)</script>"), "raw hostile <script> must not appear unescaped");
  assert.match(res.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(res.body, /href="#blocked"/);
});
