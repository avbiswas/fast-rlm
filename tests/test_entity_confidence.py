import networkx as nx
import pytest

import fast_rlm
from fast_rlm import RLMConfig


def test_min_entity_confidence_defaults_and_accepts_custom_value():
    assert RLMConfig().min_entity_confidence == 0.75
    assert RLMConfig(min_entity_confidence=0.9).min_entity_confidence == 0.9


@pytest.mark.parametrize("value", [-0.1, 1.1, "0.75", True])
def test_graph_run_rejects_invalid_min_entity_confidence(value):
    with pytest.raises(ValueError, match="min_entity_confidence"):
        fast_rlm.run(
            {"question": "q"},
            graph=nx.MultiDiGraph(),
            config={"primary_agent": "test-model", "min_entity_confidence": value},
        )
