# MCP testbed

A tiny, self-contained MCP server used to develop and test fast-rlm's MCP
integration. It exposes every primitive (tools, resources, prompts) and runs
over **both** transports the eventual RLM client must support:

- **stdio** — client spawns the server as a subprocess (`stdio.ts`)
- **Streamable HTTP** — stateful sessions over HTTP + SSE (`http.ts`)

There are **two servers** here:

- `server.ts` — a demo server with one of every primitive (tools, resources, prompts).
- `fsio.ts` — a "very basic" **filesystem + terminal-IO** server (read/write/list/run_command).

Each has its own stdio + HTTP entrypoint.

## Setup

```bash
cd mcp_testbed
bun install
```

## What it exposes

**Tools**

| Tool | Args | Purpose |
|---|---|---|
| `add` | `a, b` | numeric round-trip |
| `echo` | `text` | string round-trip |
| `now` | — | no-arg tool |
| `random_fruits` | `count` | array / `structuredContent` result |
| `big_text` | `paragraphs` | large result (truncation test) |
| `fail` | `message` | error propagation (`isError: true`) |

**Resources**

- `testbed://greeting` — static text
- `testbed://fruits.json` — static JSON
- `testbed://fruit/{name}` — templated/dynamic (not enumerated in `resources/list`)

**Prompts**

- `summarize` — reusable template with `text` + optional `style`

## Run

stdio (the client spawns it, so you usually don't run this directly):

```bash
bun run stdio        # = bun run stdio.ts
```

Streamable HTTP (long-running server on :3333, override with `PORT`):

```bash
bun run http         # listens on http://localhost:3333/mcp
```

## Smoke test

The client enumerates and exercises every primitive over the chosen transport.

```bash
bun run client stdio          # spawns the stdio server itself
# in another shell after `bun run http`:
bun run client http           # override URL with MCP_URL=...
```

## Filesystem + terminal-IO server (`fsio.ts`)

Four tools: `read_file`, `write_file`, `list_dir`, `run_command`. Filesystem ops
are confined to a root directory (`FSIO_ROOT`, default cwd); the root is created
on startup. `run_command` runs in the root with a timeout (`FSIO_CMD_TIMEOUT_MS`,
default 10000).

```bash
FSIO_ROOT=/tmp/fsio-scratch bun run fsio-stdio        # stdio
FSIO_ROOT=/tmp/fsio-scratch PORT=3334 bun run fsio-http   # HTTP on :3334

bun run fsio-client stdio     # spawns it with FSIO_ROOT=/tmp/fsio-scratch
bun run fsio-client http      # against a running fsio-http
```

> ⚠️ **Not a sandbox.** `run_command` is full host shell access and the path
> guard is a basic `..`-escape check, not a security boundary. This is the
> "sandbox hole" the RLM MCP design must treat as privileged. Point `FSIO_ROOT`
> at a scratch dir.

## Inspect interactively

The official MCP Inspector works against either transport:

```bash
npx @modelcontextprotocol/inspector bun run stdio.ts   # stdio
npx @modelcontextprotocol/inspector                    # then point at http://localhost:3333/mcp
```

## Notes for the RLM integration

- The HTTP server is **stateful**: the first POST is an `initialize`; the server
  returns an `mcp-session-id` header that the client echoes on every subsequent
  request. The SDK client handles this transparently.
- `random_fruits` returns both a text fallback and `structuredContent` — useful
  for deciding how the RLM bridge marshals MCP results into Python objects.
- `big_text` is the "large result → REPL variable, truncate only what's printed"
  case that motivates doing MCP calls inside the REPL in the first place.
