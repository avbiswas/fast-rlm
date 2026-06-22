// ACP (Agent Client Protocol) backend.
//
// Lets fast-rlm drive a coding agent (Claude Code, Codex, opencode, ...) as a
// drop-in "model": the agent is prompted with the same system prompt + message
// history as the OpenAI/Vertex path and is expected to reply with a ```repl```
// block, which subagents.ts then executes in Pyodide. The agent itself runs
// READ-ONLY — it never executes the code or writes files (see safety notes).
//
// Selection (string-only, mirrors the "vertex/" prefix convention):
//     "acp:<name>"                 -> built-in preset or registered backdoor agent
//     "acp:<name>?model=<modelId>" -> same, overriding the agent's model
//
// Safety: every ACP agent runs in a throwaway temp cwd (so any stray write is
// contained), and when the resolved agent declares a `readonly_mode` we switch
// the ACP session into it (e.g. opencode/claude "plan", codex "read-only").
// Agents with no session modes are contained by the temp cwd alone.
import { createACPProvider } from "@mcpc/acp-ai-provider";
import { generateText } from "ai";
import { buildSystemPrompt, PromptOptions } from "./prompt.ts";
import { loadConfig, type AcpAgentSpec } from "./config.ts";
import type { ApiRetryOptions, CodeReturn, ConfirmResult, Usage } from "./call_llm.ts";

const ACP_PREFIX = "acp:";

// Built-in presets — only the three we've verified end-to-end. Every other
// agent comes in through the `acp_agents` backdoor in config.
// Config files injected into the throwaway cwd before each agent launch.
// The ACP provider spawns the agent with cwd=tempDir, so these are picked up
// as project-level configs — stripping all tool access and forcing the agent
// to behave as a pure text model (no bash, no file reads, no writes).
//
// Each agent has its own config format:
//   claude-code → .claude/settings.json  (permissions.deny glob list)
//   opencode    → opencode.json          (permission.<tool>: "deny")
//   codex       → -c sandbox_permissions=[] CLI flag (added to args)
const CLAUDE_CODE_CONFIG = {
    ".claude/settings.json": {
        permissions: {
            deny: ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "MultiEdit(*)", "WebFetch(*)", "WebSearch(*)"],
        },
    },
};

const OPENCODE_CONFIG = {
    "opencode.json": {
        permission: {
            bash: "deny",
            read: "deny",
            edit: "deny",
            glob: "deny",
            grep: "deny",
        },
    },
};

const PRESETS: Record<string, AcpAgentSpec> = {
    "claude-code": { command: "npx", args: ["-y", "@zed-industries/claude-code-acp"], readonly_mode: "plan", auth_method: "claude-login", config_files: CLAUDE_CODE_CONFIG },
    "codex": { command: "npx", args: ["-y", "@zed-industries/codex-acp", "-c", "sandbox_permissions=[]"], readonly_mode: "read-only", auth_method: "chatgpt" },
    "opencode": { command: "opencode", args: ["acp"], readonly_mode: "plan", auth_method: "opencode-login", config_files: OPENCODE_CONFIG },
};

export function isAcpModel(model: string): boolean {
    return model.startsWith(ACP_PREFIX);
}

interface ParsedAcp {
    spec: AcpAgentSpec;
    // Model id to pass to the agent: ?model= override, else the spec's default.
    modelId?: string;
}

// "acp:codex?model=gpt-5.5-codex" -> resolved spec + model override.
// Registered agents (config.acp_agents) take precedence over built-in presets,
// so a user can override a preset by re-declaring its name.
function parseAcpModel(model: string): ParsedAcp {
    const rest = model.slice(ACP_PREFIX.length);
    const [name, query] = rest.split("?", 2);
    if (!name) {
        throw new Error(`Invalid ACP model "${model}". Expected "acp:<agent>" (e.g. "acp:codex").`);
    }
    const registry = loadConfig().acp_agents ?? {};
    const spec = registry[name] ?? PRESETS[name];
    if (!spec) {
        const known = [...new Set([...Object.keys(PRESETS), ...Object.keys(registry)])].sort();
        throw new Error(
            `Unknown ACP agent "${name}". Built-in presets: claude-code, codex, opencode. ` +
            `Register others via acp_agents in your config. Known: ${known.join(", ") || "(none)"}.`,
        );
    }
    let modelOverride: string | undefined;
    if (query) {
        const params = new URLSearchParams(query);
        modelOverride = params.get("model") ?? undefined;
    }
    return { spec, modelId: modelOverride ?? spec.model };
}

// fast-rlm messages are OpenAI-shaped {role, content}. Coerce to the AI SDK's
// CoreMessage shape (string content; non-string content is JSON-stringified).
// deno-lint-ignore no-explicit-any
function toAiSdkMessages(messages: any[]): any[] {
    return messages
        .filter((m) => m && m.role !== "system")
        .map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        }));
}

