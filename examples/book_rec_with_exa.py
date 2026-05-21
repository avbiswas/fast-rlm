"""Exa search smoke test — async httpx tool hitting a real auth'd API.

Goes one step beyond the cat-fact test: the tool calls Exa's search endpoint
with an API key, parses structured results, and the agent fans out multiple
concurrent searches via `asyncio.gather`.

Requires EXA_API_KEY in your environment.

Estimated time: ~30–60s.
"""

import os
import fast_rlm
from pydantic import BaseModel


# --- The one (async) tool ----------------------------------------------------


async def exa_search(query: str, num_results: int = 5) -> list:
    """Search Exa for high-signal articles matching `query`.
    Returns up to `num_results` items, each with:
        {"title": str, "url": str, "highlights": [str], "published_date": str}
    """
    import os
    import httpx

    api_key = os.environ["EXA_API_KEY"]
    payload = {
        "query": query,
        "type": "auto",
        "numResults": num_results,
        "contents": {"highlights": True},
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://api.exa.ai/search",
            headers={"Content-Type": "application/json", "x-api-key": api_key},
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
    out = []
    for r in (data.get("results") or [])[:num_results]:
        out.append(
            {
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "highlights": r.get("highlights") or [],
                "published_date": r.get("publishedDate", ""),
            }
        )
    return out


async def goodreads_reviews(query: str, num_reviews: int = 5) -> list:
    """Search Goodreads for reviews matching `query` and return their full text.
    Returns up to `num_reviews` items, each with:
        {"title": str, "url": str, "published_date": str, "text": str}
    """
    import os
    import httpx

    api_key = os.environ["EXA_API_KEY"]
    async with httpx.AsyncClient(timeout=60) as client:
        search_resp = await client.post(
            "https://api.exa.ai/search",
            headers={"Content-Type": "application/json", "x-api-key": api_key},
            json={
                "query": query,
                "type": "auto",
                "numResults": num_reviews,
                "includeDomains": ["goodreads.com"],
            },
        )
        search_resp.raise_for_status()
        results = (search_resp.json().get("results") or [])[:num_reviews]
        if not results:
            return []

        urls = [r["url"] for r in results]
        contents_resp = await client.post(
            "https://api.exa.ai/contents",
            headers={"Content-Type": "application/json", "x-api-key": api_key},
            json={"urls": urls, "text": True},
        )
        contents_resp.raise_for_status()
        text_by_url = {
            c.get("url", ""): (c.get("text") or "")
            for c in (contents_resp.json().get("results") or [])
        }

    return [
        {
            "title": r.get("title", ""),
            "url": r["url"],
            "published_date": r.get("publishedDate", ""),
            "text": text_by_url.get(r["url"], "")[:8000],
        }
        for r in results
    ]


# --- Output schema -----------------------------------------------------------


class Pick(BaseModel):
    title: str
    why: str  # one-sentence reason, grounded in the highlights


class TopReads(BaseModel):
    picks: list[Pick]  # exactly 3, ranked best-first


# --- User input --------------------------------------------------------------

TOPIC = """
books released in 2026 that I would love. Make sure they are good books. 
I don't like reading books that are anti-feminist, or racist, or sexist. I love reading good complex characters.
Last books I have loved are: The Palace of Illusions, Piranesi, Dark Matter, and Animal Farm. State why.
Give me 10 book recommendations.
"""


prompt = f"""
Launch subagents to search and explore. Divide up the work between the subagents.
{TOPIC}
"""


if __name__ == "__main__":
    api_key = os.environ.get("EXA_API_KEY")
    if not api_key:
        raise SystemExit(
            "Set EXA_API_KEY in your environment first. Get a key at https://exa.ai/"
        )

    config = fast_rlm.RLMConfig()
    config.primary_agent = "minimax/minimax-m2.7"
    config.sub_agent = "minimax/minimax-m2.7"
    config.max_depth = 2
    config.max_calls_per_subagent = 15
    config.max_money_spent = 0.15
    config.max_prompt_tokens = 300_000

    data = fast_rlm.run(
        prompt,
        config=config,
        prefix="book_rec_with_exa",
        tools=[exa_search, goodreads_reviews],
        env_variables={"EXA_API_KEY": api_key},
        output_schema=TopReads,
    )

    r = data["results"]
    print("\n=== TOP READS ===\n")
    for i, p in enumerate(r["picks"], 1):
        print(f"  {i}. {p['title']}")
        print(f"     why: {p['why']}")
        print()
    print("LOG:", data.get("log_file"))
    print("USAGE:", data.get("usage"))
