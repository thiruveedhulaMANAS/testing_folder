from pathlib import Path
from datetime import datetime
import time


DATABASE_DIR = Path("database_export")
TIMEFRAME_MINUTES = 5

# Define the files that are expected to be present
EXPECTED_FILES = {
    'audit_logs_product_views.csv', 'carts.csv', 'cart_items.csv', 'categories.csv',
    'orders.csv', 'order_items.csv', 'products.csv', 'users.csv', 'campaign_details.txt'
}

RECENT_CHECK_FILES = EXPECTED_FILES - {'campaign_details.txt'}


def is_file_recent(file_path: Path, minutes: int = TIMEFRAME_MINUTES) -> bool:
    """
    Check whether a file was modified within the specified timeframe.
    """
    try:
        modified_time = file_path.stat().st_mtime
        current_time = time.time()

        age_seconds = current_time - modified_time
        timeframe_seconds = minutes * 60

        return 0 <= age_seconds <= timeframe_seconds

    except OSError as exc:
        print(f"[file update check] Failed to check '{file_path}': {exc}")
        return False


def check_file_count() -> bool:
    """
    Check whether all expected files are present.

    Returns:
        True if all expected files are present.
        False if one or more files are missing.
    """

    if not DATABASE_DIR.is_dir():
        print(
            f"[file count check] Directory does not exist: "
            f"{DATABASE_DIR}"
        )
        return False

    actual_files = {
        file_path.name
        for file_path in DATABASE_DIR.iterdir()
        if file_path.is_file()
    }

    missing_files = EXPECTED_FILES - actual_files

    if missing_files:
        print(
            f"[file count check] ERROR: "
            f"{len(missing_files)} file(s) missing."
        )

        for file_name in sorted(missing_files):
            print(f"Missing file: {file_name}")

        return False

    print(
        f"[file count check] SUCCESS: "
        f"All {len(EXPECTED_FILES)} expected files are present."
    )

    return True


def check_file_updates() -> bool:
    """
    Check whether all expected files were modified within
    the specified timeframe.
    """

    all_files_valid = True

    for file_name in RECENT_CHECK_FILES:
        file_path = DATABASE_DIR / file_name

        if not file_path.is_file():
            # Already handled by check_file_count()
            continue

        if is_file_recent(file_path):
            modified_time = datetime.fromtimestamp(
                file_path.stat().st_mtime
            )

            print(
                f"VALID | {file_name} | "
                f"Last modified: "
                f"{modified_time:%Y-%m-%d %H:%M:%S}"
            )

        else:
            print(
                f"INVALID | {file_name} | "
                f"File was not modified within the last "
                f"{TIMEFRAME_MINUTES} minutes"
            )

            all_files_valid = False

    return all_files_valid


def main() -> bool:
    """
    Run file count and file update validation.
    """

    if not DATABASE_DIR.exists():
        print(
            f"[file checker] ERROR: "
            f"Directory does not exist: {DATABASE_DIR}"
        )
        return False

    # 1. Check expected file count / missing files
    file_count_valid = check_file_count()

    if not file_count_valid:
        return False

    # 2. Check modification time
    file_update_valid = check_file_updates()

    if not file_update_valid:
        return False

    print("[file checker] SUCCESS: All file checks passed.")

    return True


if __name__ == "__main__":
    success = main()

    if not success:
        raise SystemExit(1)