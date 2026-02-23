import fast_rlm
# # Estimated time: 1 minute

prompt = """
You need to generate three lists — 25 fruits, 25 animals, and 25 US state names — and then count the number of times the letter 'r' (case-insensitive) appears in each name.

You MUST use 6 parallel subagent calls via asyncio.gather to generate the lists concurrently:
- Subagent 1: Generate exactly 25 fruit names. Return a Python list of strings.
- Subagent 2: Generate exactly 25 animal names. Return a Python list of strings.
- Subagent 3: Generate exactly 25 US state names. Return a Python list of strings.
- Subagent 4: Generate exactly 25 Indian state names. Return a Python list of strings.
- Subagent 5: Generate exactly 25 European state names. Return a Python list of strings.
- Subagent 6: Generate exactly 25 human names. Return a Python list of strings.

After all 6 subagents return, combine the results and build a single dictionary mapping each name (string) to the count of 'r' in that name (int).

Return the dictionary using FINAL_VAR.
"""

data = fast_rlm.run(prompt, prefix="parallel_r_count")
print("Result:", data.get("results"))
print("Usage:", data.get("usage"))
