import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";
import axios from "axios";
import cheerio from "cheerio";
import AdmZip from "adm-zip";
import fs from 'fs';
import path from 'path';
import http from 'http';
import { exec } from 'child_process';
import util from 'util';

// execをPromise化して非同期処理しやすくする
const execAsync = util.promisify(exec);

// =================================================================
// 1. 事前準備: ドキュメントデータの読み込み
// =================================================================
let docsData = [];
try {
	// data/akashic_docs.json を探す
	const docsPath = path.resolve('./data/akashic_docs.json');
	if (fs.existsSync(docsPath)) {
		docsData = JSON.parse(fs.readFileSync(docsPath, 'utf-8'));
		console.error(`[Info] Loaded ${docsData.length} documents from akashic_docs.json`);
	} else {
		console.error("[Warning] akashic_docs.json not found. 'search_akashic_docs' tool will return empty results.");
		console.error("Run 'node scripts/fetch-docs.js' first.");
	}
} catch (error) {
	console.error("[Error] Failed to load docs:", error.message);
}

// =================================================================
// 2. ヘルパー関数: 利用可能なテンプレート一覧の取得
// =================================================================
async function getAkashicTemplates() {
	if (getAkashicTemplates.cache) {
		return getAkashicTemplates.cache;
	}
	try {
		// akashic init -l コマンドを実行してテンプレート一覧を取得
		console.error("[Info] Fetching available Akashic templates...");
		const { stdout } = await execAsync('akashic init -l');
		
		// 出力を解析してテンプレート名（行頭の単語）を抽出
		const templates = stdout
			.split('\n')
			.map(line => line.trim().split(/\s+/)[0])
			.filter(name => name && name.length > 0);

		const uniqueTemplates = [...new Set(templates)];
		
		if (uniqueTemplates.length === 0) {
			throw new Error("No templates found from CLI output.");
		}
		
		// TypeScript系とJavaScript系が両方含まれているか確認（ログ用）
		getAkashicTemplates.cache = uniqueTemplates;
		return uniqueTemplates;

	} catch (error) {
		console.error(`[Warning] Failed to fetch templates via CLI: ${error.message}`);
		// CLIが失敗した場合やインストールされていない場合のフォールバック
		const fallback = [
			"javascript", 
			"typescript", 
			"javascript-shin-ichiba-ranking", 
			"typescript-shin-ichiba-ranking",
			"javascript-minimal",
			"typescript-minimal",
			"javascript-multi",
			"typescript-multi"
		];
		getAkashicTemplates.cache = fallback;
		return fallback;
	}
}
getAkashicTemplates.cache = null;

