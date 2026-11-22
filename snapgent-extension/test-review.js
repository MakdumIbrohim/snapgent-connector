// SPDX-License-Identifier: GPL-3.0-or-later
// Node smoke test for Review & Approval Guard and Rollback Tracker (run: node test-review.js).
const fs = require("fs");

const ok = (name, cond) => {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) process.exitCode = 1;
};

const G = new Function(
  fs.readFileSync(__dirname + "/core/guard.js", "utf8") + "; return ZSGuard;"
)();

// ── 1. Mutating vs Safe Read-Only Tool Classification ──────────────────────
ok("read_file is safe (not mutating)", G.isMutatingTool("read_file") === false);
ok("list_dir is safe (not mutating)", G.isMutatingTool("list_dir") === false);
ok("git_status is safe (not mutating)", G.isMutatingTool("git_status") === false);
ok("git_diff is safe (not mutating)", G.isMutatingTool("git_diff") === false);
ok("list_commands is safe (not mutating)", G.isMutatingTool("list_commands") === false);

ok("write_file is mutating", G.isMutatingTool("write_file") === true);
ok("create_file is mutating", G.isMutatingTool("create_file") === true);
ok("replace_string_in_file is mutating", G.isMutatingTool("replace_string_in_file") === true);
ok("delete_file is mutating", G.isMutatingTool("delete_file") === true);
ok("execute_luau is mutating", G.isMutatingTool("execute_luau") === true);
ok("git_commit is mutating", G.isMutatingTool("git_commit") === true);
ok("scoped tool name vscode/write_file is mutating", G.isMutatingTool("vscode/write_file") === true);
ok("scoped tool name vscode/read_file is safe", G.isMutatingTool("vscode/read_file") === false);

// ── 2. Format Diff Preview ──────────────────────────────────────────────────
{
  const writeCall = {
    tool: "write_file",
    arguments: { path: "src/app.js", content: "console.log('hello');" }
  };
  const preview = G.formatDiffPreview(writeCall);
  ok("write_file preview has write type", preview.type === "write");
  ok("write_file preview identifies target", preview.target === "src/app.js");
  ok("write_file preview contains content", preview.preview.includes("console.log('hello');"));
}

{
  const replaceCall = {
    tool: "replace_string_in_file",
    arguments: {
      path: "index.html",
      old_string: "<h1>Old</h1>",
      new_string: "<h1>New</h1>"
    }
  };
  const preview = G.formatDiffPreview(replaceCall);
  ok("replace_string_in_file preview has replace type", preview.type === "replace");
  ok("replace_string_in_file preview formats diff with - and +",
    preview.preview.includes("- <h1>Old</h1>") && preview.preview.includes("+ <h1>New</h1>"));
}

{
  const deleteCall = {
    tool: "delete_file",
    arguments: { path: "temp.txt" }
  };
  const preview = G.formatDiffPreview(deleteCall);
  ok("delete_file preview has delete type", preview.type === "delete");
  ok("delete_file preview warns deletion", preview.preview.includes("permanently delete"));
}

{
  const luauCall = {
    tool: "execute_luau",
    arguments: { code: "print('Roblox')", datamodel_type: "Edit" }
  };
  const preview = G.formatDiffPreview(luauCall);
  ok("execute_luau preview has luau type", preview.type === "luau");
  ok("execute_luau preview includes code", preview.preview === "print('Roblox')");
}

// ── 3. Rollback Tracker Stack ───────────────────────────────────────────────
{
  const tracker = G.createRollbackTracker(3);
  ok("new tracker cannot rollback", tracker.canRollback() === false);
  ok("new tracker size is 0", tracker.size() === 0);

  tracker.push({ action: "restore", path: "a.js", content: "v1" });
  ok("tracker can rollback after push", tracker.canRollback() === true);
  ok("peek inspects without popping", tracker.peek().path === "a.js" && tracker.size() === 1);

  tracker.push({ action: "restore", path: "b.js", content: "v2" });
  tracker.push({ action: "delete", path: "c.js" });
  ok("tracker size is 3", tracker.size() === 3);

  // Exceed limit
  tracker.push({ action: "restore", path: "d.js", content: "v3" });
  ok("tracker size stays bounded at 3", tracker.size() === 3);

  // Pop LIFO
  const popped1 = tracker.pop();
  ok("pop returns most recent item", popped1.path === "d.js");
  const popped2 = tracker.pop();
  ok("pop returns next item", popped2.path === "c.js" && popped2.action === "delete");

  tracker.clear();
  ok("clear empties stack", tracker.size() === 0 && tracker.canRollback() === false);
}

// ── 4. Main & CSS Wiring Checks ─────────────────────────────────────────────
{
  const main = fs.readFileSync(__dirname + "/core/main.js", "utf8");
  const css = fs.readFileSync(__dirname + "/overlay.css", "utf8");

  ok("main.js checks for mutating tools with ZSGuard", /ZSGuard\.isMutatingTool\s*\(/.test(main));
  ok("main.js captures rollback snapshots before edits", /rollbackTracker\.push\s*\(/.test(main));
  ok("main.js provides showReviewModal for user approval", /function showReviewModal\s*\(/.test(main));
  ok("main.js handles user reject feedback", /decision\.action === "reject"/.test(main));
  ok("main.js supports session auto-approve", /decision\.action === "auto_session"/.test(main));
  ok("main.js provides 1-click rollback action", /async function doRollback\s*\(/.test(main));
  ok("main.js includes rollback button on status bar", /id="zs-rollback"/.test(main));
  ok("main.js includes review modal container", /id="zs-review-modal"/.test(main));
  ok("main.js exposes Review Actions toggle in menu", /id="zs-review-mode-toggle"/.test(main));
  ok("main.js persists review mode preference", /zsReviewMode/.test(main));

  ok("overlay.css styles review modal", /#zs-review-modal \{/.test(css));
  ok("overlay.css styles review dialog card", /\.zs-review-card \{/.test(css));
  ok("overlay.css styles review preview box", /\.zs-review-preview \{/.test(css));
  ok("overlay.css styles rollback button", /#zs-rollback \{/.test(css));
}

