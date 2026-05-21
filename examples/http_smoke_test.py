"""HTTP smoke test — does `requests.get` work inside Pyodide via pyodide-http?

The simplest possible RLM-shaped task that requires real network I/O. One tool,
one question. If this runs end-to-end we know `requests` works in the REPL and
we can build the movie recommender on top of the same pattern.

Endpoint: https://catfact.ninja/fact — free, no auth, returns JSON like
  {"fact": "Cats sleep 70% of their lives.", "length": 31}

The agent is asked to fetch 5 cat facts and pick the most surprising one,
returning a structured verdict.

Estimated time: ~30s.
"""

import fast_rlm
from pydantic import BaseModel


# --- The one tool we're testing ----------------------------------------------

def get_cat_fact() -> dict:
    """Fetch a random cat fact. Returns {"fact": str, "length": int}.

    Uses `pyodide-http` to patch `requests` so the WASM Pyodide sandbox can
    route the call through the host's `fetch`.
    """
    # import pyodide_http
    # pyodide_http.patch_all()
    import requests
    r = requests.get("https://catfact.ninja/fact", timeout=10)
    r.raise_for_status()
    return r.json()


# --- Output schema -----------------------------------------------------------

class CatFactVerdict(BaseModel):
    most_surprising_fact: str
    why_surprising: str          # one short sentence
    all_facts_seen: list[str]    # the 5 raw facts that were fetched


prompt = """
You are testing whether HTTP works inside your Pyodide REPL.

You have ONE tool pre-loaded: `get_cat_fact()` — calling it returns a dict
like {"fact": "...", "length": N} from a random cat-fact API.

Task:
  1. Call `get_cat_fact()` FIVE times (sequential is fine — this is a smoke test).
  2. Read all 5 facts. Pick the ONE most surprising or counter-intuitive.
  3. FINAL a dict matching this schema:
       {
         "most_surprising_fact": str,
         "why_surprising": str,              # one short sentence
         "all_facts_seen": [str, str, str, str, str]
       }

If `get_cat_fact()` raises (network blocked, pyodide_http missing, etc.),
report the exception text as `most_surprising_fact` and explain in
`why_surprising` so we can debug.
"""


if __name__ == "__main__":
    config = fast_rlm.RLMConfig()
    config.primary_agent = "minimax/minimax-m2.5"
    config.sub_agent = "minimax/minimax-m2.5"
    config.max_depth = 1
    config.max_calls_per_subagent = 8
    config.max_money_spent = 0.10

    data = fast_rlm.run(
        prompt,
        config=config,
        prefix="http_smoke_test",
        tools=[get_cat_fact],
        output_schema=CatFactVerdict,
    )

    r = data["results"]
    print("\n=== HTTP SMOKE TEST ===")
    print(f"Most surprising: {r['most_surprising_fact']}")
    print(f"Why:             {r['why_surprising']}")
    print("\nAll facts seen:")
    for i, f in enumerate(r["all_facts_seen"], 1):
        print(f"  {i}. {f}")
    print("\nLOG:", data.get("log_file"))
    print("USAGE:", data.get("usage"))