// =================================================================
// 3. メイン処理 (サーバー構築と起動)
// =================================================================
async function createMcpServer() {
	// サーバーの基本設定
	const server = new McpServer({
		name: "akashic-game-dev-server",
		version: "1.0.0",
	});

	// ---------------------------------------------------------------
	// Tool 1: ドキュメント検索 (search_akashic_docs)
	// ---------------------------------------------------------------
	server.tool(
		"search_akashic_docs",
		"Search for information about Akashic Engine API, tutorials, and game design tips.",
		{
			query: z.string().describe("Search keyword (e.g. 'click event', 'g.Sprite', 'audio')."),
		},
		async ({ query }) => {
			const q = query.toLowerCase();
			// タイトルまたは本文にキーワードが含まれるものを検索
			const results = docsData
				.filter(doc => 
					(doc.title && doc.title.toLowerCase().includes(q)) || 
					(doc.content && doc.content.toLowerCase().includes(q))
				)
				.slice(0, 3) // コンテキストサイズ節約のため上位3件に制限
				.map(doc => `Title: ${doc.title}\nURL: ${doc.url}\n\n${doc.content.substring(0, 500)}...`);

			return {
				content: [{ type: "text", text: results.join("\n\n---\n\n") || "No relevant documents found." }]
			};
		}
	);

	// ---------------------------------------------------------------
	// Tool 2: ファイル作成 (create_game_file)
	// ---------------------------------------------------------------
	server.tool(
		"create_game_file",
		"Create or overwrite a source file for the game (e.g., src/main.ts, game.json).",
		{
			filePath: z.string().describe("Relative or absolute path to the file (e.g., 'src/main.ts' or '/tmp/game/main.js')."),
			code: z.string().describe("The full content of the file."),
		},
		async ({ filePath, code }) => {
			// セキュリティ: 親ディレクトリへの遡りを禁止
			if (!path.isAbsolute(filePath) && filePath.includes('..')) {
				return { 
					content: [{ type: "text", text: "Error: Invalid file path. Avoid '..' in relative paths." }], 
					isError: true 
				};
			}

			try {
				const fullPath = path.isAbsolute(filePath)
					? path.normalize(filePath)
					: path.resolve(process.cwd(), filePath);
				const dir = path.dirname(fullPath);
				
				if (!fs.existsSync(dir)) {
					fs.mkdirSync(dir, { recursive: true });
				}
				
				fs.writeFileSync(fullPath, code);
				return {
					content: [{ type: "text", text: `Successfully wrote file to: ${filePath}` }]
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Error writing file: ${err.message}` }],
					isError: true,
				};
			}
		}
	);

	// ---------------------------------------------------------------
	// Tool 3: プロジェクト初期化 (init_project)
	// ---------------------------------------------------------------
	// 動的にテンプレートリストを取得してからツールを定義
	const templateList = await getAkashicTemplates();
	// ZodのEnumを作るには少なくとも1つの要素が必要
	const templateEnum = templateList.length > 0 ? [templateList[0], ...templateList.slice(1)] : ["javascript"];

	server.tool(
		"init_project",
		"Initialize a new Akashic Engine project with a chosen template (runs 'akashic init' and 'npm install').",
		{
			directoryName: z.string().describe("The directory path for the new project (relative or absolute)."),
			templateType: z.enum(templateEnum).describe(`Template type. Available: ${templateList.join(", ")}`),
			skipNpmInstall: z.boolean().optional().describe("Skip running 'npm install' (useful for constrained environments)."),
		},
		async ({ directoryName, templateType, skipNpmInstall }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes('..')) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);

			// ディレクトリチェック
			if (fs.existsSync(targetPath)) {
				const files = fs.readdirSync(targetPath);
				if (files.length > 0) {
					return { 
						content: [{ type: "text", text: `Error: Directory '${directoryName}' already exists and is not empty.` }],
						isError: true 
					};
				}
			} else {
				fs.mkdirSync(targetPath, { recursive: true });
			}

			try {
				console.error(`[Info] Initializing project in ${directoryName} with template ${templateType}...`);
				
				// initコマンドとnpm installを連続実行
				const initCommand = `cd "${targetPath}" && akashic init --type ${templateType} --force`;
				await execAsync(initCommand);

				if (!skipNpmInstall) {
					const installCommand = `cd "${targetPath}" && npm install --no-audit --no-fund --progress=false`;
					await execAsync(installCommand);
				}

				return {
					content: [{ 
						type: "text", 
						text: `Project initialized successfully in '${directoryName}'.\nTemplate: ${templateType}\nDependencies installed: ${skipNpmInstall ? "skipped" : "yes"}.` 
					}]
				};

			} catch (error) {
				const message = error?.message || "Unknown error";
				const stdout = error?.stdout ? `\nStdout: ${error.stdout}` : "";
				const stderr = error?.stderr ? `\nStderr: ${error.stderr}` : "";
				return {
					content: [{ type: "text", text: `Error during initialization: ${message}${stdout}${stderr}` }],
					isError: true,
				};
			}
		}
	);

	// ---------------------------------------------------------------
	// Tool 4: 最小テンプレートで初期化 (init_minimal_template)
	// ---------------------------------------------------------------
	server.tool(
		"init_minimal_template",
		"Initialize a project by copying template/game.json and template/script/main.js.",
		{
			directoryName: z.string().describe("The directory path for the new project (relative or absolute)."),
		},
		async ({ directoryName }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes("..")) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			const templateRoot = path.resolve(process.cwd(), "template");
			const templateGameJson = path.resolve(templateRoot, "game.json");
			const templateMain = path.resolve(templateRoot, "script", "main.js");

			if (!fs.existsSync(templateGameJson) || !fs.existsSync(templateMain)) {
				return {
					content: [{ type: "text", text: "Error: template/game.json or template/script/main.js not found." }],
					isError: true,
				};
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);

			if (fs.existsSync(targetPath)) {
				const files = fs.readdirSync(targetPath);
				if (files.length > 0) {
					return {
						content: [{ type: "text", text: `Error: Directory '${directoryName}' already exists and is not empty.` }],
						isError: true,
					};
				}
			} else {
				fs.mkdirSync(targetPath, { recursive: true });
			}

			try {
				const scriptDir = path.resolve(targetPath, "script");
				fs.mkdirSync(scriptDir, { recursive: true });
				fs.copyFileSync(templateGameJson, path.resolve(targetPath, "game.json"));
				fs.copyFileSync(templateMain, path.resolve(scriptDir, "main.js"));

				return {
					content: [{
						type: "text",
						text: `Project initialized from template in '${directoryName}'.`
					}]
				};
			} catch (error) {
				const message = error?.message || "Unknown error";
				return {
					content: [{ type: "text", text: `Error during template initialization: ${message}` }],
					isError: true,
				};
			}
		}
	);

	// ---------------------------------------------------------------
	// Tool 5: アセットスキャン (akashic_scan_asset)
	// ---------------------------------------------------------------
	server.tool(
		"akashic_scan_asset",
		"Run 'akashic scan asset' in the specified project directory.",
		{
			directoryName: z.string().describe("Project directory path (relative or absolute)."),
		},
		async ({ directoryName }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes("..")) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);

			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return { content: [{ type: "text", text: `Error: Directory '${directoryName}' not found.` }], isError: true };
			}

			try {
				const command = `cd "${targetPath}" && akashic scan asset`;
				const { stdout, stderr } = await execAsync(command);
				const output = [stdout, stderr].filter(Boolean).join("\n");
				return {
					content: [{ type: "text", text: output || "akashic scan asset completed." }]
				};
			} catch (error) {
				const message = error?.message || "Unknown error";
				const stdout = error?.stdout ? `\nStdout: ${error.stdout}` : "";
				const stderr = error?.stderr ? `\nStderr: ${error.stderr}` : "";
				return {
					content: [{ type: "text", text: `Error during asset scan: ${message}${stdout}${stderr}` }],
					isError: true,
				};
			}
		}
	);

	// ---------------------------------------------------------------
	// Tool 6: Install extension (akashic_install_extension)
	// ---------------------------------------------------------------
	server.tool(
		"akashic_install_extension",
		"Install Akashic extension libraries via 'akashic install' (only @akashic or @akashic-extension scope).",
		{
			directoryName: z.string().describe("Project directory path (relative or absolute)."),
			packages: z.array(z.string()).min(1).describe("Packages to install (must be @akashic/* or @akashic-extension/*)."),
		},
		async ({ directoryName, packages }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes("..")) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);

			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return { content: [{ type: "text", text: `Error: Directory '${directoryName}' not found.` }], isError: true };
			}

			const invalid = packages.filter(
				(name) => !/^@akashic(-extension)?\\//.test(name)
			);
			if (invalid.length > 0) {
				return {
					content: [{ type: "text", text: `Error: Invalid package scope: ${invalid.join(", ")}` }],
					isError: true,
				};
			}

			try {
				const command = `cd "${targetPath}" && akashic install ${packages.map((p) => `"${p}"`).join(" ")}`;
				const { stdout, stderr } = await execAsync(command);
				const output = [stdout, stderr].filter(Boolean).join("\n");
				return {
					content: [{ type: "text", text: output || "akashic install completed." }]
				};
			} catch (error) {
				const message = error?.message || "Unknown error";
				const stdout = error?.stdout ? `\nStdout: ${error.stdout}` : "";
				const stderr = error?.stderr ? `\nStderr: ${error.stderr}` : "";
				return {
					content: [{ type: "text", text: `Error during akashic install: ${message}${stdout}${stderr}` }],
					isError: true,
				};
			}
		}
	);

	// ---------------------------------------------------------------
	// Tool 6: External asset import (import_external_assets)
	// ---------------------------------------------------------------
	server.tool(
		"import_external_assets",
		"Download free assets from approved sites and import into the project.",
		{
			directoryName: z.string().describe("Project directory path (relative or absolute)."),
			assets: z.array(z.object({
				url: z.string().describe("Direct asset file URL."),
				type: z.enum(["image", "audio"]).describe("Asset type."),
				fileName: z.string().optional().describe("Optional file name override."),
				credit: z.object({
					title: z.string().describe("Asset title."),
					author: z.string().describe("Author name."),
					sourceUrl: z.string().describe("Source page URL."),
					license: z.string().describe("License name.")
				}).optional().describe("Credit information to append to README.")
			})).optional().describe("Assets to download and import."),
			sourcePageUrl: z.string().optional().describe("Asset page URL to extract links from."),
			keyword: z.string().optional().describe("Keyword to filter assets found on the page."),
			maxResults: z.number().int().min(1).optional().describe("Maximum number of assets to download from the page."),
			creditDefaults: z.object({
				author: z.string().describe("Default author name."),
				license: z.string().describe("Default license name."),
				sourceUrl: z.string().optional().describe("Default source URL."),
				titlePrefix: z.string().optional().describe("Prefix for generated titles.")
			}).optional().describe("Default credit values for extracted assets.")
		},
		async ({ directoryName, assets, sourcePageUrl, keyword, maxResults, creditDefaults }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes("..")) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);

			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return { content: [{ type: "text", text: `Error: Directory '${directoryName}' not found.` }], isError: true };
			}

			const allowedHosts = new Set([
				"commons.nicovideo.jp",
				"www.irasutoya.com",
				"irasutoya.com",
				"kenney.nl",
				"www.kenney.nl",
				"opengameart.org",
				"www.opengameart.org",
				"pipoya.net",
				"www.pipoya.net",
				"soundeffect-lab.info",
				"www.soundeffect-lab.info",
				"maou.audio",
				"www.maou.audio",
				"game-icons.net",
				"www.game-icons.net"
			]);
			const isAllowedHost = (host) => {
				if (!host) return false;
				if (allowedHosts.has(host)) return true;
				for (const base of allowedHosts) {
					if (host.endsWith(`.${base}`)) return true;
				}
				return false;
			};

			const extractAssetsFromPage = async (pageUrl) => {
				let parsedPageUrl = null;
				try {
					parsedPageUrl = new URL(pageUrl);
				} catch {
					throw new Error(`Invalid sourcePageUrl: ${pageUrl}`);
				}

				if (!isAllowedHost(parsedPageUrl.hostname)) {
					throw new Error(`URL host not allowed: ${parsedPageUrl.hostname}`);
				}

				const response = await axios.get(pageUrl, { headers: { "User-Agent": "AkashicMCP-Bot/1.0" } });
				const $ = cheerio.load(response.data);
				const candidates = [];
				const addCandidate = (url, type, context) => {
					if (!url) return;
					let absolute = null;
					try {
						absolute = new URL(url, pageUrl).href.split("#")[0];
					} catch {
						return;
					}
					candidates.push({ url: absolute, type, context: context || "" });
				};

				$("img").each((_, el) => {
					const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-original");
					const context = [$(el).attr("alt"), $(el).attr("title"), $(el).closest("a").text()].filter(Boolean).join(" ");
					addCandidate(src, "image", context);
				});

				$("a").each((_, el) => {
					const href = $(el).attr("href");
					const context = $(el).text() || "";
					addCandidate(href, "image", context);
					addCandidate(href, "audio", context);
				});

				$("source").each((_, el) => {
					const src = $(el).attr("src");
					const context = $(el).closest("audio").text() || "";
					addCandidate(src, "audio", context);
				});

				return candidates;
			};

			const imageDir = path.resolve(targetPath, "image");
			const audioDir = path.resolve(targetPath, "audio");
			fs.mkdirSync(imageDir, { recursive: true });
			fs.mkdirSync(audioDir, { recursive: true });

			const creditLines = [];
			const downloadedFiles = [];
			let assetRequests = Array.isArray(assets) ? [...assets] : [];

			if (sourcePageUrl) {
				let candidates = [];
				try {
					candidates = await extractAssetsFromPage(sourcePageUrl);
				} catch (error) {
					const message = error?.message || "Unknown error";
					return { content: [{ type: "text", text: `Error extracting assets: ${message}` }], isError: true };
				}

				const keywordLower = keyword ? keyword.toLowerCase() : null;
				if (keywordLower) {
					candidates = candidates.filter((c) => {
						const text = `${c.url} ${c.context}`.toLowerCase();
						return text.includes(keywordLower);
					});
				}

				if (typeof maxResults === "number") {
					candidates = candidates.slice(0, maxResults);
				}

				for (const candidate of candidates) {
					const ext = path.extname(new URL(candidate.url).pathname).toLowerCase();
					if (candidate.type === "image" && ![".png", ".jpg", ".jpeg"].includes(ext)) continue;
					if (candidate.type === "audio" && ![".m4a", ".ogg", ".aac", ".wav", ".mp3", ".mp4"].includes(ext)) continue;
					assetRequests.push({
						url: candidate.url,
						type: candidate.type
					});
				}
			}

			if (assetRequests.length === 0) {
				return { content: [{ type: "text", text: "Error: No assets specified or found on the page." }], isError: true };
			}

			for (const asset of assetRequests) {
				let parsedUrl = null;
				try {
					parsedUrl = new URL(asset.url);
				} catch {
					return { content: [{ type: "text", text: `Error: Invalid URL: ${asset.url}` }], isError: true };
				}

				if (!isAllowedHost(parsedUrl.hostname)) {
					return { content: [{ type: "text", text: `Error: URL host not allowed: ${parsedUrl.hostname}` }], isError: true };
				}

				const defaultName = path.basename(parsedUrl.pathname);
				const fileName = asset.fileName && asset.fileName.trim() ? asset.fileName.trim() : defaultName;
				if (!fileName) {
					return { content: [{ type: "text", text: `Error: Unable to determine file name for ${asset.url}` }], isError: true };
				}

				const ext = path.extname(fileName).toLowerCase();
				if (asset.type === "image" && ![".png", ".jpg", ".jpeg"].includes(ext)) {
					return { content: [{ type: "text", text: "Error: Image format must be png or jpg." }], isError: true };
				}
				if (asset.type === "audio" && ![".m4a", ".ogg", ".aac", ".wav", ".mp3", ".mp4"].includes(ext)) {
					return { content: [{ type: "text", text: "Error: Unsupported audio format." }], isError: true };
				}

				const outDir = asset.type === "image" ? imageDir : audioDir;
				const outPath = path.resolve(outDir, fileName);

				try {
					const response = await axios.get(asset.url, { responseType: "arraybuffer" });
					fs.writeFileSync(outPath, Buffer.from(response.data));
					downloadedFiles.push(outPath);
				} catch (error) {
					const message = error?.message || "Unknown error";
					return { content: [{ type: "text", text: `Error downloading ${asset.url}: ${message}` }], isError: true };
				}

				if (asset.type === "audio" && ![".m4a", ".ogg"].includes(ext)) {
					try {
						const localBin = path.resolve(targetPath, "node_modules", ".bin", "complete-audio");
						const completeAudioCmd = fs.existsSync(localBin) ? `"${localBin}"` : "complete-audio";
						const command = `cd "${audioDir}" && ${completeAudioCmd} "${outPath}" -f`;
						await execAsync(command);
					} catch (error) {
						const message = error?.message || "Unknown error";
						return { content: [{ type: "text", text: `Error converting audio with complete-audio: ${message}` }], isError: true };
					}
				}

				let credit = asset.credit;
				if (!credit) {
					if (creditDefaults) {
						const baseTitle = creditDefaults.titlePrefix
							? `${creditDefaults.titlePrefix}${fileName}`
							: fileName;
						credit = {
							title: baseTitle,
							author: creditDefaults.author,
							sourceUrl: creditDefaults.sourceUrl || sourcePageUrl || asset.url,
							license: creditDefaults.license
						};
					} else {
						return { content: [{ type: "text", text: `Error: Credit is required for ${asset.url}` }], isError: true };
					}
				}

				if (credit) {
					creditLines.push(`- ${credit.title} / ${credit.author} / ${credit.sourceUrl} / ${credit.license}`);
				}
			}

			if (creditLines.length > 0) {
				const readmePath = path.resolve(targetPath, "README.md");
				const section = ["", "## Credits", ...creditLines, ""].join("\n");
				try {
					if (fs.existsSync(readmePath)) {
						fs.appendFileSync(readmePath, `${section}\n`);
					} else {
						fs.writeFileSync(readmePath, `# Assets\n${section}\n`);
					}
				} catch (error) {
					const message = error?.message || "Unknown error";
					return { content: [{ type: "text", text: `Error writing README credits: ${message}` }], isError: true };
				}
			}

			try {
				const command = `cd "${targetPath}" && akashic scan asset`;
				await execAsync(command);
			} catch (error) {
				const message = error?.message || "Unknown error";
				return { content: [{ type: "text", text: `Error during akashic scan asset: ${message}` }], isError: true };
			}

			return {
				content: [{ type: "text", text: `Imported ${downloadedFiles.length} assets and updated game.json.` }]
			};
		}
	);

	// ---------------------------------------------------------------
	// Tool 7: Headless test (headless_akashic_test)
	// ---------------------------------------------------------------
	server.tool(
		"headless_akashic_test",
		"Run a headless-akashic test to validate scene and entity expectations.",
		{
			directoryName: z.string().describe("Project directory path (relative or absolute)."),
			expectedSceneName: z.string().optional().describe("Expected scene name to assert."),
			expectedEntityTypes: z.array(z.string()).optional().describe("Expected entity types, e.g. ['Sprite','Label']."),
			expectedMinEntities: z.number().int().min(0).optional().describe("Minimum number of entities in the active scene."),
			gameJsonPath: z.string().optional().describe("Path to game.json (relative to directoryName). Defaults to 'game.json'.")
		},
		async ({ directoryName, expectedSceneName, expectedEntityTypes, expectedMinEntities, gameJsonPath }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes("..")) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			if (!expectedSceneName && (!expectedEntityTypes || expectedEntityTypes.length === 0) && expectedMinEntities === undefined) {
				return { content: [{ type: "text", text: "Error: Provide at least one expectation (scene name, entity types, or min entity count)." }], isError: true };
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);

			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return { content: [{ type: "text", text: `Error: Directory '${directoryName}' not found.` }], isError: true };
			}

			const headlessModulePath = path.resolve(targetPath, "node_modules", "@akashic", "headless-akashic");
			if (!fs.existsSync(headlessModulePath)) {
				return { content: [{ type: "text", text: "Error: @akashic/headless-akashic is not installed in the project." }], isError: true };
			}

			const testDir = path.resolve(targetPath, ".mcp");
			const testFilePath = path.resolve(testDir, "headless-test.js");
			const resolvedGameJsonPath = path.resolve(
				targetPath,
				gameJsonPath && gameJsonPath.trim() ? gameJsonPath : "game.json"
			);

			if (!fs.existsSync(resolvedGameJsonPath)) {
				return { content: [{ type: "text", text: `Error: game.json not found at ${resolvedGameJsonPath}.` }], isError: true };
			}

			try {
				fs.mkdirSync(testDir, { recursive: true });
				const testCode = [
					"const assert = require(\"node:assert\");",
					"const { GameContext } = require(\"@akashic/headless-akashic\");",
					"",
					"function parseJsonEnv(name, fallback) {",
					"\tif (!process.env[name]) return fallback;",
					"\ttry {",
					"\t\treturn JSON.parse(process.env[name]);",
					"\t} catch {",
					"\t\treturn fallback;",
					"\t}",
					"}",
					"",
					"(async () => {",
					"\tconst gameJsonPath = process.env.GAME_JSON_PATH;",
					"\tif (!gameJsonPath) throw new Error(\"GAME_JSON_PATH is required\");",
					"",
					"\tconst expectedSceneName = process.env.EXPECTED_SCENE_NAME || \"\";",
					"\tconst expectedEntityTypes = parseJsonEnv(\"EXPECTED_ENTITY_TYPES\", []);",
					"\tconst expectedMinEntities = process.env.EXPECTED_MIN_ENTITIES ? Number(process.env.EXPECTED_MIN_ENTITIES) : null;",
					"",
					"\tconst context = new GameContext({ gameJsonPath });",
					"\tconst client = await context.getGameClient();",
					"\tconst game = client.game;",
					"\tconst ageBefore = game.age;",
					"\tawait client.advance();",
					"\tconst ageAfter = game.age;",
					"\tassert(ageAfter > ageBefore, \"g.game.age did not advance\");",
					"\tawait client.advanceUntil(() => game.scene() && game.scene().loaded);",
					"\tconst scene = game.scene();",
					"\tassert(scene, \"Scene is not available\");",
					"",
					"\tif (expectedSceneName) {",
					"\t\tassert.strictEqual(scene.name, expectedSceneName, \"Scene name mismatch\");",
					"\t}",
					"",
					"\tif (expectedMinEntities !== null) {",
					"\t\tassert(scene.children.length >= expectedMinEntities, \"Not enough entities in scene\");",
					"\t}",
					"",
					"\tif (Array.isArray(expectedEntityTypes) && expectedEntityTypes.length > 0) {",
					"\t\tfor (const typeName of expectedEntityTypes) {",
					"\t\t\tconst ctor = client.g[typeName];",
					"\t\t\tassert(ctor, `Unknown entity type: ${typeName}`);",
					"\t\t\tconst found = scene.children.some((child) => child instanceof ctor);",
					"\t\t\tassert(found, `Entity type not found in scene: ${typeName}`);",
					"\t\t}",
					"\t}",
					"",
					"\tawait context.destroy();",
					"\tconsole.log(\"headless-akashic check passed\");",
					"})().catch((err) => {",
					"\tconsole.error(err && err.stack ? err.stack : String(err));",
					"\tprocess.exit(1);",
					"});",
					""
				].join("\n");

				fs.writeFileSync(testFilePath, testCode);
				const envParts = [
					`GAME_JSON_PATH="${resolvedGameJsonPath}"`,
					expectedSceneName ? `EXPECTED_SCENE_NAME="${expectedSceneName}"` : null,
					expectedEntityTypes && expectedEntityTypes.length > 0
						? `EXPECTED_ENTITY_TYPES='${JSON.stringify(expectedEntityTypes)}'`
						: null,
					typeof expectedMinEntities === "number"
						? `EXPECTED_MIN_ENTITIES="${expectedMinEntities}"`
						: null
				].filter(Boolean);
				const command = `cd "${targetPath}" && ${envParts.join(" ")} node "${testFilePath}"`;
				const { stdout, stderr } = await execAsync(command);
				const output = [stdout, stderr].filter(Boolean).join("\n");
				return {
					content: [{ type: "text", text: output || "headless-akashic check passed." }]
				};
			} catch (error) {
				const message = error?.message || "Unknown error";
				const stdout = error?.stdout ? `\nStdout: ${error.stdout}` : "";
				const stderr = error?.stderr ? `\nStderr: ${error.stderr}` : "";
				return {
					content: [{ type: "text", text: `Error during headless test: ${message}${stdout}${stderr}` }],
					isError: true,
				};
			}
		}
	);

	// ---------------------------------------------------------------
		// Tool 8: ESLint format (format_with_eslint)
	// ---------------------------------------------------------------
	server.tool(
		"format_with_eslint",
		"Format game source code using @akashic/eslint-config.",
		{
			directoryName: z.string().describe("Project directory path (relative or absolute)."),
			targetGlob: z.string().optional().describe("Glob for files to format (default: 'script/**/*.js').")
		},
		async ({ directoryName, targetGlob }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes("..")) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);

			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return { content: [{ type: "text", text: `Error: Directory '${directoryName}' not found.` }], isError: true };
			}

			const eslintConfigModule = path.resolve(targetPath, "node_modules", "@akashic", "eslint-config");
			const eslintBin = path.resolve(targetPath, "node_modules", ".bin", "eslint");
			if (!fs.existsSync(eslintConfigModule) || !fs.existsSync(eslintBin)) {
				return { content: [{ type: "text", text: "Error: eslint or @akashic/eslint-config is not installed in the project." }], isError: true };
			}

			try {
				const configPath = path.resolve(targetPath, ".mcp-eslint.config.cjs");
				const configCode = [
					"const eslintConfig = require(\"@akashic/eslint-config\");",
					"",
					"module.exports = [",
					"\t...eslintConfig,",
					"\t{",
					"\t\tfiles: [\"**/*.{js,mjs,cjs,ts}\"],",
					"\t\tlanguageOptions: {",
					"\t\t\tsourceType: \"module\"",
					"\t\t}",
					"\t}",
					"];",
					""
				].join("\n");

				fs.writeFileSync(configPath, configCode);
				const glob = targetGlob && targetGlob.trim() ? targetGlob : "script/**/*.js";
				const command = `cd "${targetPath}" && "${eslintBin}" --config "${configPath}" --fix ${glob}`;
				const { stdout, stderr } = await execAsync(command);
				const output = [stdout, stderr].filter(Boolean).join("\n");
				return {
					content: [{ type: "text", text: output || "ESLint formatting completed." }]
				};
			} catch (error) {
				const message = error?.message || "Unknown error";
				const stdout = error?.stdout ? `\nStdout: ${error.stdout}` : "";
				const stderr = error?.stderr ? `\nStderr: ${error.stderr}` : "";
				return {
					content: [{ type: "text", text: `Error during ESLint formatting: ${message}${stdout}${stderr}` }],
					isError: true,
				};
			}
		}
	);

	// ---------------------------------------------------------------
	// Tool 9: Write README (write_project_readme)
	// ---------------------------------------------------------------
	server.tool(
		"write_project_readme",
		"Write a README.md describing the game in the specified project directory.",
		{
			directoryName: z.string().describe("Project directory path (relative or absolute)."),
			title: z.string().describe("Game title for the README."),
			summary: z.string().describe("Short overview of the game."),
			features: z.array(z.string()).optional().describe("Bullet list of features."),
			controls: z.array(z.string()).optional().describe("Bullet list of controls."),
			rules: z.array(z.string()).optional().describe("Bullet list of rules."),
			runtime: z.string().optional().describe("Runtime or environment notes (e.g., Akashic Engine).")
		},
		async ({ directoryName, title, summary, features, controls, rules, runtime }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes("..")) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);

			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return { content: [{ type: "text", text: `Error: Directory '${directoryName}' not found.` }], isError: true };
			}

			const lines = [];
			lines.push(`# ${title}`);
			lines.push("");
			lines.push(summary);

			if (runtime && runtime.trim()) {
				lines.push("");
				lines.push("## Runtime");
				lines.push(runtime.trim());
			}

			if (features && features.length > 0) {
				lines.push("");
				lines.push("## Features");
				for (const item of features) {
					lines.push(`- ${item}`);
				}
			}

			if (controls && controls.length > 0) {
				lines.push("");
				lines.push("## Controls");
				for (const item of controls) {
					lines.push(`- ${item}`);
				}
			}

			if (rules && rules.length > 0) {
				lines.push("");
				lines.push("## Rules");
				for (const item of rules) {
					lines.push(`- ${item}`);
				}
			}

			try {
				const readmePath = path.resolve(targetPath, "README.md");
				fs.writeFileSync(readmePath, `${lines.join("\n")}\n`);
				return {
					content: [{ type: "text", text: "README.md written successfully." }]
				};
			} catch (error) {
				const message = error?.message || "Unknown error";
				return {
					content: [{ type: "text", text: `Error writing README.md: ${message}` }],
					isError: true,
				};
			}
		}
	);

	// ---------------------------------------------------------------
	// Tool 10: Project zip (zip_project_base64)
	// ---------------------------------------------------------------
	server.tool(
		"zip_project_base64",
		"Zip an Akashic project directory and return the zip as base64.",
		{
			directoryName: z.string().describe("Relative or absolute directory path of the project to zip."),
			zipFileName: z.string().optional().describe("Optional zip file name (e.g., 'game.zip')."),
		},
		async ({ directoryName, zipFileName }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes("..")) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);
			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return { content: [{ type: "text", text: `Error: Directory '${directoryName}' not found.` }], isError: true };
			}

			try {
				const zip = new AdmZip();
				zip.addLocalFolder(targetPath);
				const buffer = zip.toBuffer();
				const base64 = buffer.toString("base64");
				const name = zipFileName || `${path.basename(directoryName)}.zip`;
				return {
					content: [{ type: "text", text: JSON.stringify({ fileName: name, base64 }) }]
				};
			} catch (error) {
				return { content: [{ type: "text", text: `Error creating zip: ${error.message}` }], isError: true };
			}
		}
	);

	// ---------------------------------------------------------------
	// Prompt: ニコ生ゲーム設計者 (design_niconama_game)
	// ---------------------------------------------------------------
	server.prompt(
		"design_niconama_game",
		"Assistance in designing and implementing a Niconico Live Game (Akashic Engine).",
		{
			genre: z.string().optional().describe("Genre or idea (e.g. 'puzzle', 'action', 'shooting')."),
		},
		({ genre }) => {
			const genreInfo = genre ? `Target Genre: ${genre}` : "Target Genre: Any";
			
			return {
				messages: [
					{
						role: "user",
						content: {
							type: "text",
							text: `あなたは熟練したAkashic Engine開発者であり、ニコ生ゲーム制作のプロフェッショナルです。
ユーザーのアイデアを実現するために、以下のフローで支援を行ってください。

${genreInfo}

**開発ガイドライン:**
1. **情報収集**: まず 'search_akashic_docs' を使用し、実装に必要なAPI（例: 音声再生、当たり判定、乱数生成）の最新仕様やニコ生ゲームの作成方法を確認してください。
2. **プロジェクト作成**: プロジェクトが存在しない場合、ユーザーに確認の上 'init_project' を提案・実行してください（推奨テンプレート: typescript-shin-ichiba-ranking）。
3. **実装**: 'create_game_file' を使用してコードを作成してください。
	 - main.ts (またはmain.js) にロジックを記述します。
	   - 'init_project' や 'init_minimal_template' でテンプレートを生成した場合、main.ts (またはmain.js)の main() 関数の export 方法は変えず、main() 関数の中身を修正してください。
	   - main.ts (またはmain.js)のステップ数が500行を超えるのであれば、エンティティやシーンなどのオブジェクトやutil関数を別ファイルに切り出してください。
	 - ランキングゲームを作成する場合は、「ランキングゲーム | Akashic Engine」(https://akashic-games.github.io/shin-ichiba/ranking/) を参考にしてください。
	 - 'format_with_eslint' を使用して作成したコードを整形してください。
4. **game.json更新**: 'akashic_scan_asset' を使用してgame.jsonを更新してください。
5. **ゲームデバッグ**: 'headless_akashic_test' でテストが通ることを確認してください。テストが通らない場合は コードを修正してください。

**コード品質:**
- 可読性の高いコードを記述してください。
- 必要なコメントを追加してください。
- エラーハンドリング（画像のロード待ちなど）を適切に行ってください。

**Akashic Engine 利用の際の注意点:**
- Akashic Engine v3系のAPIを使用してください。
- game.json については、何かしら指定がない限り基本的にはテンプレートのままで変更しないでください。
- Akashic EngineのAPIを使うときはimportを使わず、接頭辞にg.をつけてください。
- g.Scene#loadedやg.Scene#updateはv3では非推奨です。g.Scene#onLoadやg.Scene#onUpdateを使用してください。また、基本的にはv3で使用可能でも非推奨のAPIは使用しないようにしてください。
- JavaScriptの場合、CommonJS形式且つES2015以降の記法でコードを作成してください。
- g.Sceneにageは存在しません。ageを利用する場合はg.game.ageを利用してください。
- g.gameにonLoad()などのトリガーは存在しません。onLoad()はg.Sceneのメソッドです。
- g.Labelを使用する場合、特に指定が無ければ g.DynamicFont を生成して、g.Labelのfontプロパティに指定してください。
  - g.DynamicFont 生成時は、game, size, fontFamily をそれぞれ指定してください。fontFamilyとして以下の文字列のうち、いずれかを使用してください
    - "sans-serif"
    - "serif"
    - "monospace"
  - フォントデータ(フォント画像、フォントの設定が書かれたテキスト)を指定された場合は、そのデータの g.BitmapFont を生成・使用してください。
`
						}
					}
				]
			};
		}
	);

	return server;
}

