import os
import pandas as pd
from sqlalchemy import create_engine, inspect

# ----------------------------------------------------------------
# Database connection: read from the environment only. This var is
# explicitly passed through to this subprocess by
# src/services/marketingRunner.js (via config/env.js marketingScriptEnv) --
# it is intentionally a *different* variable from the app's own
# DATABASE_URL, and is never read from that.
# See .env.example / README.md for how to set it.
# ----------------------------------------------------------------
DATABASE_URI = os.environ.get("MARKETING_DATABASE_URI")
if not DATABASE_URI:
    raise RuntimeError(
        "MARKETING_DATABASE_URI is not set. Add it to your .env "
        "(see .env.example) -- this script no longer accepts a "
        "hardcoded connection string."
    )

OUTPUT_DIR = './database_export/'

# Columns that must never leave the database, even into this pipeline's
# own export directory / GitHub sync. Keyed by table name.
SENSITIVE_COLUMNS = {
    "users": {"password_hash"},
}


def _drop_sensitive_columns(table: str, df: pd.DataFrame) -> pd.DataFrame:
    columns_to_drop = SENSITIVE_COLUMNS.get(table, set()) & set(df.columns)
    if columns_to_drop:
        print(f"  Redacting columns from '{table}' export: {sorted(columns_to_drop)}")
        df = df.drop(columns=list(columns_to_drop))
    return df


def audit_filter(engine):
    table = "audit_logs"

    try:
        query = f""" 
    SELECT *
    FROM {table}
    WHERE event_type IN (
        'PRODUCT_VIEW',
        'ADD_TO_CART',
        'UPDATE_CART',
        'REMOVE_FROM_CART'
    );
        """

        df = pd.read_sql_query(query, con=engine)

        csv_file_path = os.path.join(
            OUTPUT_DIR,
            "audit_logs_product_views.csv"
        )

        df.to_csv(csv_file_path, index=False)

        print(f"Success! Exported {len(df)} PRODUCT_VIEW records.")

    except Exception as e:
        print(f"Failed! Error: {e}")


def export_all_tables_to_csv():
    # Create database engine connection
    engine = create_engine(DATABASE_URI)

    # Rebuild the generated CSV snapshot from scratch so stale exports cannot
    # be uploaded as if they were part of the latest database snapshot.
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        print(f"Created directory: {OUTPUT_DIR}")
    else:
        for filename in os.listdir(OUTPUT_DIR):
            path = os.path.join(OUTPUT_DIR, filename)
            if os.path.isfile(path) and filename.lower().endswith(".csv"):
                os.remove(path)
                print(f"Removed stale CSV export: {filename}")

    # Use SQLAlchemy inspector to safely fetch all table names
    inspector = inspect(engine)
    table_names = inspector.get_table_names()
    table_names = [
        t for t in table_names
        if t not in ('audit_logs', 'campaign_execution_time')
    ]
    print(f"Found {len(table_names)} tables to export.")
    audit_filter(engine)
    # Loop through each table and dump to CSV
    for table in table_names:
        print(f"Exporting table: {table}...", end="", flush=True)
        try:
            # Query the entire table into a Pandas DataFrame
            query = f"SELECT * FROM {table}"
            df = pd.read_sql_query(query, con=engine)
            df = _drop_sensitive_columns(table, df)

            # Define output path
            csv_file_path = os.path.join(OUTPUT_DIR, f"{table}.csv")

            # Export to CSV without the index column
            df.to_csv(csv_file_path, index=False)
            print(" Success!")

        except Exception as e:
            print(f" Failed! Error: {e}")

    print("\nDatabase export completed completely.")

if __name__ == "__main__":
    export_all_tables_to_csv()
