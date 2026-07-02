# Gitmini

[![CI](https://github.com/yangwachi123/Gitmini/actions/workflows/ci.yml/badge.svg)](https://github.com/yangwachi123/Gitmini/actions/workflows/ci.yml)
[![Python](https://img.shields.io/badge/python-3.10%2B-blue)](https://www.python.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A minimal, ready-to-build-on Python command-line tool skeleton.

This repository is a clean starting point: modern packaging, a `src/` layout,
linting and formatting with [Ruff](https://docs.astral.sh/ruff/), tests with
[pytest](https://docs.pytest.org/), and continuous integration via GitHub
Actions. Application logic is intentionally minimal — build your features on
top of it.

## Requirements

- Python 3.10 or newer

## Installation

Install from source in editable mode:

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
```

## Usage

```bash
gitmini --version
gitmini hello
gitmini hello Ada
```

You can also run it as a module:

```bash
python -m gitmini hello
```

## Development

Common tasks:

```bash
ruff check .          # lint
ruff format .         # format
pytest                # run the test suite
```

Optionally enable the pre-commit hooks so linting runs automatically:

```bash
pip install pre-commit
pre-commit install
```

## Project layout

```
Gitmini/
├── src/gitmini/        # package source
│   ├── __init__.py     # version (single source of truth)
│   ├── __main__.py     # `python -m gitmini`
│   └── cli.py          # command-line entry point
├── tests/              # pytest test suite
├── .github/workflows/  # CI pipeline
└── pyproject.toml      # packaging, tooling & metadata
```

## License

Released under the [MIT License](LICENSE).
