const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const config = require("./config");
const sync = require("./sync");

const exec = promisify(execFile);

async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      maxBuffer: 10 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, stdout: stdout || "", stderr: stderr || "" };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message,
      code: err.code,
    };
  }
}

async function git(cwd, args) {
  return run("git", args, { cwd });
}

// ---------- Repo discovery ----------

async function listRepos(baseDir) {
  if (!baseDir) return { ok: false, error: "No base directory selected", repos: [] };
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: err.message, repos: [] };
  }
  const repos = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".")) continue;
    const repoPath = path.join(baseDir, ent.name);
    // Treat directory containing a .git dir/file as a repo
    if (fs.existsSync(path.join(repoPath, ".git"))) {
      repos.push({ name: ent.name, path: repoPath });
    }
  }
  repos.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, repos };
}

// ---------- Worktree listing ----------

function parseWorktreePorcelain(out) {
  // Blocks separated by blank lines; each line: "key value"
  const blocks = out
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((block) => {
    const wt = { path: null, head: null, branch: null, bare: false, detached: false };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) wt.path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) wt.head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length);
        wt.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      } else if (line === "bare") wt.bare = true;
      else if (line === "detached") wt.detached = true;
    }
    return wt;
  });
}

async function currentBranch(repoPath) {
  const r = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.ok ? r.stdout.trim() : null;
}

async function isDirty(repoPath) {
  const r = await git(repoPath, ["status", "--porcelain"]);
  if (!r.ok) return false;
  return r.stdout.trim().length > 0;
}

async function countChanges(repoPath) {
  const r = await git(repoPath, ["status", "--porcelain"]);
  if (!r.ok) return 0;
  return r.stdout.trim().split("\n").filter(Boolean).length;
}

async function listWorktrees(repoPath) {
  // Clean up stale metadata for worktrees whose directories were deleted
  // outside of git (e.g. `rm -rf`). Safe — it only touches .git/worktrees/.
  await git(repoPath, ["worktree", "prune"]);

  const r = await git(repoPath, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return { ok: false, error: r.stderr, worktrees: [] };

  const list = parseWorktreePorcelain(r.stdout);
  const baseRepoPath = path.resolve(repoPath);

  // Determine base worktree's current branch (the main repo path)
  const baseBranch = await currentBranch(repoPath);

  const worktrees = [];
  for (const wt of list) {
    const resolved = path.resolve(wt.path || "");
    const isBase = resolved === baseRepoPath;
    // Belt-and-braces: drop any non-base worktree whose path is gone
    // (in case `prune` left it for some reason — e.g. lock file present).
    if (!isBase && !fs.existsSync(resolved)) continue;

    let changes = 0;
    if (fs.existsSync(resolved)) {
      changes = await countChanges(resolved);
    }
    worktrees.push({
      ...wt,
      path: resolved,
      isBase,
      changes,
    });
  }

  const repoKey = baseRepoPath;
  const repoCfg = config.getRepo(repoKey);
  return {
    ok: true,
    worktrees,
    baseBranch,
    activeWorktree: repoCfg.activeWorktree || null,
  };
}

// ---------- Switch / Unselect ----------
//
// Switch semantics:
//   * Operates on the base repo (the main checkout).
//   * Stash uncommitted changes on the base repo (with marker).
//   * Remove the worktree from disk (it currently owns the branch we want).
//   * Checkout the worktree's branch in the base repo.
//   * Run the per-repo post-checkout script.
//
// Unselect: reverse the steps:
//   * Checkout the original branch in the base repo.
//   * Recreate the worktree at its original path on its branch.
//   * Pop the original stash (if marker still present).

const STASH_MSG = "worktree-switcher:auto-switch";

async function findStashIndex(repoPath, message) {
  const r = await git(repoPath, ["stash", "list"]);
  if (!r.ok) return -1;
  const lines = r.stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(message)) return i;
  }
  return -1;
}

