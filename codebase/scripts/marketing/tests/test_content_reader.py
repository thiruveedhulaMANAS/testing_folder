import base64
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import content_reader
from content_reader import parse_content_bytes


def test_parses_single_json_object_without_escaping_newlines():
    payload = b'{"email":{"email_address":"one@example.com","body":"Hello\\n\\nWorld","subject":"Hi"}}'
    result = parse_content_bytes(payload)
    assert result["email"]["body"] == "Hello\n\nWorld"


def test_parses_adjacent_content_txt_json_objects():
    payload = (
        b'{"customer_id":"1","email":{"email_address":"one@example.com","subject":"One","body":"Hi"}}\n'
        b'{"customer_id":"2","email":{"email_address":"two@example.com","subject":"Two","body":"Hi"}}\n'
    )
    result = parse_content_bytes(payload)
    assert isinstance(result, list)
    assert [item["customer_id"] for item in result] == ["1", "2"]


def test_reader_uses_exact_configured_github_path(monkeypatch):
    monkeypatch.setattr(content_reader, "CONTENT_PATH", "Content/Content.txt")
    calls = []

    class Item:
        sha = "ignored"
        type = "file"
        content = base64.b64encode(
            b'{"customer_id":"1","email":{"email_address":"one@example.com","subject":"Hi","body":"Hello"}}'
        ).decode()

    class Repo:
        default_branch = "main"

        def get_contents(self, path, ref):
            calls.append((path, ref))
            return Item()

    result = content_reader.read_latest_content_after_success(Repo())
    assert result["customer_id"] == "1"
    assert calls == [("Content/Content.txt", "main")]


def test_reader_does_not_require_freshness_or_commit_metadata(monkeypatch):
    monkeypatch.setattr(content_reader, "POLL_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(content_reader, "CONTENT_PATH", "Content/Content.txt")

    class Item:
        type = "file"
        content = base64.b64encode(
            b'{"customer_id":"existing","email":{"email_address":"one@example.com","subject":"Hi","body":"Hello"}}'
        ).decode()

    class Repo:
        default_branch = "main"

        def get_contents(self, path, ref):
            return Item()

    # An existing file is accepted immediately. No commit API or timestamp
    # is needed to establish freshness.
    result = content_reader.read_latest_content_after_success(Repo())
    assert result["customer_id"] == "existing"


def test_reader_waits_only_when_file_is_not_yet_available(monkeypatch):
    monkeypatch.setattr(content_reader, "POLL_INTERVAL_SECONDS", 0)
    calls = {"count": 0}

    class Item:
        type = "file"
        content = base64.b64encode(
            b'{"customer_id":"new","email":{"email_address":"two@example.com","subject":"Hi","body":"Hello"}}'
        ).decode()

    class Repo:
        default_branch = "main"

        def get_contents(self, path, ref):
            calls["count"] += 1
            if calls["count"] == 1:
                error = RuntimeError("Not Found")
                error.status = 404
                raise error
            return Item()

    result = content_reader.read_latest_content_after_success(Repo())
    assert result["customer_id"] == "new"
    assert calls["count"] == 2
