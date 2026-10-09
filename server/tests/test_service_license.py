"""Keep the standalone Python distribution notice identical to the project license."""

from pathlib import Path


def test_service_distribution_preserves_project_license():
    root = Path(__file__).parents[2]
    assert (root / 'server/LICENSE').read_bytes() == (root / 'LICENSE').read_bytes()
