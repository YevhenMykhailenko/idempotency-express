import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["README.md", "SECURITY.md", "CHANGELOG.md", ...(await readdir(join(root, "docs"))).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`)];
for (const file of files) {
  const text = await readFile(join(root, file), "utf8");
  assert.equal((text.match(/^```/gm) ?? []).length % 2, 0, `Unclosed code fence: ${file}`);
  for (const [, link] of text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|#|mailto:)/.test(link)) continue;
    await access(resolve(root, dirname(file), link.split("#")[0]));
  }
}
const source = await readFile(join(root, "src/v3/http-error.ts"), "utf8");
const documented = await readFile(join(root, "docs/guarantees.md"), "utf8");
const codes = [...source.matchAll(/^  ([a-z_]+): \[(\d+)/gm)].map((match) => match[1]);
assert.equal(codes.length, 16);
for (const code of codes) assert.ok(documented.includes(`\`${code}\``), `Missing failure code: ${code}`);
console.log(JSON.stringify({ documentationFiles: files.length, localLinksAndFences: "passed", documentedFailureCodes: codes.length }));