// Appended to the system prompt for every ACP call. Reinforces that the agent
// must not use its own native tooling (bash, file reads, web search, etc.) and
// must work exclusively through the Python REPL provided by fast-rlm.
const ACP_SYSTEM_ADDENDUM = `
** IMPORTANT: ACP execution constraints **
You are running as a backend model inside the fast-rlm Recursive Language Model framework. In this context, you are ONLY permitted to interact with the environment through the Python REPL described above — specifically the \`context\` variable, \`llm_query\`, \`batch_llm_query\`, \`FINAL\`, and any tools explicitly passed to you.

You must NOT use any native tools or capabilities that come with your agent harness — this includes bash execution, file system reads or writes, web search, web fetch, or any other ReAct-style tool your underlying system may provide.

This is a controlled research evaluation of raw Python REPL reasoning ability, deliberately isolated from traditional agentic tool use. Using your harness tools instead of the REPL is considered cheating and invalidates the evaluation. Every computation, data access, and result must flow through the REPL.

If you cannot accomplish something purely within the REPL, say so — do not reach for external tools.
`;

function extractReplCode(content: string): string {
    const replMatches = [...content.matchAll(/```repl([\s\S]*?)```/g)];
    return replMatches.map((m) => m[1].trim()).join("\n");
}

// ACP agents don't report token usage over the protocol, so accounting is zero.
function emptyUsage(): Usage {
    return {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        cost: undefined,
    };
}

// One ACP turn: spawn the agent in a throwaway cwd, set read-only mode, send the
// full system prompt + history, return the agent's reply text. Stateless per call
// (a fresh ACP session each time) so the contract matches the OpenAI path exactly.
async function acpComplete(
    messages: any[], // deno-lint-ignore-line no-explicit-any
    model_name: string,
    is_leaf_agent: boolean,
    options: ApiRetryOptions | undefined,
    promptOpts: PromptOptions | undefined,
): Promise<{ text: string; usage: Usage }> {
    const { spec, modelId } = parseAcpModel(model_name);
    const cwd = await Deno.makeTempDir({ prefix: "fast_rlm_acp_" });

    // Write agent-specific config files into the throwaway cwd before launch.
    // The provider spawns with cwd=tempDir, so each agent picks these up as its
    // project config, stripping all tool access (bash, reads, writes, web).
    if (spec.config_files) {
        for (const [relPath, content] of Object.entries(spec.config_files)) {
            const abs = `${cwd}/${relPath}`;
            const dir = abs.substring(0, abs.lastIndexOf("/"));
            await Deno.mkdir(dir, { recursive: true });
            await Deno.writeTextFile(abs, JSON.stringify(content, null, 2));
        }
    }

    const provider = createACPProvider({
        command: spec.command,
        args: spec.args ?? [],
        env: spec.env,
        authMethodId: spec.auth_method,
        session: { cwd, mcpServers: [] },
    });
    try {
        // languageModel(modelId, modeId): both are applied automatically when the
        // fresh session is created, so no separate initSession/setMode round-trip.
        const lm = provider.languageModel(modelId, spec.readonly_mode);
        const system = buildSystemPrompt(is_leaf_agent, promptOpts ?? {}) + ACP_SYSTEM_ADDENDUM;
        const timeout = options?.timeout;
        const result = await generateText({
            model: lm,
            system,
            messages: toAiSdkMessages(messages),
            tools: provider.tools,
            ...(timeout ? { abortSignal: AbortSignal.timeout(timeout) } : {}),
        });
        return { text: result.text ?? "", usage: emptyUsage() };
    } finally {
        provider.cleanup();
        // Drop the throwaway cwd (and anything a mode-less agent may have written).
        try {
            await Deno.remove(cwd, { recursive: true });
        } catch { /* ignore */ }
    }
}

// Drop-in for generate_code when model_name is an "acp:" agent.
export async function generateAcpCode(
    messages: any[], // deno-lint-ignore-line no-explicit-any
    model_name: string,
    is_leaf_agent = false,
    options?: ApiRetryOptions,
    promptOpts?: PromptOptions,
    _llmKwargs?: Record<string, unknown> | null,
): Promise<CodeReturn> {
    const { text, usage } = await acpComplete(messages, model_name, is_leaf_agent, options, promptOpts);
    const code = extractReplCode(text);
    const message = { role: "assistant", content: text };
    if (!code) {
        return { code: "", success: false, message, usage };
    }
    return { code, success: true, message, usage };
}

// Drop-in for confirmDelegation (compression guard) when model_name is "acp:".
export async function confirmAcpDelegation(
    baseMessages: any[], // deno-lint-ignore-line no-explicit-any
    confirmQuestion: string,
    model_name: string,
    is_leaf_agent: boolean,
    options?: ApiRetryOptions,
    promptOpts?: PromptOptions,
    _llmKwargs?: Record<string, unknown> | null,
): Promise<ConfirmResult> {
    const messages = [...baseMessages, { role: "user", content: confirmQuestion }];
    const { text, usage } = await acpComplete(messages, model_name, is_leaf_agent, options, promptOpts);
    const content = text.trim();
    // Fail-open: only an explicit "NO" (as the first word) rejects.
    const firstWord = content.replace(/^[^a-zA-Z]+/, "").slice(0, 4).toUpperCase();
    const approve = !firstWord.startsWith("NO");
    return { approve, reason: content || "(no reason given)", usage };
}
