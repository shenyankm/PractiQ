import pytest
from httpx import ASGITransport, AsyncClient
from practiq_ai.product.app import create_app
from practiq_ai.product.config import load
from practiq_ai.product.services.ai import AIService

from product_tests.test_generation import FakeModel


@pytest.mark.parametrize("valid", [True, False])
async def test_metadata_contract_auth_and_success_failure_usage(valid):
    cfg = load()
    service = AIService(cfg)
    result = {"description": "适用于高等数学复习。", "tags": ["数学", "复习", "练习"]}
    service._text_model = FakeModel(
        responses=[result]
        if valid
        else [{"description": "bad", "tags": ["x" * 65]}] * 2
    )
    async with AsyncClient(
        transport=ASGITransport(app=create_app(cfg, service)), base_url="http://test"
    ) as client:
        assert (
            await client.post("/api/v1/ai/bank-metadata", json={"name": "数学"})
        ).status_code == 401
        headers = {"Authorization": "Bearer test-token"}
        assert (
            await client.post(
                "/api/v1/ai/bank-metadata", json={"name": " "}, headers=headers
            )
        ).status_code == 422
        response = await client.post(
            "/api/v1/ai/bank-metadata", json={"name": "数学"}, headers=headers
        )
    assert response.status_code == (200 if valid else 502), response.text
    body = response.json()
    assert len(body["meta"]["usage"]) == (1 if valid else 2)
    assert all(call["callKind"] == "bank_metadata" for call in body["meta"]["usage"])
    if valid:
        assert body["data"] == result


@pytest.mark.parametrize(
    "tags",
    [
        ["数学", "练习"],
        [str(i) for i in range(7)],
        ["Math", " math ", "练习"],
    ],
)
async def test_metadata_repairs_tag_count_and_duplicates(tags):
    from practiq_ai.product.agents import generator
    from practiq_ai.product.agents.model import collect_usage

    valid = {"description": "数学练习。", "tags": ["数学", "复习", "练习"]}
    fake = FakeModel(responses=[{**valid, "tags": tags}, valid])
    with collect_usage() as usage:
        result = await generator.bank_metadata(fake, {"name": "数学"})
    assert result.tags == valid["tags"]
    assert len(usage) == 2


def test_metadata_pattern_allows_full_text_in_constrained_decoders():
    import re

    from practiq_ai.product.ai_schemas import BankMetadataResult

    schema = BankMetadataResult.model_json_schema()["properties"]
    patterns = [schema["description"]["pattern"], schema["tags"]["items"]["pattern"]]
    for pattern in patterns:
        assert re.fullmatch(pattern, " 高等数学\n复习 ")
        assert not re.fullmatch(pattern, " \n\t ")
