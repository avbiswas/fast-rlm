import { OpenAI } from "openai";
import { SYSTEM_PROMPT } from "./prompt.ts";

export interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens: number;
    reasoning_tokens: number;
    cost: number;
}

interface CodeReturn {
    code: string;
    success: boolean;
    message: any;
    usage: Usage;
}

// Estimate cost for providers that don't return it (rough estimate based on typical pricing)
function estimateCost(promptTokens: number, completionTokens: number): number {
    // Rough estimate: $0.001 per 1K prompt tokens, $0.002 per 1K completion tokens
    return (promptTokens / 1000) * 0.001 + (completionTokens / 1000) * 0.002;
}

const apiKey = Deno.env.get("RLM_MODEL_API_KEY") || Deno.env.get("OPENROUTER_API_KEY");
const baseURL = Deno.env.get("RLM_MODEL_BASE_URL") || "https://openrouter.ai/api/v1";

// OpenRouter-specific features (reasoning param, cost in response)
// Set RLM_OPENROUTER_COMPAT=false to disable for other providers like Vertex AI, OpenAI, etc.
const openRouterCompat = Deno.env.get("RLM_OPENROUTER_COMPAT") !== "false";

if (!apiKey) {
    throw new Error(
        "RLM_MODEL_API_KEY environment variable is missing or empty. " +
        "Set it to your API key, e.g.: export RLM_MODEL_API_KEY='sk-...'"
    );
}

export async function generate_code(
    messages: any[],
    model_name: string
): Promise<CodeReturn> {
    const client = new OpenAI({
        apiKey,
        baseURL,
    });
    
    // Build request - some parameters are provider-specific
    const requestParams: any = {
        model: model_name,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...messages
        ],
        temperature: 0.1, // Low temperature for code generation
    };
    
    // Add OpenRouter-specific reasoning parameter (skip for other providers)
    if (openRouterCompat) {
        requestParams.reasoning = { 'effort': 'low' };
    }
    
    const completion = await client.chat.completions.create(requestParams);

    const content = completion.choices[0].message.content || "";

    const replMatches = [...content.matchAll(/```repl([\s\S]*?)```/g)];
    let code = replMatches.map(m => m[1].trim()).join("\n");

    // Handle usage - some fields are provider-specific
    const rawUsage: any = completion.usage || {};
    const usage: Usage = {
        prompt_tokens: rawUsage.prompt_tokens || 0,
        completion_tokens: rawUsage.completion_tokens || 0,
        total_tokens: rawUsage.total_tokens || 0,
        cached_tokens: rawUsage?.prompt_tokens_details?.cached_tokens || 0,
        reasoning_tokens: rawUsage?.completion_tokens_details?.reasoning_tokens || 0,
        // cost is OpenRouter-specific, estimate for other providers
        cost: rawUsage.cost || estimateCost(rawUsage.prompt_tokens || 0, rawUsage.completion_tokens || 0),
    };
    if (!code) {
        return {
            code: "",
            success: false,
            message: completion.choices[0].message,
            usage: usage
        };
    }

    return {
        code: code,
        success: true,
        message: completion.choices[0].message,
        usage: usage
    };
}

if (import.meta.main) {
    // Test with a dummy context
    const query_context = "Just return fibonacci sequence";
    const out = await generate_code([
        { "role": "user", "content": query_context }
    ], "test-model");
    console.log(out)

}