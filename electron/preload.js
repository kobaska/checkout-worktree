const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDirectory"),

  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (patch) => ipcRenderer.invoke("config:set", patch),
  setRepoScript: (repoKey, script) =>
    ipcRenderer.invoke("config:setRepoScript", repoKey, script),
  setApiKey: (plain) => ipcRenderer.invoke("config:setApiKey", plain),
  hasApiKey: () => ipcRenderer.invoke("config:hasApiKey"),

  listRepos: (baseDir) => ipcRenderer.invoke("repos:list", baseDir),
  listWorktrees: (repoPath) => ipcRenderer.invoke("worktrees:list", repoPath),

  switchWorktree: (args) => ipcRenderer.invoke("worktree:switch", args),
  unselectWorktree: (args) => ipcRenderer.invoke("worktree:unselect", args),
  deleteWorktree: (args) => ipcRenderer.invoke("worktree:delete", args),

  prepareCommit: (args) => ipcRenderer.invoke("commit:prepare", args),
  applyCommit: (args) => ipcRenderer.invoke("commit:apply", args),

  preparePR: (args) => ipcRenderer.invoke("pr:prepare", args),
  createPR: (args) => ipcRenderer.invoke("pr:create", args),

  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
});
