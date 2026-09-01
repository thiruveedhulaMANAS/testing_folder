import base64
import hashlib
import json
import os
from pathlib import Path

from github import Github, Auth, GithubException


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Add it to your .env (see .env.example).")
    return value


ACCESS_TOKEN = _require_env("GITHUB_PAT")
auth = Auth.Token(ACCESS_TOKEN)
g = Github(auth=auth)
repo_owner = _require_env("GITHUB_REPO_OWNER")
REPO_NAME = os.environ.get("GITHUB_REPO_NAME", "testing_folder")
REPO_DIR = "database_export"
CAMPAIGN_FILE = "campaign_details.txt"
LOCAL_DIR = Path.cwd() / REPO_DIR
repo = g.get_repo(f"{repo_owner}/{REPO_NAME}")


def _default_branch(repo):
    branch = getattr(repo, "default_branch", None)
    if not branch:
        raise RuntimeError("GitHub repository default branch could not be determined.")
    return branch


def _github_files(repo, branch):
    files = set()
    try:
        contents = repo.get_contents(REPO_DIR, ref=branch)
    except GithubException as exc:
        if exc.status == 404:
            return files
        raise

    def scan(items):
        for item in items:
            if item.type == "dir":
                scan(repo.get_contents(item.path, ref=branch))
            elif item.type == "file":
                files.add(item.path)

    scan(contents)
    return files


def _local_export_files():
    if not LOCAL_DIR.is_dir():
        raise RuntimeError(f"Database export directory not found: {LOCAL_DIR}")

    files = sorted(
        path for path in LOCAL_DIR.iterdir()
        if path.is_file() and (path.suffix.lower() == ".csv" or path.name == CAMPAIGN_FILE)
    )

    if not files:
        raise RuntimeError(f"No CSV or campaign TXT files found in {LOCAL_DIR}")

    csv_files = [path for path in files if path.suffix.lower() == ".csv"]
    campaign_file = LOCAL_DIR / CAMPAIGN_FILE
    if not campaign_file.is_file():
        raise RuntimeError(f"Campaign TXT not found: {campaign_file}")
    if not csv_files:
        raise RuntimeError(f"No database CSV files found in {LOCAL_DIR}")

    return files


def _github_file_bytes(repo, github_path, branch):
    item = repo.get_contents(github_path, ref=branch)
    if isinstance(item, list):
        raise RuntimeError(f"Expected GitHub file but found directory: {github_path}")
    try:
        return base64.b64decode(item.content.replace("\n", ""))
    except Exception as exc:
        raise RuntimeError(f"Unable to decode GitHub file {github_path}: {exc}") from exc


def _upsert_file(repo, local_path: Path, branch):
    github_path = f"{REPO_DIR}/{local_path.name}"
    content = local_path.read_bytes()

    if not content:
        raise RuntimeError(f"Export file is empty: {local_path}")

    try:
        existing = repo.get_contents(github_path, ref=branch)
        if isinstance(existing, list):
            raise RuntimeError(f"GitHub path is a directory, expected file: {github_path}")
        repo.update_file(
            github_path,
            f"Update {local_path.name}",
            content,
            existing.sha,
            branch=branch,
        )
        print(f"Updated: {github_path} (branch={branch})")
    except GithubException as exc:
        if exc.status != 404:
            raise
        repo.create_file(
            github_path,
            f"Add {local_path.name}",
            content,
            branch=branch,
        )
        print(f"Created: {github_path} (branch={branch})")


def _delete_obsolete_files(repo, expected_paths, branch):
    existing_paths = _github_files(repo, branch)
    for path in sorted(existing_paths - expected_paths, reverse=True):
        item = repo.get_contents(path, ref=branch)
        if isinstance(item, list):
            continue
        repo.delete_file(
            path,
            f"Remove obsolete marketing export {Path(path).name}",
            item.sha,
            branch=branch,
        )
        print(f"Deleted obsolete: {path} (branch={branch})")


def _verify_uploaded_files(repo, local_files, branch):
    expected = {f"{REPO_DIR}/{path.name}" for path in local_files}
    actual = _github_files(repo, branch)
    if actual != expected:
        raise RuntimeError(
            "GitHub validation failed. "
            f"Expected {sorted(expected)}, found {sorted(actual)} on branch '{branch}'"
        )

    for local_path in local_files:
        github_path = f"{REPO_DIR}/{local_path.name}"
        local_bytes = local_path.read_bytes()
        remote_bytes = _github_file_bytes(repo, github_path, branch)
        if hashlib.sha256(local_bytes).digest() != hashlib.sha256(remote_bytes).digest():
            raise RuntimeError(
                f"GitHub content verification failed for {github_path} on branch '{branch}'"
            )


def sync_campaign_file(repo):
    """Upload the latest database CSV exports and campaign TXT to GitHub.

    marketing_output.json is intentionally excluded and remains local.
    """
    branch = _default_branch(repo)
    local_files = _local_export_files()
    expected = {f"{REPO_DIR}/{path.name}" for path in local_files}

    print(f"GitHub sync target: {repo.full_name}@{branch}")
    print(f"Local export directory: {LOCAL_DIR}")
    print(f"Files to upload: {len(local_files)}")

    for local_path in local_files:
        _upsert_file(repo, local_path, branch)

    _delete_obsolete_files(repo, expected, branch)
    _verify_uploaded_files(repo, local_files, branch)

    csv_count = sum(path.suffix.lower() == ".csv" for path in local_files)
    print(
        "GitHub validation passed: "
        f"{csv_count} CSV file(s) and {CAMPAIGN_FILE} are uploaded and content-verified "
        f"on branch '{branch}'. marketing_output.json is excluded."
    )


if __name__ == "__main__":
    sync_campaign_file(repo)