const sseTransports = new Map();
let mcpServerPromise = null;

function getSessionId(req, url) {
	const header = req.headers["mcp-session-id"];
	if (typeof header === "string" && header.trim()) {
		return header.trim();
	}
	if (Array.isArray(header) && header.length > 0) {
		return header[0];
	}
	const querySession = url?.searchParams?.get("sessionId") || url?.searchParams?.get("session_id");
	if (querySession && querySession.trim()) {
		return querySession.trim();
	}
	return null;
}

let proxyClient = null;
let proxyClientPromise = null;

async function getProxyClient(baseUrl) {
	if (proxyClient) {
		return proxyClient;
	}
	if (proxyClientPromise) {
		return proxyClientPromise;
	}

	proxyClientPromise = (async () => {
		const transport = new SSEClientTransport(new URL(`${baseUrl}/mcp/sse`));
		const client = new Client({
			name: "akashic-mcp-proxy",
			version: "1.0.0",
		});
		await client.connect(transport);
		proxyClient = client;
		proxyClientPromise = null;
		return client;
	})().catch((error) => {
		proxyClientPromise = null;
		throw error;
	});

	return proxyClientPromise;
}

async function readJsonBody(req) {
	let raw = "";
	for await (const chunk of req) {
		raw += chunk;
	}
	if (!raw) {
		return null;
	}
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

function sendJson(res, statusCode, payload) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}