async function runPostCheckout(cwd, script) {
  if (!script || !script.trim()) return { ok: true, ran: false, logs: [] };
  const logs = [];
  const lines = script
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  for (const line of lines) {
    const r = await run("sh", ["-c", line], { cwd });
    logs.push({ cmd: line, ok: r.ok, stdout: r.stdout, stderr: r.stderr });
    if (!r.ok) return { ok: false, ran: true, logs, failed: line };
  }
  return { ok: true, ran: true, logs };
}

// Live-sync mode:
//   * Stash base if dirty (so we can restore on unselect).
//   * Detach base's HEAD to the worktree's HEAD commit (so git status in
//     base reflects what the worktree sees, and shared .git keeps everything
//     consistent).
//   * rsync the worktree's working dir into base (overlays uncommitted
//     changes the worktree has on top of its HEAD).
//   * Start a chokidar watcher; every change in the worktree mirrors into
//     base. node_modules / .next / dist etc. are excluded from sync — base
//     rebuilds those via post-checkout.
//   * Worktree directory is NEVER removed — the user keeps editing it.
async function switchToWorktree({ repoPath, worktreePath, branch }) {
  const baseRepo = path.resolve(repoPath);
  const wtPath = path.resolve(worktreePath);

  if (baseRepo === wtPath) {
    return { ok: false, error: "Already on the base worktree" };
  }
  if (!fs.existsSync(wtPath)) {
    return { ok: false, error: "Worktree directory no longer exists on disk" };
  }

  const originalBranch = await currentBranch(baseRepo);
  if (!originalBranch) return { ok: false, error: "Could not read base branch" };

  // 1. Stash base repo if dirty
  const opId = Date.now().toString(36);
  const baseStashMsg = `${STASH_MSG} base ${opId} ${originalBranch}→${branch}`;
  let baseStashed = false;
  if (await isDirty(baseRepo)) {
    const s = await git(baseRepo, ["stash", "push", "-u", "-m", baseStashMsg]);
    if (!s.ok) return { ok: false, error: `git stash (base) failed: ${s.stderr}` };
    baseStashed = true;
  }

  // 2. Read worktree's HEAD commit
  const headR = await git(wtPath, ["rev-parse", "HEAD"]);
  if (!headR.ok) {
    if (baseStashed) {
      const idx = await findStashIndex(baseRepo, baseStashMsg);
      if (idx >= 0) await git(baseRepo, ["stash", "pop", `stash@{${idx}}`]);
    }
    return { ok: false, error: `read worktree HEAD: ${headR.stderr}` };
  }
  const wtHead = headR.stdout.trim();

  // 3. Detach base to that commit. Base's git state now matches what the
  //    worktree's HEAD points at, without taking the branch (the worktree
  //    still owns it).
  const co = await git(baseRepo, ["checkout", "--detach", wtHead]);
  if (!co.ok) {
    if (baseStashed) {
      const idx = await findStashIndex(baseRepo, baseStashMsg);
      if (idx >= 0) await git(baseRepo, ["stash", "pop", `stash@{${idx}}`]);
    }
    return { ok: false, error: `git checkout --detach failed: ${co.stderr}` };
  }

  // 4. Initial sync: rsync worktree's working dir into base. --delete
  //    handles files that exist in base (from the checked-out commit) but
  //    were removed in the worktree.
  const syncRes = await sync.initialSync(wtPath, baseRepo);
  if (!syncRes.ok) {
    // Best-effort rollback
    await git(baseRepo, ["checkout", originalBranch]).catch(() => {});
    if (baseStashed) {
      const idx = await findStashIndex(baseRepo, baseStashMsg);
      if (idx >= 0) await git(baseRepo, ["stash", "pop", `stash@{${idx}}`]);
    }
    return { ok: false, error: `initial rsync failed: ${syncRes.error}` };
  }

  // 5. Persist active state (used by unselect + UI)
  config.setRepoActive(baseRepo, {
    branch,
    worktreePath: wtPath,
    originalBranch,
    stashed: baseStashed,
    stashMsg: baseStashed ? baseStashMsg : null,
    liveSync: true,
    detachedAt: wtHead,
  });

  // 6. Start the file watcher
  const watcherState = await sync.startWatcher(wtPath, baseRepo, () => {
    // Hook for future UI updates; we just count events internally.
  });
  sync.registerWatcher(baseRepo, watcherState);

  // 7. Run post-checkout in base (npm install etc. — rebuilds node_modules)
  const repoCfg = config.getRepo(baseRepo);
  const post = await runPostCheckout(baseRepo, repoCfg.script);

  return {
    ok: true,
    originalBranch,
    branch,
    stashed: baseStashed,
    liveSync: true,
    post,
  };
}

