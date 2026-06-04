const { app, BrowserWindow, ipcMain, dialog, nativeTheme, safeStorage, shell } = require("electron");
const path = require("node:path");
const config = require("./config");
const git = require("./git");
const claude = require("./claude");

if (!app.isPackaged) {
  try {
    require("electron-reloader")(module, {
      watchRenderer: true,
      ignore: [/dist/, /node_modules/, /mockups/, /\.git/, /memory/],
    });
  } catch {}
}

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 620,
    height: 760,
    minWidth: 480,
    minHeight: 480,
    titleBarStyle: "hiddenInset",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#18181b" : "#fafaf9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(() => {
  config.init();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---------- IPC ----------

ipcMain.handle("dialog:pickDirectory", async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("config:get", () => config.getAll());
ipcMain.handle("config:set", (_e, patch) => config.set(patch));
ipcMain.handle("config:setRepoScript", (_e, repoKey, script) =>
  config.setRepoScript(repoKey, script),
);
ipcMain.handle("config:setApiKey", (_e, plain) => {
  if (!plain) {
    config.set({ encryptedApiKey: null });
    claude.clearClient();
    return { ok: true };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: "Encryption not available on this system" };
  }
  const cipher = safeStorage.encryptString(plain).toString("base64");
  config.set({ encryptedApiKey: cipher });
  claude.clearClient();
  return { ok: true };
});
ipcMain.handle("config:hasApiKey", () => Boolean(config.getAll().encryptedApiKey));

ipcMain.handle("repos:list", async (_e, baseDir) => {
  return git.listRepos(baseDir);
});
ipcMain.handle("worktrees:list", async (_e, repoPath) => {
  return git.listWorktrees(repoPath);
});

ipcMain.handle("worktree:switch", async (_e, args) => {
  return git.switchToWorktree(args);
});
ipcMain.handle("worktree:unselect", async (_e, args) => {
  return git.unselectWorktree(args);
});
ipcMain.handle("worktree:delete", async (_e, args) => {
  return git.deleteWorktree(args);
});

// ---------- Commit ----------

ipcMain.handle("commit:prepare", async (_e, { cwd }) => {
  const ctx = await git.getCommitContext(cwd);
  if (!ctx.ok) return ctx;
  if (!ctx.diff && !ctx.untracked.length) {
    return { ok: false, error: "No changes to commit" };
  }
  try {
    const message = await claude.generateCommitMessage({
      diff: ctx.diff,
      untracked: ctx.untracked,
    });
    return { ok: true, message, files: ctx.files };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});

ipcMain.handle("commit:apply", async (_e, { cwd, message }) => {
  return git.commitAll({ cwd, message });
});

// ---------- PR ----------

ipcMain.handle("pr:prepare", async (_e, { cwd }) => {
  const dirty = await git.hasUncommittedChanges(cwd);
  if (dirty) {
    return {
      ok: false,
      error: "Working tree has uncommitted changes. Commit them first.",
    };
  }
  const ctx = await git.getPRContext(cwd);
  if (!ctx.ok) return ctx;
  if (!ctx.log && !ctx.diff) {
    return { ok: false, error: `No commits ahead of ${ctx.baseBranch}` };
  }
  try {
    const { title, body } = await claude.generatePRContent({
      diff: ctx.diff,
      log: ctx.log,
      branch: ctx.branch,
      baseBranch: ctx.baseBranch,
    });
    const existing = await git.existingPR(cwd);
    return {
      ok: true,
      title,
      body,
      branch: ctx.branch,
      baseBranch: ctx.baseBranch,
      existing,
    };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});

ipcMain.handle("pr:create", async (_e, { cwd, title, body, branch }) => {
  const push = await git.pushBranch({ cwd, branch });
  if (!push.ok) return { ok: false, error: `git push failed: ${push.error}` };
  const pr = await git.createPR({ cwd, title, body });
  if (!pr.ok) return pr;
  return { ok: true, url: pr.url };
});

ipcMain.handle("shell:openExternal", (_e, url) => shell.openExternal(url));
