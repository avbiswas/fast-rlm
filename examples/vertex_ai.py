"""Demonstrates using fast-rlm with Vertex AI (Google Gemini) via ADC.

Requirements:
    - gcloud CLI authenticated: gcloud auth application-default login
    - Environment variables:
        GOOGLE_CLOUD_PROJECT  — your GCP project ID
        GOOGLE_CLOUD_LOCATION — (optional, defaults to us-central1)
    - OR: set GOOGLE_APPLICATION_CREDENTIALS to a service account key JSON path

No API key needed — authentication uses Application Default Credentials.

Model names use the format: vertex/<publisher>/<model>
Example: vertex/google/gemini-2.5-flash
"""

import fast_rlm

config = fast_rlm.RLMConfig()
config.primary_agent = "vertex/google/gemini-2.5-flash"
config.sub_agent = "vertex/google/gemini-2.5-flash"
config.max_depth = 2
config.max_calls_per_subagent = 10
config.max_money_spent = 0.50

result = fast_rlm.run(
    "Generate 30 random fruit names. Then count how many contain the letter 'r'. "
    "Return the count as your final answer.",
    config=config,
    prefix="vertex_ai",
    vertex=True,
)

print("\n=== RESULT ===")
print(result["results"])
print("\nLOG:", result.get("log_file"))
print("USAGE:", result.get("usage"))
