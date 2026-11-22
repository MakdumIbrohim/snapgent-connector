// SPDX-License-Identifier: GPL-3.0-or-later
// core/guard.js - the two bits of execution policy that used to live inline in
// main.js and therefore had no tests. PURE logic, zero DOM, so this file can be
// loaded and checked by node without a browser.
//
// Why they moved out: both decide whether a tool runs, and both were wrong in a
// way nobody could see by reading the diff (see the review of PR #3):
//
//   1. A retried call could repeat a side effect. A dropped socket reported the
//      same "disconnected" whether the request had never left the extension or
//      had reached the bridge and maybe run. Retrying the second case applies
//      write_file / run_command twice.
//   2. A scroll held nothing - it CANCELLED the command, so a call that became
//      ready exactly as the user scrolled up was dropped and reported to the
//      model as "skipped".
const ZSGuard = (() => {
  "use strict";

  // The bridge reports `sent` on every failure it can identify:
  //   sent: true  - the frame went out; the tool MAY have run.
  //   sent: false - it never left (not connected, or ws.send threw).
  //   undefined   - an older bridge, which never sent this field.
  //
  // Undefined is treated as UNSAFE. An old bridge that did deliver the request
  // is indistinguishable from one that did not, and duplicating a write is worse
  // than telling the user the command may already have run.
  function mayRetryAfterDisconnect(res) {
    return !!(res && res.kind === "disconnected" && res.sent === false);
  }

  // The message the model receives when a command was lost mid-flight. It must
  // NOT invite a blind retry: the tool may have completed, so repeating a
  // destructive command would apply it twice.
  function inFlightFailure(name) {
    return (
      `ERROR: the connection dropped after '${name}' was sent, so it may or may ` +
      "not have run. Do not repeat a destructive command blindly - check the " +
      "current state first."
    );
  }

  // ── Scroll hold ───────────────────────────────────────────────────────────
  // A hold, not a cancel: the command waits for the suppression window to lapse
  // and then proceeds. Returns true when the caller may run, false when the user
  // asked to stop while it was parked.
  //
  // `now` and `sleep` are injected so the wait is testable without real time.
  async function holdUntilScrollLapses(opts) {
    const o = opts || {};
    const isSuppressed = o.isSuppressed || (() => false);
    const isStopped = o.isStopped || (() => false);
    const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = o.now || (() => Date.now());
    const pollMs = o.pollMs == null ? 120 : o.pollMs;
    // Bounded: at most two extra windows, so a pathological scroll loop cannot
    // park a command forever.
    const capMs = o.capMs == null ? 8500 : o.capMs;
    const deadline = now() + capMs;

    while (isSuppressed() && now() < deadline) {
      if (isStopped()) return false;
      await sleep(pollMs);
    }
    return !isStopped();
  }

  // ── Per-element scroll positions ──────────────────────────────────────────
  // The listener is on `document` in the capture phase, so it sees the
  // transcript, the sidebar, code blocks and textareas. One shared "last top"
  // compared values from DIFFERENT elements: sidebar at 900 then transcript at
  // 400 read as an upward move of 500px and held execution for nothing.
  function createScrollTracker(threshold) {
    const min = threshold == null ? 24 : threshold;
    // WeakMap in the page, so a scrollable element that the site removes can be
    // collected instead of being kept alive for the tab's lifetime. A WeakMap
    // only accepts OBJECT keys, so anything else (a string in the tests, or a
    // missing target) falls back to Map - otherwise observe() would throw
    // "Invalid value used as weak map key" and kill the scroll listener.
    const weak = typeof WeakMap === "function";
    // The fallback MUST always exist: a non-object key (a string in the tests,
    // or a missing target) cannot go into a WeakMap, and silently dropping the
    // write would stop the tracker from ever noticing an upward move.
    const fallback = new Map();
    const strong = new WeakMap();
    const isObject = (k) => !!k && (typeof k === "object" || typeof k === "function");
    const useWeak = (k) => weak && isObject(k);
    const store = {
      get: (k) => (useWeak(k) ? strong.get(k) : fallback.get(k)),
      set: (k, v) => {
        if (useWeak(k)) strong.set(k, v);
        else fallback.set(k, v);
      },
      delete: (k) => (useWeak(k) ? strong.delete(k) : fallback.delete(k)),
    };
    const liveKeys = new Set();
    if (!weak) {
      // Without a WeakMap, `last` IS the fallback map; keep them identical.
      store.get = (k) => fallback.get(k);
      store.set = (k, v) => fallback.set(k, v);
      store.delete = (k) => fallback.delete(k);
    }
    return {
      // Returns true when this move counts as an upward scroll.
      observe(key, top) {
        const prev = store.get(key);
        store.set(key, top);
        liveKeys.add(key);
        if (prev == null) return false;
        return top < prev - min;
      },
      forget(key) {
        store.delete(key);
        liveKeys.delete(key);
      },
      size() {
        return liveKeys.size;
      },
    };
  }

  // ── Heartbeat decision ────────────────────────────────────────────────────
  // Should a stale-looking socket be dropped? Time alone is NOT proof: Chrome
  // suspends the MV3 worker and setInterval does not run while suspended, so
  // lastMessageAt is always old right after a wake-up. Only a failed ping may
  // close the socket.
  //
  //   { shouldProbe: true }  - stale, so ask for a pong first
  //   { close: true }        - stale AND the bridge did not answer
  //   { close: false }       - either fresh, or the pong proved it healthy
  function heartbeatDecision(opts) {
    const o = opts || {};
    const now = o.now == null ? Date.now() : o.now;
    const lastMessageAt = o.lastMessageAt || 0;
    const staleMs = o.staleMs == null ? 25000 : o.staleMs;
    const stale = !!lastMessageAt && now - lastMessageAt > staleMs;
    if (!stale) return { shouldProbe: false, close: false };
    // pongAnswered is undefined when the probe has not been made yet.
    if (o.pongAnswered === undefined) return { shouldProbe: true, close: false };
    return { shouldProbe: true, close: !o.pongAnswered };
  }

  // ── Per-call execution memory ───────────────────────────────────────────
  // The turn-level `executed` map keys on a TEXT PREFIX of the reply, so it
  // misses a replayed call whose text changed: the site re-renders the answer
  // once a tool result lands below it, startsWith() no longer holds, and the
  // watchdog (or a stale tab) dispatches the SAME command again - measured live
  // as one identical `list_dir` every 30 s for 20+ minutes while nothing else
  // ran. It also cannot tell one call from another inside a reply that carries
  // several commands.
  //
  // This memory keys on (turn key, tool name, canonical arguments): the same
  // call in the same turn can only ever run once, no matter how the reply text
  // is re-rendered. Different arguments, or the same call in another turn, are
  // still allowed - that is ordinary agent behaviour.
  function createCallMemory(opts) {
    const o = opts || {};
    const limit = o.limit > 0 ? o.limit : 64;
    const map = new Map(); // turnKey -> Set(signature)
    // Order-independent serialisation, so {"a":1,"b":2} and {"b":2,"a":1} are
    // the same call (models reorder keys between retries of one command).
    const canon = (v) => {
      if (v === null || typeof v !== "object") {
        try { return JSON.stringify(v); } catch { return String(v); }
      }
      if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
      const keys = Object.keys(v).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
    };
    const signature = (call) => {
      if (!call || typeof call !== "object") return "";
      const name = String(call.tool || call.command || "");
      const raw = call.arguments != null ? call.arguments : call.params;
      let body;
      try {
        body = typeof raw === "string" ? raw : canon(raw == null ? {} : raw);
      } catch {
        body = String(raw);
      }
      return (name || "?") + "|" + body;
    };
    return {
      signature,
      remember(turnKey, call) {
        const sig = signature(call);
        if (!turnKey || !sig) return;
        let set = map.get(turnKey);
        if (!set) {
          if (map.size >= limit) map.delete(map.keys().next().value);
          set = new Set();
          map.set(turnKey, set);
        }
        set.add(sig);
      },
      has(turnKey, call) {
        const set = map.get(turnKey);
        return !!(set && set.has(signature(call)));
      },
      size() { return map.size; },
      clear() { map.clear(); },
    };
  }

  // A reply produced by the ChatGPT mobile app lands in the page through the
  // server-side conversation sync and never passes through the loop's "wait for
  // the reply I just sent" path. Measured 2026-11-18: such a reply sat in the DOM
  // with a perfectly good {"command":"list_dir"} block and the loop read it as
  // plain text, ended, and resume answered no-command.
  // The decision lives here so it can be tested without a DOM: adopt at most one
  // command per assistant turn, never the turn that was already on screen when
  // adoption started (so enabling the toggle cannot fire an old command), and
  // never a turn whose commands all ran already.
  function createRemoteCommandAdopter(opts) {
    const o = opts || {};
    const limit = o.limit > 0 ? o.limit : 64;
    const seen = new Set();
    let baseline = null;
    const remember = (key) => {
      if (!key) return;
      if (seen.size >= limit) seen.delete(seen.values().next().value);
      seen.add(key);
    };
    return {
      setBaseline(key) { baseline = key || null; },
      baseline() { return baseline; },
      seenBefore(key) { return !!key && seen.has(key); },
      decide(input) {
        const i = input || {};
        if (!i.enabled) return "disabled";
        if (!i.started) return "not-started";
        if (i.busy) return "busy";
        if (i.generating) return "generating";
        if (!i.key) return "no-turn";
        if (baseline === null) { baseline = i.key; return "baseline"; }
        if (i.key === baseline) return "not-new";
        if (seen.has(i.key)) return "seen";
        if (!i.hasSignature) return "no-command";
        if (!i.callCount) return "unparseable";
        if (i.allExecuted) {
          remember(i.key);
          return "already-call";
        }
        remember(i.key);
        return "adopt";
      },
      size() { return seen.size; },
      clear() { seen.clear(); baseline = null; },
    };
  }

  // ── Run stats on a tool chip / the "Agent is working" cover ──────────────
  // The chip already showed the tool name and a spinner, but the question a user
  // actually asks about a run is "what did it do, how many tokens did it get, and
  // how long did it take". Both numbers are derivable from data we already have
  // (result length ≈ chars/4, and a start timestamp), so this stays pure text
  // formatting - no DOM, no extra bridge round-trip.

  // Same compacting as the page's token meter: 0-999 as-is, then 1k/1.1k/99k/1M
  // (one decimal below 10 of the unit, trailing ".0" dropped) so a live number
  // cannot grow into a wide, jumpy string.
  function compactCount(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return "";
    if (v < 1000) return String(Math.round(v));
    for (const [div, suf] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]]) {
      if (v >= div) {
        const scaled = v / div;
        const rounded = scaled < 10 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
        return rounded + suf;
      }
    }
    return String(Math.round(v));
  }

  // Tokens are an ESTIMATE (no tokenizer in the extension), so they are shown
  // with a leading "~" and must never be presented as billed usage.
  function tokensFromChars(chars) {
    const c = Number(chars);
    if (!Number.isFinite(c) || c <= 0) return 0;
    return Math.floor(c / 4);
  }

  // One detail line: "<what it did> · ~N tok · 1.4s".
  //   arg   - the call's own arguments (already summarised by the caller)
  //   inChars / tokIn   - the streamed command text (what the model sent)
  //   chars   / tokOut  - the tool RESULT (what came back - the useful count)
  //   ms                - measured wall time of the call
  // Returns "" when there is nothing truthful to show, so callers can fall back
  // to the plain summary instead of printing an empty " · · ".
  function formatRunStats(input) {
    const i = input || {};
    const parts = [];
    if (i.arg) {
      const arg = String(i.arg).replace(/\s+/g, " ").trim();
      if (arg) parts.push(arg.length > 60 ? arg.slice(0, 57) + "…" : arg);
    }
    const tokIn = Number(i.tokIn) > 0 ? Number(i.tokIn) : tokensFromChars(i.inChars);
    if (tokIn > 0) parts.push(`in ~${compactCount(tokIn)} tok`);
    const tokOut = Number(i.tokOut) > 0 ? Number(i.tokOut) : tokensFromChars(i.chars);
    if (tokOut > 0) parts.push(`out ~${compactCount(tokOut)} tok`);
    const ms = Number(i.ms);
    if (Number.isFinite(ms) && ms > 0) {
      parts.push(ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`);
    }
    return parts.join(" · ");
  }

  // ── Safety & Review Guard ────────────────────────────────────────────────
  // Tools that do not modify files, game datamodels, or system state. These are
  // safe to run immediately without requiring human confirmation.
  const READ_ONLY_TOOLS = new Set([
    "read_file", "list_dir", "grep_search", "find_by_name", "find_files",
    "git_status", "git_diff", "git_log", "git_branches",
    "list_commands", "list_tools", "list_mcp_servers",
    "inspect_instance", "get_studio_state", "search_game_tree", "script_read", "get_outline"
  ]);

  function isMutatingTool(name) {
    if (!name || typeof name !== "string") return false;
    const bare = name.split("/").pop().toLowerCase().trim();
    return !READ_ONLY_TOOLS.has(bare);
  }

  // Formats human-readable metadata and diff/code preview for the Review dialog.
  function formatDiffPreview(call) {
    if (!call || typeof call !== "object") {
      return { type: "unknown", target: "", title: "Execute Action", preview: "" };
    }
    const tool = String(call.tool || call.command || "");
    const bare = tool.split("/").pop().toLowerCase().trim();
    const args = (call.arguments != null ? call.arguments : call.params) || {};
    const target = String(args.path || args.file || args.filename || args.command || args.target || "");

    const isWrite = bare === "write_file" || bare === "create_file" || bare === "overwrite_file";
    const isEdit = bare === "replace_string_in_file" || bare === "edit_file" || bare === "modify_file" || bare === "patch_file" || bare === "apply_patch";
    const isDelete = bare === "delete_file" || bare === "remove_file" || bare === "unlink" || bare === "trash_file";

    if (isWrite) {
      const content = typeof args.content === "string" ? args.content : JSON.stringify(args.content || "", null, 2);
      return {
        type: "write",
        target,
        title: `Write File: ${target || "unnamed"}`,
        preview: content
      };
    }
    if (isEdit) {
      const oldStr = String(args.old_text != null ? args.old_text : (args.old_string != null ? args.old_string : ""));
      const newStr = String(args.new_text != null ? args.new_text : (args.new_string != null ? args.new_string : ""));
      const diffLines = [];
      for (const line of oldStr.split("\n")) diffLines.push(`- ${line}`);
      for (const line of newStr.split("\n")) diffLines.push(`+ ${line}`);
      return {
        type: "replace",
        target,
        title: `Edit in: ${target || "unnamed"}`,
        preview: diffLines.join("\n")
      };
    }
    if (isDelete) {
      return {
        type: "delete",
        target,
        title: `Delete File: ${target || "unnamed"}`,
        preview: `Warning: This will permanently delete '${target}'.`
      };
    }
    if (bare === "execute_luau") {
      const code = String(args.code || args.script || "");
      return {
        type: "luau",
        target: args.datamodel_type || "Edit",
        title: `Execute Luau (${args.datamodel_type || "Edit"})`,
        preview: code
      };
    }
    if (bare === "git_commit") {
      return {
        type: "git_commit",
        target: "git",
        title: `Git Commit`,
        preview: `Commit message: ${args.message || "(empty)"}`
      };
    }
    return {
      type: "generic",
      target,
      title: `Execute Command: ${bare || "unknown"}`,
      preview: JSON.stringify(args, null, 2)
    };
  }

  // In-memory stack of file snapshots for 1-click rollback / undo.
  function createRollbackTracker(limit = 32) {
    const stack = [];
    const max = limit > 0 ? limit : 32;
    return {
      push(entry) {
        if (!entry || !entry.path) return;
        stack.push({
          action: entry.action || "restore",
          path: String(entry.path),
          content: entry.content != null ? String(entry.content) : null,
          timestamp: entry.timestamp || Date.now(),
        });
        if (stack.length > max) stack.shift();
      },
      pop() {
        return stack.pop() || null;
      },
      peek() {
        return stack.length ? stack[stack.length - 1] : null;
      },
      canRollback() {
        return stack.length > 0;
      },
      size() {
        return stack.length;
      },
      clear() {
        stack.length = 0;
      }
    };
  }

  // Groups a list of file change records or paths by their directory for workspace preview.
  function groupFilesByDirectory(items) {
    if (!Array.isArray(items)) return [];
    const map = new Map();
    for (const item of items) {
      if (!item) continue;
      const path = typeof item === "string" ? item : String(item.path || "");
      if (!path) continue;
      const norm = path.replace(/\\/g, "/");
      const lastSlash = norm.lastIndexOf("/");
      const folder = lastSlash === -1 ? "./" : norm.slice(0, lastSlash + 1);
      const name = lastSlash === -1 ? norm : norm.slice(lastSlash + 1);
      if (!map.has(folder)) map.set(folder, []);
      map.get(folder).push({
        path: norm,
        name,
        item: typeof item === "object" ? item : { path: norm, name },
      });
    }
    const result = [];
    for (const [folder, files] of map.entries()) {
      result.push({ folder, files });
    }
    result.sort((a, b) => a.folder.localeCompare(b.folder));
    return result;
  }

  function resolveFileStatusChip(item) {
    if (!item) return { chip: "M", text: "Diubah", cls: "zs-chip-m" };
    const tool = String(item.tool || (item.call && item.call.tool) || "").toLowerCase();
    const type = item.type || (item.reviewData && item.reviewData.type);
    if (tool.includes("create") || type === "create") {
      return { chip: "A", text: "File baru", cls: "zs-chip-a" };
    }
    if (tool.includes("delete") || tool.includes("remove") || tool.includes("unlink") || type === "delete") {
      return { chip: "D", text: "Dihapus", cls: "zs-chip-d" };
    }
    return { chip: "M", text: "Diubah", cls: "zs-chip-m" };
  }

  // ── Side-by-Side Diff & File Review Logic ─────────────────────────────────

  function countOccurrences(content, needle) {
    if (!needle) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = content.indexOf(needle, pos)) !== -1) {
      count++;
      pos += needle.length;
    }
    return count;
  }

  function computeWordDiff(leftStr, rightStr) {
    const leftTokens = leftStr.match(/\s+|[^\s\w]+|\w+/g) || [];
    const rightTokens = rightStr.match(/\s+|[^\s\w]+|\w+/g) || [];

    const m = leftTokens.length;
    const n = rightTokens.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        if (leftTokens[i] === rightTokens[j]) {
          dp[i + 1][j + 1] = dp[i][j] + 1;
        } else {
          dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    let i = m;
    let j = n;
    const leftWords = [];
    const rightWords = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && leftTokens[i - 1] === rightTokens[j - 1]) {
        leftWords.push({ text: leftTokens[i - 1], changed: false });
        rightWords.push({ text: rightTokens[j - 1], changed: false });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        rightWords.push({ text: rightTokens[j - 1], changed: true });
        j--;
      } else {
        leftWords.push({ text: leftTokens[i - 1], changed: true });
        i--;
      }
    }
    leftWords.reverse();
    rightWords.reverse();
    return { leftWords, rightWords };
  }

  function computeLineDiff(oldLines, newLines) {
    const m = oldLines.length;
    const n = newLines.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        if (oldLines[i] === newLines[j]) {
          dp[i + 1][j + 1] = dp[i][j] + 1;
        } else {
          dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    let i = m;
    let j = n;
    const edits = [];
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        edits.push({ type: "equal", oldLine: oldLines[i - 1], newLine: newLines[j - 1], oldIdx: i, newIdx: j });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        edits.push({ type: "add", newLine: newLines[j - 1], newIdx: j });
        j--;
      } else {
        edits.push({ type: "delete", oldLine: oldLines[i - 1], oldIdx: i });
        i--;
      }
    }
    edits.reverse();
    return edits;
  }

  function lineSimilarity(lineA, lineB) {
    const wordsA = new Set((lineA.toLowerCase().match(/\w+/g) || []));
    const wordsB = lineB.toLowerCase().match(/\w+/g) || [];
    if (wordsA.size === 0 || wordsB.length === 0) return 0;
    let matches = 0;
    for (const w of wordsB) {
      if (wordsA.has(w)) matches++;
    }
    return matches / Math.max(wordsA.size, wordsB.length);
  }

  function alignDiffRows(edits) {
    const rows = [];
    let idx = 0;
    while (idx < edits.length) {
      const edit = edits[idx];
      if (edit.type === "equal") {
        rows.push({
          kind: "equal",
          left: { lineNo: edit.oldIdx, sign: "", text: edit.oldLine, words: [{ text: edit.oldLine, changed: false }] },
          right: { lineNo: edit.newIdx, sign: "", text: edit.newLine, words: [{ text: edit.newLine, changed: false }] },
        });
        idx++;
      } else {
        const deletes = [];
        const adds = [];
        while (idx < edits.length && edits[idx].type !== "equal") {
          if (edits[idx].type === "delete") deletes.push(edits[idx]);
          else if (edits[idx].type === "add") adds.push(edits[idx]);
          idx++;
        }

        // Pair up deletes and adds that share similar content into "modify"
        const pairedAdds = new Set();
        const pairedDeletes = new Set();

        for (let dIdx = 0; dIdx < deletes.length; dIdx++) {
          let bestAddIdx = -1;
          let bestSim = 0.24; // Threshold
          for (let aIdx = 0; aIdx < adds.length; aIdx++) {
            if (pairedAdds.has(aIdx)) continue;
            const sim = lineSimilarity(deletes[dIdx].oldLine, adds[aIdx].newLine);
            if (sim > bestSim) {
              bestSim = sim;
              bestAddIdx = aIdx;
            }
          }
          if (bestAddIdx !== -1) {
            pairedDeletes.add(dIdx);
            pairedAdds.add(bestAddIdx);
            const d = deletes[dIdx];
            const a = adds[bestAddIdx];
            const { leftWords, rightWords } = computeWordDiff(d.oldLine, a.newLine);
            rows.push({
              kind: "modify",
              left: { lineNo: d.oldIdx, sign: "−", text: d.oldLine, words: leftWords },
              right: { lineNo: a.newIdx, sign: "+", text: a.newLine, words: rightWords },
            });
          } else {
            const d = deletes[dIdx];
            rows.push({
              kind: "delete",
              left: { lineNo: d.oldIdx, sign: "−", text: d.oldLine, words: [{ text: d.oldLine, changed: false }] },
              right: null,
            });
          }
        }

        for (let aIdx = 0; aIdx < adds.length; aIdx++) {
          if (!pairedAdds.has(aIdx)) {
            const a = adds[aIdx];
            rows.push({
              kind: "add",
              left: null,
              right: { lineNo: a.newIdx, sign: "+", text: a.newLine, words: [{ text: a.newLine, changed: false }] },
            });
          }
        }
      }
    }
    return rows;
  }

  function foldUnchangedRows(rows) {
    const result = [];
    let i = 0;
    let foldSeq = 0;
    const hasChangeBefore = () => result.some((r) => r.type === "row" && r.kind !== "equal");

    while (i < rows.length) {
      if (rows[i].kind !== "equal") {
        result.push({ type: "row", ...rows[i] });
        i++;
        continue;
      }

      // Collect contiguous equal rows
      const eqStart = i;
      while (i < rows.length && rows[i].kind === "equal") {
        i++;
      }
      const eqRows = rows.slice(eqStart, i);
      const L = eqRows.length;

      // Has changes after this block?
      let changeAfter = false;
      for (let k = i; k < rows.length; k++) {
        if (rows[k].kind !== "equal") {
          changeAfter = true;
          break;
        }
      }
      const changeBefore = hasChangeBefore();

      if (L <= 6) {
        for (const r of eqRows) result.push({ type: "row", ...r });
      } else {
        // More than 6 unchanged lines: fold with 3 lines of context around changes
        if (!changeBefore && changeAfter) {
          // Beginning of file before first change: keep last 3 lines, fold the preceding L - 3 lines
          const foldCount = L - 3;
          const foldItems = eqRows.slice(0, foldCount);
          const keepItems = eqRows.slice(foldCount);
          result.push({ type: "fold", foldId: `f_${++foldSeq}`, count: foldCount, rows: foldItems });
          for (const r of keepItems) result.push({ type: "row", ...r });
        } else if (changeBefore && !changeAfter) {
          // End of file after last change: keep first 3 lines, fold the trailing L - 3 lines
          const keepItems = eqRows.slice(0, 3);
          const foldCount = L - 3;
          const foldItems = eqRows.slice(3);
          for (const r of keepItems) result.push({ type: "row", ...r });
          result.push({ type: "fold", foldId: `f_${++foldSeq}`, count: foldCount, rows: foldItems });
        } else if (changeBefore && changeAfter) {
          // In between two changes: keep first 3 and last 3 lines, fold middle L - 6 lines
          const keepHead = eqRows.slice(0, 3);
          const foldCount = L - 6;
          const foldItems = eqRows.slice(3, 3 + foldCount);
          const keepTail = eqRows.slice(3 + foldCount);
          for (const r of keepHead) result.push({ type: "row", ...r });
          result.push({ type: "fold", foldId: `f_${++foldSeq}`, count: foldCount, rows: foldItems });
          for (const r of keepTail) result.push({ type: "row", ...r });
        } else {
          // No changes at all in entire file
          result.push({ type: "fold", foldId: `f_${++foldSeq}`, count: L, rows: eqRows });
        }
      }
    }
    return result;
  }

  function prepareFileReview(call, currentContent) {
    if (!call || typeof call !== "object") {
      return {
        type: "unknown",
        target: "",
        title: "Aksi Agen",
        statusBadge: "",
        addCount: 0,
        delCount: 0,
        error: null,
        noChanges: false,
        canApprove: true,
        isSinglePanel: false,
        items: [],
      };
    }
    const tool = String(call.tool || call.command || "");
    const bare = tool.split("/").pop().toLowerCase().trim();
    const args = (call.arguments != null ? call.arguments : call.params) || {};
    const target = String(args.path || args.file || args.filename || args.command || args.target || "");

    const isWrite = bare === "write_file" || bare === "create_file" || bare === "overwrite_file";
    const isEdit = bare === "replace_string_in_file" || bare === "edit_file" || bare === "modify_file" || bare === "patch_file" || bare === "apply_patch";
    const isDelete = bare === "delete_file" || bare === "remove_file" || bare === "unlink" || bare === "trash_file";

    // 1. Edit file (replace_string_in_file / edit_file)
    if (isEdit) {
      const oldText = String(args.old_text != null ? args.old_text : (args.old_string != null ? args.old_string : (args.target != null && typeof args.target === "string" ? args.target : "")));
      const newText = String(args.new_text != null ? args.new_text : (args.new_string != null ? args.new_string : (args.replacement != null ? args.replacement : "")));

      if (currentContent == null) {
        // Fallback diff directly between oldText and newText if disk file content is unavailable
        const oldLines = oldText ? oldText.split("\n") : [];
        const newLines = newText ? newText.split("\n") : [];
        const edits = computeLineDiff(oldLines, newLines);
        const aligned = alignDiffRows(edits);

        let addCount = 0;
        let delCount = 0;
        for (const row of aligned) {
          if (row.kind === "add") addCount++;
          else if (row.kind === "delete") delCount++;
          else if (row.kind === "modify") {
            addCount++;
            delCount++;
          }
        }
        const items = foldUnchangedRows(aligned);
        return {
          type: "edit",
          target,
          title: "Agen ingin mengubah file ini",
          statusBadge: "Perubahan ditulis ke file yang sudah ada",
          addCount,
          delCount,
          error: null,
          noChanges: false,
          canApprove: true,
          isSinglePanel: false,
          items,
        };
      }

      const count = countOccurrences(currentContent, oldText);
      if (oldText === "" || count === 0) {
        // Render diff between oldText and newText so user sees what the agent tried to do
        const oldLines = oldText ? oldText.split("\n") : [];
        const newLines = newText ? newText.split("\n") : [];
        const edits = computeLineDiff(oldLines, newLines);
        const aligned = alignDiffRows(edits);
        let addCount = 0;
        let delCount = 0;
        for (const row of aligned) {
          if (row.kind === "add") addCount++;
          else if (row.kind === "delete") delCount++;
          else if (row.kind === "modify") {
            addCount++;
            delCount++;
          }
        }
        return {
          type: "edit",
          target,
          title: "Agen ingin mengubah file ini",
          statusBadge: "Perubahan ditulis ke file yang sudah ada",
          addCount,
          delCount,
          error: "Teks lama tidak ditemukan di dalam file.",
          noChanges: false,
          canApprove: false,
          isSinglePanel: false,
          items: aligned,
        };
      }
      if (count > 1) {
        const oldLines = oldText ? oldText.split("\n") : [];
        const newLines = newText ? newText.split("\n") : [];
        const edits = computeLineDiff(oldLines, newLines);
        const aligned = alignDiffRows(edits);
        let addCount = 0;
        let delCount = 0;
        for (const row of aligned) {
          if (row.kind === "add") addCount++;
          else if (row.kind === "delete") delCount++;
          else if (row.kind === "modify") {
            addCount++;
            delCount++;
          }
        }
        return {
          type: "edit",
          target,
          title: "Agen ingin mengubah file ini",
          statusBadge: "Perubahan ditulis ke file yang sudah ada",
          addCount,
          delCount,
          error: `Teks lama muncul lebih dari sekali di dalam file (${count} kali).`,
          noChanges: false,
          canApprove: false,
          isSinglePanel: false,
          items: aligned,
        };
      }

      // Exact single occurrence: perform in-memory replacement
      const newContent = currentContent.replace(oldText, newText);
      if (newContent === currentContent) {
        return {
          type: "edit",
          target,
          title: "Agen ingin mengubah file ini",
          statusBadge: "Perubahan ditulis ke file yang sudah ada",
          addCount: 0,
          delCount: 0,
          error: "Tidak ada perubahan",
          noChanges: true,
          canApprove: false,
          isSinglePanel: false,
          items: [],
        };
      }

      const oldLines = currentContent.split("\n");
      const newLines = newContent.split("\n");
      const edits = computeLineDiff(oldLines, newLines);
      const aligned = alignDiffRows(edits);

      let addCount = 0;
      let delCount = 0;
      for (const row of aligned) {
        if (row.kind === "add") addCount++;
        else if (row.kind === "delete") delCount++;
        else if (row.kind === "modify") {
          addCount++;
          delCount++;
        }
      }

      const items = foldUnchangedRows(aligned);
      return {
        type: "edit",
        target,
        title: "Agen ingin mengubah file ini",
        statusBadge: "Perubahan ditulis ke file yang sudah ada",
        addCount,
        delCount,
        error: null,
        noChanges: false,
        canApprove: true,
        isSinglePanel: false,
        items,
      };
    }

    // 2. write_file / create_file
    if (isWrite) {
      const newContent = typeof args.content === "string" ? args.content : JSON.stringify(args.content || "", null, 2);

      // File already exists -> full rewrite
      if (currentContent != null) {
        if (currentContent === newContent) {
          return {
            type: "write",
            target,
            title: "Agen ingin mengubah file ini",
            statusBadge: "Perubahan ditulis ke file yang sudah ada",
            addCount: 0,
            delCount: 0,
            error: "Tidak ada perubahan",
            noChanges: true,
            canApprove: false,
            isSinglePanel: false,
            items: [],
          };
        }

        const oldLines = currentContent.split("\n");
        const newLines = newContent.split("\n");
        const edits = computeLineDiff(oldLines, newLines);
        const aligned = alignDiffRows(edits);

        let addCount = 0;
        let delCount = 0;
        for (const row of aligned) {
          if (row.kind === "add") addCount++;
          else if (row.kind === "delete") delCount++;
          else if (row.kind === "modify") {
            addCount++;
            delCount++;
          }
        }
        const items = foldUnchangedRows(aligned);
        return {
          type: "write",
          target,
          title: "Agen ingin mengubah file ini",
          statusBadge: "Perubahan ditulis ke file yang sudah ada",
          addCount,
          delCount,
          error: null,
          noChanges: false,
          canApprove: true,
          isSinglePanel: false,
          items,
        };
      }

      // New file (does not exist yet)
      const lines = newContent.split("\n");
      const items = lines.map((line, idx) => ({
        type: "row",
        kind: "add",
        left: null,
        right: { lineNo: idx + 1, sign: "+", text: line, words: [{ text: line, changed: false }] },
      }));

      return {
        type: "create",
        target,
        title: "Agen ingin membuat file ini",
        statusBadge: "File baru",
        addCount: lines.length,
        delCount: 0,
        error: null,
        noChanges: false,
        canApprove: true,
        isSinglePanel: true,
        items,
      };
    }

    // 3. delete_file / remove_file
    if (isDelete) {
      const rawLines = currentContent != null ? currentContent.split("\n") : [`[Hapus file: ${target || "file"}]`];
      const items = rawLines.map((line, idx) => ({
        type: "row",
        kind: "delete",
        left: { lineNo: idx + 1, sign: "−", text: line, words: [{ text: line, changed: false }] },
        right: null,
      }));
      return {
        type: "delete",
        target,
        title: "Agen ingin menghapus file ini",
        statusBadge: "File akan dihapus",
        addCount: 0,
        delCount: rawLines.length,
        error: null,
        noChanges: false,
        canApprove: true,
        isSinglePanel: true,
        items,
      };
    }

    // Fallback for other commands
    return {
      type: "generic",
      target,
      title: "Agen ingin menjalankan aksi ini",
      statusBadge: "",
      addCount: 0,
      delCount: 0,
      error: null,
      noChanges: false,
      canApprove: true,
      isSinglePanel: true,
      items: [],
    };
  }

  return {
    mayRetryAfterDisconnect,
    formatRunStats,
    compactCount,
    tokensFromChars,
    createCallMemory,
    createRemoteCommandAdopter,
    inFlightFailure,
    holdUntilScrollLapses,
    createScrollTracker,
    heartbeatDecision,
    isMutatingTool,
    formatDiffPreview,
    createRollbackTracker,
    groupFilesByDirectory,
    countOccurrences,
    computeWordDiff,
    computeLineDiff,
    alignDiffRows,
    foldUnchangedRows,
    prepareFileReview,
    resolveFileStatusChip,
  };
})();
