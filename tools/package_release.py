"""Build and verify a Foundry release: python tools/package_release.py."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[1]


def build():
    manifest_bytes = (ROOT / "module.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    module_id, version = manifest["id"], manifest["version"]
    assert re.fullmatch(r"[a-z0-9-]+", module_id), "Invalid module ID"
    assert re.fullmatch(r"\d+\.\d+\.\d+", version), "Expected a semantic version"
    base = manifest["url"]
    archive_name = f"{module_id}-{version}.zip"
    assert manifest["manifest"] == f"{base}/releases/latest/download/module.json"
    assert manifest["download"] == f"{base}/releases/download/v{version}/{archive_name}"
    assert manifest["authors"] and manifest["compatibility"]["verified"]
    for key in ("url", "bugs", "changelog", "manifest", "download"):
        assert manifest[key].startswith("https://"), key
    for filename in [manifest["license"], manifest["readme"], *manifest["esmodules"], *manifest["styles"]]:
        assert (ROOT / filename).is_file(), f"Missing manifest file: {filename}"

    files = [ROOT / "module.json", ROOT / "README.md", ROOT / "LICENSE"]
    for folder in ("scripts", "styles", "templates", "assets"):
        files.extend(path for path in (ROOT / folder).rglob("*") if path.is_file())
    for path in files:
        assert not path.is_symlink(), f"Unexpected symlink: {path}"
        if path.suffix == ".mjs":
            for imported in re.findall(r'''from\s+["'](\.[^"']+)["']''', path.read_text()):
                assert (path.parent / imported).is_file(), f"Missing import: {imported}"

    release_dir = ROOT / "releases" / version
    release_dir.mkdir(parents=True, exist_ok=True)
    archive = release_dir / archive_name
    with ZipFile(archive, "w", ZIP_DEFLATED) as package:
        for path in sorted(files):
            # Stable timestamps and permissions make repeat builds byte-for-byte reproducible.
            info = ZipInfo(f"{module_id}/{path.relative_to(ROOT).as_posix()}", (2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            package.writestr(info, path.read_bytes())
    with ZipFile(archive) as package:
        assert package.testzip() is None
        assert len(package.namelist()) == len(files)
        for path in files:
            assert package.read(f"{module_id}/{path.relative_to(ROOT).as_posix()}") == path.read_bytes()
        assert package.read(f"{module_id}/module.json") == manifest_bytes
    (release_dir / "module.json").write_bytes(manifest_bytes)
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    (release_dir / f"{archive_name}.sha256").write_text(f"{checksum}  {archive_name}\n")
    print(f"Verified {module_id} {version}: {len(files)} files")
    print(archive)
    print(f"SHA256: {checksum}")


if __name__ == "__main__":
    build()
