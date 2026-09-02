// Diagnostic branch only: native filesystem + actual metadata owner, without Vitest or Rolldown.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { copyBundledPluginMetadata } from "./copy-bundled-plugin-metadata.mts";
import { DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV } from "./lib/bundled-plugin-build-entries.mjs";

const mode = process.argv[2];
assert.ok(mode === "baseline" || mode === "candidate");
const phase = (value) => fs.writeSync(2, `[windows-native] primitive ${value}\n`);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "windows-native-staging-")));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};
const run = (file) => {
  const result = spawnSync(process.execPath, [file], { encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
};
try {
  phase(`start ${process.platform} ${process.version} ${process.arch}`);
  write(path.join(root, "package.json"), {
    name: "openclaw",
    type: "module",
    version: "1.0.0",
    exports: { "./plugin-sdk/probe": "./dist/plugin-sdk/probe.js" },
  });
  write(path.join(root, "dist/plugin-sdk/probe.js"), "export const shared = {};\n");
  const sourceLinks = new Map();
  for (const [id, version] of [
    ["first", "1.0.0"],
    ["second", "2.0.0"],
  ]) {
    const plugin = path.join(root, "extensions", id);
    const modules = path.join(plugin, "node_modules");
    const dependency = path.join(root, "installed", version, "node_modules/@fixture/private-dep");
    write(path.join(dependency, "package.json"), {
      name: "@fixture/private-dep",
      version,
      main: "index.cjs",
    });
    write(path.join(dependency, "index.cjs"), `exports.version = ${JSON.stringify(version)};\n`);
    write(path.join(dependency, "SKILL.md"), version);
    write(
      path.join(modules, ".bin/probe.cjs"),
      'console.log(require("../@fixture/private-dep").version);\n',
    );
    fs.mkdirSync(path.join(modules, "@fixture"));
    fs.symlinkSync(
      path.relative(path.join(modules, "@fixture"), dependency),
      path.join(modules, "@fixture/private-dep"),
      "dir",
    );
    fs.symlinkSync(path.relative(modules, root), path.join(modules, "openclaw"), "dir");
    sourceLinks.set(id, fs.readlinkSync(path.join(modules, "openclaw")));
    write(path.join(plugin, "package.json"), {
      name: `@openclaw/${id}`,
      type: "module",
      version: "1.0.0",
      openclaw: {
        extensions: ["./index.ts"],
        build: { bundledDist: false },
        release: { publishToNpm: true },
      },
    });
    write(path.join(plugin, "index.ts"), "export {};\n");
    write(path.join(plugin, "openclaw.plugin.json"), {
      id,
      skills: ["./node_modules/@fixture/private-dep"],
    });
    const output = path.join(root, "dist/extensions", id);
    write(path.join(output, "host.mjs"), 'export { shared } from "openclaw/plugin-sdk/probe";\n');
    write(
      path.join(output, "host.cjs"),
      'module.exports = require("openclaw/plugin-sdk/probe");\n',
    );
    fs.symlinkSync(modules, path.join(output, "node_modules"), "junction");
  }
  for (const [profile, isolated] of [
    ["legacy Docker", false],
    ["isolated", true],
    ["Docker", false],
    ["isolated again", true],
    ["isolated repeated", true],
  ]) {
    phase(`metadata ${profile} begin`);
    copyBundledPluginMetadata({
      repoRoot: root,
      env: isolated ? {} : { [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "first,second" },
    });
    phase(`metadata ${profile} end`);
    for (const [id, version] of [
      ["first", "1.0.0"],
      ["second", "2.0.0"],
    ]) {
      const modules = path.join(root, "extensions", id, "node_modules");
      assert.equal(fs.readlinkSync(path.join(modules, "openclaw")), sourceLinks.get(id));
      assert.equal(
        fs.readFileSync(path.join(modules, "@fixture/private-dep/SKILL.md"), "utf8"),
        version,
      );
    }
  }
  phase("staged copy begin");
  const staged = path.join(root, "staged/first");
  fs.cpSync(path.join(root, "dist/extensions/first"), staged, { recursive: true });
  phase("staged copy end");
  for (const format of ["mjs", "cjs"]) {
    phase(`${format} host imports begin`);
    const roots = [
      path.join(root, "dist/extensions/first"),
      path.join(root, "dist/extensions/second"),
      staged,
    ];
    const script = path.join(root, `check-${format}.mjs`);
    write(
      script,
      `import assert from "node:assert/strict";\nimport { shared } from "./dist/plugin-sdk/probe.js";\n${roots.map((dir, i) => `const p${i} = await import(${JSON.stringify(pathToFileURL(path.join(dir, `host.${format}`)).href)}); assert.equal(p${i}.shared ?? p${i}.default.shared, shared);`).join("\n")}\nconsole.log("HOST singleton");\n`,
    );
    const result = run(script);
    phase(`${format} host imports exit ${result.status}`);
    if (mode === "candidate") assert.equal(result.status, 0, result.stderr);
    else {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /ERR_MODULE_NOT_FOUND|ENOENT/);
      assert.match(result.stderr, /plugin-sdk/);
      assert.doesNotMatch(result.stderr, /EPERM/);
    }
  }
  phase("bin exec begin");
  const bin = run(path.join(staged, "node_modules/.bin/probe.cjs"));
  phase(`bin exec exit ${bin.status}`);
  if (mode === "candidate") {
    assert.equal(bin.status, 0, bin.stderr);
    assert.equal(bin.stdout.trim(), "1.0.0");
  } else assert.equal(bin.status, 1, bin.stderr);
} finally {
  phase("cleanup begin");
  fs.rmSync(root, { recursive: true, force: true });
  phase("cleanup end");
}
phase(`${mode} complete`);
