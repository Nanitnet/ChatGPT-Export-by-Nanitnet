import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = JSON.parse(await readFile(join(root, "extension/manifest.json"), "utf8")).version;
const archives = [`chatgpt-local-export-firefox-${version}.zip`, `chatgpt-local-export-chrome-${version}.zip`, "chatgpt-local-export-source.zip"];
const tripwire = `PUBLICATION_TRIPWIRE_${randomBytes(24).toString("hex")}`;

// These checks exercise the actual ZIP writer, including nested source archives.
test("release ZIPs exclude local files and stale output; repeat builds are identical; source symlinks fail closed", async () => {
  const work = await mkdtemp(join(tmpdir(), "nanitnet-package-"));
  try {
    for (const name of [".gitignore", "README.md", "THIRD_PARTY_NOTICES.md", "package.json", "extension", "scripts", "tests", "docs"]) {
      await cp(join(root, name), join(work, name), { recursive: true, filter: (path) => !path.split(/[\\/]/).includes("__pycache__") });
    }
    await mkdir(join(work, "dist/firefox"), { recursive: true });
    await mkdir(join(work, "test-results"));
    for (const name of [".env", "extension/local-config.json", "scripts/private.txt", "tests/.env", "test-results/local.log", "dist/firefox/stale-token.txt"]) {
      await writeFile(join(work, name), tripwire);
    }
    const build = () => spawnSync("python3", ["scripts/package.py"], { cwd: work, encoding: "utf8" });
    const first = build();
    assert.equal(first.status, 0, first.stderr);
    const inspect = spawnSync("python3", ["-c", `
import hashlib, pathlib, zipfile
root=pathlib.Path('dist')
for archive in root.glob('*.zip'):
    with zipfile.ZipFile(archive) as z:
        assert all(not name.endswith(('.env', '.log', 'local-config.json', 'private.txt', 'stale-token.txt')) for name in z.namelist())
        assert all(b'${tripwire}' not in z.read(name) for name in z.namelist())
for line in (root/'SHA256SUMS').read_text().splitlines():
    digest,name=line.split()
    assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest
`], { cwd: work, encoding: "utf8" });
    assert.equal(inspect.status, 0, inspect.stderr);
    const hash = async (name) => createHash("sha256").update(await readFile(join(work, "dist", name))).digest("hex");
    const before = await Promise.all(archives.map(hash));
    const second = build();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(await Promise.all(archives.map(hash)), before);
    await unlink(join(work, "extension/api-job.js"));
    await symlink(join(work, ".env"), join(work, "extension/api-job.js"));
    const unsafe = build();
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /Refusing source symlink/);
    assert.deepEqual(await Promise.all(archives.map(hash)), before, "Rejected inputs must not replace existing releases");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
