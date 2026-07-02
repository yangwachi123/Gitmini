"""Tests for the gitmini command-line interface."""

from __future__ import annotations

import pytest

from gitmini.cli import build_parser, greet, main


def test_greet_default() -> None:
    assert greet() == "Hello, world!"


def test_greet_name() -> None:
    assert greet("Gitmini") == "Hello, Gitmini!"


def test_hello_command_output(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main(["hello", "there"])
    captured = capsys.readouterr()
    assert exit_code == 0
    assert captured.out.strip() == "Hello, there!"


def test_hello_command_default_name(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main(["hello"])
    captured = capsys.readouterr()
    assert exit_code == 0
    assert captured.out.strip() == "Hello, world!"


def test_no_command_prints_help(capsys: pytest.CaptureFixture[str]) -> None:
    exit_code = main([])
    captured = capsys.readouterr()
    assert exit_code == 0
    assert "usage:" in captured.out.lower()


def test_parser_builds() -> None:
    assert build_parser() is not None
