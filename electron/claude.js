const { safeStorage } = require("electron");
const config = require("./config");

const MODEL = "claude-haiku-4-5-20251001";
const MAX_DIFF_CHARS = 60_000; // keep prompts within a sensible bound

let _client;

function getApiKey() {
  const cfg = config.getAll();
  if (!cfg.encryptedApiKey) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(cfg.encryptedApiKey, "base64"));
  } catch (err) {
    console.error("claude: failed to decrypt API key:", err);
    return null;
  }
}

async function getClient() {
  if (_client) return _client;
  const key = getApiKey();
  if (!key) {
    const err = new Error("Claude API key not set. Open Settings and add one.");
    err.code = "NO_API_KEY";
    throw err;
  }
  // Lazy require so app launches even if the SDK fails to install
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  _client = new Anthropic({ apiKey: key });
  return _client;
}

function clearClient() {
  _client = null;
}

function clipDiff(text, limit = MAX_DIFF_CHARS) {
  if (!text) return "";
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n\n…[diff truncated at ${limit} chars]…`;
}

async function generateCommitMessage({ diff, untracked }) {
  const client = await getClient();
  const untrackedBlock = untracked && untracked.length
    ? `\n\nUntracked files (filenames only):\n${untracked.join("\n")}`
    : "";

  const prompt = `Write a git commit message for the following changes.

Rules:
- Subject line: imperative mood, lowercase first letter, no trailing period, under 72 characters.
- If the changes touch one cohesive thing, subject only.
- If multiple distinct changes, add a blank line then 1-4 short bullet points (each starting with "- ").
- No markdown fences, no quotes, no preamble. Output the message text only.

Diff:
${clipDiff(diff)}${untrackedBlock}`;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });
  const block = resp.content.find((c) => c.type === "text");
  return (block?.text || "").trim();
}

async function generatePRContent({ diff, log, branch, baseBranch }) {
  const client = await getClient();
  const prompt = `Write a pull request title and description for these changes.

Rules for title: imperative mood, under 70 characters, no leading capital required, no trailing period.
Rules for body: GitHub-flavoured markdown, structured as:

## Summary
- 1-3 bullets describing what changed and why

## Test plan
- [ ] one short bullet per thing a reviewer can run to verify

Output ONLY a single JSON object with keys "title" and "body". No code fences, no preamble.

Branch: ${branch}
Base: ${baseBranch}

Commit log (newest first):
${log || "(no commits ahead of base)"}

Diff:
${clipDiff(diff)}`;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    messages: [{ role: "user", content: prompt }],
  });
  const text = (resp.content.find((c) => c.type === "text")?.text || "").trim();

  // Be lenient: pull out the first {...} block in case the model wraps it.
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error("Claude response was not JSON:\n" + text.slice(0, 200));
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  } catch (err) {
    throw new Error("Could not parse Claude JSON: " + err.message);
  }
  if (!parsed.title || !parsed.body) {
    throw new Error("Claude response missing title/body");
  }
  return { title: String(parsed.title).trim(), body: String(parsed.body).trim() };
}

module.exports = {
  generateCommitMessage,
  generatePRContent,
  clearClient,
  getApiKey,
};
