#!/usr/bin/env -S npx tsx
/**
 * ralph - drive a Cursor SDK agent in an infinite loop toward GOAL.md,
 * persisting progress in STATE.md and surviving restarts.
 *
 *   ralph PROMPT.md GOAL.md [--model id] [--state path] [--reset-every n]
 *                           [--token-budget n] [--idle-ms n] [--max-iters n]
 */

import {
  Agent,
  Cursor,
  CursorAgentError,
  AuthenticationError,
  ConfigurationError,
} from "@cursor/sdk";
import type { SDKAgent, Run, RunResult, SDKMessage } from "@cursor/sdk";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface ModelSpec {
  id: string;
  params?: { id: string; value: string }[];
}

interface Args {
  promptPath?: string; // undefined => use BUILTIN_PROMPT
  goalPath: string;
  model: ModelSpec;
  statePath?: string;
  planPath?: string;
  workspacePath?: string;
  resetEvery: number;
  tokenBudget: number;
  idleMs: number;
  maxIters: number;
  noPlan: boolean;
}

function parseModelSpec(s: string): ModelSpec {
  // Format: "id" or "id,key=value,key=value"
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const id = parts.shift();
  if (!id) die(`--model requires an id (e.g. claude-opus-4-7)`);
  const params: { id: string; value: string }[] = [];
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) die(`--model param "${p}" must be key=value (e.g. thinking=high)`);
    params.push({ id: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim() });
  }
  return params.length > 0 ? { id, params } : { id };
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const BOOL_FLAGS = new Set(["no-plan", "print-prompt"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      printHelpAndExit(0);
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) {
        bools.add(key);
        continue;
      }
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        die(`Flag --${key} requires a value`);
      }
      flags.set(key, val);
      i++;
    } else {
      positional.push(a);
    }
  }

  if (bools.has("print-prompt")) {
    process.stdout.write(BUILTIN_PROMPT);
    process.exit(0);
  }

  if (positional.length !== 1) {
    printHelpAndExit(positional.length === 0 ? 0 : 2);
  }
  const goalPath = resolve(positional[0]);
  if (!existsSync(goalPath)) die(`File not found: ${goalPath}`);

  const promptPath = flags.get("prompt") ? resolve(flags.get("prompt")!) : undefined;
  if (promptPath && !existsSync(promptPath)) die(`File not found: ${promptPath}`);

  return {
    promptPath,
    goalPath,
    model: parseModelSpec(flags.get("model") ?? "claude-opus-4-7"),
    statePath: flags.get("state") ? resolve(flags.get("state")!) : undefined,
    planPath: flags.get("plan") ? resolve(flags.get("plan")!) : undefined,
    workspacePath: flags.get("workspace") ? resolve(flags.get("workspace")!) : undefined,
    resetEvery: intFlag(flags, "reset-every", 20),
    tokenBudget: intFlag(flags, "token-budget", 800_000),
    idleMs: intFlag(flags, "idle-ms", 2000),
    maxIters: intFlag(flags, "max-iters", Number.MAX_SAFE_INTEGER),
    noPlan: bools.has("no-plan"),
  };
}

function intFlag(flags: Map<string, string>, key: string, def: number): number {
  const v = flags.get(key);
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) die(`--${key} must be a number, got ${v}`);
  return n;
}

function printHelpAndExit(code: number): never {
  const txt = `ralph - drive a Cursor SDK agent in a loop toward GOAL.md

USAGE
  ralph <GOAL.md> [options]

OPTIONS
  --model <spec>        Model spec; "id" or "id,key=value,..." (default: claude-opus-4-7)
                        Examples: claude-opus-4-7   |   claude-opus-4-7,thinking=high
                        Discover ids/params via the Cursor SDK Cursor.models.list().
  --prompt <path>       Override the built-in operating manual with the file at <path>
  --print-prompt        Print the built-in operating manual to stdout and exit
  --workspace <path>    Agent's working dir / cwd (default: <goalDir>/workspace)
  --state <path>        STATE.md path (default: STATE.md next to GOAL.md)
  --plan <path>         PLAN.md path (default: PLAN.md next to GOAL.md)
  --no-plan             Skip the plan phase; collapse each iteration to a single execute send
  --reset-every <n>     Reset agent session every N iterations (default: 20)
  --token-budget <n>    Reset when usage since last reset exceeds N (default: 800000)
  --idle-ms <n>         Sleep between iterations (default: 2000)
  --max-iters <n>       Stop after N iterations (default: infinity)
  -h, --help            Show this help

The operating manual ("how to behave in the loop") is built into the binary so
the user only ever needs to write GOAL.md. To customize, dump it with
\`ralph --print-prompt > my-prompt.md\`, edit, and pass back via \`--prompt\`.

ENV
  CURSOR_API_KEY        Required. Falls back to \`doppler secrets get CURSOR_API_KEY --plain\`.

SIGNALS
  SIGINT/SIGTERM        Cancel current run, dispose agent, exit cleanly.
  SIGUSR1               Force agent reset before next iteration.

LAYOUT (control plane = dirname(GOAL.md); workspace = agent cwd)
  GOAL.md               Mission. You author it; agent only reads it.
  STATE.md              Agent's working memory. Rewritten by the agent each iteration.
  PLAN.md               Plan for the current iteration. Written by plan phase, consumed by execute phase.
  .gitignore            Auto-dropped if missing; ignores workspace/ and .ralph/.
  .ralph/state.json     ralph's own state (agentId, iteration, totals).
  .ralph/iterations/    Per-iteration JSON logs (plan + execute phases).
  .ralph/plans/         Snapshot of every iteration's PLAN.md.
  .ralph/heartbeat      Touched every loop tick.
  .ralph/lock           Pidfile.
  .ralph/reset.signal   Touch to force reset on next iteration.
  workspace/            Agent's cwd. Auto-created with own .git and .gitignore.
`;
  process.stdout.write(txt);
  process.exit(code);
}

