import { parse as parseYaml } from "@std/yaml";

// A user-registered ACP agent ("backdoor"). Built-in presets (claude-code,
// codex, opencode) live in acp.ts; anything else is declared here by command.
export interface AcpAgentSpec {
    // Executable to spawn (e.g. "npx", "opencode", "hermes").
    command: string;
    // Arguments passed to the command (e.g. ["-y", "@acme/foo-acp"]).
    args?: string[];
    // The agent's read-only session mode id, if it has one (e.g. "plan",
    // "read-only"). When set, fast-rlm switches the session into it so the
    // agent cannot edit files. Agents with no modes omit this and are
    // contained only by the isolated cwd.
    readonly_mode?: string;
    // Default model id for the agent (overridable per-call via ?model=...).
    model?: string;
    // ACP auth method id (e.g. "opencode-login", "chatgpt", "claude-login").
    // Only used on the lazy-auth fallback path; pinning it silences the
    // provider's "authMethodId is not configured" warning.
    auth_method?: string;
    // Extra env vars for the agent process.
    env?: Record<string, string>;
    // Config files to write into the throwaway cwd before the agent launches.
    // Keys are relative paths (e.g. ".claude/settings.json", "opencode.json");
    // values are serialized as JSON. Used to inject per-agent permission configs
    // that strip tool access so the agent acts as a pure text model.
    config_files?: Record<string, unknown>;
}

export interface RlmConfig {
    max_calls_per_subagent?: number;
    max_depth?: number;
    truncate_len?: number;
    primary_agent?: string;
    sub_agent?: string;
    max_money_spent?: number;
    max_completion_tokens?: number;
    max_prompt_tokens?: number;
    // Global cap on the TOTAL number of LLM calls across the whole run (root +
    // all sub-agents, every backend). Once reached, no new calls are allowed and
    // the loop stops. Especially important for ACP agents, where the token/cost
    // budgets are always zero and so never trigger.
    max_global_calls?: number;
    api_max_retries?: number;
    api_timeout_ms?: number;
    // Ablation toggles (default true). When false, the capability is removed at
    // the agent/subagent layer AND stripped from the system prompt.
    enable_tools?: boolean;
    enable_structured_io?: boolean;
    enable_compression_guard?: boolean;
    compression_min_chars?: number;
    compression_ratio?: number;
    instruction?: string;
    // ACP backdoor: name -> adapter spec. Used to resolve "acp:<name>" model
    // strings for agents that aren't one of the built-in presets.
    acp_agents?: Record<string, AcpAgentSpec>;
}

export function loadConfig(): RlmConfig {
    try {
        const configIdx = Deno.args.indexOf("--config");
        const configPath = configIdx !== -1 && Deno.args[configIdx + 1]
            ? Deno.args[configIdx + 1]
            : new URL("../rlm_config.yaml", import.meta.url).pathname;
        const raw = Deno.readTextFileSync(configPath);
        return (parseYaml(raw) as RlmConfig) ?? {};
    } catch {
        return {};
    }
}
