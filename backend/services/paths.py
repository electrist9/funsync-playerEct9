"""Shared backend filesystem locations.

`--user-data-dir` is the Electron userData directory (it holds
`config.json`). More than one backend feature now needs it:

  * the web-remote locale mirror  — routes/locale.py
  * the generated-funscript store — services/generated_store.py

Both used to keep their own copy of the value. This module is the single
source of truth: main.py calls set_user_data_dir() once at startup and
every consumer reads get_user_data_dir(). Keeping it here also means a
new feature that needs userData does not have to invent its own wiring.
"""

_user_data_dir: str | None = None


def set_user_data_dir(path: str | None) -> None:
    """Called once at startup from main.py with the --user-data-dir value."""
    global _user_data_dir
    _user_data_dir = path


def get_user_data_dir() -> str | None:
    """The userData dir, or None when the backend was started without one
    (bare `python main.py` in dev, tests). Callers must have a fallback."""
    return _user_data_dir