async function unselectWorktree({ repoPath }) {
  const baseRepo = path.resolve(repoPath);
  const repoCfg = config.getRepo(baseRepo);
  const active = repoCfg.activeWorktree;
  if (!active) return { ok: false, error: "No active worktree to unselect" };

  const { branch, worktreePath, originalBranch, stashed, stashMsg, liveSync } = active;

  if (liveSync) {
    // 1. Stop the watcher
    await sync.stopWatcher(baseRepo);

    // 2. Discard all synced changes in base.
    //    reset --hard wipes tracked-file modifications, clean -fd removes
    //    untracked files/dirs (which is most of what rsync laid down).
    //    -e is omitted so gitignored files (node_modules etc.) stay.
    const reset = await git(baseRepo, ["reset", "--hard"]);
    if (!reset.ok) return { ok: false, error: `git reset failed: ${reset.stderr}` };
    const clean = await git(baseRepo, ["clean", "-fd"]);
    if (!clean.ok) return { ok: false, error: `git clean failed: ${clean.stderr}` };

    // 3. Checkout original branch in base
    const co = await git(baseRepo, ["checkout", originalBranch]);
    if (!co.ok) return { ok: false, error: `git checkout failed: ${co.stderr}` };

    // 4. Pop the base stash
    let warning = null;
    if (stashed) {
      const idx = await findStashIndex(baseRepo, stashMsg || STASH_MSG);
      if (idx >= 0) {
        const pop = await git(baseRepo, ["stash", "pop", `stash@{${idx}}`]);
        if (!pop.ok) warning = `base stash pop: ${pop.stderr.split("\n")[0]}`;
      }
    }

    config.setRepoActive(baseRepo, null);
    return { ok: true, warning };
  }

  // ----- Fallback: legacy non-live-sync state (worktree was removed) -----

  let restoreMsg = null;
  if (await isDirty(baseRepo)) {
    const opId = Date.now().toString(36);
    restoreMsg = `${STASH_MSG} wt-restore ${opId} ${branch}`;
    const s = await git(baseRepo, ["stash", "push", "-u", "-m", restoreMsg]);
    if (!s.ok) return { ok: false, error: `git stash failed: ${s.stderr}` };
  }
  const co = await git(baseRepo, ["checkout", originalBranch]);
  if (!co.ok) {
    if (restoreMsg) {
      const idx = await findStashIndex(baseRepo, restoreMsg);
      if (idx >= 0) await git(baseRepo, ["stash", "pop", `stash@{${idx}}`]);
    }
    return { ok: false, error: `git checkout failed: ${co.stderr}` };
  }
  const add = await git(baseRepo, ["worktree", "add", worktreePath, branch]);
  if (!add.ok) {
    return { ok: false, error: `Switched back, but failed to recreate worktree: ${add.stderr}` };
  }
  let warning = null;
  let broughtBack = false;
  if (restoreMsg) {
    const idx = await findStashIndex(baseRepo, restoreMsg);
    if (idx >= 0) {
      const pop = await git(worktreePath, ["stash", "pop", `stash@{${idx}}`]);
      if (!pop.ok) warning = `worktree restore had conflicts: ${pop.stderr.split("\n")[0]}`;
      else broughtBack = true;
    }
  }
  if (stashed) {
    const idx = await findStashIndex(baseRepo, stashMsg || STASH_MSG);
    if (idx >= 0) {
      const pop = await git(baseRepo, ["stash", "pop", `stash@{${idx}}`]);
      if (!pop.ok) warning = (warning ? warning + "; " : "") + `base stash pop: ${pop.stderr.split("\n")[0]}`;
    }
  }
  config.setRepoActive(baseRepo, null);
  return { ok: true, warning, broughtBack };
}

