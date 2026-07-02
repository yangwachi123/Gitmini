"""Command-line interface for Gitmini.

This module wires up argument parsing and dispatches to the (currently
placeholder) subcommands. Application logic is intentionally minimal — the
repository is a clean starting point to build on.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

from gitmini import __version__


def greet(name: str = "world") -> str:
    """Return a friendly greeting for ``name``."""
    return f"Hello, {name}!"


def build_parser() -> argparse.ArgumentParser:
    """Construct the top-level argument parser."""
    parser = argparse.ArgumentParser(
        prog="gitmini",
        description="Gitmini — a minimal command-line tool.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )

    subparsers = parser.add_subparsers(dest="command")
    hello = subparsers.add_parser("hello", help="Print a friendly greeting.")
    hello.add_argument("name", nargs="?", default="world", help="Who to greet.")

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point for the ``gitmini`` command.

    Returns a process exit code (``0`` on success).
    """
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "hello":
        print(greet(args.name))
        return 0

    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
