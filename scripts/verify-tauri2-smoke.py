#!/usr/bin/env python3
"""Launch the built Tauri 2 probe against disposable v1-shaped data on macOS."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory

APP_ID = "com.cup-translate.app"
EXPECTED = {
    f"Tauri 2 identifier: {APP_ID}",
    "smoke: Tauri 2 IPC: allowed",
    "unprivileged: Tauri 2 IPC: denied",
}


def snapshot(config_dir):
    return {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in config_dir.iterdir()
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("the disposable config layout in this check is for macOS")
    binary = args.binary.resolve(strict=True)

    with TemporaryDirectory(prefix="cup-tauri2-fixture-") as temp:
        home = Path(temp, "home")
        webview_temp = Path(temp, "tmp")
        webview_temp.mkdir()
        config_dir = home / "Library" / "Application Support" / APP_ID
        config_dir.mkdir(parents=True)
        (config_dir / "config.json").write_text(
            json.dumps({"app_language": "zh_cn", "check_update": False}) + "\n",
            encoding="utf-8",
        )
        db = sqlite3.connect(config_dir / "history.db")
        try:
            db.execute(
                "CREATE TABLE history(id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "text TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, "
                "service TEXT NOT NULL, result TEXT NOT NULL, timestamp INTEGER NOT NULL)"
            )
            db.executemany(
                "INSERT INTO history(text, source, target, service, result, timestamp) "
                "VALUES (?, 'en', 'zh_cn', 'fixture', ?, 1794448800000)",
                [("fixture alpha", "隔离历史甲"), ("fixture beta", "隔离历史乙")],
            )
            db.commit()
        finally:
            db.close()

        before = snapshot(config_dir)
        result = subprocess.run(
            [binary, "--automated"],
            env={**os.environ, "HOME": str(home), "TMPDIR": str(webview_temp)},
            capture_output=True,
            text=True,
            timeout=35,
        )
        print(result.stdout, end="")
        print(result.stderr, end="", file=sys.stderr)
        result.check_returncode()
        if missing := EXPECTED - set(result.stdout.splitlines()):
            raise SystemExit(f"Missing smoke output: {sorted(missing)}")
        if before != snapshot(config_dir):
            raise SystemExit("The probe changed the isolated config or history")
        print("Synthetic v1 config and history hashes unchanged")


if __name__ == "__main__":
    main()
