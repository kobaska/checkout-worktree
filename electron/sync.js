// Live file sync from a worktree's working directory into the base repo.
//
// On switch, we:
//   1. rsync the worktree → base (excluding .git and heavy generated dirs)
//   2. start a chokidar watcher on the worktree
//   3. on add/change/unlink, mirror into base
//
// Stash/checkout/HEAD plumbing happens in git.js around this module.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const exec = promisify(execFile);

// Paths we never copy or watch — they're either git internals or heavy
// generated output that each side should rebuild via post-checkout.
const IGNORED_DIRS = [
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".cache",
  ".turbo",
  ".parcel-cache",
  ".vite",
];

// One watcher per base-repo path.
const watchers = new Map(); // baseRepoPath → { watcher, srcPath, eventCount }

// Initial sync. DO NOT use rsync here — the worktree often lives inside the
// base repo (e.g. .claude/worktrees/<name>/), so a tree-walking sync with
// --delete will eat its own source and clobber sibling worktrees + .git.
//
// Instead, ask git directly for the exact set of files that differ between
// the worktree's working tree and the commit base just checked out
// (which is the worktree's HEAD). That set is small and well-defined: only
// the worktree's uncommitted changes + untracked files. We then copy or
// delete those specific paths in base. Nothing else in base is touched.
async function initialSync(srcPath, destPath) {
  // -z gives NUL-separated entries so weird filenames don't tear.
  let stdout;
  try {
    const r = await exec("git", ["-C", srcPath, "status", "--porcelain", "-z"], {
      maxBuffer: 20 * 1024 * 1024,
    });
    stdout = r.stdout || "";
  } catch (err) {
    return {
      ok: false,
      error: `git status failed: ${err.stderr?.toString?.() || err.message}`,
    };
  }

  let copied = 0;
  let deleted = 0;
  const errors = [];

  // Porcelain -z format: <XY><space><path>\0  (with renames: extra \0<orig>)
  const tokens = stdout.split("\0").filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i];
    const xy = entry.slice(0, 2);
    const relPath = entry.slice(3);
    i += 1;
    // Renames are encoded as "Rxx new\0old". Skip the old name.
    if (xy[0] === "R" || xy[0] === "C") i += 1;

    if (!relPath) continue;
    if (shouldIgnorePath(srcPath, path.join(srcPath, relPath))) continue;

    const src = path.join(srcPath, relPath);
    const dst = path.join(destPath, relPath);

    // 'D' in either column means deleted in worktree
    const isDeleted = xy[0] === "D" || xy[1] === "D";

    try {
      if (isDeleted) {
        if (fs.existsSync(dst)) {
          fs.unlinkSync(dst);
          deleted += 1;
        }
      } else if (fs.existsSync(src)) {
        // Skip if it's a directory (shouldn't happen from status output,
        // but be defensive).
        const st = fs.statSync(src);
        if (st.isDirectory()) continue;
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        try { fs.chmodSync(dst, st.mode); } catch {}
        copied += 1;
      }
    } catch (err) {
      errors.push({ path: relPath, err: err.message });
    }
  }

  return { ok: true, copied, deleted, errors };
}

function shouldIgnorePath(srcPath, absPath) {
  const rel = path.relative(srcPath, absPath);
  if (!rel || rel.startsWith("..")) return true;
  const segments = rel.split(path.sep);
  return segments.some((seg) => IGNORED_DIRS.includes(seg));
}

// chokidar's ignored option accepts a function. We use it to skip both
// segment-level matches and dotted git internals.
function buildIgnoredFn(srcPath) {
  return (p) => shouldIgnorePath(srcPath, p);
}

async function startWatcher(srcPath, destPath, onEvent) {
  // Lazy require so app launches even if chokidar isn't installed yet
  const chokidar = require("chokidar");

  const watcher = chokidar.watch(srcPath, {
    ignored: buildIgnoredFn(srcPath),
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    ignorePermissionErrors: true,
  });

  const state = { watcher, srcPath, destPath, eventCount: 0, lastEvent: null };

  function dest(p) {
    return path.join(destPath, path.relative(srcPath, p));
  }

  function safe(fn, type, p) {
    try {
      fn();
      state.eventCount += 1;
      state.lastEvent = { type, path: path.relative(srcPath, p), at: Date.now() };
      onEvent?.(state.lastEvent);
    } catch (err) {
      onEvent?.({ type: "error", path: path.relative(srcPath, p), err: err.message });
    }
  }

  watcher.on("add", (p) => safe(() => {
    const d = dest(p);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(p, d);
    try { fs.chmodSync(d, fs.statSync(p).mode); } catch {}
  }, "add", p));

  watcher.on("change", (p) => safe(() => {
    const d = dest(p);
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(p, d);
  }, "change", p));

  watcher.on("unlink", (p) => safe(() => {
    const d = dest(p);
    if (fs.existsSync(d)) fs.unlinkSync(d);
  }, "unlink", p));

  watcher.on("addDir", (p) => safe(() => {
    const d = dest(p);
    fs.mkdirSync(d, { recursive: true });
  }, "addDir", p));

  watcher.on("unlinkDir", (p) => safe(() => {
    const d = dest(p);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }, "unlinkDir", p));

  watcher.on("error", (err) => {
    onEvent?.({ type: "error", err: err?.message || String(err) });
  });

  return state;
}

function registerWatcher(baseRepoPath, state) {
  watchers.set(baseRepoPath, state);
}

function getWatcher(baseRepoPath) {
  return watchers.get(baseRepoPath) || null;
}

async function stopWatcher(baseRepoPath) {
  const w = watchers.get(baseRepoPath);
  if (!w) return false;
  try {
    await w.watcher.close();
  } catch (err) {
    // best-effort
  }
  watchers.delete(baseRepoPath);
  return true;
}

function stopAll() {
  for (const w of watchers.values()) {
    try { w.watcher.close(); } catch {}
  }
  watchers.clear();
}

module.exports = {
  initialSync,
  startWatcher,
  registerWatcher,
  getWatcher,
  stopWatcher,
  stopAll,
};