async function deleteWorktree({ repoPath, worktreePath }) {
  const r = await git(path.resolve(repoPath), [
    "worktree",
    "remove",
    path.resolve(worktreePath),
  ]);
  if (!r.ok) return { ok: false, error: r.stderr };
  return { ok: true };
}

// ---------- Commit / PR plumbing ----------

async function defaultBranch(cwd) {
  // Try origin/HEAD first
  const sym = await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (sym.ok && sym.stdout.trim()) {
    return sym.stdout.trim().replace(/^origin\//, "");
  }
  // Fall back to common names
  for (const candidate of ["main", "master"]) {
    const r = await git(cwd, ["rev-parse", "--verify", `refs/heads/${candidate}`]);
    if (r.ok) return candidate;
  }
  return null;
}

async function getCommitContext(cwd) {
  // All uncommitted (tracked) changes + list of untracked filenames
  const diff = await git(cwd, ["diff", "HEAD"]);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (!diff.ok) return { ok: false, error: diff.stderr };
  const files = await git(cwd, ["status", "--porcelain"]);
  const fileList = (files.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    ok: true,
    diff: diff.stdout,
    untracked: (untracked.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean),
    files: fileList,
  };
}

async function commitAll({ cwd, message }) {
  const add = await git(cwd, ["add", "-A"]);
  if (!add.ok) return { ok: false, error: `git add failed: ${add.stderr}` };
  const commit = await git(cwd, ["commit", "-m", message]);
  if (!commit.ok) return { ok: false, error: `git commit failed: ${commit.stderr}` };
  return { ok: true, stdout: commit.stdout };
}

async function getPRContext(cwd) {
  const branch = await currentBranch(cwd);
  if (!branch) return { ok: false, error: "Could not read current branch" };
  const base = await defaultBranch(cwd);
  if (!base) return { ok: false, error: "Could not find default branch" };
  if (branch === base) {
    return { ok: false, error: `Already on ${base}; switch to a feature branch first` };
  }

  // Range: from divergence point to HEAD
  const mergeBase = await git(cwd, ["merge-base", `origin/${base}`, "HEAD"]);
  let range;
  if (mergeBase.ok && mergeBase.stdout.trim()) {
    range = `${mergeBase.stdout.trim()}..HEAD`;
  } else {
    // No remote tracking; fall back to local base
    range = `${base}..HEAD`;
  }

  const log = await git(cwd, ["log", "--no-merges", "--pretty=format:%h %s", range]);
  const diff = await git(cwd, ["diff", range]);

  return {
    ok: true,
    branch,
    baseBranch: base,
    log: log.stdout || "",
    diff: diff.stdout || "",
  };
}

async function hasUncommittedChanges(cwd) {
  return isDirty(cwd);
}

async function pushBranch({ cwd, branch }) {
  // Try with -u in case it's the first push
  const r = await git(cwd, ["push", "-u", "origin", branch]);
  if (!r.ok) return { ok: false, error: r.stderr };
  return { ok: true, stdout: r.stdout };
}

async function createPR({ cwd, title, body }) {
  const r = await run("gh", ["pr", "create", "--title", title, "--body", body], { cwd });
  if (!r.ok) {
    return { ok: false, error: r.stderr || r.stdout || "gh pr create failed" };
  }
  // gh prints the PR URL on stdout
  const url = (r.stdout || "").trim().split("\n").pop();
  return { ok: true, url };
}

async function existingPR(cwd) {
  const r = await run("gh", ["pr", "view", "--json", "url,number,state"], { cwd });
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

module.exports = {
  listRepos,
  listWorktrees,
  switchToWorktree,
  unselectWorktree,
  deleteWorktree,
  getCommitContext,
  commitAll,
  getPRContext,
  hasUncommittedChanges,
  pushBranch,
  createPR,
  existingPR,
};
