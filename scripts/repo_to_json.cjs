#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Usage:
 *   node repo_to_json.cjs --repo-dir ./REPO-main --out ./repo_for_llm.json \
 *     --base-url https://github.com/OWNER/REPO --branch main
 */

const DEFAULT_EXCLUDE_DIRS = new Set([
  ".git", ".github", ".idea", ".vscode",
  "node_modules", "dist", "build", "out",
  "target", "vendor", "__pycache__",
  ".next", ".nuxt", ".pytest_cache",
]);

const DEFAULT_EXCLUDE_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", // 必要なら外してOK
]);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function buildUrl(baseUrl, branch, relPathPosix) {
  if (!baseUrl) return "";
  const b = String(baseUrl).replace(/\/+$/, "");
  if (branch) return `${b}/blob/${branch}/${relPathPosix}`;
  return `${b}/${relPathPosix}`;
}

function looksBinary(buffer) {
  // NUL byte is a strong signal of binary
  const n = Math.min(buffer.length, 4096);
  for (let i = 0; i < n; i++) {
    if (buffer[i] === 0) return true;
  }
  // Heuristic: too many control chars (except \t \n \r)
  let weird = 0;
  for (let i = 0; i < n; i++) {
    const c = buffer[i];
    if (c < 9) weird++;
    else if (c >= 14 && c <= 31) weird++;
  }
  return (weird / Math.max(1, n)) > 0.02;
}

async function readTextIfOk(filePath, maxBytes) {
  let st;
  try {
    st = await fs.promises.stat(filePath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (st.size > maxBytes) return null;

  let buf;
  try {
    buf = await fs.promises.readFile(filePath);
  } catch {
    return null;
  }
  if (looksBinary(buf)) return null;

  // UTF-8 decode (invalid bytes are replaced)
  // Buffer#toString('utf8') is fine here.
  return buf.toString("utf8");
}

async function walkFiles(rootDir, extraExcludeDirs) {
  const files = [];
  const stack = [rootDir];

  while (stack.length) {
    const current = stack.pop();
    let dirents;
    try {
      dirents = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const de of dirents) {
      const full = path.join(current, de.name);
      if (de.isDirectory()) {
        if (DEFAULT_EXCLUDE_DIRS.has(de.name)) continue;
        if (extraExcludeDirs.has(de.name)) continue;
        stack.push(full);
      } else if (de.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

async function main() {
  const args = parseArgs(process.argv);

  const repoDir = args["repo-dir"];
  if (!repoDir) {
    console.error("ERROR: --repo-dir is required");
    process.exit(1);
  }

  const outPath = args["out"] || "repo.json";
  const baseUrl = args["base-url"] || "";
  const branch = args["branch"] || "";
  const maxFileBytes = Number(args["max-file-bytes"] || 800_000);

  const extraExcludeDirs = new Set(
    String(args["exclude-dirs"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const absRepoDir = path.resolve(repoDir);
  const files = await walkFiles(absRepoDir, extraExcludeDirs);

  const items = [];
  for (const file of files) {
    const baseName = path.basename(file);
    if (DEFAULT_EXCLUDE_FILES.has(baseName)) continue;

    const rel = path.relative(absRepoDir, file);
    const relPosix = rel.split(path.sep).join("/");

    const content = await readTextIfOk(file, maxFileBytes);
    if (content == null) continue;

    items.push({
      url: buildUrl(baseUrl, branch, relPosix),
      title: relPosix,
      content,
    });
  }

  await fs.promises.writeFile(outPath, JSON.stringify(items, null, 2), "utf8");
  console.log(`Wrote ${items.length} items to: ${outPath}`);
}

main().catch((e) => {
  console.error("ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
