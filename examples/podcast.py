import fast_rlm
# Estimated time: 10-15 minutes

query = "Find what the first 5 Machine Learning guests had to say about AGI in the Lex Fridman Podcast. Not all guests are ML guests, focus on established researchers that are known for their contribution in AI. Return summaries about what the coversations were like about AGI." 

# #!/bin/bash
# curl -L -o ~/Downloads/lex-fridman-podcast-transcript.zip\
#  https://www.kaggle.com/api/v1/datasets/download/rajneesh231/lex-fridman-podcast-transcript
# You have to download and prepare the data first

data_file = "data/lex_fridman_dataset.csv"

text = open(data_file, "r").read()

context = f"""
{query}

The CSV Starts below this line:
# Data:
{text}
"""

print(f"Context length: {len(context)} chars")

config = fast_rlm.RLMConfig().default()
config.primary_agent = "anthropic/claude-sonnet-4.6"
config.sub_agent = "z-ai/glm-5"
config.max_depth = 4
config.truncate_len = 10000

data = fast_rlm.run(context, config=config, prefix="lex_fridman")
print("Result:", data.get("results"))
