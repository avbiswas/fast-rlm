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

const apiKey = Deno.env.get("RLM_MODEL_API_KEY") || Deno.env.get("OPENROUTER_API_KEY");
const baseURL = Deno.env.get("RLM_MODEL_BASE_URL") || "https://openrouter.ai/api/v1";

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
    const completion = await client.chat.completions.create({
        // model: "openai/gpt-5.2-codex",
        // model: "z-ai/glm-5",
        // model: "minimax/minimax-m2.5",
        model: model_name,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...messages
        ],
        reasoning: { 'effort': 'low' },
        temperature: 0.1, // Low temperature for code generation
    });

    const content = completion.choices[0].message.content || "";

    const replMatches = [...content.matchAll(/```repl([\s\S]*?)```/g)];
    let code = replMatches.map(m => m[1].trim()).join("\n");

    const usage = {
        prompt_tokens: completion.usage.prompt_tokens,
        completion_tokens: completion.usage.completion_tokens,
        total_tokens: completion.usage.total_tokens,
        cached_tokens: completion.usage?.prompt_tokens_details?.cached_tokens,
        reasoning_tokens: completion.usage?.completion_tokens_details?.reasoning_tokens,
        cost: completion.usage.cost,
    }
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
    ]);
    console.log(out)

}

