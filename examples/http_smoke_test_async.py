"""HTTP smoke test (async edition) — exercise async tools + asyncio.gather with httpx.

Same cat-facts task as `http_smoke_test.py`, but the tool is `async def` and
uses `httpx.AsyncClient` — the way a normal Python developer would write
async HTTP.

Estimated time: ~30s.
"""

import fast_rlm
from pydantic import BaseModel


# --- The one (async) tool we're testing --------------------------------------

async def get_cat_fact_async() -> dict:
    """Fetch a random cat fact via async HTTP.

    Returns {"fact": str, "length": int}.
    """
    import httpx
    async with httpx.AsyncClient() as client:
        resp = await client.get("https://catfact.ninja/fact")
        return resp.json()


# --- Output schema -----------------------------------------------------------

class CatFactVerdict(BaseModel):
    most_surprising_fact: str
    why_surprising: str          # one short sentence
    all_facts_seen: list[str]    # the 5 raw facts that were fetched
    fetched_concurrently: bool   # set True only if asyncio.gather was used


prompt = """
You are testing whether ASYNC HTTP works inside your Pyodide REPL.

You have ONE tool pre-loaded — check the tool listing above for its async/sync
marker. If it is marked [async — needs await], you MUST call it with `await`,
and to run 5 calls concurrently you MUST use `asyncio.gather`.

Task:
  1. Fan out FIVE concurrent calls to the cat-fact tool using a single
     `asyncio.gather(...)`. Sequential calls are NOT acceptable for this test —
     the whole point is to verify concurrent async fetches work.
  2. Read all 5 facts. Pick the ONE most surprising or counter-intuitive.
  3. FINAL a dict matching this schema:
       {
         "most_surprising_fact": str,
         "why_surprising": str,                # one short sentence
         "all_facts_seen": [str, str, str, str, str],
         "fetched_concurrently": bool          # True only if you used asyncio.gather
       }

If the tool raises (network blocked, httpx missing, SSL not supported, etc.),
report the exception text as `most_surprising_fact` and explain in
`why_surprising`.
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
        prefix="http_smoke_test_async",
        tools=[get_cat_fact_async],
        output_schema=CatFactVerdict,
    )

    r = data["results"]
    print("\n=== ASYNC HTTP SMOKE TEST ===")
    print(f"Most surprising: {r['most_surprising_fact']}")
    print(f"Why:             {r['why_surprising']}")
    print(f"Concurrent:      {r['fetched_concurrently']}")
    print("\nAll facts seen:")
    for i, f in enumerate(r["all_facts_seen"], 1):
        print(f"  {i}. {f}")
    print("\nLOG:", data.get("log_file"))
    print("USAGE:", data.get("usage"))
