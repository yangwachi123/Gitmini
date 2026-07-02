"""Tests for package metadata."""

from __future__ import annotations

import gitmini


def test_version_is_non_empty_string() -> None:
    assert isinstance(gitmini.__version__, str)
    assert gitmini.__version__


def test_version_is_semver_like() -> None:
    parts = gitmini.__version__.split(".")
    assert len(parts) == 3
    assert all(part.isdigit() for part in parts)
