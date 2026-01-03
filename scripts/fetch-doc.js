// scripts/fetch-doc.js
const axios = require("axios");
const cheerio = require("cheerio");
const TurndownService = require("turndown");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const util = require("util");
const zlib = require("zlib");

const BASE_URL = "https://akashic-games.github.io/";
const SITEMAP_URL = `${BASE_URL}sitemap.xml`;
const SEED_URLS = [BASE_URL];
const OUTPUT_FILE = "data/akashic_docs.json";
const DELAY_MS = 500;
const USE_WGET = process.env.USE_WGET === "1";
const WGET_MIRROR_DIR = process.env.WGET_MIRROR_DIR || "data/wget_mirror";

const execAsync = util.promisify(exec);

const turndownService = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});

const visited = new Set();
const queue = [...SEED_URLS];
const docs = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeUrl(link, currentUrl) {
  try {
    if (!link || link.startsWith("mailto:") || link.startsWith("javascript:")) {
      return null;
    }
    const absoluteUrl = new URL(link, currentUrl).href;
    return absoluteUrl.split("#")[0];
  } catch {
    return null;
  }
}

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

async function fetchSitemapXml(url) {
  const response = await axios.get(url, {
    headers: { "User-Agent": "AkashicMCP-Bot/1.0" },
    responseType: "arraybuffer"
  });
  const contentType = response.headers["content-type"] || "";
  const buffer = Buffer.from(response.data);
  if (url.endsWith(".gz") || contentType.includes("gzip")) {
    return zlib.gunzipSync(buffer).toString("utf-8");
  }
  return buffer.toString("utf-8");
}

async function loadSitemapSeeds() {
  const urls = new Set();
  const pending = [SITEMAP_URL];
  const seen = new Set();

  while (pending.length > 0) {
    const sitemapUrl = pending.shift();
    if (!sitemapUrl || seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);

    try {
      const xml = await fetchSitemapXml(sitemapUrl);
      const $ = cheerio.load(xml, { xmlMode: true });

      $("url > loc").each((_, el) => {
        const loc = $(el).text().trim();
        if (loc && loc.startsWith(BASE_URL)) {
          urls.add(loc);
        }
      });

      $("sitemap > loc").each((_, el) => {
        const loc = $(el).text().trim();
        if (loc && loc.startsWith(BASE_URL)) {
          pending.push(loc);
        }
      });
    } catch {
      continue;
    }
  }

  return Array.from(urls);
}

async function crawlWithWget() {
  const mirrorDir = path.resolve(WGET_MIRROR_DIR);
  fs.mkdirSync(mirrorDir, { recursive: true });
  const command = [
    "wget",
    "--mirror",
    "--page-requisites",
    "--adjust-extension",
    "--convert-links",
    "--no-parent",
    "--domains",
    "akashic-games.github.io",
    "--no-host-directories",
    "--directory-prefix",
    `"${mirrorDir}"`,
    BASE_URL
  ].join(" ");

  console.log(`Running wget mirror to: ${mirrorDir}`);
  await execAsync(command);

  const htmlFiles = listHtmlFiles(mirrorDir);
  console.log(`Parsing ${htmlFiles.length} mirrored HTML files...`);

  for (const filePath of htmlFiles) {
    const html = fs.readFileSync(filePath, "utf-8");
    const $ = cheerio.load(html);
    $("nav, footer, script, style, noscript, iframe, .site-header, .site-footer").remove();

    const title = $("title").text().trim();
    const htmlContent = $("body").html();
    if (!htmlContent) continue;

    const markdown = turndownService.turndown(htmlContent);
    docs.push({
      url: buildUrlFromFile(filePath, mirrorDir),
      title,
      content: markdown
    });
  }

  console.log(`\nCompleted! Saving ${docs.length} pages to ${OUTPUT_FILE}...`);
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(docs, null, 2), "utf-8");
  console.log("Done.");
}

async function crawl() {
  if (USE_WGET) {
    await crawlWithWget();
    return;
  }

  const sitemapSeeds = await loadSitemapSeeds();
  for (const seed of sitemapSeeds) {
    if (!visited.has(seed)) {
      queue.push(seed);
    }
  }
  console.log(`Crawler started. Seed count: ${SEED_URLS.length + sitemapSeeds.length}`);

  while (queue.length > 0) {
    const currentUrl = queue.shift();
    if (!currentUrl || visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    if (!currentUrl.startsWith(BASE_URL)) continue;
    if (currentUrl.match(/\.(png|jpg|jpeg|gif|zip|pdf)$/i)) continue;

    try {
      console.log(`Fetching: ${currentUrl} (Queue: ${queue.length})`);
      const response = await axios.get(currentUrl, {
        headers: { "User-Agent": "AkashicMCP-Bot/1.0" }
      });

      const contentType = response.headers["content-type"];
      if (!contentType || !contentType.includes("text/html")) continue;

      const $ = cheerio.load(response.data);
      $("nav, footer, script, style, noscript, iframe, .site-header, .site-footer").remove();

      const title = $("title").text().trim();
      const htmlContent = $("body").html();

      if (htmlContent) {
        const markdown = turndownService.turndown(htmlContent);
        docs.push({
          url: currentUrl,
          title,
          content: markdown
        });
      }

      $("a").each((_, element) => {
        const href = $(element).attr("href");
        const nextUrl = normalizeUrl(href, currentUrl);
        if (nextUrl && !visited.has(nextUrl) && nextUrl.startsWith(BASE_URL)) {
          queue.push(nextUrl);
        }
      });

      await sleep(DELAY_MS);
    } catch (error) {
      console.error(`Error fetching ${currentUrl}: ${error.message}`);
    }
  }

  console.log(`\nCompleted! Saving ${docs.length} pages to ${OUTPUT_FILE}...`);
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(docs, null, 2), "utf-8");
  console.log("Done.");
}

crawl();
