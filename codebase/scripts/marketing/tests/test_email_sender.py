import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from email_sender import extract_email_records, load_approved_output


def test_extracts_nested_email_address_and_excludes_configured_recipients():
    data = [
        {"customer_id": "1", "email": {"email_address": "one@example.com", "subject": "One", "body": "Hi one"}},
        {"customer_id": "2", "email": {"email_address": "tiffanydominguez@example.org", "subject": "Skip", "body": "Skip"}},
        {"customer_id": "3", "email": {"email_address": "[bad](mailto:bad@example.com)", "subject": "Bad", "body": "Bad"}},
        {"customer_id": "4", "email": {"email_address": "two@example.com", "subject": "Two", "body": "Hi two"}},
    ]
    assert extract_email_records(data, {"tiffanydominguez@example.org"}) == [
        {"mail_id": "one@example.com", "content": "Hi one", "subject": "One"},
        {"mail_id": "two@example.com", "content": "Hi two", "subject": "Two"},
    ]


def test_loads_adjacent_json_objects(tmp_path):
    path = tmp_path / "Content.txt"
    path.write_text(
        '{"customer_id":"1","email":{"email_address":"one@example.com","subject":"One","body":"Hi"}}\n'
        '{"customer_id":"2","email":{"email_address":"two@example.com","subject":"Two","body":"Hi"}}\n',
        encoding="utf-8",
    )
    data = load_approved_output(path)
    assert isinstance(data, list)
    assert len(data) == 2


def test_loads_legacy_agent_output(tmp_path):
    path = tmp_path / "marketing_output.json"
    path.write_text(json.dumps({"agent_outputs": [{"content": {"mail_id": "one@example.com", "subject": "One", "content": "Hi"}}]}), encoding="utf-8")
    data = load_approved_output(path)
    assert extract_email_records(data) == [{"mail_id": "one@example.com", "content": "Hi", "subject": "One"}]


def test_send_approved_emails_sends_only_non_excluded_valid_records(tmp_path, monkeypatch):
    import email_sender

    output = tmp_path / "Content.txt"
    output.write_text(
        json.dumps([
            {"email": {"email_address": "one@example.com", "subject": "One", "body": "Hello one"}},
            {"email": {"email_address": "blocked@example.org", "subject": "Blocked", "body": "Do not send"}},
            {"email": {"email_address": "two@example.com", "subject": "Two", "body": "Hello two"}},
        ]),
        encoding="utf-8",
    )
    monkeypatch.setenv("APP_PASSWORD", "test-password")
    monkeypatch.setenv("SENDER_EMAIL", "sender@example.com")
    monkeypatch.setenv("EMAIL_EXCLUDE_LIST", "blocked@example.org")

    sent = []

    class FakeSMTP:
        def __init__(self, host, port, timeout):
            assert (host, port, timeout) == ("smtp.gmail.com", 587, 20)
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def ehlo(self): pass
        def starttls(self): pass
        def login(self, sender, password):
            assert sender == "sender@example.com"
            assert password == "test-password"
        def send_message(self, msg): sent.append((msg["To"], msg["Subject"], msg.get_content().strip()))

    monkeypatch.setattr(email_sender.smtplib, "SMTP", FakeSMTP)
    assert email_sender.send_approved_emails(output) == (2, 0)
    assert [item[0] for item in sent] == ["one@example.com", "two@example.com"]
