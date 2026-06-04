const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

let configPath;
let data = {};

const DEFAULTS = {
  baseDir: null,
  encryptedApiKey: null,
  // { [repoKey]: { script: string, activeWorktree?: { ... } } }
  repos: {},
};

function init() {
  const dir = app.getPath("userData");
  configPath = path.join(dir, "config.json");
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      data = { ...DEFAULTS, ...JSON.parse(raw) };
    } else {
      data = { ...DEFAULTS };
      persist();
    }
  } catch (err) {
    console.error("config: failed to load, resetting:", err);
    data = { ...DEFAULTS };
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("config: failed to persist:", err);
  }
}

function getAll() {
  return data;
}

function set(patch) {
  data = { ...data, ...patch };
  persist();
  return data;
}

function setRepoScript(repoKey, script) {
  const repos = { ...(data.repos || {}) };
  repos[repoKey] = { ...(repos[repoKey] || {}), script };
  data = { ...data, repos };
  persist();
  return data;
}

function setRepoActive(repoKey, activeWorktree) {
  const repos = { ...(data.repos || {}) };
  repos[repoKey] = { ...(repos[repoKey] || {}), activeWorktree };
  data = { ...data, repos };
  persist();
  return data;
}

function getRepo(repoKey) {
  return (data.repos || {})[repoKey] || {};
}

module.exports = { init, getAll, set, setRepoScript, setRepoActive, getRepo };