async function main() {
	const port = Number(process.env.PORT || 8080);
	const basePath = "/mcp";
	const ssePath = `${basePath}/sse`;
	const messagePath = `${basePath}/messages`;
	const proxyBasePath = "/proxy";
	const toolsPath = `${proxyBasePath}/tools`;
	const callPath = `${proxyBasePath}/call`;
	const baseUrl = `http://localhost:${port}`;

	const httpServer = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url || "", `http://localhost:${port}`);
			const pathname = url.pathname;

			const isSseRequest = req.method === "GET" && (pathname === ssePath || pathname === basePath);
			if (isSseRequest) {
				if (!mcpServerPromise) {
					mcpServerPromise = createMcpServer();
				}
				const mcpServer = await mcpServerPromise;
				const transport = new SSEServerTransport(messagePath, res);
				const sessionId = transport.sessionId;
				if (sessionId) {
					sseTransports.set(sessionId, transport);
					res.on("close", () => {
						sseTransports.delete(sessionId);
					});
				} else {
					console.error("SSE transport missing sessionId; POST routing may fail.");
				}
				await mcpServer.connect(transport);
				return;
			}

			const isMessageRequest = req.method === "POST" && (pathname === messagePath || pathname === ssePath);
			if (isMessageRequest) {
				try {
					const sessionId = getSessionId(req, url);
					if (!sessionId) {
						return sendJson(res, 400, { error: "Missing sessionId." });
					}
					const transport = sseTransports.get(sessionId);
					if (!transport) {
						return sendJson(res, 404, { error: "Unknown sessionId." });
					}
					if (typeof transport.handlePostMessage === "function") {
						await transport.handlePostMessage(req, res);
						return;
					}
					if (typeof SSEServerTransport.handlePostMessage === "function") {
						await SSEServerTransport.handlePostMessage(req, res);
						return;
					}
					return sendJson(res, 500, { error: "SSE transport does not support POST handling." });
				} catch (error) {
					const message = error?.message || "Failed to process MCP message.";
					console.error("MCP message error:", message);
					return sendJson(res, 400, { error: message });
				}
			}

			if (req.method === "GET" && pathname === toolsPath) {
				const client = await getProxyClient(baseUrl);
				const tools = await client.listTools();
				return sendJson(res, 200, tools);
			}

			if (req.method === "POST" && pathname === callPath) {
				const body = await readJsonBody(req);
				if (body === undefined) {
					return sendJson(res, 400, { error: "Invalid JSON body." });
				}
				if (!body || typeof body.name !== "string") {
					return sendJson(res, 400, { error: "Missing tool name." });
				}
				const args = body.arguments && typeof body.arguments === "object" ? body.arguments : {};
				const client = await getProxyClient(baseUrl);
				const result = await client.callTool({ name: body.name, arguments: args });
				return sendJson(res, 200, result);
			}

			res.statusCode = 404;
			res.end("Not Found");
		} catch (error) {
			res.statusCode = 500;
			res.end("Internal Server Error");
			console.error("HTTP handler error:", error);
		}
	});

	httpServer.listen(port, () => {
		console.error(`Akashic MCP Server listening on http://localhost:${port}${basePath}`);
		console.error(`SSE endpoint: ${ssePath}`);
		console.error(`Message endpoint: ${messagePath}`);
		console.error(`Proxy tools endpoint: ${toolsPath}`);
		console.error(`Proxy call endpoint: ${callPath}`);
	});
}

// エラーハンドリング付きで実行
main().catch((error) => {
	console.error("Fatal error in main():", error);
	process.exit(1);
});
