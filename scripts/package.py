"""Package only reviewed files, with deterministic metadata and no network."""
import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extension"
DIST = ROOT / "dist"
# Permanent public identity. Keep it unchanged after registration/signing on AMO.
FIREFOX_ADDON_ID = "{472cb22c-c88d-4fc9-92b8-9141fa5db431}"
RUNTIME_FILES = (
    "api-format.js", "api-job.js", "collector.js", "diagnostics.js", "format.js",
    "job.js", "manifest.json", "popup.css", "popup.html", "popup.js",
    "inter-cyrillic-wght-normal.woff2", "inter-latin-wght-normal.woff2",
    "Inter-OFL.txt", "Lucide-LICENSE.txt",
)
# Explicit publication inventory. Local files, logs, profiles and credentials
# cannot enter a source archive merely by being placed beside these files.
SOURCE_FILES = (
    ".gitignore", "README.md", "THIRD_PARTY_NOTICES.md", "package.json",
    "scripts/package.py", "tests/package.test.js", "tests/api.test.js",
    "tests/format.test.js", "tests/browser.mjs", "tests/long-chat.mjs",
    "tests/api-investigation.mjs", "tests/firefox-api.py", "tests/firefox-e2e.py",
    "tests/firefox-live.py", "tests/firefox-long.py", "tests/fixture.html",
    "tests/fixture-modern.html", "tests/fixture-octane.html", "tests/fixture-large.html",
    "docs/screenshots/dark.png", "docs/screenshots/light.png",
) + tuple(f"extension/{name}" for name in RUNTIME_FILES)


def reviewed_file(relative):
    """Do not let a source symlink pull an unrelated host file into a release."""
    path = ROOT / relative
    parts = Path(relative).parts
    if any(ROOT.joinpath(*parts[:index]).is_symlink() for index in range(1, len(parts) + 1)):
        raise ValueError(f"Refusing source symlink: {relative}")
    if not path.is_file():
        raise FileNotFoundError(f"Missing reviewed source file: {relative}")
    return path


def write_entry(output, name, data):
    info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    output.writestr(info, data)


def main():
    # Validate all inputs before replacing any release artifacts.
    sources = {name: reviewed_file(name) for name in SOURCE_FILES}
    manifest = json.loads(sources["extension/manifest.json"].read_text())
    version = manifest["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Expected a three-part numeric extension version")
    DIST.mkdir(parents=True, exist_ok=True)
    releases = []
    for browser in ("chrome", "firefox"):
        destination = DIST / browser
        destination.mkdir(parents=True, exist_ok=True)
        for name in RUNTIME_FILES:
            shutil.copyfile(sources[f"extension/{name}"], destination / name)
        if browser == "firefox":
            firefox_manifest = dict(manifest)
            firefox_manifest.pop("minimum_chrome_version", None)
            firefox_manifest["browser_specific_settings"] = {"gecko": {
                "id": FIREFOX_ADDON_ID,
                "strict_min_version": "140.0",
                # Page authorization is sent only back to chatgpt.com.
                "data_collection_permissions": {"required": ["authenticationInfo"]},
            }}
            (destination / "manifest.json").write_text(
                json.dumps(firefox_manifest, ensure_ascii=False, indent=2) + "\n"
            )
        archive = DIST / f"chatgpt-local-export-{browser}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
            for name in sorted(RUNTIME_FILES):
                write_entry(output, name, (destination / name).read_bytes())
        versioned = archive.with_name(f"chatgpt-local-export-{browser}-{version}.zip")
        shutil.copyfile(archive, versioned)
        releases.append(versioned)
        print(archive)
        print(versioned)

    archive = DIST / "chatgpt-local-export-source.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
        for name in sorted(SOURCE_FILES):
            write_entry(output, f"chatgpt-local-export/{name}", sources[name].read_bytes())
    releases.append(archive)
    print(archive)
    checksums = DIST / "SHA256SUMS"
    checksums.write_text("".join(
        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n"
        for path in releases
    ))
    print(checksums)


if __name__ == "__main__":
    main()
