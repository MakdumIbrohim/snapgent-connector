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

// ── 4. Group Files by Directory (Workspace Changes Tree) ────────────────────
{
  ok("groupFilesByDirectory handles empty array", G.groupFilesByDirectory([]).length === 0);
  const sample = [
    "src/components/Header.jsx",
    "src/components/Sidebar.jsx",
    "src/app.js",
    "package.json"
  ];
  const grouped = G.groupFilesByDirectory(sample);
  ok("groupFilesByDirectory groups into 3 folders", grouped.length === 3);
  ok("root file goes into ./", grouped.some((g) => g.folder === "./" && g.files[0].name === "package.json"));
  ok("nested files grouped in src/components/",
    grouped.some((g) => g.folder === "src/components/" && g.files.length === 2));
}

// ── 5. Five Verification Cases for Diff Review ─────────────────────────────
{
  // Kasus 1: File Baru
  const callNew = {
    tool: "create_file",
    arguments: { path: "src/new.js", content: "console.log('line 1');\nconsole.log('line 2');" }
  };
  const resNew = G.prepareFileReview(callNew, null);
  ok("Kasus 1: file baru title Agen ingin membuat file ini", resNew.title === "Agen ingin membuat file ini");
  ok("Kasus 1: file baru isSinglePanel is true", resNew.isSinglePanel === true);
  ok("Kasus 1: file baru canApprove is true", resNew.canApprove === true);
  ok("Kasus 1: file baru addCount is 2 and delCount is 0", resNew.addCount === 2 && resNew.delCount === 0);
  ok("Kasus 1: file baru statusBadge is File baru", resNew.statusBadge === "File baru");

  // Kasus 2: Satu baris diubah
  const currSingle = "console.log('hello');";
  const callSingle = {
    tool: "replace_string_in_file",
    arguments: { path: "src/single.js", old_string: "console.log('hello');", new_string: "console.log('world');" }
  };
  const resSingle = G.prepareFileReview(callSingle, currSingle);
  ok("Kasus 2: satu baris diubah title Agen ingin mengubah file ini", resSingle.title === "Agen ingin mengubah file ini");
  ok("Kasus 2: satu baris diubah addCount is 1 and delCount is 1", resSingle.addCount === 1 && resSingle.delCount === 1);
  ok("Kasus 2: satu baris diubah has modify row with word diff", resSingle.items.some(r => r.kind === "modify" && r.left.words.some(w => w.text === "hello" && w.changed) && r.right.words.some(w => w.text === "world" && w.changed)));
  ok("Kasus 2: canApprove is true", resSingle.canApprove === true);

  // Kasus 3: Hapus dan tambah sekaligus (seperti gambar)
  const currMixed = [
    "",
    "[hasil]",
    "Status awal: belum diuji",
    "Status: tes tulis file berhasil.",
    "Catatan: hapus baris ini nanti",
    "",
    "[akhir]"
  ].join("\n");
  const oldBlock = "Status: tes tulis file berhasil.\nCatatan: hapus baris ini nanti";
  const newBlock = "Status: tes EDIT file berhasil - baris ini sudah diubah.\nDiedit oleh: snapgentV3";
  const callMixed = {
    tool: "replace_string_in_file",
    arguments: { path: "test-snapgent.txt", old_string: oldBlock, new_string: newBlock }
  };
  const resMixed = G.prepareFileReview(callMixed, currMixed);
  ok("Kasus 3: hapus dan tambah sekaligus title Agen ingin mengubah file ini", resMixed.title === "Agen ingin mengubah file ini");
  ok("Kasus 3: hapus dan tambah sekaligus addCount is 2 and delCount is 2", resMixed.addCount === 2 && resMixed.delCount === 2);
  ok("Kasus 3: canApprove is true", resMixed.canApprove === true);
  ok("Kasus 3: contains both modified row and add/del aligned rows", resMixed.items.some(r => r.kind === "modify") && resMixed.items.some(r => r.kind === "add"));

  // Kasus 4: old_text tidak ditemukan
  const callNotFound = {
    tool: "replace_string_in_file",
    arguments: { path: "test.txt", old_string: "teks_yang_tidak_ada", new_string: "baru" }
  };
  const resNotFound = G.prepareFileReview(callNotFound, "isi file yang ada di disk");
  ok("Kasus 4: old_text tidak ditemukan canApprove is false", resNotFound.canApprove === false);
  ok("Kasus 4: old_text tidak ditemukan has clear error", resNotFound.error.includes("tidak ditemukan"));

  // Kasus 4b: old_text muncul lebih dari sekali
  const callMulti = {
    tool: "replace_string_in_file",
    arguments: { path: "test.txt", old_string: "duplikat", new_string: "baru" }
  };
  const resMulti = G.prepareFileReview(callMulti, "duplikat 1 dan duplikat 2");
  ok("Kasus 4b: old_text muncul lebih dari sekali canApprove is false", resMulti.canApprove === false);
  ok("Kasus 4b: old_text muncul lebih dari sekali has clear error", resMulti.error.includes("lebih dari sekali"));

  // Kasus 4c: tidak ada perubahan
  const callNoChange = {
    tool: "replace_string_in_file",
    arguments: { path: "test.txt", old_string: "sama", new_string: "sama" }
  };
  const resNoChange = G.prepareFileReview(callNoChange, "teks sama di sini");
  ok("Kasus 4c: tidak ada perubahan canApprove is false", resNoChange.canApprove === false);
  ok("Kasus 4c: tidak ada perubahan has error Tidak ada perubahan", resNoChange.error.includes("Tidak ada perubahan"));

  // Kasus 6: edit_file tool name and delete_file tool name
  const callEditTool = {
    tool: "vscode/edit_file",
    arguments: { path: "contoh.txt", old_text: "baris lama", new_text: "baris baru" }
  };
  const resEditTool = G.prepareFileReview(callEditTool, "baris lama di sini");
  ok("Kasus 6: vscode/edit_file recognized as edit", resEditTool.type === "edit");
  ok("Kasus 6: vscode/edit_file title is Agen ingin mengubah file ini", resEditTool.title === "Agen ingin mengubah file ini");
  ok("Kasus 6: vscode/edit_file produces items diff", resEditTool.items.length > 0 && resEditTool.addCount === 1 && resEditTool.delCount === 1);

  // Fallback edit_file when disk content is null
  const resEditToolNoDisk = G.prepareFileReview(callEditTool, null);
  ok("Kasus 6b: edit_file without disk content still produces diff preview", resEditToolNoDisk.items.length > 0 && resEditToolNoDisk.type === "edit");

  // delete_file with and without disk content
  const callDeleteTool = {
    tool: "vscode/delete_file",
    arguments: { path: "contoh.txt" }
  };
  const resDeleteWithDisk = G.prepareFileReview(callDeleteTool, "line1\nline2");
  ok("Kasus 6c: delete_file with content produces delete items", resDeleteWithDisk.type === "delete" && resDeleteWithDisk.delCount === 2);
  const resDeleteNoDisk = G.prepareFileReview(callDeleteTool, null);
  ok("Kasus 6d: delete_file without content still produces delete item", resDeleteNoDisk.type === "delete" && resDeleteNoDisk.items.length === 1 && resDeleteNoDisk.delCount === 1);
}

