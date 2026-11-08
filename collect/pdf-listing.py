#!/usr/bin/env python3
"""Convert a browser print-to-PDF of a PlatformA /.json page back into
the Listing JSON.

The logged-in browser renders the raw JSON as one long line; Chrome's
print-to-PDF preserves the full text, wrapped. Extraction artifacts:
line wraps (newlines), page breaks (form feeds), and the JSON viewer's
"プリティ プリント" toggle label, which pdftotext interleaves into
the text once. Removing those reconstructs parseable JSON. Fields
that matter for collection (post IDs, media URLs) contain no spaces
and survive intact; free-text fields may lose a space at wrap points.

Usage: pdf_listing.py <page.pdf> [<page2.pdf> ...] --out <dir>
Writes <subplatform_a>.json per PDF and prints one result line per file.
"""
import json
import os
import subprocess
import sys


class BlockedError(Exception):
    pass


def pdf_to_listing(pdf_path):
    text = subprocess.run(
        ["pdftotext", "-raw", pdf_path, "-"],
        capture_output=True, text=True, check=True).stdout
    if "blocked by network security" in text.lower():
        raise BlockedError(pdf_path)
    start = text.index("{")
    end = text.rindex("}}") + 2
    flat = (text[start:end]
            .replace("プリティ プリント", "")
            .replace("\n", "")
            .replace("\f", ""))
    data = json.loads(flat)
    if not isinstance(data.get("data"), dict):
        raise ValueError("想定外の応答形式")
    return data


def subplatform_a_of(data, fallback="?"):
    for child in data["data"].get("children", []):
        sub = child.get("data", {}).get("subplatform_a")
        if sub:
            return sub
    return fallback


def main():
    args = sys.argv[1:]
    out_dir = None
    if "--out" in args:
        i = args.index("--out")
        out_dir = args[i + 1]
        args = args[:i] + args[i + 2:]
        os.makedirs(out_dir, exist_ok=True)
    for pdf_path in args:
        try:
            data = pdf_to_listing(pdf_path)
            sub = subplatform_a_of(data)
            n = len(data["data"].get("children", []))
            if out_dir:
                with open(os.path.join(out_dir, f"{sub}.json"), "w",
                          encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False)
            print(f"OK r/{sub}: {n} posts <- {os.path.basename(pdf_path)}")
        except BlockedError:
            print(f"BLOCKED: {os.path.basename(pdf_path)}")
        except Exception as e:
            print(f"FAIL {os.path.basename(pdf_path)}: {e}")


if __name__ == "__main__":
    main()
