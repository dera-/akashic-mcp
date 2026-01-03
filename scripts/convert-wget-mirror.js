// scripts/convert-wget-mirror.js
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const TurndownService = require("turndown");

const MIRROR_DIR = process.env.WGET_MIRROR_DIR || "data/wget_mirror";
const OUTPUT_FILE = process.env.OUTPUT_FILE || "data/akashic_docs.json";
const BASE_URL = process.env.BASE_URL || "https://akashic-games.github.io/";

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});

function listHtmlFiles(dirPath) {
  const results = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listHtmlFiles(fullPath));
      continue;
    }
    if (entry.isFile() && /\.(html?|xhtml)$/i.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

function buildUrlFromFile(filePath, rootDir) {
  let relative = path.relative(rootDir, filePath).split(path.sep).join("/");
  if (relative.endsWith("index.html")) {
    relative = relative.slice(0, -"index.html".length);
  }
  return new URL(relative, BASE_URL).href;
}

function extractDoc(filePath, rootDir) {
  const html = fs.readFileSync(filePath, "utf-8");
  const $ = cheerio.load(html);
  $("nav, footer, script, style, noscript, iframe, .site-header, .site-footer").remove();
  const title = $("title").text().trim();
  const htmlContent = $("body").html();
  if (!htmlContent) return null;
  const markdown = turndownService.turndown(htmlContent);
  return {
    url: buildUrlFromFile(filePath, rootDir),
    title,
    content: markdown
  };
}

function main() {
  const mirrorDir = path.resolve(MIRROR_DIR);
  if (!fs.existsSync(mirrorDir) || !fs.statSync(mirrorDir).isDirectory()) {
    throw new Error(`Mirror directory not found: ${mirrorDir}`);
  }

  const htmlFiles = listHtmlFiles(mirrorDir);
  const docs = [];
  for (const filePath of htmlFiles) {
    const doc = extractDoc(filePath, mirrorDir);
    if (doc) docs.push(doc);
  }

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(docs, null, 2), "utf-8");
  console.log(`Saved ${docs.length} pages to ${OUTPUT_FILE}`);
}

main();
