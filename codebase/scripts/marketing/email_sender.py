#!/usr/bin/env python3
"""Send approved marketing emails from the approved AAVA output.

Recipient selection is deliberately isolated here so it can be changed later
without modifying the workflow or frontend. A recipient is accepted only when
its email address is structurally valid and it is not in EMAIL_EXCLUDE_LIST.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import smtplib
from email.message import EmailMessage
from pathlib import Path
from typing import Any, Iterable

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None

PROJECT_ROOT = Path(__file__).resolve().parent
JSON_FILE = PROJECT_ROOT / "database_export" / "marketing_output.json"  # legacy local override only
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587
EMAIL_RE = re.compile(r"^[A-Za-z0-9.!#$%&' *+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$".replace(" ", ""))


def _log(message: str) -> None:
    print(message, flush=True)


def _parse_exclusion_list(raw: str | None) -> set[str]:
    """Parse comma-separated excluded recipients from .env."""
    if not raw:
        return set()
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


def _iter_json_values(text: str) -> Iterable[Any]:
    """Read one JSON value or multiple adjacent JSON objects from Content.txt."""
    decoder = json.JSONDecoder()
    index = 0
    length = len(text)
    found = False
    while index < length:
        while index < length and text[index].isspace():
            index += 1
        if index >= length:
            break
        value, end = decoder.raw_decode(text, index)
        found = True
        yield value
        index = end
    if not found:
        raise ValueError("Approved marketing output is empty.")


def load_approved_output(path: Path = JSON_FILE) -> Any:
    if not path.is_file():
        raise ValueError(f"Approved marketing output not found: {path}")
    text = path.read_text(encoding="utf-8")
    try:
        values = list(_iter_json_values(text))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError(f"Approved marketing output is invalid JSON: {exc}") from exc
    if len(values) == 1:
        return values[0]
    return values


def _iter_email_objects(value: Any) -> Iterable[dict[str, Any]]:
    """Yield customer email payloads from current and legacy approved shapes."""
    if isinstance(value, dict):
        # Current Content.txt shape:
        # {"customer_id": ..., "email": {"email_address": ..., "subject": ..., "body": ...}}
        email = value.get("email")
        if isinstance(email, dict):
            yield email

        # Legacy/approval shape:
        if "mail_id" in value:
            yield value
        if "agent_outputs" in value:
            yield from _iter_email_objects(value["agent_outputs"])
        if "content" in value and not isinstance(value.get("content"), str):
            yield from _iter_email_objects(value["content"])
        return

    if isinstance(value, list):
        for item in value:
            yield from _iter_email_objects(item)


def extract_email_records(data: Any, excluded: set[str] | None = None) -> list[dict[str, str]]:
    """Extract every valid email.email_address, excluding configured recipients."""
    excluded = excluded or set()
    records: list[dict[str, str]] = []
    seen: set[str] = set()

    for item in _iter_email_objects(data):
        # Current Content.txt uses email.email_address/body.
        recipient = str(item.get("email_address") or item.get("mail_id") or "").strip()
        subject = str(item.get("subject") or "").strip()
        content = str(item.get("body") or item.get("content") or "")

        if not EMAIL_RE.fullmatch(recipient):
            _log(f"[EMAIL] Skipping invalid email_address: {recipient or '<empty>'}")
            continue
        normalized = recipient.lower()
        if normalized in excluded:
            _log(f"[EMAIL] Skipping explicitly excluded recipient: {recipient}")
            continue
        if not subject:
            _log(f"[EMAIL] Skipping {recipient}: subject is empty")
            continue
        if not content.strip():
            _log(f"[EMAIL] Skipping {recipient}: body is empty")
            continue
        if normalized in seen:
            _log(f"[EMAIL] Skipping duplicate recipient: {recipient}")
            continue

        seen.add(normalized)
        records.append({"mail_id": recipient, "subject": subject, "content": content})

    if not records:
        raise ValueError("Approved marketing output contains no valid, non-excluded email records.")
    return records


def send_approved_emails(path: Path | None = None) -> tuple[int, int]:
    if load_dotenv:
        load_dotenv(PROJECT_ROOT.parent.parent / ".env")
        load_dotenv()

    app_password = os.getenv("APP_PASSWORD")
    sender_email = os.getenv("SENDER_EMAIL")
    excluded = _parse_exclusion_list(os.getenv("EMAIL_EXCLUDE_LIST"))

    if not app_password:
        raise ValueError("APP_PASSWORD is not set in .env")
    if not sender_email:
        raise ValueError("SENDER_EMAIL is not set in .env")
    sender_email = sender_email.strip()
    if not EMAIL_RE.fullmatch(sender_email):
        raise ValueError("SENDER_EMAIL is not a valid email address.")

    if path is None:
        try:
            import github_writer
            from content_reader import read_current_content

            # Approval happens only after Content.txt has already been verified
            # for the current AAVA attempt. Read it again here so email delivery
            # always consumes the GitHub source of truth rather than a stale local file.
            data = read_current_content(github_writer.repo, log=lambda msg: _log(msg))
            source_name = "Content/Content.txt"
        except Exception as exc:
            raise ValueError(f"Unable to read approved GitHub Content.txt: {exc}") from exc
    else:
        data = load_approved_output(path)
        source_name = str(path)

    records = extract_email_records(data, excluded)
    _log(f"[EMAIL] Loaded {len(records)} valid, non-excluded recipient(s) from {source_name}.")

    success_count = 0
    failure_count = 0
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as smtp:
        _log("[EMAIL] Connecting to Gmail SMTP...")
        smtp.ehlo()
        smtp.starttls()
        smtp.ehlo()
        smtp.login(sender_email, app_password)
        _log("[EMAIL] SMTP authentication successful.")

        for index, email_data in enumerate(records, start=1):
            recipient = email_data["mail_id"]
            _log(f"[EMAIL] Sending {index}/{len(records)} to {recipient}")
            msg = EmailMessage()
            msg["From"] = sender_email
            msg["To"] = recipient
            msg["Subject"] = email_data["subject"]
            msg.set_content(email_data["content"])
            try:
                smtp.send_message(msg)
                success_count += 1
                _log(f"[EMAIL] Sent successfully to {recipient}")
            except Exception as exc:
                failure_count += 1
                _log(f"[EMAIL] Failed to send to {recipient}: {exc}")

    _log(f"[EMAIL] Completed: {success_count} sent, {failure_count} failed.")
    if failure_count:
        raise RuntimeError(f"Email delivery completed with {failure_count} failure(s).")
    return success_count, failure_count


def main() -> int:
    parser = argparse.ArgumentParser(description="Send approved marketing emails.")
    parser.add_argument("--output", default=None, help="Optional local approved marketing JSON path (GitHub Content.txt is the default)")
    args = parser.parse_args()
    try:
        send_approved_emails(Path(args.output).resolve() if args.output else None)
    except Exception as exc:
        _log(f"[EMAIL] ERROR: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
