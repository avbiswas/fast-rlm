import fast_rlm

if __name__ == "__main__":
    query = "Generate names of 50 fruits and return a dictionary of each name and the number of r in each fruit. Ensure that there are 50 fruits before returning the output by first asserting that it does! Generate the names using a subagent!"

    config = fast_rlm.RLMConfig()
    config.primary_agent = "minimax/minimax-m3"  # hardcoded for this test script
    config.sub_agent = "minimax/minimax-m3"
    config.max_completion_tokens = 2000
    data = fast_rlm.run(query, config=config, prefix="r_count")
    print("Here in this land:", data.get("results"))
    print("Log file:", data.get("log_file"))
