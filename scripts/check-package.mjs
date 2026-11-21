import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const workingLock = await readFile(join(root, "package-lock.json"), "utf8");
const typescript = JSON.parse(await readFile(join(root, "node_modules/typescript/package.json"), "utf8")).version;
const temp = await mkdtemp(join(process.env.IDEM_TEST_TMPDIR ?? tmpdir(), "idem-tarball-"));
const runtime = process.env.IDEM_RUNTIME_NODE ?? process.execPath;
const npm = process.env.npm_execpath;
const childEnv = { ...process.env }; delete childEnv.NODE_PATH;
async function run(command, args, cwd = root) {
  try { return await exec(command, args, { cwd, env: childEnv, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }); } catch (error) {
    throw new Error(`${command} ${args.join(" ")} failed\n${error.stdout ?? ""}\n${error.stderr ?? ""}`, { cause: error });
  }
}
const npmRun = (args, cwd) => npm ? run(process.execPath, [npm, ...args], cwd) : run("npm", args, cwd);
try {
  const { stdout } = await npmRun(["pack", "--json", "--pack-destination", temp]);
  const [pack] = JSON.parse(stdout);
  assert.equal(pack.version, pkg.version);
  const paths = pack.files.map((file) => file.path);
  for (const path of ["dist/src/index.js", "dist/src/redis.js", "dist/src/index.d.ts", "dist/src/redis.d.ts", "docs/guarantees.md", "docs/migration.md", "SECURITY.md", "CHANGELOG.md"]) assert.ok(paths.includes(path), path);
  assert.equal(paths.some((path) => /(^|\/)(AGENTS\.md|\.opencode|audit|test|examples|\.git)(\/|$)/.test(path)), false);
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  console.log(JSON.stringify({ actualTarball: true, files: paths.length, version: pack.version, runtimeDependencies: 0, developmentFilesIncluded: false }));
  const majors = (process.env.IDEM_EXPRESS_MAJORS ?? "4,5").split(",");
  for (const major of majors) {
    if (!["4", "5"].includes(major)) throw new Error("IDEM_EXPRESS_MAJORS must contain 4 and/or 5");
    const consumer = join(temp, `express-${major}`);
    await cp(join(root, "test/fixtures/package"), consumer, { recursive: true });
    await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await npmRun(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
      join(temp, pack.filename), `express@${major === "4" ? pkg.peerDependencies.express.split(" || ")[0] : "^5.1.0"}`,
      `@types/express@${major}`, "@types/node@18", `typescript@${typescript}`, "compression@1.8.2"], consumer);
    const installed = join(consumer, "node_modules", pkg.name);
    assert.equal((await lstat(installed)).isSymbolicLink(), false);
    assert.ok((await realpath(installed)).startsWith(consumer));
    await assert.rejects(lstat(join(consumer, "node_modules/redis")));
    await assert.rejects(lstat(join(consumer, "node_modules/@redis/client")));
    const config = { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, esModuleInterop: true, types: ["node"] }, files: ["types.ts"] };
    await writeFile(join(consumer, "tsconfig.json"), JSON.stringify(config));
    const tsc = join(consumer, "node_modules/typescript/bin/tsc");
    await run(process.execPath, [tsc, "-p", "tsconfig.json"], consumer);
    const smoke = await run(runtime, ["runtime.mjs"], consumer);
    const driver = process.env.IDEM_REDIS_CLIENT_VERSION ?? "5.12.2";
    await npmRun(["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", `redis@${driver}`], consumer);
    config.files.push("redis-types.ts");
    await writeFile(join(consumer, "tsconfig.json"), JSON.stringify(config));
    await run(process.execPath, [tsc, "-p", "tsconfig.json"], consumer);
    if (process.env.IDEM_REQUIRE_REDIS === "1" && !process.env.REDIS_URL) throw new Error("REDIS_URL required; Redis tarball gate cannot be silently skipped");
    const redis = process.env.REDIS_URL ? (await run(runtime, ["redis-runtime.mjs"], consumer)).stdout.trim() : "not-run-no-REDIS_URL";
    const expressVersion = JSON.parse(await readFile(join(consumer, "node_modules/express/package.json"), "utf8")).version;
    console.log(JSON.stringify({ tarballInstalled: true, express: expressVersion, pairedTypes: major, driverAbsentInitially: true, redisDriver: driver, core: smoke.stdout.trim(), redis }));
  }
  assert.equal(await readFile(join(root, "package-lock.json"), "utf8"), workingLock, "Working lockfile changed during isolated consumer checks; investigate without discarding changes");
} finally { await rm(temp, { recursive: true, force: true }); } // Only this script's mkdtemp directory.
