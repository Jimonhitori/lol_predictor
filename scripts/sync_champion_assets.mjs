import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rosterPath = path.join(root, "docs", "static", "data", "champions.json");
const outputDir = path.join(root, "docs", "static", "images", "champions");
const roster = JSON.parse(await readFile(rosterPath, "utf8"));
const version = roster.version;

if (!version || !roster.data) throw new Error("Champion roster is missing version or data");

await mkdir(outputDir, { recursive: true });

const expectedFiles = new Set(Object.values(roster.data).map(champion => champion.image?.full || `${champion.id}.png`));
for (const filename of await readdir(outputDir)) {
  if (filename.endsWith(".png") && !expectedFiles.has(filename)) await unlink(path.join(outputDir, filename));
}

let downloaded = 0;
for (const champion of Object.values(roster.data)) {
  const filename = champion.image?.full || `${champion.id}.png`;
  const url = `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${filename}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  await writeFile(path.join(outputDir, filename), Buffer.from(await response.arrayBuffer()));
  downloaded += 1;
}

console.log(`Synced ${downloaded} champion images for Data Dragon ${version}`);