// ── 6. Main & CSS Wiring Checks ─────────────────────────────────────────────
{
  const main = fs.readFileSync(__dirname + "/core/main.js", "utf8");
  const css = fs.readFileSync(__dirname + "/overlay.css", "utf8");

  ok("main.js checks for mutating tools with ZSGuard", /ZSGuard\.isMutatingTool\s*\(/.test(main));
  ok("main.js captures rollback snapshots before edits", /rollbackTracker\.push\s*\(/.test(main));
  ok("main.js provides showReviewModal for user approval", /function showReviewModal\s*\(/.test(main));
  ok("main.js provides feedback textarea for agent", /id="zs-review-feedback"/.test(main));
  ok("main.js supports session toggle switch", /id="zs-review-toggle-session"/.test(main));
  ok("main.js handles user reject feedback", /decision\.action === "reject"/.test(main));
  ok("main.js supports session auto-approve", /sessionAutoApproved/.test(main));
  ok("main.js provides 1-click rollback action", /async function doRollback\s*\(/.test(main));
  ok("main.js includes rollback button on status bar", /id="zs-rollback"/.test(main));
  ok("main.js includes workspace changes summary button", /id="zs-changes-btn"/.test(main));
  ok("main.js includes workspace changes modal container", /id="zs-changes-modal"/.test(main));
  ok("main.js renders workspace changes preview tree", /function showWorkspaceChangesModal\s*\(/.test(main));
  ok("main.js includes review modal container", /id="zs-review-modal"/.test(main));
  ok("main.js exposes Review Actions toggle in menu", /id="zs-review-mode-toggle"/.test(main));
  ok("main.js persists review mode preference", /zsReviewMode/.test(main));

  ok("overlay.css styles review modal", /#zs-review-modal\s*\{/.test(css));
  ok("overlay.css styles review dialog card", /\.zs-review-card\s*\{/.test(css));
  ok("overlay.css styles side-by-side diff box", /\.zs-diff-box\s*\{/.test(css));
  ok("overlay.css styles side-by-side scroll", /\.zs-diff-scroll\s*\{/.test(css));
  ok("overlay.css styles diff fold bar", /\.zs-diff-fold-bar\s*\{/.test(css));
  ok("overlay.css styles word diff del and add", /\.zs-word-del\s*\{/.test(css) && /\.zs-word-add\s*\{/.test(css));
  ok("overlay.css styles responsive under 600px", /@media\s*\(max-width:\s*600px\)/.test(css));
  ok("overlay.css styles session switch toggle", /\.zs-review-switch\s*\{/.test(css));
  ok("overlay.css styles outline reject button", /\.zs-review-btn-outline\s*\{/.test(css));
  ok("overlay.css styles solid approve button", /\.zs-review-btn-solid\s*\{/.test(css));
  ok("overlay.css styles rollback button", /#zs-rollback\s*\{/.test(css));
  ok("overlay.css styles changes button on bar", /#zs-changes-btn\s*\{/.test(css));
  ok("overlay.css styles workspace changes modal", /#zs-changes-modal\s*\{/.test(css));
}

// ── 7. Workspace Changes Redesign & Status Chips ────────────────────────────
{
  const chipCreate = G.resolveFileStatusChip({ tool: "create_file" });
  ok("resolveFileStatusChip creates A chip for create_file", chipCreate.chip === "A" && chipCreate.text === "File baru" && chipCreate.cls === "zs-chip-a");

  const chipEdit = G.resolveFileStatusChip({ tool: "replace_string_in_file" });
  ok("resolveFileStatusChip creates M chip for edit", chipEdit.chip === "M" && chipEdit.text === "Diubah" && chipEdit.cls === "zs-chip-m");

  const chipDelete = G.resolveFileStatusChip({ tool: "delete_file" });
  ok("resolveFileStatusChip creates D chip for delete_file", chipDelete.chip === "D" && chipDelete.text === "Dihapus" && chipDelete.cls === "zs-chip-d");

  const main = fs.readFileSync(__dirname + "/core/main.js", "utf8");
  const css = fs.readFileSync(__dirname + "/overlay.css", "utf8");

  ok("main.js calculates total adds and dels in workspace changes", /totalAdds\s*\+=/.test(main) && /totalDels\s*\+=/.test(main));
  ok("main.js supports arrow key navigation in workspace modal", /e\.key === "ArrowDown"/.test(main) && /e\.key === "ArrowUp"/.test(main));
  ok("main.js supports Escape key to close modal", /e\.key === "Escape"/.test(main));
  ok("main.js supports empty state message", /Belum ada perubahan di workspace/.test(main));
  ok("main.js supports large binary file message", /Pratinjau tidak tersedia/.test(main));
  ok("main.js resets preview scroll to top on file switch", /scrollPane\.scrollTop = 0/.test(main));

  ok("overlay.css styles workspace changes card (max 980px)", /\.zs-ws-changes-card\s*\{[^}]*max\(980px|\.zs-ws-changes-card\s*\{[^}]*980px/.test(css));
  ok("overlay.css styles workspace header", /\.zs-ws-header\s*\{/.test(css));
  ok("overlay.css styles workspace tree sidebar (260px)", /\.zs-ws-tree-sidebar\s*\{[^}]*260px/.test(css));
  ok("overlay.css styles status chips M, A, D", /\.zs-ws-chip\s*\{/.test(css) && /\.zs-chip-m\s*\{/.test(css));
  ok("overlay.css styles active tree file selection indicator", /\.zs-ws-tree-file\.active\s*\{/.test(css));
  ok("overlay.css styles sticky column headers (Sebelum, Sesudah)", /\.zs-diff-col-headers\s*\{/.test(css));
  ok("overlay.css styles workspace footer", /\.zs-ws-footer\s*\{/.test(css));
  ok("overlay.css styles responsive under 700px", /@media\s*\(max-width:\s*700px\)/.test(css));
}


