# ralph

A tiny CLI that drives a [Cursor SDK](https://cursor.com/docs/sdk/typescript) agent in a forever loop toward a goal you describe in `GOAL.md`. Each iteration is split into a **plan** phase and an **execute** phase, the agent maintains its own memory in `STATE.md`, and the whole thing runs under [pm2](https://pm2.keymetrics.io/) so it survives reboots and disconnects.

> "Ralph the Wiggum loop" — a small autonomous loop that wakes up, reads its
> notes, takes one concrete step toward the goal, writes new notes, and stops.
> Repeat forever.

## Install

```bash
git clone https://github.com/unarbos/ralph.git
cd ralph
npm install
npm link                       # puts `ralph` on $PATH

npm install -g pm2             # required for `ralph run/stop/restart/logs`
```

You'll also need:

- A Cursor API key. Either `export CURSOR_API_KEY=...` or have it accessible via `doppler secrets get CURSOR_API_KEY --plain` (ralph automatically falls back to doppler when the env var is missing).
- Node 20+ (the SDK requires it).

## Quick start

```bash
ralph init mine97             # scaffold ./mine97/ + register in ~/.ralph/registry.json
vim mine97/GOAL.md            # write your mission
ralph run mine97              # start under pm2
ralph logs mine97             # follow the agent's stdout
ralph stop mine97             # graceful stop (drains the in-flight run, ~30s)
```

That's the whole user-facing flow.

## What the agent does each iteration

```
+-----------------------------------+
|  PLAN PHASE (read-only)           |
|  - reads GOAL.md, STATE.md        |
|  - inspects the world (no writes) |
|  - writes PLAN.md only            |
+-----------------------------------+
                |
                v
+-----------------------------------+
|  EXECUTE PHASE (full tool access) |
|  - reads PLAN.md                  |
|  - runs the steps in PLAN.md      |
|  - rewrites STATE.md              |
+-----------------------------------+
                |
                v
        sleep, then loop
```

Both phases share one Cursor SDK session. Periodically (every N iterations or when a token budget is exceeded) the session is reset and a fresh agent is spawned, which re-bootstraps from STATE.md alone — that's why the operating manual is strict about STATE.md hygiene.

## Project layout (per `ralph init <name>`)

```
<name>/                          control plane for this goal
  GOAL.md                        you author this; agent re-reads every iteration
  STATE.md                       agent's living memory (auto-created, agent rewrites)
  PLAN.md                        plan for the current iteration (auto-created)
  ralph.config.cjs               pm2 ecosystem (auto-generated)
  .gitignore                     ignores workspace/ and .ralph/
  .ralph/                        ralph bookkeeping (loop driver only)
    state.json                   iteration cursor + agent id + token totals
    iterations/NNNNNN.json       full per-iteration transcript (both phases)
    plans/NNNNNN.md              snapshot of every prior PLAN.md
    pm2.out.log, pm2.err.log     pm2-captured stdout/stderr
    heartbeat                    touched every loop tick
    lock                         pidfile (prevents double-runs)
  workspace/                     agent's cwd; has its own .git
    .git/
    .gitignore                   Python/ML defaults
    ...everything the agent creates...
```

The split between control plane and `workspace/` is deliberate: the agent's actual work — code, configs, model weights, training logs, commits — all lives in `workspace/` with its own git history, while the control plane stays clean and focused on goal/state/plan.

## Subcommands

```
ralph init <name>           create ./<name>/ and register it
ralph run <name|path>       start the project under pm2 (idempotent)
ralph stop <name|path>      graceful stop (drains current run, ~30s)
ralph restart <name|path>   stop + start
ralph logs <name|path>      tail pm2 logs (Ctrl-C to detach)
ralph status [<name>]       pretty table of running ralph projects
ralph list                  list every registered project
ralph delete <name> [--rm]  pm2 delete + unregister; --rm also removes the dir
ralph loop <GOAL.md>        foreground loop (what pm2 invokes; not for daily use)
ralph print-prompt          dump the built-in agent operating manual
ralph help                  this help
```

`<name|path>` accepts either a registered project name (looked up in `~/.ralph/registry.json`) or an absolute/relative path.

## Loop-level flags (for `ralph loop`)

```
--prompt <path>             override the built-in operating manual
--workspace <path>          agent's cwd (default: <goal-dir>/workspace)
--state <path>              STATE.md path (default: STATE.md next to GOAL.md)
--plan <path>               PLAN.md path (default: PLAN.md next to GOAL.md)
--no-plan                   skip the plan phase; one execute send per iteration
--model <spec>              "id" or "id,key=value,..."
                            default: claude-opus-4-7
                            example: claude-opus-4-7,thinking=high
--reset-every <n>           reset agent session every N iterations (default: 20)
--token-budget <n>          reset when usage since last reset exceeds N (default: 800k)
--idle-ms <n>               sleep between iterations (default: 2000)
--max-iters <n>             stop after N iterations (default: infinity)
--print-prompt              print the operating manual and exit
```

## The built-in operating manual

ralph ships with a goal-agnostic operating manual baked into the binary. It tells the agent how the loop works, the difference between control plane and workspace, the two-phase structure, the schema for STATE.md, anti-patterns, and end-of-phase checklists.

See it with:

```bash
ralph print-prompt | less
```

To customize:

```bash
ralph print-prompt > ~/my-prompt.md
$EDITOR ~/my-prompt.md
ralph run mine97   # but you'll need to edit mine97/ralph.config.cjs to add
                   #   args: ["loop", "GOAL.md", "--prompt", "/abs/path/to/my-prompt.md"],
```

## Architecture

```
+------+        +-----------------+        +-------------------+
| You  | -----> | ralph init/run  | -----> | pm2 (ralph-name)  |
+------+        +-----------------+        +-------------------+
                                                    |
                                            spawns/keeps alive
                                                    v
                                          +-------------------+
                                          | ralph loop        |
                                          | - plan phase      |
                                          | - execute phase   |
                                          | - reset policy    |
                                          | - state recovery  |
                                          +-------------------+
                                                    |
                                                    v
                                          +-------------------+
                                          | Cursor SDK Agent  |
                                          | (claude-opus-4-7) |
                                          +-------------------+
                                                    |
                                            shell, edit, web,
                                            subagents, etc.
                                                    v
                                          +-------------------+
                                          | <name>/workspace/ |
                                          | (the actual work) |
                                          +-------------------+
```

## Robustness for forever-running

- **Crash recovery**: ralph persists `agentId`, iteration, token totals to `.ralph/state.json` after every iteration. On restart it resumes the same Cursor agent session (or creates a fresh one if resume fails) and STATE.md picks up where it left off.
- **Pid lockfile**: `.ralph/lock` prevents two ralph processes from racing on the same project. Stale locks are detected via `kill -0` and cleaned up.
- **Graceful shutdown**: `SIGINT`/`SIGTERM` cancels the in-flight Cursor run (`run.cancel()`), disposes the agent, releases the lock, exits 0. pm2's `kill_timeout: 30000` gives this 30s.
- **SIGUSR1 = force reset**: send `SIGUSR1` (or `touch .ralph/reset.signal`) to dispose the agent and start a fresh session next iteration.
- **Retry policy**: only retries `CursorAgentError.isRetryable` (RateLimit/Network) with exponential backoff (1s, 2s, 4s, 8s, max 60s, 6 attempts). Auth/Configuration errors exit non-zero and pm2's `exp_backoff_restart_delay` keeps the restart loop sane.
- **Iteration log rotation**: keeps the last 200 in `.ralph/iterations/`, gzips older into `iterations/archive/`.
- **Token-budget reset**: when cumulative session usage exceeds `--token-budget` (default 800k), the agent is disposed and rebuilt from STATE.md alone. Prevents context bloat over very long runs.
- **Periodic reset**: every `--reset-every` iterations (default 20) the agent is reset on principle.

## Operations cheat sheet

```bash
ralph status                 # all ralph processes + their iteration cursors
ralph logs mine97            # streaming log tail
ralph logs mine97 --lines 1000 --nostream   # backscroll N lines

pm2 monit                    # live cpu/mem dashboard for everything pm2 runs
pm2 save && pm2 startup systemd   # boot persistence (do once after first run)

cat <name>/STATE.md          # what the agent has learned
cat <name>/PLAN.md           # what it's executing right now
ls <name>/.ralph/iterations/ # full forensic transcripts
ls <name>/.ralph/plans/      # every prior plan

# force the agent to reset its session before next iteration
touch <name>/.ralph/reset.signal

# clean slate (keeps GOAL.md, removes everything else)
ralph stop <name>
rm -rf <name>/{STATE.md,PLAN.md,.ralph}
ralph run <name>
```

## CURSOR_API_KEY resolution

ralph looks for the key in this order:

1. `process.env.CURSOR_API_KEY`
2. `doppler secrets get CURSOR_API_KEY --plain` (whatever doppler resolves for the project's cwd)

If both fail, ralph prints the exact doppler stderr (e.g. "you must provide a token", "You must specify a project") plus the three concrete fixes — so the failure is self-diagnosing.

## Development

```bash
git clone https://github.com/unarbos/ralph.git
cd ralph
npm install
./node_modules/.bin/tsc --noEmit       # type check
./bin/ralph --help                     # run without npm link
```

Single-file implementation at [ralph.ts](./ralph.ts). The bash shim at [bin/ralph](./bin/ralph) execs `tsx ralph.ts`. The built-in operating manual is the `BUILTIN_PROMPT` constant near the top of the file.

## License

MIT.