function die(msg: string): never {
  process.stderr.write(`ralph: ${msg}\n`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// API key (env or doppler fallback)
// ---------------------------------------------------------------------------

function resolveApiKey(): string {
  const fromEnv = process.env.CURSOR_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  // Try doppler. Capture both stdout and stderr so we can report what actually
  // went wrong (no token configured, project not set up, secret missing, etc).
  let dopplerStdout = "";
  let dopplerStderr = "";
  let dopplerStatus: number | null = null;
  try {
    const result = spawnSync("doppler", ["secrets", "get", "CURSOR_API_KEY", "--plain"], {
      encoding: "utf8",
    });
    dopplerStdout = (result.stdout ?? "").trim();
    dopplerStderr = (result.stderr ?? "").trim();
    dopplerStatus = result.status;
    if (result.error) {
      // ENOENT (doppler not installed) etc.
      const lines = [
        "CURSOR_API_KEY not set and could not invoke doppler.",
        `  spawn error: ${result.error.message}`,
        "Fix one of:",
        "  - export CURSOR_API_KEY=<key>           (skip doppler entirely)",
        "  - install doppler                       (https://docs.doppler.com/docs/install-cli)",
      ];
      die(lines.join("\n"));
    }
    if (dopplerStdout) return dopplerStdout;
  } catch (e) {
    die(`CURSOR_API_KEY not set and doppler invocation threw: ${(e as Error).message}`);
  }

  const lines = [
    "CURSOR_API_KEY not set and `doppler secrets get CURSOR_API_KEY --plain` did not return a value.",
    `  doppler exit code: ${dopplerStatus ?? "unknown"}`,
  ];
  if (dopplerStderr) {
    lines.push("  doppler stderr:");
    for (const l of dopplerStderr.split("\n")) lines.push(`    ${l}`);
  }
  lines.push("Fix one of:");
  lines.push("  - export CURSOR_API_KEY=<key>           (bypass doppler)");
  lines.push("  - doppler login --no-check && doppler setup   (configure this box)");
  lines.push("  - DOPPLER_TOKEN=dp.st.xxx ralph GOAL.md       (use a service token inline)");
  die(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// File primitives
// ---------------------------------------------------------------------------

function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

function atomicWrite(path: string, contents: string | Buffer): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function touch(path: string): void {
  try {
    const fd = openSync(path, "a");
    const now = new Date();
    closeSync(fd);
    // best-effort; ignore mtime races
    void now;
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Persisted ralph state
// ---------------------------------------------------------------------------

interface RalphState {
  agentId?: string;
  iteration: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  tokensSinceReset: number;
  lastResetAt: number;
  lastError?: string;
  startedAt: number;
}

function loadState(stateJsonPath: string): RalphState {
  if (!existsSync(stateJsonPath)) {
    return {
      iteration: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      tokensSinceReset: 0,
      lastResetAt: 0,
      startedAt: Date.now(),
    };
  }
  try {
    const raw = JSON.parse(readUtf8(stateJsonPath));
    return {
      iteration: raw.iteration ?? 0,
      agentId: raw.agentId,
      totalInputTokens: raw.totalInputTokens ?? 0,
      totalOutputTokens: raw.totalOutputTokens ?? 0,
      tokensSinceReset: raw.tokensSinceReset ?? 0,
      lastResetAt: raw.lastResetAt ?? 0,
      lastError: raw.lastError,
      startedAt: raw.startedAt ?? Date.now(),
    };
  } catch (e) {
    process.stderr.write(`ralph: corrupt state.json (${(e as Error).message}), starting fresh\n`);
    return {
      iteration: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      tokensSinceReset: 0,
      lastResetAt: 0,
      startedAt: Date.now(),
    };
  }
}

function saveState(stateJsonPath: string, state: RalphState): void {
  atomicWrite(stateJsonPath, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Pid lock
// ---------------------------------------------------------------------------

function acquireLock(lockPath: string): void {
  if (existsSync(lockPath)) {
    const otherPid = Number(readUtf8(lockPath).trim());
    if (Number.isFinite(otherPid) && otherPid > 0 && pidAlive(otherPid)) {
      die(`another ralph process is running (pid ${otherPid}); remove ${lockPath} if stale`);
    }
    try { unlinkSync(lockPath); } catch { /* ignore */ }
  }
  writeFileSync(lockPath, String(process.pid));
}

function releaseLock(lockPath: string): void {
  try {
    if (existsSync(lockPath) && readUtf8(lockPath).trim() === String(process.pid)) {
      unlinkSync(lockPath);
    }
  } catch { /* ignore */ }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// STATE.md template
// ---------------------------------------------------------------------------

const STATE_MD_TEMPLATE = `# STATE

This file is the agent's working memory. The agent rewrites it every iteration.

## What we know

(empty — first iteration will populate)

## What we have tried

(none yet)

## Next actions

1. Read GOAL.md carefully and orient.
2. Survey the workspace and tools available.
3. Form an initial plan.
`;

function ensureStateMd(statePath: string): void {
  if (!existsSync(statePath)) {
    atomicWrite(statePath, STATE_MD_TEMPLATE);
  }
}

// ---------------------------------------------------------------------------
// Built-in operating manual (the "PROMPT" in old terminology).
// ---------------------------------------------------------------------------
//
// This is the durable, goal-agnostic operating manual that ships with ralph.
// The agent receives it as the first segment of every plan and execute prompt.
// Override at the command line with `--prompt <path>` if you want to customize.
// Dump the current builtin with `ralph --print-prompt`.

const BUILTIN_PROMPT = `# Ralph operating manual

You are an autonomous agent running inside a \`ralph\` loop. You are not in a chat with a human; you are in a tight feedback loop with yourself.

## How an iteration is structured

Each iteration of the loop calls you **twice**, in the same SDK session, in this order:

1. **PLAN PHASE**. The loop hands you this operating manual, GOAL.md, the current STATE.md, and the iteration number, and asks you to produce a tight plan for *this iteration only* in PLAN.md.
   - You are **read-only** in this phase. The only file you may modify is PLAN.md (absolute path is in the prompt). No \`Edit\`/\`Write\` to anything else, no \`Shell\` commands that mutate state. Reads, greps, semantic search, web fetches, dry-runs, and read-only inspections (\`ls\`, \`cat\`, \`git log\`, \`nvidia-smi\`, \`btcli\` view-only, \`doppler secrets get\`) are all encouraged.
   - You must overwrite PLAN.md with the structure: \`# PLAN - iteration N\`, \`## Hypothesis\`, \`## Steps\` (1-5 small concrete actions), \`## Success criteria\`, \`## Risks and mitigations\`, \`## Fallback\`. The renderer enforces this; do not deviate.

2. **EXECUTE PHASE**. The loop calls you again with the plan you just wrote attached, and asks you to execute it.
   - You may use any tool: shell, edit, write, grep, subagents.
   - Execute the plan. If a step fails or the world differs from your plan's assumptions, do as much as you can per the plan, document the divergence in STATE.md, and propose the next plan in \`## Next actions\`. Do not silently re-plan and run a different plan.
   - You **must** overwrite STATE.md per the schema below before stopping.

You are the same agent across both phases of one iteration (same context window). Then the loop may dispose your session and reset you between iterations - which means STATE.md is the only thing that survives. Anything you "remember" but did not write to STATE.md is gone the moment your session is reset.

---

## Where you are

- Host: a Linux box (\`uname -a\` to confirm). You have full root.
- You operate against TWO directories. The exact paths are surfaced in every prompt under \`=== WORKSPACE ===\` and \`=== CONTROL FILES ===\`.

**1. CONTROL PLANE** (e.g. \`/root/mining/\`) - the parent of your cwd. You touch it only through STATE.md and PLAN.md.

  - GOAL.md - read-only mission. Re-read it every iteration; the human may edit it live.
  - STATE.md - your living memory. The execute phase overwrites it every iteration via the absolute path the prompt gives you.
  - PLAN.md - the plan for the current iteration. The plan phase overwrites it via the absolute path the prompt gives you. The execute phase reads it but never writes it.
  - \`.ralph/\` - loop driver bookkeeping. You may READ \`.ralph/iterations/*.json\` (full per-iteration transcripts) and \`.ralph/plans/NNNNNN.md\` (every prior PLAN.md) for forensics. Never modify anything in \`.ralph/\`.

**2. WORKSPACE** (e.g. \`/root/mining/workspace/\`) - your cwd. This is where you actually work.

  - Has its own \`.git/\`. Commit freely after each meaningful change. Use feature branches if you want; the loop doesn't care.
  - All code, configs, training scripts, model weights, datasets, logs, scratch files, cloned repos go here.
  - Treat this dir as your scratch space - create subdirs freely.
  - The Cursor SDK rooted you here, so SemanticSearch and \`.cursor/\` settings apply to this dir, not the control plane.

- The target box is the same machine you are running on (per GOAL.md). Anything that needs hardware runs here.
- Python: use \`uv\` inside the workspace. \`cd $WORKSPACE && uv venv .venv && source .venv/bin/activate && uv pip install -e .\` is the canonical setup.
- Node: available system-wide.

## Secrets and credentials

- Secrets live in Doppler. Fetch with \`doppler secrets get <NAME> --plain\`. If \`doppler whoami\` fails, authenticate first (\`doppler login\`) - but most env vars should already be present in \`printenv\`; check there first.
- Never hardcode secrets in files. Never echo a secret into a log line you keep.
- Wallet/keys for any on-chain operations are referenced by name in GOAL.md. Read it.

## How to think across iterations

1. **One iteration = one substantive step.** Don't try to finish the whole goal in one iteration. Don't make a multi-week plan and call it done. The plan phase produces a plan whose \`## Steps\` list is sized for the execute phase to actually finish in one turn. If your plan would take an hour of execution, it's too big - split it.

2. **Bias heavily toward action and observation.** The loop runs forever. A tiny experiment whose result is recorded in STATE.md is worth ten paragraphs of speculation. The plan phase exists to make execution sharper, not to defer it.

3. **Read before writing.** First iteration in a fresh session: re-read GOAL.md and STATE.md in full before doing anything else. They might have changed since the last session. The plan phase is the natural place for this.

4. **Use the plan phase for hypotheses, not for surveys.** If you find yourself spending the entire plan phase exploring the codebase with no opinion, stop and form an opinion: "I think X is true because Y; this iteration tests it by doing Z." Surveys without hypotheses produce plans without success criteria.

5. **Compress as you go.** STATE.md is your context window. Keep it under ~8000 tokens. When it grows, summarize older entries into a \`## Compacted history\` section with iterations and outcomes only - drop the play-by-play.

6. **Prefer reversible moves.** Snapshot configs and code before modifying. Commit in the workspace after each meaningful change. If you're about to do something destructive (deleting weights, force-pushing, sending TAO), the plan phase must dry-run it and the dry-run output must be in STATE.md before the execute phase actually does it.

7. **Treat each turn as if you might crash mid-action.** Write intermediate results to disk. Don't hold long-running shell jobs in your head - start them with \`nohup ... &\` or \`tmux\`/\`screen\` and record the pid + log path in STATE.md so the next iteration can check on them.

8. **When stuck, change the level of abstraction.** If three iterations in a row produced no new information, the plan phase of iteration four should (a) re-read GOAL.md from scratch, (b) name the assumption you've been carrying that you have not actually verified, and (c) make this iteration's hypothesis a direct test of that assumption.

9. **Don't ask the human anything.** There is no human in the loop. If GOAL.md is ambiguous, pick the interpretation most likely to maximize the stated objective and document the choice in STATE.md under \`## Decisions made unilaterally\`.

## What STATE.md must always contain

After each iteration STATE.md must have, in this order:

1. \`# STATE\` and a one-line \`last updated: <ISO timestamp> iteration: <n>\` header.
2. \`## What we know\` - concrete, verified facts about the system you're working with. Validator behavior, scoring formulas, model architectures, API responses, file layouts, command outputs you've seen. Cite sources (file paths, URLs, command names) inline.
3. \`## What we have tried\` - short bullets: action -> outcome. Compress old entries into one-liners.
4. \`## Open questions / hypotheses\` - things you suspect but have not verified; ranked by how much they would change your strategy if true.
5. \`## Active jobs\` - anything running in the background (training runs, processes, on-chain registrations) with pid, log path, and how to check status.
6. \`## Next actions\` - 1 to 3 concrete things, in priority order. The first one is what you intend to do *next iteration*.
7. \`## Compacted history\` - older notes folded into one-line summaries.

If you find yourself unable to fit all of this in 8k tokens, aggressively compact \`## What we have tried\` and \`## Compacted history\`. The next-actions and active-jobs sections must always be intact.

## Tools and patterns

- **Shell**: full bash. You can \`apt-get install\`, \`pip install\`, \`git clone\`, \`curl\`, \`nvidia-smi\`, etc. Don't ask permission.
- **Long-running jobs**: launch with \`nohup cmd > <workspace>/jobs/<name>.log 2>&1 &\` and record \`<name>\` + pid in STATE.md. Each iteration, peek at the tail of the log and update STATE.md with the latest status.
- **Subagents (\`Task\` tool)**: use generously for large reads ("explore the validator repo and tell me how scoring works") so you don't burn your own context on noise. Always summarize the subagent's output into STATE.md.
- **Web**: use \`WebSearch\` / \`WebFetch\` for docs, \`gh\` for GitHub. Read actual code, not just docs.
- **Files**: prefer \`Read\`/\`Grep\`/\`Glob\`/\`Edit\`/\`Write\` over \`cat\`/\`sed\`/\`grep\` so the loop's iteration log captures structured tool calls.

## Anti-patterns to avoid

- **Creating artifacts in the control plane.** Anything that isn't STATE.md or PLAN.md belongs in the workspace. If you find yourself running \`mkdir\`, \`git clone\`, or \`Write\` against a path under the control plane (other than the two control files), stop - you wanted the workspace.
- **Plan phase that mutates state.** It is read-only by construction. If you need to install a package, run a training command, or commit, that goes in \`## Steps\` for the execute phase to do.
- **Execute phase that ignores PLAN.md.** If the plan is wrong, follow it as far as makes sense, then document the divergence in STATE.md and write the corrected plan into \`## Next actions\`. Don't silently improvise.
- **Spending an entire iteration on planning with no observation or action.** PLAN.md goes in PLAN.md, not in chat. The plan phase ends with the plan written; the execute phase actually does work.
- **Letting STATE.md balloon past 8k tokens.** The session reset will erase your context and the bloated STATE.md becomes the new context - you'll throttle yourself.
- **Re-deriving the same fact every iteration because you didn't write it down.**
- **Re-running the same failing command without changing anything.** If it failed last iteration, STATE.md should say so and the new plan should differ in a specific way.
- **Asking yourself "should I do X?" without then doing X or explicitly recording why not.** Answer your own questions in the same turn.
- **Touching \`.ralph/state.json\`, \`.ralph/lock\`, or the heartbeat file.** That's the loop driver's domain.

## End-of-phase checklists

**End of plan phase**, confirm:
- [ ] PLAN.md was overwritten with the required structure (\`# PLAN - iteration N\`, \`## Hypothesis\`, \`## Steps\`, \`## Success criteria\`, \`## Risks and mitigations\`, \`## Fallback\`).
- [ ] The steps are small enough that the execute phase can finish them in one turn.
- [ ] You did not modify any file other than PLAN.md.
- [ ] You did not run mutating shell commands.
- [ ] Final assistant message is a one-paragraph summary of the plan.

**End of execute phase**, confirm:
- [ ] STATE.md has been overwritten and contains all seven sections (header + What we know + What we have tried + Open questions / hypotheses + Active jobs + Next actions + Compacted history).
- [ ] Any new long-running job is recorded under \`## Active jobs\` with pid + log path.
- [ ] Any new fact discovered this iteration is in \`## What we know\`.
- [ ] The first item in \`## Next actions\` is something the next iteration's plan phase can pick up cold.
- [ ] Final assistant message is a one-paragraph summary of what you did this iteration. Keep it short. Detail belongs in STATE.md.

Now read the GOAL, CURRENT STATE.md, and (if you are in the execute phase) PLAN.md sections that the loop appended below this prompt, identify which phase you are in from the \`=== ITERATION N - PLAN PHASE ===\` or \`=== ITERATION N - EXECUTE PHASE ===\` marker, and act accordingly.
`;

const PLAN_MD_TEMPLATE = `# PLAN

(empty - will be populated by the plan phase of the next iteration)
`;

function ensurePlanMd(planPath: string): void {
  if (!existsSync(planPath)) {
    atomicWrite(planPath, PLAN_MD_TEMPLATE);
  }
}

const WORKSPACE_GITIGNORE = `# Auto-generated by ralph on first run; edit freely.
__pycache__/
*.pyc
*.pyo
*.egg-info/
.venv/
.env
.env.*
.ipynb_checkpoints/
.pytest_cache/
.ruff_cache/
.mypy_cache/

# ML artifacts
models/
checkpoints/
*.safetensors
*.pt
*.bin
*.ckpt
*.onnx
wandb/
mlruns/

# OS
.DS_Store
Thumbs.db
`;

const CONTROL_PLANE_GITIGNORE = `# Auto-generated by ralph; tracks GOAL/PROMPT/STATE/PLAN only.
workspace/
.ralph/
`;

function bootstrapWorkspace(workspaceDir: string): void {
  ensureDir(workspaceDir);
  const gitignorePath = join(workspaceDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    atomicWrite(gitignorePath, WORKSPACE_GITIGNORE);
  }
  const gitDir = join(workspaceDir, ".git");
  if (!existsSync(gitDir)) {
    try {
      execFileSync("git", ["init", "-q"], { cwd: workspaceDir, stdio: ["ignore", "ignore", "pipe"] });
      // Set author identity only if not already configured (system/global config wins).
      const ensureGitConfig = (key: string, value: string) => {
        try {
          const existing = execFileSync("git", ["config", "--get", key], {
            cwd: workspaceDir,
            stdio: ["ignore", "pipe", "ignore"],
            encoding: "utf8",
          }).trim();
          if (existing) return;
        } catch {
          // not set; fall through
        }
        try {
          execFileSync("git", ["config", key, value], { cwd: workspaceDir, stdio: "ignore" });
        } catch {
          /* ignore */
        }
      };
      ensureGitConfig("user.email", "ralph@localhost");
      ensureGitConfig("user.name", "ralph agent");
    } catch (e) {
      logWarn(`git init failed in ${workspaceDir} (${(e as Error).message}); workspace will not be a git repo`);
    }
  }
}

function bootstrapControlPlaneGitignore(goalDir: string): void {
  const gitignorePath = join(goalDir, ".gitignore");
  if (existsSync(gitignorePath)) return;
  try {
    atomicWrite(gitignorePath, CONTROL_PLANE_GITIGNORE);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Prompt rendering (plan phase + execute phase)
// ---------------------------------------------------------------------------

function sessionLine(freshSession: boolean): string {
  return freshSession
    ? "(This is a fresh session. Your only memory of prior iterations is STATE.md below.)"
    : "(You retain context from earlier turns in this session, but STATE.md is the canonical record.)";
}

function renderPlanPrompt(args: {
  sysmsg: string;
  goal: string;
  stateMd: string;
  iteration: number;
  freshSession: boolean;
  workspaceDir: string;
  goalPath: string;
  statePath: string;
  planPath: string;
}): string {
  return `${args.sysmsg.trim()}

=== WORKSPACE (your cwd) ===
${args.workspaceDir}
This directory is yours. Code, configs, scripts, models, datasets, training jobs, git commits all go here.

=== CONTROL FILES (absolute paths; outside your cwd) ===
GOAL.md  : ${args.goalPath}  (read-only)
STATE.md : ${args.statePath}  (the execute phase rewrites this)
PLAN.md  : ${args.planPath}  (THIS PHASE rewrites this; nothing else)

=== GOAL (verbatim from GOAL.md) ===
${args.goal.trim()}

=== CURRENT STATE.md ===
${args.stateMd.trim()}

=== ITERATION ${args.iteration} - PLAN PHASE ===
${sessionLine(args.freshSession)}

You are in PLAN MODE. The only file you may MODIFY this turn is ${args.planPath}.
You may freely READ files (Read/Grep/Glob/Ls), run read-only shell commands (cat, ls, ps, nvidia-smi, git status, git log, btcli view-only commands, doppler secrets get, curl GET requests, etc.), and use SemanticSearch / WebSearch / WebFetch / subagents to gather context.

DO NOT in this phase:
  - Edit, write, or delete any file other than ${args.planPath}.
  - Run shell commands that mutate state (apt install, pip install, git commit, git push, training jobs, btcli register/transfer/stake, kill/rm/mv on existing artifacts, etc.).
  - Modify STATE.md (the execute phase will do that).

Your task: produce a tight, concrete plan for THIS iteration only. Overwrite ${args.planPath} with exactly this structure (markdown):

# PLAN - iteration ${args.iteration}

## Hypothesis
What you believe is true and want to either verify, exploit, or refute this iteration. One paragraph.

## Steps
Ordered list of 1-5 concrete actions. Each step should be small enough that the execute phase can finish in one turn (think minutes, not hours). Include the exact commands or file edits where possible.

1. ...
2. ...

## Success criteria
How you (and a future iteration of you) will know this iteration succeeded. Concrete, observable.

## Risks and mitigations
- Risk: ... -> Mitigation: ...

## Fallback
If the steps above fail or partially succeed, the next thing to try is ...

End the message with a one-paragraph summary of the plan. Then stop.
`;
}

function renderExecutePrompt(args: {
  sysmsg: string;
  goal: string;
  stateMd: string;
  planMd: string;
  iteration: number;
  freshSession: boolean;
  hadPlanPhase: boolean;
  workspaceDir: string;
  goalPath: string;
  statePath: string;
  planPath: string;
}): string {
  const planSection = args.hadPlanPhase
    ? `=== PLAN.md (just produced by your plan phase) ===
${args.planMd.trim()}

`
    : "";
  const planNote = args.hadPlanPhase
    ? `You are in EXECUTE MODE. The plan above was produced by your previous turn this iteration.
Execute it. If a step fails or reveals new information that invalidates the plan, complete what you can,
then DOCUMENT the divergence in STATE.md under "What we have tried" and propose the next plan in
"Next actions". Do NOT silently re-plan and execute a different plan.`
    : `You are in EXECUTE MODE (plan phase was skipped). Take one substantive step toward the goal.`;

  return `${args.sysmsg.trim()}

=== WORKSPACE (your cwd) ===
${args.workspaceDir}
This directory is yours. Code, configs, scripts, models, datasets, training jobs, git commits all go here.
Do NOT create artifacts in the control plane (parent dir). Anything that isn't STATE.md or PLAN.md belongs in the workspace.

=== CONTROL FILES (absolute paths; outside your cwd) ===
GOAL.md  : ${args.goalPath}  (read-only)
STATE.md : ${args.statePath}  (THIS PHASE rewrites this via Write tool with the absolute path)
PLAN.md  : ${args.planPath}  (read-only this phase)

=== GOAL (verbatim from GOAL.md) ===
${args.goal.trim()}

=== CURRENT STATE.md ===
${args.stateMd.trim()}

${planSection}=== ITERATION ${args.iteration} - EXECUTE PHASE ===
${sessionLine(args.freshSession)}

${planNote}

You may use any tool: shell, edit, read, write, grep, subagents.

When done, you MUST overwrite STATE.md (use the absolute path ${args.statePath}) per the schema in PROMPT.md:
  - # STATE header with iteration ${args.iteration} and ISO timestamp
  - ## What we know
  - ## What we have tried (append this iteration's outcome)
  - ## Open questions / hypotheses
  - ## Active jobs (anything left running in the background, with pid + log path)
  - ## Next actions (1-3 items; the first becomes the seed for next iteration's plan)
  - ## Compacted history

Keep STATE.md under ~8000 tokens; compact older entries aggressively.

Then stop and return a one-paragraph summary of what you did this iteration.
`;
}

// ---------------------------------------------------------------------------
// Streaming UX
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY === true;
const C = {
  reset: isTTY ? "\x1b[0m" : "",
  dim: isTTY ? "\x1b[2m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  green: isTTY ? "\x1b[32m" : "",
  red: isTTY ? "\x1b[31m" : "",
  magenta: isTTY ? "\x1b[35m" : "",
};

function logBanner(msg: string): void {
  process.stdout.write(`\n${C.bold}${C.cyan}== ${msg} ==${C.reset}\n`);
}

function logInfo(msg: string): void {
  process.stdout.write(`${C.cyan}[ralph]${C.reset} ${msg}\n`);
}

function logWarn(msg: string): void {
  process.stdout.write(`${C.yellow}[ralph]${C.reset} ${msg}\n`);
}

function logError(msg: string): void {
  process.stderr.write(`${C.red}[ralph]${C.reset} ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Iteration logger (writes per-iteration JSON file)
// ---------------------------------------------------------------------------

interface PhaseRecord {
  phase: "plan" | "execute";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  prompt: string;
  events: SDKMessage[];
  result?: {
    id: string;
    status: string;
    text?: string;
    durationMs?: number;
  };
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  error?: string;
}

interface IterationRecord {
  iteration: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  agentId: string;
  freshSession: boolean;
  phases: PhaseRecord[];
  beforeStateHash?: string;
  afterStateHash?: string;
  beforePlanHash?: string;
  afterPlanHash?: string;
}

function iterationLogPath(stateDir: string, iteration: number): string {
  const padded = String(iteration).padStart(6, "0");
  return join(stateDir, "iterations", `${padded}.json`);
}

function writeIterationLog(stateDir: string, rec: IterationRecord): void {
  ensureDir(join(stateDir, "iterations"));
  atomicWrite(iterationLogPath(stateDir, rec.iteration), JSON.stringify(rec, null, 2));
}

function rotateIterationLogs(stateDir: string, keep: number = 200): void {
  const dir = join(stateDir, "iterations");
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length <= keep) return;
  const archiveDir = join(dir, "archive");
  ensureDir(archiveDir);
  const toArchive = files.slice(0, files.length - keep);
  for (const f of toArchive) {
    const src = join(dir, f);
    try {
      const content = readFileSync(src);
      writeFileSync(join(archiveDir, `${f}.gz`), gzipSync(content));
      unlinkSync(src);
    } catch (e) {
      logWarn(`failed to archive ${f}: ${(e as Error).message}`);
    }
  }
}

function quickHash(s: string): string {
  // tiny non-crypto hash; just enough to spot changes
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

async function withRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 6): Promise<T> {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof CursorAgentError && e.isRetryable;
      if (e instanceof AuthenticationError || e instanceof ConfigurationError || !retryable) {
        throw e;
      }
      attempt++;
      const backoff = Math.min(60_000, 1000 * 2 ** (attempt - 1));
      logWarn(`${label} attempt ${attempt}/${maxAttempts} failed (${(e as Error).message}); backing off ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Phase runner (one agent.send + stream + wait)
// ---------------------------------------------------------------------------

interface PhaseRunResult {
  record: PhaseRecord;
  fatal?: Error; // AuthenticationError or ConfigurationError, caller should re-throw
}

async function runPhase(args: {
  agent: SDKAgent;
  phase: "plan" | "execute";
  prompt: string;
  shutdownFlag: { shutdown: boolean };
  setActiveRun: (run: Run | undefined) => void;
}): Promise<PhaseRunResult> {
  const { agent, phase, prompt, shutdownFlag, setActiveRun } = args;
  const startedAt = Date.now();
  const events: SDKMessage[] = [];
  let usage: PhaseRecord["usage"] | undefined;
  let result: RunResult | undefined;
  let phaseError: string | undefined;
  let fatal: Error | undefined;

  process.stdout.write(`${C.bold}${C.magenta}-- ${phase.toUpperCase()} phase --${C.reset}\n`);

  try {
    const run = await withRetry(`agent.send (${phase})`, () => agent.send(prompt, {
      local: { force: true },
      onDelta: ({ update }) => {
        switch (update.type) {
          case "text-delta":
            process.stdout.write(`${C.green}${update.text}${C.reset}`);
            break;
          case "thinking-delta":
            process.stdout.write(`${C.dim}${update.text}${C.reset}`);
            break;
          case "thinking-completed":
            process.stdout.write(`\n${C.dim}[/think ${update.thinkingDurationMs}ms]${C.reset}\n`);
            break;
          case "turn-ended":
            if (update.usage) {
              usage = {
                inputTokens: update.usage.inputTokens ?? 0,
                outputTokens: update.usage.outputTokens ?? 0,
                cacheReadTokens: update.usage.cacheReadTokens ?? 0,
                cacheWriteTokens: update.usage.cacheWriteTokens ?? 0,
              };
            }
            break;
        }
      },
    }));
    setActiveRun(run);

    for await (const ev of run.stream()) {
      events.push(ev);
      if (ev.type === "tool_call") {
        const tag = ev.status === "running"
          ? `${C.magenta}[tool-start]${C.reset}`
          : ev.status === "error"
            ? `${C.red}[tool-error]${C.reset}`
            : `${C.cyan}[tool-done]${C.reset}`;
        process.stdout.write(`\n${tag} ${ev.name}\n`);
      } else if (ev.type === "status") {
        process.stdout.write(`\n${C.yellow}[status]${C.reset} ${ev.status}${ev.message ? ` - ${ev.message}` : ""}\n`);
      } else if (ev.type === "task" && ev.text) {
        process.stdout.write(`\n${C.cyan}[task]${C.reset} ${ev.text}\n`);
      }
      if (shutdownFlag.shutdown) break;
    }

    result = await run.wait();
    process.stdout.write("\n");
    logInfo(`${phase} -> ${result.status}` + (result.durationMs !== undefined ? ` (${result.durationMs}ms)` : ""));
  } catch (e) {
    phaseError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    logError(`${phase} phase failed: ${phaseError}`);
    if (e instanceof AuthenticationError || e instanceof ConfigurationError) {
      fatal = e;
    }
  } finally {
    setActiveRun(undefined);
  }

  const endedAt = Date.now();
  return {
    record: {
      phase,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: endedAt - startedAt,
      prompt,
      events,
      result: result ? {
        id: result.id,
        status: result.status,
        text: result.result,
        durationMs: result.durationMs,
      } : undefined,
      usage,
      error: phaseError,
    },
    fatal,
  };
}

function snapshotPlan(stateDir: string, iteration: number, planMd: string): void {
  const dir = join(stateDir, "plans");
  ensureDir(dir);
  const padded = String(iteration).padStart(6, "0");
  atomicWrite(join(dir, `${padded}.md`), planMd);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

interface RuntimeFlags {
  shutdown: boolean;
  forceReset: boolean;
}

async function cmdLoop(rest: string[]): Promise<void> {
  const args = parseArgs(rest);
  const apiKey = resolveApiKey();

  const goalDir = dirname(args.goalPath);
  const statePath = args.statePath ?? join(goalDir, "STATE.md");
  const planPath = args.planPath ?? join(goalDir, "PLAN.md");
  const workspaceDir = args.workspacePath ?? join(goalDir, "workspace");
  const stateDir = join(goalDir, ".ralph");
  ensureDir(stateDir);
  ensureDir(join(stateDir, "iterations"));
  ensureDir(join(stateDir, "plans"));

  const lockPath = join(stateDir, "lock");
  acquireLock(lockPath);

  const stateJsonPath = join(stateDir, "state.json");
  const heartbeatPath = join(stateDir, "heartbeat");
  const resetSignalPath = join(stateDir, "reset.signal");
  ensureStateMd(statePath);
  ensurePlanMd(planPath);
  bootstrapWorkspace(workspaceDir);
  bootstrapControlPlaneGitignore(goalDir);


  const state = loadState(stateJsonPath);
  const flags: RuntimeFlags = { shutdown: false, forceReset: false };
  let activeRun: Run | undefined;
  let activeAgent: SDKAgent | undefined;

  const installSignals = () => {
    const onShutdown = (sig: NodeJS.Signals) => {
      logWarn(`received ${sig}, finishing current run and exiting...`);
      flags.shutdown = true;
      if (activeRun && activeRun.supports("cancel")) {
        activeRun.cancel().catch(() => { /* ignore */ });
      }
    };
    process.on("SIGINT", onShutdown);
    process.on("SIGTERM", onShutdown);
    process.on("SIGUSR1", () => {
      logWarn("received SIGUSR1, will reset agent before next iteration");
      flags.forceReset = true;
    });
  };
  installSignals();

  logBanner(`ralph starting (pid ${process.pid})`);
  logInfo(`prompt:  ${args.promptPath ?? "(built-in; pass --prompt to override or --print-prompt to view)"}`);
  logInfo(`goal:    ${args.goalPath}`);
  logInfo(`state:   ${statePath}`);
  logInfo(`plan:    ${planPath}${args.noPlan ? " (plan phase disabled)" : ""}`);
  logInfo(`control: ${goalDir}`);
  logInfo(`workspace (agent cwd): ${workspaceDir}`);
  logInfo(`model:   ${args.model.id}${args.model.params?.length ? ` (${args.model.params.map(p => `${p.id}=${p.value}`).join(", ")})` : ""}`);
  logInfo(`iteration cursor: ${state.iteration}`);
  if (state.agentId) logInfo(`will resume agent: ${state.agentId}`);

  try {
    while (!flags.shutdown && state.iteration < args.maxIters) {
      state.iteration += 1;
      touch(heartbeatPath);

      const goal = readUtf8(args.goalPath);
      const sysmsg = args.promptPath ? readUtf8(args.promptPath) : BUILTIN_PROMPT;
      ensureStateMd(statePath);
      ensurePlanMd(planPath);
      const stateMdBefore = readUtf8(statePath);
      const planMdBefore = readUtf8(planPath);

      // decide whether to use a fresh session
      const periodic = args.resetEvery > 0 && state.iteration > 1
        && (state.iteration - state.lastResetAt) >= args.resetEvery;
      const overBudget = state.tokensSinceReset >= args.tokenBudget;
      const explicit = flags.forceReset || existsSync(resetSignalPath);
      const wantFresh = !state.agentId || periodic || overBudget || explicit;

      if ((periodic || overBudget || explicit) && state.agentId) {
        logWarn(
          `resetting agent (${periodic ? "periodic" : ""}${overBudget ? " budget" : ""}${explicit ? " explicit" : ""}); previous id=${state.agentId}`
        );
        state.agentId = undefined;
        state.lastResetAt = state.iteration - 1;
        state.tokensSinceReset = 0;
        flags.forceReset = false;
        if (existsSync(resetSignalPath)) {
          try { unlinkSync(resetSignalPath); } catch { /* ignore */ }
        }
      }

      logBanner(`iteration ${state.iteration}`);

      // create or resume agent (shared by both phases this iteration)
      let agent: SDKAgent;
      try {
        if (state.agentId) {
          agent = await withRetry(
            "Agent.resume",
            () => Agent.resume(state.agentId!, {
              apiKey,
              model: args.model,
              local: { cwd: workspaceDir, settingSources: ["project", "user"] },
            })
          );
        } else {
          agent = await withRetry(
            "Agent.create",
            () => Agent.create({
              apiKey,
              model: args.model,
              local: { cwd: workspaceDir, settingSources: ["project", "user"] },
              name: `ralph-iter-${state.iteration}`,
            })
          );
        }
      } catch (e) {
        if (state.agentId && e instanceof CursorAgentError) {
          logWarn(`resume failed (${e.message}); creating fresh agent`);
          state.agentId = undefined;
          state.lastResetAt = state.iteration - 1;
          state.tokensSinceReset = 0;
          agent = await withRetry(
            "Agent.create (after resume failure)",
            () => Agent.create({
              apiKey,
              model: args.model,
              local: { cwd: workspaceDir, settingSources: ["project", "user"] },
              name: `ralph-iter-${state.iteration}`,
            })
          );
        } else {
          throw e;
        }
      }
      activeAgent = agent;
      state.agentId = agent.agentId;
      saveState(stateJsonPath, state);
      logInfo(`agent ${agent.agentId}`);

      const iterStartedAt = Date.now();
      const phases: PhaseRecord[] = [];
      const setActiveRun = (r: Run | undefined) => { activeRun = r; };

      // ---- PLAN PHASE ----
      let planMdAfter = planMdBefore;
      let hadPlanPhase = false;
      if (!args.noPlan) {
        const planPrompt = renderPlanPrompt({
          sysmsg,
          goal,
          stateMd: stateMdBefore,
          iteration: state.iteration,
          freshSession: wantFresh,
          workspaceDir,
          goalPath: args.goalPath,
          statePath,
          planPath,
        });
        const planRun = await runPhase({
          agent,
          phase: "plan",
          prompt: planPrompt,
          shutdownFlag: flags,
          setActiveRun,
        });
        phases.push(planRun.record);
        if (planRun.record.usage) {
          state.totalInputTokens += planRun.record.usage.inputTokens;
          state.totalOutputTokens += planRun.record.usage.outputTokens;
          state.tokensSinceReset += planRun.record.usage.inputTokens + planRun.record.usage.outputTokens;
        }
        if (planRun.fatal) throw planRun.fatal;
        hadPlanPhase = true;

        planMdAfter = existsSync(planPath) ? readUtf8(planPath) : planMdBefore;
        snapshotPlan(stateDir, state.iteration, planMdAfter);
        if (quickHash(planMdAfter) === quickHash(planMdBefore)) {
          logWarn("PLAN.md was not modified by the plan phase");
        } else {
          logInfo(`PLAN.md updated (hash ${quickHash(planMdBefore)} -> ${quickHash(planMdAfter)})`);
        }
      }

      // ---- EXECUTE PHASE ----
      let executeRun: PhaseRunResult | undefined;
      if (!flags.shutdown) {
        const executePrompt = renderExecutePrompt({
          sysmsg,
          goal,
          stateMd: stateMdBefore,
          planMd: planMdAfter,
          iteration: state.iteration,
          freshSession: wantFresh && !hadPlanPhase, // session is no longer fresh after plan phase ran
          hadPlanPhase,
          workspaceDir,
          goalPath: args.goalPath,
          statePath,
          planPath,
        });
        executeRun = await runPhase({
          agent,
          phase: "execute",
          prompt: executePrompt,
          shutdownFlag: flags,
          setActiveRun,
        });
        phases.push(executeRun.record);
        if (executeRun.record.usage) {
          state.totalInputTokens += executeRun.record.usage.inputTokens;
          state.totalOutputTokens += executeRun.record.usage.outputTokens;
          state.tokensSinceReset += executeRun.record.usage.inputTokens + executeRun.record.usage.outputTokens;
        }
        if (executeRun.fatal) throw executeRun.fatal;
      }

      const stateMdAfter = existsSync(statePath) ? readUtf8(statePath) : stateMdBefore;
      const iterEndedAt = Date.now();
      const record: IterationRecord = {
        iteration: state.iteration,
        startedAt: new Date(iterStartedAt).toISOString(),
        endedAt: new Date(iterEndedAt).toISOString(),
        durationMs: iterEndedAt - iterStartedAt,
        agentId: agent.agentId,
        freshSession: wantFresh,
        phases,
        beforeStateHash: quickHash(stateMdBefore),
        afterStateHash: quickHash(stateMdAfter),
        beforePlanHash: quickHash(planMdBefore),
        afterPlanHash: quickHash(planMdAfter),
      };
      writeIterationLog(stateDir, record);
      rotateIterationLogs(stateDir);

      if (record.beforeStateHash === record.afterStateHash) {
        logWarn("STATE.md was not modified this iteration");
      } else {
        logInfo(`STATE.md updated (hash ${record.beforeStateHash} -> ${record.afterStateHash})`);
      }

      const lastPhaseError = phases.length > 0 ? phases[phases.length - 1].error : undefined;
      if (lastPhaseError) state.lastError = lastPhaseError;

      // post-iteration agent disposition
      const overBudgetAfter = state.tokensSinceReset >= args.tokenBudget;
      const periodicAfter = args.resetEvery > 0
        && (state.iteration - state.lastResetAt) >= args.resetEvery;
      if (overBudgetAfter || periodicAfter) {
        try { await agent[Symbol.asyncDispose](); } catch { /* ignore */ }
        state.agentId = undefined;
        state.lastResetAt = state.iteration;
        state.tokensSinceReset = 0;
        logInfo("agent disposed; next iteration starts fresh");
      } else {
        agent.close();
      }
      activeAgent = undefined;

      saveState(stateJsonPath, state);

      if (flags.shutdown) break;
      if (args.idleMs > 0) await sleep(args.idleMs);
    }
  } finally {
    if (activeAgent) {
      try { await activeAgent[Symbol.asyncDispose](); } catch { /* ignore */ }
    }
    saveState(stateJsonPath, state);
    releaseLock(lockPath);
    logBanner(`ralph stopped after ${state.iteration} iteration(s)`);
  }
}

// ---------------------------------------------------------------------------
// Project registry (~/.ralph/registry.json)
// ---------------------------------------------------------------------------

interface Registry {
  version: number;
  projects: Record<string, string>; // name -> absolute path
}

function registryPath(): string {
  const home = process.env.HOME ?? "/root";
  return join(home, ".ralph", "registry.json");
}

function loadRegistry(): Registry {
  const p = registryPath();
  if (!existsSync(p)) return { version: 1, projects: {} };
  try {
    const raw = JSON.parse(readUtf8(p));
    return {
      version: raw.version ?? 1,
      projects: raw.projects ?? {},
    };
  } catch (e) {
    logWarn(`registry at ${p} is corrupt (${(e as Error).message}); ignoring`);
    return { version: 1, projects: {} };
  }
}

function saveRegistry(reg: Registry): void {
  const p = registryPath();
  ensureDir(dirname(p));
  atomicWrite(p, JSON.stringify(reg, null, 2));
}

function registerProject(name: string, absDir: string): void {
  const reg = loadRegistry();
  const existing = reg.projects[name];
  if (existing && existing !== absDir) {
    die(`project name "${name}" is already registered to ${existing}; refusing to clobber`);
  }
  reg.projects[name] = absDir;
  saveRegistry(reg);
}

function unregisterProject(name: string): void {
  const reg = loadRegistry();
  if (!(name in reg.projects)) return;
  delete reg.projects[name];
  saveRegistry(reg);
}

interface ResolvedProject {
  name: string;
  dir: string;
  fromRegistry: boolean;
}

function looksLikePath(s: string): boolean {
  return s.includes("/") || s.startsWith(".");
}

function resolveProject(arg: string): ResolvedProject {
  if (looksLikePath(arg)) {
    const dir = resolve(arg);
    if (!existsSync(dir)) die(`directory does not exist: ${dir}`);
    return { name: dir.split("/").filter(Boolean).pop() ?? "ralph", dir, fromRegistry: false };
  }
  const reg = loadRegistry();
  const dir = reg.projects[arg];
  if (!dir) {
    die(
      `unknown project "${arg}"\n` +
      `  - run \`ralph init ${arg}\` to create one in the current directory\n` +
      `  - or pass an explicit path: \`ralph run /path/to/project\``
    );
  }
  if (!existsSync(dir)) {
    die(`project "${arg}" is registered to ${dir} but the directory no longer exists`);
  }
  return { name: arg, dir, fromRegistry: true };
}

function pm2NameFor(projectName: string): string {
  return `ralph-${projectName}`;
}

// ---------------------------------------------------------------------------
// pm2 helpers (shells out)
// ---------------------------------------------------------------------------

function runPm2(args: string[], opts: { inheritStdio?: boolean } = {}): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("pm2", args, {
    encoding: "utf8",
    stdio: opts.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      die("pm2 not found on PATH. install with: npm install -g pm2");
    }
    die(`pm2 invocation failed: ${result.error.message}`);
  }
  return {
    stdout: opts.inheritStdio ? "" : (result.stdout ?? ""),
    stderr: opts.inheritStdio ? "" : (result.stderr ?? ""),
    status: result.status,
  };
}

interface Pm2Process {
  name: string;
  pm_id: number;
  pid: number;
  pm2_env: {
    status: string;
    pm_uptime?: number;
    restart_time?: number;
    pm_cwd?: string;
    pm_out_log_path?: string;
    pm_err_log_path?: string;
  };
  monit?: { memory: number; cpu: number };
}

function pm2List(): Pm2Process[] {
  const r = runPm2(["jlist"]);
  if (r.status !== 0) {
    if (/connect ENOENT|daemon/.test(r.stderr)) return []; // pm2 daemon not started yet
    return [];
  }
  try {
    const parsed = JSON.parse(r.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pm2Find(name: string): Pm2Process | undefined {
  return pm2List().find((p) => p.name === name);
}

// ---------------------------------------------------------------------------
// Templates dropped by `ralph init`
// ---------------------------------------------------------------------------

const GOAL_MD_TEMPLATE = `# Mission

Replace this with your goal. Be as specific as you can. The agent re-reads
this file every iteration, so you can edit it live without restarting ralph.

Include in your mission:
- The desired outcome.
- Constraints (what is and isn't allowed).
- References the agent will need (URLs, machine addresses, wallet names, doppler key names).
- Anything else relevant.

Once you've written it:

    ralph run <name>      # start under pm2
    ralph logs <name>     # follow live
    ralph stop <name>     # graceful stop
`;

function renderRalphConfigCjs(name: string, absDir: string): string {
  const pm2Name = pm2NameFor(name);
  return `/**
 * pm2 ecosystem for ralph project "${name}".
 * Auto-generated by \`ralph init ${name}\`. Edit if you need to.
 *
 * Start:    ralph run ${name}
 * Logs:     ralph logs ${name}
 * Stop:     ralph stop ${name}
 */

module.exports = {
  apps: [
    {
      name: ${JSON.stringify(pm2Name)},
      script: "/usr/local/bin/ralph",
      args: ["loop", "GOAL.md"],
      cwd: ${JSON.stringify(absDir)},
      interpreter: "bash",
      autorestart: true,
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      kill_timeout: 30000,
      max_memory_restart: "8G",
      out_file: ${JSON.stringify(join(absDir, ".ralph", "pm2.out.log"))},
      error_file: ${JSON.stringify(join(absDir, ".ralph", "pm2.err.log"))},
      merge_logs: true,
      time: true,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        // CURSOR_API_KEY: "key_...",     // pin if you don't want to rely on doppler
        // DOPPLER_TOKEN: "dp.st.xxx",    // or a doppler service token
      },
    },
  ],
};
`;
}

const CONTROL_PLANE_GITIGNORE_INIT = `workspace/
.ralph/
`;

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const VALID_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

async function cmdInit(rest: string[]): Promise<void> {
  if (rest.length !== 1 || rest[0] === "-h" || rest[0] === "--help") {
    process.stdout.write(`ralph init <name>

Creates ./<name>/ in the current directory with:
  GOAL.md             mock mission template; you edit this
  ralph.config.cjs    pm2 ecosystem (auto-generated)
  .gitignore          ignores workspace/ and .ralph/

Registers the name in ~/.ralph/registry.json so \`ralph run <name>\`,
\`ralph stop <name>\`, etc. work from any directory.

Then:
  vim <name>/GOAL.md
  ralph run <name>
`);
    process.exit(rest[0] === "-h" || rest[0] === "--help" ? 0 : 2);
  }
  const name = rest[0];
  if (!VALID_NAME_RE.test(name)) {
    die(`invalid project name "${name}"; use [a-zA-Z0-9_-], starting with a letter or digit`);
  }
  const absDir = resolve(name);
  if (existsSync(absDir)) {
    const entries = readdirSync(absDir);
    if (entries.length > 0) die(`${absDir} already exists and is not empty; refusing to overwrite`);
  } else {
    ensureDir(absDir);
  }

  atomicWrite(join(absDir, "GOAL.md"), GOAL_MD_TEMPLATE);
  atomicWrite(join(absDir, "ralph.config.cjs"), renderRalphConfigCjs(name, absDir));
  atomicWrite(join(absDir, ".gitignore"), CONTROL_PLANE_GITIGNORE_INIT);

  registerProject(name, absDir);

  process.stdout.write(`${C.green}created${C.reset} ${absDir}/
  ${C.dim}GOAL.md             <- edit this${C.reset}
  ${C.dim}ralph.config.cjs    <- pm2 ecosystem${C.reset}
  ${C.dim}.gitignore${C.reset}
${C.green}registered${C.reset} "${name}" -> ${absDir}

next:
  ${C.bold}vim ${name}/GOAL.md${C.reset}
  ${C.bold}ralph run ${name}${C.reset}
`);
}

async function cmdRun(rest: string[]): Promise<void> {
  if (rest.length !== 1) {
    die("usage: ralph run <name|path>");
  }
  const proj = resolveProject(rest[0]);
  const cfg = join(proj.dir, "ralph.config.cjs");
  if (!existsSync(cfg)) {
    die(`${cfg} not found; run \`ralph init ${proj.name}\` first or recreate the file`);
  }
  const pm2Name = pm2NameFor(proj.name);
  const existing = pm2Find(pm2Name);
  if (existing && existing.pm2_env.status === "online") {
    logInfo(`${pm2Name} is already online (pid ${existing.pid}, ${existing.pm2_env.restart_time ?? 0} restart(s))`);
    logInfo(`  follow with: ralph logs ${proj.name}`);
    return;
  }
  if (existing) {
    logInfo(`${pm2Name} exists but is ${existing.pm2_env.status}; restarting`);
    const r = runPm2(["restart", pm2Name, "--update-env"]);
    if (r.status !== 0) die(`pm2 restart failed:\n${r.stderr || r.stdout}`);
  } else {
    logInfo(`starting ${pm2Name} from ${cfg}`);
    const r = runPm2(["start", cfg]);
    if (r.status !== 0) die(`pm2 start failed:\n${r.stderr || r.stdout}`);
  }
  runPm2(["save"]); // best effort, persist for boot
  const after = pm2Find(pm2Name);
  if (after) {
    logInfo(`${pm2Name} is ${after.pm2_env.status} (pid ${after.pid})`);
  }
  logInfo(`follow with: ralph logs ${proj.name}`);
}

async function cmdStop(rest: string[]): Promise<void> {
  if (rest.length !== 1) die("usage: ralph stop <name|path>");
  const proj = resolveProject(rest[0]);
  const pm2Name = pm2NameFor(proj.name);
  const existing = pm2Find(pm2Name);
  if (!existing) {
    logWarn(`${pm2Name} is not registered with pm2; nothing to stop`);
    return;
  }
  if (existing.pm2_env.status === "stopped") {
    logInfo(`${pm2Name} is already stopped`);
    return;
  }
  const r = runPm2(["stop", pm2Name]);
  if (r.status !== 0) die(`pm2 stop failed:\n${r.stderr || r.stdout}`);
  logInfo(`${pm2Name} stopped`);
}

async function cmdRestart(rest: string[]): Promise<void> {
  if (rest.length !== 1) die("usage: ralph restart <name|path>");
  const proj = resolveProject(rest[0]);
  const pm2Name = pm2NameFor(proj.name);
  const r = runPm2(["restart", pm2Name, "--update-env"]);
  if (r.status !== 0) die(`pm2 restart failed:\n${r.stderr || r.stdout}`);
  logInfo(`${pm2Name} restarted`);
}

async function cmdLogs(rest: string[]): Promise<void> {
  if (rest.length < 1) die("usage: ralph logs <name|path> [extra pm2 logs flags]");
  const proj = resolveProject(rest[0]);
  const pm2Name = pm2NameFor(proj.name);
  // Inherit stdio so the user sees a streaming tail.
  runPm2(["logs", pm2Name, ...rest.slice(1)], { inheritStdio: true });
}

async function cmdDelete(rest: string[]): Promise<void> {
  const wantRm = rest.includes("--rm");
  const positional = rest.filter((a) => a !== "--rm");
  if (positional.length !== 1) die("usage: ralph delete <name|path> [--rm]");
  const proj = resolveProject(positional[0]);
  const pm2Name = pm2NameFor(proj.name);
  const existing = pm2Find(pm2Name);
  if (existing) {
    runPm2(["delete", pm2Name]);
    logInfo(`pm2 ${pm2Name} deleted`);
  } else {
    logInfo(`${pm2Name} not in pm2; skipping pm2 delete`);
  }
  if (proj.fromRegistry) {
    unregisterProject(proj.name);
    logInfo(`unregistered "${proj.name}"`);
  }
  if (wantRm) {
    try {
      execFileSync("rm", ["-rf", proj.dir]);
      logInfo(`removed ${proj.dir}`);
    } catch (e) {
      logWarn(`failed to remove ${proj.dir}: ${(e as Error).message}`);
    }
  }
}

function readIterationCursor(dir: string): { iteration?: number; agentId?: string; lastError?: string } {
  const p = join(dir, ".ralph", "state.json");
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readUtf8(p));
    return { iteration: raw.iteration, agentId: raw.agentId, lastError: raw.lastError };
  } catch {
    return {};
  }
}

function fmtUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d${h % 24}h`;
  if (h > 0) return `${h}h${m % 60}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

function fmtMem(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes)) return "-";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(0)}M`;
  return `${(mb / 1024).toFixed(2)}G`;
}

async function cmdStatus(rest: string[]): Promise<void> {
  const filter = rest[0];
  const all = pm2List().filter((p) => p.name.startsWith("ralph-"));
  if (filter) {
    const proj = resolveProject(filter);
    const target = pm2NameFor(proj.name);
    const filtered = all.filter((p) => p.name === target);
    printStatusTable(filtered);
    return;
  }
  printStatusTable(all);
}

function printStatusTable(procs: Pm2Process[]): void {
  if (procs.length === 0) {
    process.stdout.write("(no ralph processes registered with pm2)\n");
    return;
  }
  const reg = loadRegistry();
  const rows = procs.map((p) => {
    const projName = p.name.replace(/^ralph-/, "");
    const dir = reg.projects[projName] ?? p.pm2_env.pm_cwd ?? "?";
    const cur = readIterationCursor(dir);
    const uptime = p.pm2_env.pm_uptime ? fmtUptime(Date.now() - p.pm2_env.pm_uptime) : "-";
    return {
      name: projName,
      status: p.pm2_env.status,
      pid: String(p.pid || "-"),
      uptime,
      iter: cur.iteration !== undefined ? String(cur.iteration) : "-",
      mem: fmtMem(p.monit?.memory),
      restarts: String(p.pm2_env.restart_time ?? 0),
      dir,
    };
  });
  const cols: { key: keyof typeof rows[number]; label: string }[] = [
    { key: "name", label: "NAME" },
    { key: "status", label: "STATUS" },
    { key: "pid", label: "PID" },
    { key: "uptime", label: "UPTIME" },
    { key: "iter", label: "ITER" },
    { key: "mem", label: "MEM" },
    { key: "restarts", label: "↺" },
    { key: "dir", label: "DIR" },
  ];
  const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => r[c.key].length)));
  const header = cols.map((c, i) => c.label.padEnd(widths[i])).join("  ");
  process.stdout.write(`${C.bold}${header}${C.reset}\n`);
  for (const r of rows) {
    const line = cols.map((c, i) => r[c.key].padEnd(widths[i])).join("  ");
    process.stdout.write(`${line}\n`);
  }
}

async function cmdList(rest: string[]): Promise<void> {
  void rest;
  const reg = loadRegistry();
  const names = Object.keys(reg.projects).sort();
  if (names.length === 0) {
    process.stdout.write("(no projects registered; create one with `ralph init <name>`)\n");
    return;
  }
  const all = pm2List();
  const procs = names
    .map((n) => all.find((p) => p.name === pm2NameFor(n)))
    .filter((p): p is Pm2Process => Boolean(p));
  // Print all registered projects, including ones not in pm2.
  const reg2 = loadRegistry();
  const rows = names.map((n) => {
    const dir = reg2.projects[n];
    const proc = procs.find((p) => p.name === pm2NameFor(n));
    const cur = readIterationCursor(dir);
    const status = proc ? proc.pm2_env.status : "(not started)";
    const uptime = proc?.pm2_env.pm_uptime ? fmtUptime(Date.now() - proc.pm2_env.pm_uptime) : "-";
    return {
      name: n,
      status,
      iter: cur.iteration !== undefined ? String(cur.iteration) : "-",
      uptime,
      dir,
    };
  });
  const cols: { key: keyof typeof rows[number]; label: string }[] = [
    { key: "name", label: "NAME" },
    { key: "status", label: "STATUS" },
    { key: "iter", label: "ITER" },
    { key: "uptime", label: "UPTIME" },
    { key: "dir", label: "DIR" },
  ];
  const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => r[c.key].length)));
  const header = cols.map((c, i) => c.label.padEnd(widths[i])).join("  ");
  process.stdout.write(`${C.bold}${header}${C.reset}\n`);
  for (const r of rows) {
    process.stdout.write(`${cols.map((c, i) => r[c.key].padEnd(widths[i])).join("  ")}\n`);
  }
}

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

function printTopHelpAndExit(code: number): never {
  process.stdout.write(`ralph - autonomous Cursor SDK loop driver

USAGE
  ralph <subcommand> [args]

SUBCOMMANDS
  init <name>           create a new ralph project ./<name>/ and register it
  run <name|path>       start the project under pm2 (idempotent)
  stop <name|path>      stop the pm2 process gracefully (drains current run, ~30s)
  restart <name|path>   stop + start
  logs <name|path>      tail the pm2 logs (streams; Ctrl-C to detach)
  status [<name>]       show all (or one) ralph pm2 processes with iteration counts
  list                  list every registered project + its pm2 status
  delete <name> [--rm]  pm2 delete + unregister; --rm also removes the project dir
  loop <GOAL.md>        run the loop in the foreground (what pm2 invokes; not for daily use)
  print-prompt          print the built-in agent operating manual to stdout
  help, -h, --help      show this help

QUICK START
  ralph init mine97
  vim mine97/GOAL.md
  ralph run mine97
  ralph logs mine97
  ralph stop mine97

For loop-specific flags (--model, --workspace, --reset-every, --token-budget, ...),
see \`ralph loop --help\`.

State lives at:
  <project-dir>/{GOAL.md, STATE.md, PLAN.md, .ralph/, workspace/}
  ~/.ralph/registry.json   (name -> abs path mapping)
`);
  process.exit(code);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [first, ...rest] = argv;

  if (!first || first === "-h" || first === "--help" || first === "help") {
    printTopHelpAndExit(0);
  }
  if (first === "--print-prompt" || first === "print-prompt") {
    process.stdout.write(BUILTIN_PROMPT);
    process.exit(0);
  }

  const SUBCMDS: Record<string, (args: string[]) => Promise<void>> = {
    init: cmdInit,
    run: cmdRun,
    stop: cmdStop,
    restart: cmdRestart,
    logs: cmdLogs,
    status: cmdStatus,
    list: cmdList,
    delete: cmdDelete,
    loop: cmdLoop,
  };

  if (SUBCMDS[first]) {
    await SUBCMDS[first](rest);
    return;
  }

  // Back-compat: `ralph <something>` with an unknown first token routes to
  // `ralph loop <something>`. Keeps existing pm2 ecosystems that call
  // `ralph GOAL.md` working.
  await cmdLoop(argv);
}

main().catch((e) => {
  logError(e instanceof Error ? `fatal: ${e.message}` : `fatal: ${String(e)}`);
  if (e instanceof Error && e.stack) process.stderr.write(`${e.stack}\n`);
  process.exit(1);
});
