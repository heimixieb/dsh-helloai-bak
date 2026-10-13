/**
 * Regression: a `file:` dependency pointing at a packed tarball OUTSIDE DSH_HOME
 * must travel through the archive as a FILE.
 *
 * declaredLinks() used to record every declared link:/file: spec with the literal
 * kind "directory". A .tgz carries no package.json, so discoverPlugins()
 * classified the plugin as a directory and packagePluginPayload() read the
 * tarball through collectDirectoryWithStats(): the file's relative name came out
 * empty and was prefixed into "external/NNN-<slug>/" — a trailing-slash
 * (directory) entry holding the tarball bytes. Every ZIP reader treats that entry
 * as a directory and discards the data, so restore recreated an empty directory
 * and the tarball was silently lost.
 *
 * Usage: node test-file-plugin.mjs
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "./lib/zip.js";

const sandbox = await mkdtemp(join(tmpdir(), "helloai-file-plugin-"));
const outside = await mkdtemp(join(tmpdir(), "helloai-file-payload-"));
const name = "fixture-plugin-1.0.0.tgz";
const tarball = join(outside, name);
// gzip magic + filler: the archiver never opens the tarball, it only moves bytes.
const payload = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.alloc(4096, 0x42)]);
await writeFile(tarball, payload);

try {
  await mkdir(join(sandbox, "profiles", "desktop"), { recursive: true });
  await writeFile(join(sandbox, "profiles", "desktop", "package.json"), JSON.stringify({
    name: "dsh-profile-desktop",
    private: true,
    dependencies: { "@fixture/tarball-plugin": `file:${tarball.replace(/\\/g, "/")}` },
    dsh: { profile: { bundles: [] } },
  }, null, 2) + "\n");

  process.env.DSH_HOME = sandbox;
  const { makeBackup } = await import("./lib/index.js");
  const made = await makeBackup();

  const filePlugins = made.manifest.plugins.filter((plugin) => plugin.kind === "file");
  assert.equal(filePlugins.length, 1, `expected exactly one file-kind plugin, got ${filePlugins.length}`);
  const plugin = filePlugins[0];
  assert.ok(plugin.source.endsWith(name), `source should be the tarball, got ${plugin.source}`);
  assert.equal(plugin.status, "packed", `expected packed, got ${plugin.status}: ${plugin.reason || ""}`);
  assert.equal(plugin.fileCount, 1, "a tarball is one file");
  assert.equal(plugin.bytes, payload.byteLength);
  assert.equal(plugin.runtimeDependencies.length, 0, "a tarball has no node_modules to vendor");

  const external = made.manifest.externalRoots.find((item) => item.source === plugin.source);
  assert.equal(external?.kind, "file", "externalRoots must record the tarball as a file");
  assert.equal(made.manifest.plugins.filter((item) => item.status === "packed").length, 1, "only the tarball is packed");

  const entries = unzipSync(made.archive);
  const inside = entries.filter(({ entry }) => entry.name.startsWith(`${plugin.archive}/`));
  const files = inside.filter(({ entry }) => !entry.name.endsWith("/"));
  assert.equal(files.length, 1, `expected one payload entry under ${plugin.archive}/, got ${files.length}`);
  assert.equal(files[0].entry.name, `${plugin.archive}/payload.tgz`);
  assert.equal(files[0].data.byteLength, payload.byteLength, "the whole tarball must be in the archive");
  assert.ok(Buffer.from(files[0].data).equals(payload), "payload bytes must be the tarball itself");
  for (const { entry, data } of inside.filter(({ entry }) => entry.name.endsWith("/"))) {
    assert.equal(data.byteLength, 0, `${entry.name} is a directory entry and must not carry the tarball bytes`);
  }

  console.log(`file-plugin regression passed: ${plugin.archive}/payload.tgz (${payload.byteLength} bytes, kind=${plugin.kind})`);
} finally {
  await rm(sandbox, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
