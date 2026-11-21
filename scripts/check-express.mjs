import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.env.npm_execpath;
const major = process.env.IDEM_EXPRESS_MAJOR ?? "5";
if (!["4", "5"].includes(major)) throw new Error("IDEM_EXPRESS_MAJOR must be 4 or 5");
if (process.env.IDEM_REQUIRE_REDIS === "1" && !process.env.REDIS_URL) throw new Error("REDIS_URL required for this matrix gate");
const workingLock = await readFile(join(root, "package-lock.json"), "utf8");
const temp = await mkdtemp(join(process.env.IDEM_TEST_TMPDIR ?? tmpdir(), "idem-express-"));
const env = { ...process.env, PATH: dirname(process.execPath) + delimiter + process.env.PATH };
async function run(args) {
  try {
    const { stdout, stderr } = await exec(npm ? process.execPath : "npm", npm ? [npm, ...args] : args,
      { cwd: temp, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    if (args[0] === "run" || args[0] === "test") process.stdout.write(stdout + stderr);
  } catch (error) { throw new Error(`${args.join(" ")} failed\n${error.stdout ?? ""}\n${error.stderr ?? ""}`, { cause: error }); }
}
try {
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "vitest.config.ts", "vitest.redis.config.ts", "eslint.config.js", "README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", "docs", "src", "examples", "test", "scripts"]) {
    await cp(join(root, file), join(temp, file), { recursive: true });
  }
  await run(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  if (major === "5") await run(["install", "--no-save", "--package-lock=true", "--ignore-scripts", "--no-audit", "--no-fund", "express@^5.1.0", "@types/express@5"]);
  const installedVersion = async (name, directory = temp) => JSON.parse(await readFile(join(directory, "node_modules", name, "package.json"), "utf8")).version;
  for (const name of ["vitest", "typescript", "eslint", "redis", "compression"]) {
    assert.equal(await installedVersion(name), await installedVersion(name, root), `Matrix must not silently upgrade ${name}`);
  }
  await run(["run", "build"]); await run(["run", "typecheck"]); await run(["test"]);
  if (process.env.REDIS_URL) await run(["run", "test:redis"]);
  if (process.env.IDEM_MATRIX_FULL === "1") {
    await run(["run", "lint", "--", "--max-warnings=0"]);
    await run(["run", "test:docs"]);
    await run(["run", "test:package"]);
  }
  assert.equal(await readFile(join(root, "package-lock.json"), "utf8"), workingLock, "Working lockfile changed during isolated matrix; investigate without discarding changes");
  console.log(JSON.stringify({ isolatedExpressMatrix: "passed", node: process.version, express: await installedVersion("express"), expressTypes: await installedVersion("@types/express"), vitest: await installedVersion("vitest"), redisSuite: Boolean(process.env.REDIS_URL), workingLockfileChanged: false }));
} finally { await rm(temp, { recursive: true, force: true }); }
