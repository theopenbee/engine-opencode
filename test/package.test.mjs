import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));

test("manifest describes the opencode engine", () => {
  assert.deepEqual(readJson("openbee.plugin.json"), {
    protocol_version: 1,
    type: "engine",
    id: "opencode",
    name: { en: "OpenCode", zh: "OpenCode" },
    description: { en: "Runs tasks with OpenCode", zh: "用 OpenCode 执行任务" },
    command: ["node", "dist/index.js"],
    config: [
      {
        key: "path",
        type: "string",
        label: { en: "OpenCode path", zh: "OpenCode 路径" },
        help: { en: "Leave empty to use opencode on PATH or in ~/.opencode/bin", zh: "留空则使用 PATH 或 ~/.opencode/bin 里的 opencode" },
      },
    ],
  });
});

test("package.json publishes dist and the manifest", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg.name, "@theopenbee/engine-opencode");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.deepEqual(pkg.files, ["dist", "openbee.plugin.json"]);
  assert.equal(pkg.engines.node, ">=20");
  assert.equal(pkg.scripts.prepare, "npm run build");
  assert.equal(pkg.dependencies["@theopenbee/engine-sdk"], "^0.2.0");
  assert.deepEqual(pkg.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
});

test("the build output exists", () => {
  assert.ok(existsSync(join(root, "dist", "index.js")));
  assert.ok(existsSync(join(root, "dist", "opencode.js")));
});
