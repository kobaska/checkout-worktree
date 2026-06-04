// Renderer logic for Worktree Switcher.

const api = window.api;

const state = {
  config: null,
  repos: [],
  selectedRepoPath: null,
  worktrees: [],
  baseBranch: null,
  activeWorktree: null,
};

const $ = (id) => document.getElementById(id);

const baseDirPath = $("baseDirPath");
const repoSelect = $("repoSelect");
const wtList = $("wtList");
const emptyMsg = $("emptyMsg");
const loadingMsg = $("loadingMsg");
const wtCount = $("wtCount");

// ---------- Toast ----------

let toastTimer;
function toast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3600);
}

// ---------- Confirm ----------

function confirm({ title, body, okLabel = "Delete", okClass = "danger" }) {
  return new Promise((resolve) => {
    $("confirmTitle").textContent = title;
    $("confirmBody").textContent = body;
    const okBtn = $("btnConfirmOk");
    okBtn.textContent = okLabel;
    okBtn.className = okClass;
    $("confirmModal").hidden = false;

    const cleanup = () => {
      $("confirmModal").hidden = true;
      okBtn.removeEventListener("click", onOk);
      $("btnConfirmCancel").removeEventListener("click", onCancel);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    okBtn.addEventListener("click", onOk);
    $("btnConfirmCancel").addEventListener("click", onCancel);
  });
}

// ---------- Format ----------

function fmtPath(p) {
  if (!p) return "";
  const home = state.config?.home || "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

// ---------- Render ----------

function renderWorktrees() {
  wtList.innerHTML = "";
  const list = state.worktrees;
  wtCount.textContent = list.length ? `${list.length}` : "";
  if (!list.length) {
    emptyMsg.hidden = false;
    return;
  }
  emptyMsg.hidden = true;

  const active = state.activeWorktree;

  for (const wt of list) {
    const item = document.createElement("div");
    item.className = "wt-item" + (wt.isBase ? " current" : "");

    // ---- left side: name + tags ----
    const left = document.createElement("div");
    left.className = "wt-main";
    const name = document.createElement("div");
    name.className = "name";
    const branchLabel = wt.branch || (wt.detached ? "(detached HEAD)" : "(unknown)");
    const branchSpan = document.createElement("span");
    branchSpan.className = "branch";
    branchSpan.textContent = branchLabel;
    branchSpan.title = `${branchLabel}\n${wt.path}`;
    name.appendChild(branchSpan);

    if (wt.isBase) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "base";
      name.appendChild(tag);
    }
    if (wt.isBase && active) {
      const tag = document.createElement("span");
      tag.className = "tag active";
      tag.textContent = active.liveSync ? "syncing ↻" : "borrowed";
      name.appendChild(tag);
    }
    if (wt.changes > 0) {
      const tag = document.createElement("span");
      tag.className = "tag dirty";
      tag.textContent = `${wt.changes} change${wt.changes === 1 ? "" : "s"}`;
      name.appendChild(tag);
    }

    left.appendChild(name);

    if (wt.isBase && active) {
      const note = document.createElement("div");
      note.className = "sub-note";
      const parts = [];
      if (active.liveSync) {
        parts.push(`live-syncing from ${fmtPath(active.worktreePath)}`);
      }
      if (active.stashed) parts.push(`stashed changes on ${active.originalBranch}`);
      else parts.push(`will restore to ${active.originalBranch}`);
      note.textContent = parts.join(" · ");
      left.appendChild(note);
    }

    // ---- right side: actions ----
    const actions = document.createElement("div");
    actions.className = "actions";

    const branchForOps = wt.branch || null;
    // While live-syncing, hide commit/PR on the base row — the worktree is
    // the source of truth, so the user should commit there. Base's git state
    // is detached anyway, so committing in base wouldn't update the branch.
    const isLiveSyncBase = wt.isBase && active?.liveSync;

    // Commit (any worktree with changes)
    if (wt.changes > 0 && branchForOps && !isLiveSyncBase) {
      const b = document.createElement("button");
      b.className = "icon";
      b.title = "Commit changes (auto message)";
      b.textContent = "✎";
      b.addEventListener("click", () => onCommit(wt));
      actions.appendChild(b);
    }

    // PR (any worktree on a non-base-branchy branch; backend will validate)
    if (branchForOps && !isLiveSyncBase) {
      const b = document.createElement("button");
      b.className = "icon";
      b.title = "Create PR (auto title & body)";
      b.textContent = "⇪";
      b.addEventListener("click", () => onCreatePR(wt));
      actions.appendChild(b);
    }

    if (wt.isBase && active) {
      const b = document.createElement("button");
      b.className = "icon";
      b.title = "Unselect and restore";
      b.textContent = "↩";
      b.addEventListener("click", onUnselect);
      actions.appendChild(b);
    } else if (!wt.isBase) {
      const switchBtn = document.createElement("button");
      switchBtn.className = "icon";
      switchBtn.title = "Switch to this worktree";
      switchBtn.textContent = "→";
      switchBtn.disabled = Boolean(active);
      switchBtn.addEventListener("click", () => onSwitch(wt));

      const delBtn = document.createElement("button");
      delBtn.className = "icon danger";
      delBtn.title = "Delete worktree";
      delBtn.textContent = "×";
      delBtn.addEventListener("click", () => onDelete(wt));

      actions.appendChild(switchBtn);
      actions.appendChild(delBtn);
    }

    item.appendChild(left);
    item.appendChild(actions);
    wtList.appendChild(item);
  }
}

// ---------- Loading ----------

async function loadConfig() {
  state.config = await api.getConfig();
  if (state.config.baseDir) {
    baseDirPath.textContent = fmtPath(state.config.baseDir);
    baseDirPath.title = state.config.baseDir;
    await loadRepos();
  } else {
    baseDirPath.textContent = "— select a base directory —";
  }
}

async function loadRepos() {
  const baseDir = state.config?.baseDir;
  if (!baseDir) return;
  const res = await api.listRepos(baseDir);
  if (!res.ok) {
    toast(res.error || "Failed to list repos", "error");
    repoSelect.disabled = true;
    return;
  }
  state.repos = res.repos;
  repoSelect.innerHTML = "";
  if (!res.repos.length) {
    const opt = document.createElement("option");
    opt.textContent = "— no git repos found —";
    repoSelect.appendChild(opt);
    repoSelect.disabled = true;
    state.selectedRepoPath = null;
    state.worktrees = [];
    renderWorktrees();
    return;
  }

  const prior = localStorage.getItem("lastRepoPath");
  let toSelect = res.repos.find((r) => r.path === prior) || res.repos[0];

  for (const r of res.repos) {
    const opt = document.createElement("option");
    opt.value = r.path;
    opt.textContent = r.name;
    if (r.path === toSelect.path) opt.selected = true;
    repoSelect.appendChild(opt);
  }
  repoSelect.disabled = false;
  state.selectedRepoPath = toSelect.path;
  localStorage.setItem("lastRepoPath", toSelect.path);
  await loadWorktrees();
}

async function loadWorktrees() {
  if (!state.selectedRepoPath) return;
  emptyMsg.hidden = true;
  loadingMsg.hidden = false;
  const res = await api.listWorktrees(state.selectedRepoPath);
  loadingMsg.hidden = true;
  if (!res.ok) {
    toast(res.error || "Failed to list worktrees", "error");
    state.worktrees = [];
    state.activeWorktree = null;
  } else {
    state.worktrees = res.worktrees;
    state.baseBranch = res.baseBranch;
    state.activeWorktree = res.activeWorktree;
  }
  renderWorktrees();
}

// ---------- Worktree actions ----------

async function onPickBaseDir() {
  const dir = await api.pickDirectory();
  if (!dir) return;
  await api.setConfig({ baseDir: dir });
  state.config = await api.getConfig();
  baseDirPath.textContent = fmtPath(dir);
  baseDirPath.title = dir;
  await loadRepos();
}

async function onRepoChange() {
  state.selectedRepoPath = repoSelect.value;
  localStorage.setItem("lastRepoPath", state.selectedRepoPath);
  await loadWorktrees();
}

async function onSwitch(wt) {
  if (state.activeWorktree) {
    toast("Another worktree is already active. Unselect first.", "error");
    return;
  }
  toast(`Switching to ${wt.branch}…`);
  const res = await api.switchWorktree({
    repoPath: state.selectedRepoPath,
    worktreePath: wt.path,
    branch: wt.branch,
  });
  if (!res.ok) {
    toast(res.error || "Switch failed", "error");
    await loadWorktrees();
    return;
  }
  let msg = `Switched to ${wt.branch}`;
  if (res.liveSync) msg += " · live-syncing";
  if (res.post?.ran) {
    msg += res.post.ok ? " · post-checkout ran" : ` · post-checkout failed at: ${res.post.failed}`;
  }
  const isError = res.post && !res.post.ok;
  toast(msg, isError ? "error" : "success");
  await loadWorktrees();
}

async function onUnselect() {
  if (!state.activeWorktree) return;
  toast("Restoring base branch…");
  const res = await api.unselectWorktree({ repoPath: state.selectedRepoPath });
  if (!res.ok) {
    toast(res.error || "Unselect failed", "error");
    await loadWorktrees();
    return;
  }
  let msg = "Restored";
  if (res.broughtBack) msg += " · carried changes back to worktree";
  if (res.warning) msg += " · " + res.warning;
  toast(msg, res.warning ? "error" : "success");
  await loadWorktrees();
}

async function onDelete(wt) {
  const ok = await confirm({
    title: "Delete worktree",
    body: `Remove worktree ${wt.branch} at ${fmtPath(wt.path)}? Uncommitted changes will be lost.`,
    okLabel: "Delete",
  });
  if (!ok) return;
  const res = await api.deleteWorktree({
    repoPath: state.selectedRepoPath,
    worktreePath: wt.path,
  });
  if (!res.ok) {
    toast(res.error || "Delete failed", "error");
    return;
  }
  toast("Worktree deleted", "success");
  await loadWorktrees();
}

// ---------- Commit ----------

let commitCtx = null;

async function onCommit(wt) {
  commitCtx = { cwd: wt.path, branch: wt.branch };
  $("commitBranch").textContent = wt.branch || "";
  $("commitMessage").value = "";
  $("commitFiles").innerHTML = "";
  $("commitLoading").hidden = false;
  $("btnDoCommit").disabled = true;
  $("btnRegenCommit").disabled = true;
  $("commitModal").hidden = false;

  const res = await api.prepareCommit({ cwd: wt.path });
  $("commitLoading").hidden = true;
  if (!res.ok) {
    if (res.code === "NO_API_KEY") {
      toast("Add a Claude API key in Settings first.", "error");
    } else {
      toast(res.error || "Failed to prepare commit", "error");
    }
    $("commitModal").hidden = true;
    return;
  }
  $("commitMessage").value = res.message || "";
  for (const f of res.files || []) {
    const row = document.createElement("div");
    row.className = "file-row";
    row.textContent = f;
    $("commitFiles").appendChild(row);
  }
  $("btnDoCommit").disabled = false;
  $("btnRegenCommit").disabled = false;
}

async function regenerateCommit() {
  if (!commitCtx) return;
  $("commitLoading").hidden = false;
  $("btnDoCommit").disabled = true;
  $("btnRegenCommit").disabled = true;
  const res = await api.prepareCommit({ cwd: commitCtx.cwd });
  $("commitLoading").hidden = true;
  $("btnDoCommit").disabled = false;
  $("btnRegenCommit").disabled = false;
  if (!res.ok) {
    toast(res.error || "Regenerate failed", "error");
    return;
  }
  $("commitMessage").value = res.message || "";
}

async function doCommit() {
  const msg = $("commitMessage").value.trim();
  if (!msg) {
    toast("Commit message is empty", "error");
    return;
  }
  $("btnDoCommit").disabled = true;
  const res = await api.applyCommit({ cwd: commitCtx.cwd, message: msg });
  $("btnDoCommit").disabled = false;
  if (!res.ok) {
    toast(res.error || "Commit failed", "error");
    return;
  }
  $("commitModal").hidden = true;
  toast("Committed", "success");
  await loadWorktrees();
}

function closeCommit() { $("commitModal").hidden = true; commitCtx = null; }

// ---------- PR ----------

let prCtx = null;

async function onCreatePR(wt) {
  prCtx = { cwd: wt.path, branch: wt.branch };
  $("prBranchLabel").textContent = wt.branch || "";
  $("prTitle").value = "";
  $("prBody").value = "";
  $("prHint").textContent = "";
  $("prLoading").hidden = false;
  $("btnDoCreatePR").disabled = true;
  $("btnRegenPR").disabled = true;
  $("prModal").hidden = false;

  const res = await api.preparePR({ cwd: wt.path });
  $("prLoading").hidden = true;
  if (!res.ok) {
    if (res.code === "NO_API_KEY") {
      toast("Add a Claude API key in Settings first.", "error");
    } else {
      toast(res.error || "Failed to prepare PR", "error");
    }
    $("prModal").hidden = true;
    return;
  }
  $("prTitle").value = res.title || "";
  $("prBody").value = res.body || "";
  prCtx.baseBranch = res.baseBranch;
  if (res.existing?.url) {
    $("prHint").innerHTML =
      `A PR already exists for this branch: <a href="#" id="prExistingLink">${escapeHTML(res.existing.url)}</a>`;
    document.getElementById("prExistingLink").addEventListener("click", (e) => {
      e.preventDefault();
      api.openExternal(res.existing.url);
    });
  } else {
    $("prHint").textContent = `Will push ${res.branch} to origin and open a PR against ${res.baseBranch}.`;
  }
  $("btnDoCreatePR").disabled = false;
  $("btnRegenPR").disabled = false;
}

async function regeneratePR() {
  if (!prCtx) return;
  $("prLoading").hidden = false;
  $("btnDoCreatePR").disabled = true;
  $("btnRegenPR").disabled = true;
  const res = await api.preparePR({ cwd: prCtx.cwd });
  $("prLoading").hidden = true;
  $("btnDoCreatePR").disabled = false;
  $("btnRegenPR").disabled = false;
  if (!res.ok) {
    toast(res.error || "Regenerate failed", "error");
    return;
  }
  $("prTitle").value = res.title || "";
  $("prBody").value = res.body || "";
}

async function doCreatePR() {
  const title = $("prTitle").value.trim();
  const body = $("prBody").value.trim();
  if (!title || !body) {
    toast("Title and body required", "error");
    return;
  }
  $("btnDoCreatePR").disabled = true;
  toast("Pushing branch & creating PR…");
  const res = await api.createPR({
    cwd: prCtx.cwd,
    title,
    body,
    branch: prCtx.branch,
  });
  $("btnDoCreatePR").disabled = false;
  if (!res.ok) {
    toast(res.error || "PR creation failed", "error");
    return;
  }
  $("prModal").hidden = true;
  toast("PR created — click toast to open", "success");
  const t = $("toast");
  const oldClick = t.onclick;
  t.onclick = () => { api.openExternal(res.url); t.onclick = oldClick; };
}

function closePR() { $("prModal").hidden = true; prCtx = null; }

// ---------- Settings ----------

async function openSettings() {
  const cfg = await api.getConfig();
  const hasKey = await api.hasApiKey();
  $("inputApiKey").value = "";
  $("inputApiKey").placeholder = hasKey ? "•••••••• (stored)" : "sk-ant-…";
  const repoKey = state.selectedRepoPath;
  const repo = (cfg.repos || {})[repoKey] || {};
  const repoName = state.repos.find((r) => r.path === repoKey)?.name || "(no repo selected)";
  $("settingsRepoName").textContent = repoName;
  $("inputScript").value = repo.script || "";
  $("inputScript").disabled = !repoKey;
  $("settingsModal").hidden = false;
}

function closeSettings() { $("settingsModal").hidden = true; }

async function saveSettings() {
  const repoKey = state.selectedRepoPath;
  const apiKey = $("inputApiKey").value.trim();
  if (apiKey) {
    const r = await api.setApiKey(apiKey);
    if (!r.ok) { toast(r.error || "Failed to save API key", "error"); return; }
  }
  if (repoKey) {
    await api.setRepoScript(repoKey, $("inputScript").value);
  }
  closeSettings();
  toast("Settings saved", "success");
}

// ---------- Wire up ----------

$("btnPickBaseDir").addEventListener("click", onPickBaseDir);
$("btnRefresh").addEventListener("click", () => loadWorktrees());
$("repoSelect").addEventListener("change", onRepoChange);

$("btnSettings").addEventListener("click", openSettings);
$("btnCloseSettings").addEventListener("click", closeSettings);
$("btnCancelSettings").addEventListener("click", closeSettings);
$("btnSaveSettings").addEventListener("click", saveSettings);

$("btnCloseCommit").addEventListener("click", closeCommit);
$("btnCancelCommit").addEventListener("click", closeCommit);
$("btnDoCommit").addEventListener("click", doCommit);
$("btnRegenCommit").addEventListener("click", regenerateCommit);

$("btnClosePR").addEventListener("click", closePR);
$("btnCancelPR").addEventListener("click", closePR);
$("btnDoCreatePR").addEventListener("click", doCreatePR);
$("btnRegenPR").addEventListener("click", regeneratePR);

loadConfig();
