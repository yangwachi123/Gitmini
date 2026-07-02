# Contributing to Gitmini

Thanks for your interest in contributing!

## Getting started

1. Fork and clone the repository.
2. Create a virtual environment and install the development dependencies:

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -e ".[dev]"
   ```

3. (Optional) Install the pre-commit hooks:

   ```bash
   pip install pre-commit
   pre-commit install
   ```

## Before you open a pull request

Please make sure the checks that run in CI pass locally:

```bash
ruff check .
ruff format --check .
pytest
```

## Guidelines

- Keep changes focused and include tests for new behavior.
- Follow the existing code style; Ruff handles formatting and linting.
- Write clear commit messages describing what changed and why.
