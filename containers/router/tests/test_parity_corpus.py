"""Replay the committed parity corpus against the Python reference implementation.

tests/parity_corpus.py generates the corpus and tests/fixtures/parity/README.md describes it.
CI also runs `python tests/parity_corpus.py --check`, which fails when a committed file is stale.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from parity_corpus import INPUT_KEYS, PARITY_DIRECTORY, observe, validate_document

from gh_aw_router import classification

DOCUMENTS = {
    path.name: json.loads(path.read_text(encoding="utf-8"))
    for path in sorted(PARITY_DIRECTORY.glob("*.json"))
}


def _cases() -> list[Any]:
    return [
        pytest.param(document["kind"], case, id=f"{name}::{case['id']}")
        for name, document in DOCUMENTS.items()
        for case in document["cases"]
    ]


def test_corpus_has_one_document_per_kind() -> None:
    assert sorted(document["kind"] for document in DOCUMENTS.values()) == sorted(INPUT_KEYS)


@pytest.mark.parametrize("name", sorted(DOCUMENTS))
def test_document_structure(name: str) -> None:
    assert validate_document(DOCUMENTS[name]) == []


def test_classification_prompts() -> None:
    (document,) = (item for item in DOCUMENTS.values() if item["kind"] == "classification")
    assert document["system_prompt"] == classification.SYSTEM_PROMPT
    assert document["classification_contract"] == classification.CLASSIFICATION_CONTRACT


@pytest.mark.parametrize(("kind", "case"), _cases())
def test_case(kind: str, case: dict[str, Any]) -> None:
    assert observe(kind, case) == case["expect"]
