import json
from pathlib import Path

import pytest

from practiq_ai.contracts import GradeResult

CASES = json.loads((Path(__file__).parents[1] / "evals/badcases/grading-evidence-v2.json").read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_grading_evidence_matches_native_contract(case):
    def verify():
        GradeResult.model_validate(case["result"]).verify_evidence(case["input"]["question"], case["input"]["answer"])

    if case["valid"]:
        verify()
    else:
        with pytest.raises(ValueError):
            verify()
