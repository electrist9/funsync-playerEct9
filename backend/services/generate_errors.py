"""Error type shared by the funscript generation engines and their route.

The renderer localizes these: an error carries a stable `code` that maps
to a `generate.error.*` i18n key, plus a developer-facing message that
only ever goes to logs (never a file path — see the diagnostics privacy
contract in electron/main.js).
"""

from __future__ import annotations


class GenerateError(RuntimeError):
    """A generation failure the UI can explain.

    Codes (renderer maps these to generate.error.*):
      noFfmpeg   — ffmpeg/ffprobe not available on this machine
      noAudio    — the video has no audio track; use the motion engine
      noVideo    — the video has no decodable video stream
      badRange   — the requested start/end makes no sense
      cancelled  — the user pressed cancel
      failed     — anything else (ffmpeg error, unreadable file, ...)
    """

    def __init__(self, code: str, message: str = "") -> None:
        super().__init__(message or code)
        self.code = code
