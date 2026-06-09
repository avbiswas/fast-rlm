import { OpenAI } from "openai";

const TOKEN_REFRESH_MARGIN_MS = 60_000;

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

function b64url(data: string): string {
    return btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(): Promise<string> {
    if (cachedToken && Date.now() < tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
        return cachedToken;
    }

    const keyFile = Deno.env.get("GOOGLE_APPLICATION_CREDENTIALS");
    if (keyFile) {
        const token = await getTokenFromServiceAccount(keyFile);
        return token;
    }

    // Fall back to gcloud CLI (ADC)
    const cmd = new Deno.Command("gcloud", {
        args: ["auth", "print-access-token"],
        stdout: "piped",
        stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    if (code !== 0) {
        const err = new TextDecoder().decode(stderr);
        throw new Error(
            `Failed to get access token from gcloud CLI. ` +
            `Run 'gcloud auth application-default login' first.\n${err}`
        );
    }
    cachedToken = new TextDecoder().decode(stdout).trim();
    tokenExpiresAt = Date.now() + 3_500_000; // ~58 min (gcloud tokens last 60 min)
    return cachedToken;
}

async function getTokenFromServiceAccount(keyPath: string): Promise<string> {
    const raw = await Deno.readTextFile(keyPath);
    const key = JSON.parse(raw);

    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({
        iss: key.client_email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
    }));

    const signingInput = `${header}.${payload}`;
    const keyData = pemToArrayBuffer(key.private_key);
    const cryptoKey = await crypto.subtle.importKey(
        "pkcs8", keyData,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false, ["sign"],
    );
    const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5", cryptoKey,
        new TextEncoder().encode(signingInput),
    );
    const sig = b64url(String.fromCharCode(...new Uint8Array(signature)));

    const jwt = `${header}.${payload}.${sig}`;
    const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!resp.ok) {
        throw new Error(`Service account token exchange failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    return cachedToken!;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
    const b64 = pem
        .replace(/-----BEGIN PRIVATE KEY-----/, "")
        .replace(/-----END PRIVATE KEY-----/, "")
        .replace(/\s/g, "");
    const binary = atob(b64);
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    return buf.buffer;
}

function getVertexEndpoint(): string {
    const project = Deno.env.get("GOOGLE_CLOUD_PROJECT") ||
        Deno.env.get("CLOUDSDK_CORE_PROJECT");
    const location = Deno.env.get("GOOGLE_CLOUD_LOCATION") || "us-central1";

    if (!project) {
        throw new Error(
            "GOOGLE_CLOUD_PROJECT environment variable is required for Vertex AI. " +
            "Set it to your GCP project ID."
        );
    }

    return `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/endpoints/openapi`;
}

export async function createVertexClient(options?: {
    maxRetries?: number;
    timeout?: number;
}): Promise<OpenAI> {
    const token = await getAccessToken();
    return new OpenAI({
        apiKey: token,
        baseURL: getVertexEndpoint(),
        maxRetries: options?.maxRetries ?? 3,
        timeout: options?.timeout ?? 600000,
    });
}

export async function refreshVertexClient(client: OpenAI): Promise<OpenAI> {
    if (Date.now() < tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
        return client;
    }
    return createVertexClient();
}

export function isVertexModel(model: string): boolean {
    return model.startsWith("vertex/");
}

export function stripVertexPrefix(model: string): string {
    return model.replace(/^vertex\//, "");
}
