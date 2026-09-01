#!/usr/bin/env python3
"""Read the current AAVA-generated Content.txt from GitHub.

This module is intentionally isolated from the AAVA API client and the Node
approval lifecycle. Content.txt is the authoritative AAVA output after the
workflow reports SUCCESS. No freshness or version check is performed.
"""

from __future__ import annotations

import base64
import json
import os
import time
from typing import Any



CONTENT_PATH = os.getenv("AAVA_CONTENT_PATH", "Content/Content.txt")
POLL_INTERVAL_SECONDS = float(os.getenv("AAVA_CONTENT_POLL_INTERVAL_SECONDS", "2"))


def _default_branch(repo) -> str:
    branch = getattr(repo, "default_branch", None)
    if not branch:
        raise RuntimeError("GitHub repository default branch could not be determined.")
    return branch


def _file_item(repo, branch: str):
    try:
        item = repo.get_contents(CONTENT_PATH, ref=branch)
    except Exception as exc:
        if getattr(exc, "status", None) == 404:
            return None
        raise
    if isinstance(item, list):
        raise RuntimeError(f"GitHub path is a directory, expected file: {CONTENT_PATH}")
    return item


def _decode_item(item) -> bytes:
    try:
        return base64.b64decode((item.content or "").replace("\n", ""))
    except Exception as exc:
        raise RuntimeError(f"Unable to decode GitHub file {CONTENT_PATH}: {exc}") from exc


def _iter_json_values(text: str):
    """Parse one JSON value or multiple adjacent JSON objects."""
    decoder = json.JSONDecoder()
    index = 0
    length = len(text)
    found = False

    while index < length:
        while index < length and text[index].isspace():
            index += 1
        if index >= length:
            break

        try:
            value, end = decoder.raw_decode(text, index)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"GitHub {CONTENT_PATH} contains invalid JSON at character {exc.pos}: {exc.msg}"
            ) from exc

        found = True
        yield value
        index = end

    if not found:
        raise RuntimeError(f"GitHub {CONTENT_PATH} is empty.")


def parse_content_bytes(content: bytes) -> Any:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RuntimeError(f"GitHub {CONTENT_PATH} is not valid UTF-8: {exc}") from exc

    values = list(_iter_json_values(text))
    if len(values) == 1:
        return values[0]
    return values


def read_current_content(repo, log=None) -> Any:
    """Read and parse the current GitHub Content.txt.

    GitHub is the source of truth after AAVA reports SUCCESS. No freshness,
    SHA, commit timestamp, or AAVA/GitHub correlation is performed.
    """
    branch = _default_branch(repo)
    item = _file_item(repo, branch)
    if item is None:
        raise RuntimeError(f"GitHub {CONTENT_PATH} was not found.")
    payload = parse_content_bytes(_decode_item(item))
    if log:
        log(f"[AAVA] Read GitHub {CONTENT_PATH}.")
    return payload


def read_latest_content_after_success(repo, log=None) -> Any:
    """Read GitHub Content.txt after AAVA SUCCESS.

    AAVA and GitHub are independent systems. This function deliberately does
    not perform freshness/version checks and does not inspect AAVA's execution
    id. If GitHub has not published the file yet, polling continues until the
    current Content.txt becomes available and contains valid JSON.
    """
    while True:
        try:
            return read_current_content(repo, log=log)
        except RuntimeError as exc:
            if "was not found" not in str(exc):
                raise
            if log:
                log(f"[AAVA] GitHub {CONTENT_PATH} is not available yet; retrying...")
            time.sleep(POLL_INTERVAL_SECONDS)
