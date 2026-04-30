import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";
import fs from 'fs';
import path from 'path';
import http from 'http';
import net from 'net';
import { exec, spawn } from 'child_process';
import util from 'util';

// execをPromise化して非同期処理しやすくする
const execAsync = util.promisify(exec);
const isWindows = process.platform === "win32";
let cachedChromium = null;
let playwrightInstallPromise = null;
let playwrightReady = false;

function getNpxCommand() {
	return process.env.NPX_BINARY ?? (isWindows ? "npx.cmd" : "npx");
}

function buildSpawnOptions(baseOptions = {}) {
	return {
		...baseOptions,
		shell: isWindows
	};
}

function runTaskkill(pid) {
	return new Promise((resolve) => {
		if (!isWindows || typeof pid !== "number" || pid <= 0) {
			resolve(false);
			return;
		}
		const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true
		});
		killer.once("error", () => resolve(false));
		killer.once("exit", (code) => resolve(code === 0));
	});
}

async function ensurePlaywrightChromiumInstalled() {
	if (playwrightReady && cachedChromium) {
		return { ok: true, chromium: cachedChromium };
	}
	if (playwrightInstallPromise) {
		return playwrightInstallPromise;
	}

	playwrightInstallPromise = (async () => {
		let playwright = null;
		try {
			playwright = await import("playwright");
		} catch {
			return {
				ok: false,
				message: "Missing dependency: 'playwright'. Install it with: npm install playwright"
			};
		}

		const chromium = playwright.chromium;
		const executablePath = chromium.executablePath();
		if (executablePath && fs.existsSync(executablePath)) {
			cachedChromium = chromium;
			playwrightReady = true;
			return { ok: true, chromium };
		}

		try {
			const npxCommand = getNpxCommand();
			console.error(`[Info] Playwright Chromium not found. Running: ${npxCommand} playwright install chromium`);
			await execAsync(`"${npxCommand}" playwright install chromium`);
		} catch (error) {
			const message = error && error.message ? error.message : "Unknown error";
			const stderr = error && error.stderr ? `\nStderr: ${error.stderr}` : "";
			return {
				ok: false,
				message: `Failed to install Playwright Chromium: ${message}${stderr}`
			};
		}

		const installedPath = chromium.executablePath();
		if (installedPath && fs.existsSync(installedPath)) {
			cachedChromium = chromium;
			playwrightReady = true;
			console.error("[Info] Playwright Chromium is ready.");
			return { ok: true, chromium };
		}

		return {
			ok: false,
			message: "Playwright Chromium install finished but executable was not found."
		};
	})().finally(() => {
		playwrightInstallPromise = null;
	});

	return playwrightInstallPromise;
}

function warmupPlaywrightChromiumInBackground() {
	if (process.env.AKASHIC_AUTO_INSTALL_PLAYWRIGHT === "0") {
		console.error("[Info] Skipped Playwright auto-install (AKASHIC_AUTO_INSTALL_PLAYWRIGHT=0).");
		return;
	}
	// Fire-and-forget warmup; akashic_serve waits on the same promise if still running.
	void ensurePlaywrightChromiumInstalled().then((result) => {
		if (!result.ok) {
			console.error(`[Warning] Playwright warmup failed: ${result.message}`);
		}
	});
}

// =================================================================
// 1. 事前準備: ドキュメントデータの読み込み
// =================================================================
function getDocsData(docsPath, label) {
	let docsData = [];
	try {
		if (fs.existsSync(docsPath)) {
			const parsed = JSON.parse(fs.readFileSync(docsPath, 'utf-8'));
			if (Array.isArray(parsed)) {
				docsData = parsed;
			}
			console.log(`[Info] Loaded ${docsData.length} documents from ${label}`);
		} else {
			console.error(`[Warning] ${label} not found. Related docs will be empty.`);
		}
	} catch (error) {
		console.error("[Error] Failed to load docs:", error.message);
	}
	return docsData;
}
const docsData = getDocsData(path.resolve('./data/akashic_docs.json'), "akashic_docs.json");
const apiData = getDocsData(path.resolve('./data/akashic-engine.json'), "akashic-engine.json");

function normalizeDocItem(item, sourceName) {
	const title = typeof item?.title === "string" ? item.title.trim() : "";
	const url = typeof item?.url === "string" ? item.url.trim() : "";
	const content = typeof item?.content === "string" ? item.content : "";
	if (!title && !url && !content) return null;
	return { source: sourceName, title, url, content };
}

const allDocsData = [
	...docsData.map((item) => normalizeDocItem(item, "official-docs")),
	...apiData.map((item) => normalizeDocItem(item, "akashic-engine-repo")),
].filter(Boolean);

function buildApiSummaryIndex(data, maxItems = 60) {
	const seen = new Set();
	const lines = [];
	for (const doc of data) {
		if (!doc || (!doc.title && !doc.url)) continue;
		const key = `${doc.title}::${doc.url}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const title = doc.title || "(no title)";
		const line = `- [${doc.source}] ${title}${doc.url ? ` | ${doc.url}` : ""}`;
		lines.push(line);
		if (lines.length >= maxItems) break;
	}
	return [
		"## 事前ロード済み API 要約インデックス",
		"* 詳細本文は必要なときだけ search_akashic_docs で取得すること",
		...lines
	].join("\n");
}

const apiSummaryIndexForPrompt = buildApiSummaryIndex([
	...apiData.map((item) => normalizeDocItem(item, "akashic-engine-repo")),
].filter(Boolean));


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
		"Search and fetch detailed information from preloaded Akashic docs/repo references.",
		{
			query: z.string().describe("Search keyword (e.g. 'click event', 'g.Sprite', 'audio')."),
			maxResults: z.number().int().min(1).max(10).optional().describe("Maximum number of hits (default: 3)."),
		},
		async ({ query, maxResults }) => {
			const q = query.toLowerCase();
			const limit = typeof maxResults === "number" ? maxResults : 3;
			// タイトルまたは本文にキーワードが含まれるものを検索
			const results = allDocsData
				.filter((doc) =>
					(doc.title && doc.title.toLowerCase().includes(q)) || 
					(doc.content && doc.content.toLowerCase().includes(q))
				)
				.slice(0, limit)
				.map((doc) => {
					const excerpt = doc.content ? doc.content.substring(0, 700) : "";
					return [
						`Source: ${doc.source}`,
						`Title: ${doc.title || "(no title)"}`,
						`URL: ${doc.url || "(no url)"}`,
						"",
						excerpt ? `${excerpt}...` : "(no content)"
					].join("\n");
				});

			return {
				content: [{ type: "text", text: results.join("\n\n---\n\n") || "No relevant documents found." }]
			};
		}
	);

	// ---------------------------------------------------------------
	// Tool 1.1: API要約インデックス取得 (get_api_summary_index)
	// ---------------------------------------------------------------
	server.tool(
		"get_api_summary_index",
		"Get the preloaded lightweight API summary index. Use this first, then fetch details with search_akashic_docs.",
		{},
		async () => {
			return {
				content: [{ type: "text", text: apiSummaryIndexForPrompt }]
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
			directoryName: z.string().optional().describe("Project directory path (relative or absolute). Recommended."),
			filePath: z.string().describe("File path inside the project directory (e.g., 'script/main.js' or 'game.json')."),
			code: z.string().describe("The full content of the file."),
			forbidGameJsonUpdate: z.boolean().optional().describe("When true, prevents writing to game.json."),
		},
		async ({ directoryName, filePath, code, forbidGameJsonUpdate }) => {
			if (directoryName && !path.isAbsolute(directoryName) && directoryName.includes('..')) {
				return {
					content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }],
					isError: true
				};
			}

			if (!path.isAbsolute(filePath) && filePath.includes('..')) {
				return { 
					content: [{ type: "text", text: "Error: Invalid file path. Avoid '..' in relative paths." }], 
					isError: true 
				};
			}

			try {
				const fullPath = path.isAbsolute(filePath)
					? path.normalize(filePath)
					: null;
				const inferProjectRoot = (startPath) => {
					let currentDir = path.dirname(startPath);
					for (let depth = 0; depth < 8; depth += 1) {
						if (fs.existsSync(path.resolve(currentDir, "game.json"))) {
							return currentDir;
						}
						const parentDir = path.dirname(currentDir);
						if (parentDir === currentDir) {
							break;
						}
						currentDir = parentDir;
					}
					return null;
				};

				const targetPath = directoryName
					? (path.isAbsolute(directoryName)
						? path.normalize(directoryName)
						: path.resolve(process.cwd(), directoryName))
					: (fullPath ? inferProjectRoot(fullPath) : null);
				if (!targetPath || !fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
					return {
						content: [{ type: "text", text: "Error: Project directory could not be determined. Pass directoryName or use an absolute filePath inside a project." }],
						isError: true
					};
				}

				const resolvedFullPath = fullPath ?? path.resolve(targetPath, filePath);
				if (!resolvedFullPath.startsWith(targetPath + path.sep) && resolvedFullPath !== targetPath) {
					return {
						content: [{ type: "text", text: "Error: filePath must be inside the project directory." }],
						isError: true
					};
				}

				const relativePath = path.relative(targetPath, resolvedFullPath).replace(/\\/g, "/");
				if (!relativePath || relativePath.startsWith("..")) {
					return {
						content: [{ type: "text", text: "Error: filePath must be inside the project directory." }],
						isError: true
					};
				}

				if (path.basename(resolvedFullPath).toLowerCase() === "game.json" && relativePath !== "game.json") {
					return {
						content: [{ type: "text", text: "Error: game.json must exist directly under the project directory." }],
						isError: true,
					};
				}
				if (forbidGameJsonUpdate && relativePath.toLowerCase() === "game.json") {
					return {
						content: [{ type: "text", text: "Error: game.json updates are forbidden by option." }],
						isError: true,
					};
				}
				const dir = path.dirname(resolvedFullPath);
				
				if (!fs.existsSync(dir)) {
					fs.mkdirSync(dir, { recursive: true });
				}
				
				fs.writeFileSync(resolvedFullPath, code);
				return {
					content: [{ type: "text", text: `Successfully wrote file to: ${relativePath}` }]
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

				if (!fs.existsSync(path.resolve(targetPath, "game.json"))) {
					return {
						content: [{ type: "text", text: "Error during initialization: game.json was not created in the project root." }],
						isError: true,
					};
				}

				return {
					content: [{ 
						type: "text", 
						text: `Project initialized successfully in '${directoryName}'.\nTemplate: ${templateType}\nDependencies installed: ${skipNpmInstall ? "skipped" : "yes"}.` 
					}]
				};

			} catch (error) {
				const message = error && error.message ? error.message : "Unknown error";
				const stdout = error && error.stdout ? `\nStdout: ${error.stdout}` : "";
				const stderr = error && error.stderr ? `\nStderr: ${error.stderr}` : "";
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

				if (!fs.existsSync(path.resolve(targetPath, "game.json"))) {
					return {
						content: [{ type: "text", text: "Error during template initialization: game.json was not created in the project root." }],
						isError: true,
					};
				}

				return {
					content: [{
						type: "text",
						text: `Project initialized from template in '${directoryName}'.`
					}]
				};
			} catch (error) {
				const message = error && error.message ? error.message : "Unknown error";
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
				const message = error && error.message ? error.message : "Unknown error";
				const stdout = error && error.stdout ? `\nStdout: ${error.stdout}` : "";
				const stderr = error && error.stderr ? `\nStderr: ${error.stderr}` : "";
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
				(name) => !/^@akashic(-extension)?\//.test(name)
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
				const message = error && error.message ? error.message : "Unknown error";
				const stdout = error && error.stdout ? `\nStdout: ${error.stdout}` : "";
				const stderr = error && error.stderr ? `\nStderr: ${error.stderr}` : "";
				return {
					content: [{ type: "text", text: `Error during akashic install: ${message}${stdout}${stderr}` }],
					isError: true,
				};
			}
		}
	);

	// ---------------------------------------------------------------
	// Tool 6: Local asset import (import_local_assets)
	// ---------------------------------------------------------------
	server.tool(
		"import_local_assets",
		"Import local image/audio assets into the project.",
		{
			directoryName: z.string().describe("Project directory path (relative or absolute)."),
			assets: z.array(z.object({
				localPath: z.string().describe("Local file path to import."),
				type: z.enum(["image", "audio"]).describe("Asset type."),
				targetDir: z.string().optional().describe("Optional destination directory (relative or absolute)."),
				fileName: z.string().optional().describe("Optional file name override."),
				credit: z.object({
					title: z.string().describe("Asset title."),
					author: z.string().describe("Author name."),
					sourceUrl: z.string().describe("Source page URL."),
					license: z.string().describe("License name.")
				}).optional().describe("Credit information to append to README.")
			})).min(1).describe("Assets to import.")
		},
		async ({ directoryName, assets }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes("..")) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);

			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return { content: [{ type: "text", text: `Error: Directory '${directoryName}' not found.` }], isError: true };
			}

			const resolveLocalPath = (rawPath) => {
				if (!rawPath || !rawPath.trim()) return null;
				const trimmed = rawPath.trim();
				const candidates = [];
				const distroName = process.env.WSL_DISTRO_NAME || "Ubuntu";

				if (/^file:\/\//i.test(trimmed)) {
					try {
						const fileUrl = new URL(trimmed);
						const urlPath = decodeURIComponent(fileUrl.pathname || "");
						if (urlPath) {
							candidates.push(path.normalize(urlPath));
						}
					} catch {
						// ignore invalid file URL
					}
				}

				if (path.isAbsolute(trimmed)) {
					candidates.push(path.normalize(trimmed));
				} else {
					candidates.push(path.resolve(process.cwd(), trimmed));
				}

				if (process.platform === "win32") {
					if (trimmed.startsWith("/home/")) {
						const wslPath = `\\\\wsl.localhost\\${distroName}${trimmed.replace(/\//g, "\\")}`;
						candidates.push(wslPath);
					}
					if (trimmed.startsWith("/mnt/")) {
						const parts = trimmed.split("/");
						if (parts.length > 2 && /^[a-zA-Z]$/.test(parts[2])) {
							const drive = parts[2].toUpperCase();
							const rest = parts.slice(3).join("\\");
							const winPath = `${drive}:\\${rest}`;
							candidates.push(winPath);
						}
					}
				}

				const winDriveMatch = /^[a-zA-Z]:[\\/]/.test(trimmed);
				if (winDriveMatch) {
					const winPath = trimmed.replace(/\//g, "\\");
					candidates.push(path.win32.normalize(winPath));
					if (process.platform !== "win32") {
						const drive = trimmed[0].toLowerCase();
						const rest = trimmed.slice(2).replace(/\\/g, "/");
						const mapped = `/mnt/${drive}${rest.startsWith("/") ? "" : "/"}${rest}`;
						candidates.push(mapped);
					}
				}

				const wslMatch = /^\\\\wsl\.localhost\\[^\\]+\\(.+)$/.exec(trimmed);
				if (wslMatch) {
					const rel = wslMatch[1].replace(/\\/g, "/");
					candidates.push(`/${rel}`);
				}

				for (const candidate of candidates) {
					try {
						if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
							return candidate;
						}
					} catch {
						// ignore invalid candidate
					}
				}
				return null;
			};

			const imageDir = path.resolve(targetPath, "image");
			const audioDir = path.resolve(targetPath, "audio");
			fs.mkdirSync(imageDir, { recursive: true });
			fs.mkdirSync(audioDir, { recursive: true });

			const creditLines = [];
			const importedFiles = [];
			for (let index = 0; index < assets.length; index++) {
				const asset = assets[index];
				const rawLocalPath = asset.localPath;
				const resolvedLocalPath = resolveLocalPath(rawLocalPath);
				if (!resolvedLocalPath) {
					return {
						content: [{ type: "text", text: `Error: Local file not found or inaccessible: ${rawLocalPath}` }],
						isError: true
					};
				}

				let fileName = asset.fileName && asset.fileName.trim() ? asset.fileName.trim() : path.basename(resolvedLocalPath);
				if (!fileName) {
					return { content: [{ type: "text", text: `Error: Unable to determine file name for ${rawLocalPath}` }], isError: true };
				}

				const ext = path.extname(fileName).toLowerCase();
				if (asset.type === "image" && ![".png", ".jpg", ".jpeg"].includes(ext)) {
					return { content: [{ type: "text", text: "Error: Image format must be png or jpg." }], isError: true };
				}
				if (asset.type === "audio" && ![".m4a", ".ogg", ".aac", ".wav", ".mp3", ".mp4"].includes(ext)) {
					return { content: [{ type: "text", text: "Error: Unsupported audio format." }], isError: true };
				}

				if (asset.type === "image") {
					const baseDir = asset.targetDir && asset.targetDir.trim()
						? path.resolve(targetPath, asset.targetDir.trim())
						: imageDir;
					if (!baseDir.startsWith(targetPath)) {
						return { content: [{ type: "text", text: "Error: targetDir must be inside the project directory." }], isError: true };
					}
					fs.mkdirSync(baseDir, { recursive: true });
					const outPath = path.resolve(baseDir, fileName);
					try {
						fs.copyFileSync(resolvedLocalPath, outPath);
						importedFiles.push(outPath);
					} catch (error) {
						const message = error && error.message ? error.message : "Unknown error";
						return { content: [{ type: "text", text: `Error copying ${rawLocalPath}: ${message}` }], isError: true };
					}
				} else {
					const baseDir = asset.targetDir && asset.targetDir.trim()
						? path.resolve(targetPath, asset.targetDir.trim())
						: audioDir;
					if (!baseDir.startsWith(targetPath)) {
						return { content: [{ type: "text", text: "Error: targetDir must be inside the project directory." }], isError: true };
					}
					fs.mkdirSync(baseDir, { recursive: true });
					try {
						const outPath = path.resolve(baseDir, fileName);
						fs.copyFileSync(resolvedLocalPath, outPath);
						importedFiles.push(outPath);
					} catch (error) {
						const message = error && error.message ? error.message : "Unknown error";
						return { content: [{ type: "text", text: `Error copying ${rawLocalPath}: ${message}` }], isError: true };
					}
				}

				const credit = asset.credit;
				if (!credit) {
					return { content: [{ type: "text", text: `Error: Credit is required for ${rawLocalPath}` }], isError: true };
				}
				creditLines.push(`- ${credit.title} / ${credit.author} / ${credit.sourceUrl} / ${credit.license}`);
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
					const message = error && error.message ? error.message : "Unknown error";
					return { content: [{ type: "text", text: `Error writing README credits: ${message}` }], isError: true };
				}
			}

	return {
		content: [{ type: "text", text: `Imported ${importedFiles.length} assets.` }]
	};
}
);

	// ---------------------------------------------------------------
	// Tool 7: complete-audio (run_complete_audio)
	// ---------------------------------------------------------------
	server.tool(
		"run_complete_audio",
		"Run @akashic/complete-audio in a directory and clean up non-audio outputs.",
		{
			directoryName: z.string().describe("Target directory path (relative or absolute)."),
		},
		async ({ directoryName }) => {
			console.error("[info] run_complete_audio", directoryName);
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
				const logLines = [];
				logLines.push(`Target: ${targetPath}`);
				const beforeFiles = fs.readdirSync(targetPath).filter((file) => {
					try {
						return fs.statSync(path.resolve(targetPath, file)).isFile();
					} catch {
						return false;
					}
				});
				logLines.push(`Files before: ${beforeFiles.join(", ") || "(none)"}`);
				const localBin = path.resolve(targetPath, "node_modules", ".bin", "complete-audio");
				const candidates = beforeFiles.filter((file) => {
					const ext = path.extname(file).toLowerCase();
					if (!ext) return false;
					return ![".ogg", ".m4a", ".aac"].includes(ext);
				});
				logLines.push(`Conversion targets: ${candidates.join(", ") || "(none)"}`);
				console.error(`[info] Conversion targets: ${candidates.join(", ") || "(none)"}`);

				for (const file of candidates) {
					const filePath = path.resolve(targetPath, file);
					const command = fs.existsSync(localBin)
						? `cd "${targetPath}" && "${localBin}" -f "${filePath}"`
						: `cd "${targetPath}" && npx @akashic/complete-audio -f "${filePath}"`;
					logLines.push(`Command: ${command}`);
					console.error("[info] run_complete_audio command: ", command);

					const { stdout, stderr } = await execAsync(command);
					if (stdout && stdout.trim()) logLines.push(`stdout:\n${stdout}`);
					if (stderr && stderr.trim()) logLines.push(`stderr:\n${stderr}`);
					console.error(`[info] stdout:\n${stdout}`);
					console.error(`[info] stderr:\n${stderr}`);
				}

				const keepExt = new Set([".ogg", ".m4a", ".aac"]);
				const files = fs.readdirSync(targetPath);
				let removedCount = 0;
				let keptCount = 0;
				for (const file of files) {
					const fullPath = path.resolve(targetPath, file);
					if (!fs.statSync(fullPath).isFile()) continue;
					const ext = path.extname(file).toLowerCase();
					if (!keepExt.has(ext)) {
						fs.unlinkSync(fullPath);
						removedCount += 1;
					} else {
						keptCount += 1;
					}
				}

				logLines.push(`Cleanup: kept=${keptCount}, removed=${removedCount}`);

				return {
					content: [{ type: "text", text: logLines.join("\n") }]
				};
			} catch (error) {
				const message = error && error.message ? error.message : "Unknown error";
				const stdout = error && error.stdout ? `\nStdout: ${error.stdout}` : "";
				const stderr = error && error.stderr ? `\nStderr: ${error.stderr}` : "";
				return {
					content: [{ type: "text", text: `Error running complete-audio: ${message}${stdout}${stderr}` }],
					isError: true,
				};
			}
		}
	);

	// ---------------------------------------------------------------
	// Tool 8: Serve and inspect console (akashic_serve)
	// ---------------------------------------------------------------
	server.tool(
		"akashic_serve",
		"Serve an Akashic project for a fixed duration, inspect browser devtools console logs, and map errors to source lines.",
		{
			directoryName: z.string().describe("Project directory path (relative or absolute)."),
			durationMs: z.number().int().min(1000).max(120000).optional().describe("How long to run the game in milliseconds (default: 10000)."),
			port: z.number().int().min(1).max(65535).optional().describe("Serve port (default: 3300)."),
			entryPath: z.string().optional().describe("Path to open in browser (default: '/')."),
		},
		async ({ directoryName, durationMs, port, entryPath }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes("..")) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);
			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return { content: [{ type: "text", text: `Error: Directory '${directoryName}' not found.` }], isError: true };
			}

			const gameJsonPath = path.resolve(targetPath, "game.json");
			if (!fs.existsSync(gameJsonPath)) {
				return { content: [{ type: "text", text: "Error: game.json not found in project directory." }], isError: true };
			}

			const runDurationMs = typeof durationMs === "number" ? durationMs : 10000;
			const servePort = typeof port === "number" ? port : 25252; // Math.round(10000 * Math.random()) + 20000
			const openPath = entryPath && entryPath.trim() ? entryPath.trim() : "/";
			const serveUrl = `http://127.0.0.1:${servePort}${openPath.startsWith("/") ? openPath : `/${openPath}`}`;

			const command = getNpxCommand();
			const args = ["akashic", "serve", "--port", String(servePort), "-B"];

			const playwrightSetup = await ensurePlaywrightChromiumInstalled();
			if (!playwrightSetup.ok) {
				return {
					content: [{
						type: "text",
						text: `Error: ${playwrightSetup.message}`
					}],
					isError: true
				};
			}
			const chromium = playwrightSetup.chromium;

			const stdoutLogs = [];
			const stderrLogs = [];
			const consoleLogs = [];
			const errorLogs = [];
			const pageErrors = [];

			const maxLogItems = 200;
			const pushLimited = (arr, value) => {
				if (arr.length < maxLogItems) arr.push(value);
			};

			const serveProcess = spawn(command, args, {
				cwd: targetPath,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: !isWindows,
				windowsHide: true,
				...buildSpawnOptions()
			});

			const waitForPortClose = (portNumber, timeoutMs) => new Promise((resolve) => {
				const start = Date.now();
				const check = () => {
					const socket = new net.Socket();
					let settled = false;
					const done = (isClosed) => {
						if (settled) return;
						settled = true;
						try {
							socket.destroy();
						} catch {
							// ignore
						}
						resolve(isClosed);
					};
					socket.setTimeout(400);
					socket.once("connect", () => {
						const elapsed = Date.now() - start;
						if (elapsed >= timeoutMs) {
							done(false);
							return;
						}
						setTimeout(check, 150);
					});
					socket.once("timeout", () => done(true));
					socket.once("error", () => done(true));
					try {
						socket.connect(portNumber, "127.0.0.1");
					} catch {
						done(true);
					}
				};
				check();
			});

			const waitForServeProcessExit = (timeoutMs) => new Promise((resolve) => {
				if (serveProcess.exitCode !== null) {
					resolve();
					return;
				}
				let settled = false;
				const done = () => {
					if (settled) return;
					settled = true;
					resolve();
				};
				serveProcess.once("close", done);
				setTimeout(done, timeoutMs);
			});

			const killServeProcessGroup = (signal) => {
				if (isWindows) {
					return false;
				}
				try {
					if (typeof serveProcess.pid === "number" && serveProcess.pid > 0) {
						// Kill the entire process group created by detached spawn.
						process.kill(-serveProcess.pid, signal);
						return true;
					}
				} catch {
					// ignore and fallback
				}
				try {
					serveProcess.kill(signal);
					return true;
				} catch {
					return false;
				}
			};

			const cleanupServeProcess = async () => {
				if (isWindows) {
					await runTaskkill(serveProcess.pid);
				} else {
					killServeProcessGroup("SIGTERM");
				}
				await waitForServeProcessExit(1000);
				let portClosed = await waitForPortClose(servePort, 2000);
				if (serveProcess.exitCode === null || !portClosed) {
					if (isWindows) {
						await runTaskkill(serveProcess.pid);
					} else {
						killServeProcessGroup("SIGKILL");
					}
					await waitForServeProcessExit(1000);
					portClosed = await waitForPortClose(servePort, 2500);
				}
				return portClosed;
			};

			serveProcess.stdout.on("data", (chunk) => {
				pushLimited(stdoutLogs, String(chunk).trim());
			});
			serveProcess.stderr.on("data", (chunk) => {
				pushLimited(stderrLogs, String(chunk).trim());
			});

			const findFileByBaseName = (rootDir, fileName) => {
				const skipDirs = new Set(["node_modules", ".git", ".mcp", "tmp", "dist", "build"]);
				const walk = (dir) => {
					const entries = fs.readdirSync(dir, { withFileTypes: true });
					for (const entry of entries) {
						if (entry.isDirectory()) {
							if (skipDirs.has(entry.name)) continue;
							const nested = walk(path.resolve(dir, entry.name));
							if (nested) return nested;
						} else if (entry.isFile() && entry.name === fileName) {
							return path.resolve(dir, entry.name);
						}
					}
					return null;
				};
				try {
					return walk(rootDir);
				} catch {
					return null;
				}
			};

			const mapErrorToSource = (text) => {
				const patterns = [
					/(https?:\/\/[^)\s]+\.js):(\d+):(\d+)/,
					/(\/[^)\s]+\.js):(\d+):(\d+)/,
					/([A-Za-z0-9_.-]+\.js):(\d+):(\d+)/
				];
				for (const pattern of patterns) {
					const match = text.match(pattern);
					if (!match) continue;
					const rawPath = match[1];
					const line = Number(match[2]);
					const column = Number(match[3]);
					let resolved = null;
					if (/^https?:\/\//.test(rawPath)) {
						try {
							const u = new URL(rawPath);
							const fromUrlPath = u.pathname.startsWith("/") ? u.pathname.slice(1) : u.pathname;
							const candidate = path.resolve(targetPath, fromUrlPath);
							if (candidate.startsWith(targetPath) && fs.existsSync(candidate)) {
								resolved = candidate;
							}
						} catch {
							// ignore
						}
					} else if (rawPath.startsWith("/")) {
						const candidate = path.resolve(targetPath, rawPath.slice(1));
						if (candidate.startsWith(targetPath) && fs.existsSync(candidate)) {
							resolved = candidate;
						}
					} else {
						const direct = path.resolve(targetPath, rawPath);
						if (direct.startsWith(targetPath) && fs.existsSync(direct)) {
							resolved = direct;
						} else {
							resolved = findFileByBaseName(targetPath, path.basename(rawPath));
						}
					}

					let sourceLine = null;
					if (resolved && fs.existsSync(resolved)) {
						try {
							const lines = fs.readFileSync(resolved, "utf-8").split(/\r?\n/);
							sourceLine = line > 0 && line <= lines.length ? lines[line - 1] : null;
						} catch {
							// ignore
						}
					}
					return {
						rawPath,
						file: resolved ? path.relative(targetPath, resolved).replace(/\\/g, "/") : null,
						line,
						column,
						sourceLine
					};
				}
				return null;
			};

			let browser = null;
			try {
				// akashic_serve always runs Playwright in headless mode.
				browser = await chromium.launch({ headless: true });
				const page = await browser.newPage();

				page.on("console", (msg) => {
					const text = msg.text();
					const type = msg.type();
					const location = msg.location();
					const item = {
						type,
						text,
						url: location && location.url ? location.url : null,
						lineNumber: location && typeof location.lineNumber === "number" ? location.lineNumber + 1 : null,
						columnNumber: location && typeof location.columnNumber === "number" ? location.columnNumber + 1 : null
					};
					pushLimited(consoleLogs, item);
					if (type === "error") {
						pushLimited(errorLogs, item);
					}
				});

				page.on("pageerror", (error) => {
					const text = error && error.stack ? String(error.stack) : String(error);
					pushLimited(pageErrors, { type: "pageerror", text });
					pushLimited(errorLogs, { type: "pageerror", text });
				});

				let opened = false;
				for (let i = 0; i < 20; i++) {
					if (serveProcess.killed) break;
					try {
						await page.goto(serveUrl, { waitUntil: "domcontentloaded", timeout: 1500 });
						opened = true;
						break;
					} catch {
						await new Promise((resolve) => setTimeout(resolve, 500));
					}
				}

				if (!opened) {
					await cleanupServeProcess();
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								status: "failed",
								reason: `Failed to open ${serveUrl}`,
								serveStdout: stdoutLogs,
								serveStderr: stderrLogs
							}, null, 2)
						}],
						isError: true
					};
				}

				await new Promise((resolve) => setTimeout(resolve, runDurationMs));
			} catch (error) {
				const message = error && error.message ? error.message : "Unknown error";
				return {
					content: [{
						type: "text",
						text: `Error while serving or browser inspection: ${message}`
					}],
					isError: true
				};
			} finally {
				try {
					if (browser) await browser.close();
				} catch {
					// ignore
				}
				const portClosed = await cleanupServeProcess();
				if (!portClosed) {
					pushLimited(stderrLogs, `Warning: akashic serve may still be alive on port ${servePort} after cleanup.`);
				}
			}

			const mappedErrors = errorLogs.map((entry) => {
				const mapping = mapErrorToSource(entry.text || "");
				return {
					type: entry.type,
					message: entry.text || "",
					file: mapping ? mapping.file : null,
					line: mapping ? mapping.line : null,
					column: mapping ? mapping.column : null,
					sourceLine: mapping ? mapping.sourceLine : null
				};
			});
			const hasErrors = mappedErrors.length > 0;
			const result = {
				status: hasErrors ? "error_detected" : "ok",
				url: serveUrl,
				durationMs: runDurationMs,
				logSummary: {
					consoleCount: consoleLogs.length,
					errorCount: mappedErrors.length,
					pageErrorCount: pageErrors.length
				},
				errors: mappedErrors,
				consoleLogs,
				serveStdout: stdoutLogs,
				serveStderr: stderrLogs
			};

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				isError: hasErrors
			};
		}
	);

	// ---------------------------------------------------------------
	// Tool 10: JS syntax check (check_js_syntax)
	// ---------------------------------------------------------------
	server.tool(
		"check_js_syntax",
		"Check JavaScript syntax using node --check.",
		{
			directoryName: z.string().describe("Project directory path (relative or absolute)."),
			filePaths: z.array(z.string()).optional().describe("Files to check (relative to directoryName). Defaults to script/main.js if present."),
		},
		async ({ directoryName, filePaths }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes("..")) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);

			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return { content: [{ type: "text", text: `Error: Directory '${directoryName}' not found.` }], isError: true };
			}

			let targets = Array.isArray(filePaths) ? filePaths.filter((p) => p && p.trim()) : [];
			if (targets.length === 0) {
				const defaultPath = path.resolve(targetPath, "script", "main.js");
				if (fs.existsSync(defaultPath)) {
					targets = ["script/main.js"];
				} else {
					return { content: [{ type: "text", text: "Error: No filePaths provided and script/main.js not found." }], isError: true };
				}
			}

			const results = [];
			for (const relPath of targets) {
				const fullPath = path.resolve(targetPath, relPath);
				if (!fullPath.startsWith(targetPath)) {
					return { content: [{ type: "text", text: `Error: filePath must be inside the project directory: ${relPath}` }], isError: true };
				}
				if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
					return { content: [{ type: "text", text: `Error: File not found: ${relPath}` }], isError: true };
				}

				try {
					const command = `node --check "${fullPath}"`;
					const { stdout, stderr } = await execAsync(command);
					const output = [stdout, stderr].filter(Boolean).join("\n");
					results.push(`${relPath}: OK${output ? `\n${output}` : ""}`);
				} catch (error) {
					const message = error && error.message ? error.message : "Unknown error";
					const stdout = error && error.stdout ? `\nStdout: ${error.stdout}` : "";
					const stderr = error && error.stderr ? `\nStderr: ${error.stderr}` : "";
					results.push(`${relPath}: ERROR\n${message}${stdout}${stderr}`);
				}
			}

			return {
				content: [{ type: "text", text: results.join("\n\n") }]
			};
		}
	);

	// ---------------------------------------------------------------
	// Tool 11: Read project files (read_project_files)
	// ---------------------------------------------------------------
	server.tool(
		"read_project_files",
		"Read text files from a project directory (skips images/audio/binary).",
		{
			directoryName: z.string().describe("Project directory path (relative or absolute)."),
			maxBytes: z.number().int().min(1).optional().describe("Maximum bytes per file (default: 200000)."),
			maxFiles: z.number().int().min(1).optional().describe("Maximum number of files to read (default: 500).")
		},
		async ({ directoryName, maxBytes, maxFiles }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes("..")) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);

			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return { content: [{ type: "text", text: `Error: Directory '${directoryName}' not found.` }], isError: true };
			}

			const options = {
				maxBytes: typeof maxBytes === "number" ? maxBytes : 200000,
				maxFiles: typeof maxFiles === "number" ? maxFiles : 500
			};
			const skipExt = new Set([
				".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
				".mp3", ".wav", ".m4a", ".ogg", ".aac", ".mp4", ".webm",
				".zip", ".7z", ".tar", ".gz", ".bz2", ".xz",
				".exe", ".dll", ".so", ".dylib", ".bin", ".dat",
				".ico", ".pdf"
			]);
			const skipDirs = new Set([
				".git",
				"node_modules",
				".mcp",
				"tmp",
				"dist",
				"build",
				"data/wget_mirror"
			]);
			let readCount = 0;

			const files = [];
			const readFileSafe = (fullPath, relPath) => {
				if (!fullPath.startsWith(targetPath)) return;
				if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return;
				const ext = path.extname(relPath).toLowerCase();
				if (skipExt.has(ext)) return;
				const data = fs.readFileSync(fullPath);
				if (data.length > options.maxBytes) {
					files.push({
						path: relPath,
						content: "",
						truncated: true
					});
					return;
				}
				files.push({ path: relPath, content: data.toString("utf-8") });
			};

			const walk = (dir, baseRel) => {
				if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
				const entries = fs.readdirSync(dir);
				for (const entry of entries) {
					if (readCount >= options.maxFiles) return;
					const full = path.resolve(dir, entry);
					const rel = path.join(baseRel, entry);
					if (fs.statSync(full).isDirectory()) {
						const relDir = rel.replace(/\\/g, "/");
						if (skipDirs.has(entry) || skipDirs.has(relDir)) {
							continue;
						}
						walk(full, rel);
					} else if (fs.statSync(full).isFile()) {
						if (readCount >= options.maxFiles) return;
						readFileSafe(full, rel.replace(/\\/g, "/"));
						readCount += 1;
					}
				}
			};
			walk(targetPath, ".");

			return {
				content: [{ type: "text", text: JSON.stringify({ files }, null, 2) }]
			};
		}
	);

	// ---------------------------------------------------------------
	// Tool 12: Write README (write_project_readme)
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
				const message = error && error.message ? error.message : "Unknown error";
				return {
					content: [{ type: "text", text: `Error writing README.md: ${message}` }],
					isError: true,
				};
			}
		}
	);

	// ---------------------------------------------------------------
	// Tool 13: Validate Niconama spec (validate_niconama_spec)
	// ---------------------------------------------------------------
	server.tool(
		"validate_niconama_spec",
		"Validate a Niconama (Akashic) project against common manifest/asset compliance checks.",
		{
			directoryName: z.string().describe("Project directory path (relative or absolute)."),
			expectedMode: z.enum(["ranking", "multi"]).optional().describe("Expected supported mode."),
			maxGameJsonBytes: z.number().int().positive().optional().describe("Optional max bytes for game.json."),
			maxZipBytes: z.number().int().positive().optional().describe("Optional max bytes for zipped project."),
		},
		async ({ directoryName, expectedMode, maxGameJsonBytes, maxZipBytes }) => {
			if (!path.isAbsolute(directoryName) && directoryName.includes("..")) {
				return { content: [{ type: "text", text: "Error: Invalid directory name. Avoid '..' in relative paths." }], isError: true };
			}

			const targetPath = path.isAbsolute(directoryName)
				? path.normalize(directoryName)
				: path.resolve(process.cwd(), directoryName);

			if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
				return { content: [{ type: "text", text: `Error: Directory '${directoryName}' not found.` }], isError: true };
			}

			const gameJsonPath = path.resolve(targetPath, "game.json");
			if (!fs.existsSync(gameJsonPath) || !fs.statSync(gameJsonPath).isFile()) {
				return { content: [{ type: "text", text: "Error: game.json not found." }], isError: true };
			}

			const errors = [];
			const warnings = [];
			const infos = [];
			let gameJson = null;

			try {
				const raw = fs.readFileSync(gameJsonPath, "utf-8");
				gameJson = JSON.parse(raw);
				const gameJsonBytes = Buffer.byteLength(raw, "utf-8");
				infos.push(`game.json size: ${gameJsonBytes} bytes`);
				if (typeof maxGameJsonBytes === "number" && gameJsonBytes > maxGameJsonBytes) {
					errors.push(`game.json exceeds maxGameJsonBytes (${gameJsonBytes} > ${maxGameJsonBytes})`);
				}
			} catch (error) {
				const message = error && error.message ? error.message : "Unknown error";
				return { content: [{ type: "text", text: `Error: Failed to parse game.json: ${message}` }], isError: true };
			}

			const requiredFields = ["width", "height", "fps", "main", "assets"];
			for (const key of requiredFields) {
				if (!(key in gameJson)) {
					errors.push(`Missing required game.json field: ${key}`);
				}
			}

			if (typeof gameJson.width !== "number" || gameJson.width <= 0) {
				errors.push("Invalid width: must be a positive number.");
			}
			if (typeof gameJson.height !== "number" || gameJson.height <= 0) {
				errors.push("Invalid height: must be a positive number.");
			}
			if (typeof gameJson.fps !== "number" || gameJson.fps <= 0) {
				errors.push("Invalid fps: must be a positive number.");
			}
			if (typeof gameJson.main !== "string" || !gameJson.main.startsWith("./")) {
				warnings.push("main should be a relative path starting with './'.");
			}

			const environment = gameJson.environment && typeof gameJson.environment === "object" ? gameJson.environment : null;
			const nicolive = environment && environment.nicolive && typeof environment.nicolive === "object" ? environment.nicolive : null;
			const supportedModes = nicolive && Array.isArray(nicolive.supportedModes) ? nicolive.supportedModes : null;

			if (!environment) {
				warnings.push("environment is missing.");
			}
			if (!nicolive) {
				warnings.push("environment.nicolive is missing.");
			}
			if (!supportedModes || supportedModes.length === 0) {
				warnings.push("environment.nicolive.supportedModes is missing or empty.");
			} else {
				infos.push(`supportedModes: ${supportedModes.join(", ")}`);
				if (expectedMode && !supportedModes.includes(expectedMode)) {
					errors.push(`expectedMode '${expectedMode}' is not included in supportedModes.`);
				}
			}

			const rankingMode = (supportedModes && supportedModes.includes("ranking")) || expectedMode === "ranking";
			if (rankingMode) {
				const psp = nicolive && nicolive.preferredSessionParameters;
				const ttl = psp && psp.totalTimeLimit;
				if (typeof ttl !== "number" || ttl <= 0) {
					warnings.push("ranking mode: preferredSessionParameters.totalTimeLimit is missing or invalid.");
				}
			}

			const assets = gameJson.assets && typeof gameJson.assets === "object" ? gameJson.assets : null;
			if (!assets) {
				errors.push("assets is missing or invalid.");
			} else {
				const knownTypes = new Set(["image", "audio", "script", "text", "vector-image"]);
				for (const [assetId, asset] of Object.entries(assets)) {
					if (!asset || typeof asset !== "object") {
						errors.push(`assets.${assetId} is not an object.`);
						continue;
					}
					if (typeof asset.type !== "string") {
						errors.push(`assets.${assetId}.type is missing.`);
						continue;
					}
					if (!knownTypes.has(asset.type)) {
						warnings.push(`assets.${assetId}.type '${asset.type}' is not in common known types.`);
					}
					if (typeof asset.path !== "string" || asset.path.length === 0) {
						errors.push(`assets.${assetId}.path is missing.`);
						continue;
					}

					const normalizedAssetPath = asset.path.startsWith("./") ? asset.path.slice(2) : asset.path;
					const resolvedAssetPath = path.resolve(targetPath, normalizedAssetPath);
					if (!resolvedAssetPath.startsWith(targetPath)) {
						errors.push(`assets.${assetId}.path points outside project: ${asset.path}`);
						continue;
					}

					if (asset.type === "audio") {
						if (asset.systemId && !["sound", "music"].includes(asset.systemId)) {
							warnings.push(`assets.${assetId}.systemId '${asset.systemId}' is unusual (common: sound/music).`);
						}
						const audioCandidates = [".ogg", ".m4a", ".aac"]
							.map((ext) => `${resolvedAssetPath}${ext}`);
						const audioExists = audioCandidates.some((filePath) => fs.existsSync(filePath));
						if (!audioExists) {
							warnings.push(`Audio source not found for assets.${assetId} (checked extension candidates from '${asset.path}').`);
						}
					} else if (!fs.existsSync(resolvedAssetPath)) {
						errors.push(`Asset file not found: assets.${assetId}.path='${asset.path}'`);
					}

					if (asset.type === "script" && asset.global !== true) {
						errors.push(`assets.${assetId} is script but global is not true.`);
					}
				}
			}

			const lines = [];
			lines.push("Niconama compliance report");
			lines.push(`Project: ${targetPath}`);
			lines.push(`Status: ${errors.length > 0 ? "FAILED" : "PASSED_WITH_WARNINGS_OR_INFO"}`);
			if (errors.length > 0) {
				lines.push("");
				lines.push("[Errors]");
				for (const item of errors) lines.push(`- ${item}`);
			}
			if (warnings.length > 0) {
				lines.push("");
				lines.push("[Warnings]");
				for (const item of warnings) lines.push(`- ${item}`);
			}
			if (infos.length > 0) {
				lines.push("");
				lines.push("[Info]");
				for (const item of infos) lines.push(`- ${item}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				isError: errors.length > 0,
			};
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
							text: `
あなたは**ニコ生ゲーム**の「要件定義・基本設計」志向のゲームデザイナーです。
**コードは実装せず**、仕様レベルで設計を明確化してください。

${genreInfo}

## 成果物の形式
* 要件定義・基本設計を、**分かりやすい箇条書き**で提示すること
* **実装手順やコードは書かない**こと
* 前提や不明点がある場合は、**「質問」と「仮定」**を分けて記載すること

## 要件定義
1. **目的とターゲット**：誰のためのゲームで、どんな体験を提供するか
2. **一文概要**：コンセプトを一文で簡潔にまとめる
3. **コアの面白さ**：最も気持ちよい／報われる瞬間は何か
4. **ルール／スコア**：勝利・終了条件、採点ルール、制限時間の有無
5. **ランキング要件**：どのスコアを、いつ送信（登録）するか
6. **入力方法**：クリック／タップ等、想定する操作方法
7. **プレイ時間**：1プレイの想定時間と、リプレイ性

## 基本設計
1. **画面遷移**：タイトル、ゲーム本編、結果画面、各遷移の流れ
2. **UI要件**：表示すべき情報、レイアウトの優先順位
3. **フィードバック方針**：SE／演出（視覚効果）の方向性、強調ポイント
4. **素材要件**：画像／音声の種類と、おおよその必要量
5. **難易度設計**：導入（チュートリアル）、上達余地、バランス方針
6. **非機能要件**：想定解像度、性能目標（処理落ちしない等）
7. **リスクと将来案**：既知の懸念点と、拡張アイデア

## 前提
* search_akashic_docs を使用して、Akashic Engine の仕様とニコ生ゲーム側の要件を確認する
* ニコ生ゲーム向けの **Akashic Engine v3** を対象とする
* **テンプレートベースのプロジェクト制約**の範囲内で設計する
* ニコ生ゲームはPC環境だけでなくスマホ環境も想定しているため、入力方法としてキーボードの利用は禁止
`
						}
					}
				]
			};
		}
	);

	// ---------------------------------------------------------------
	// Prompt: ニコ生ゲーム実装者 (implement_niconama_game)
	// ---------------------------------------------------------------
	server.prompt(
		"implement_niconama_game",
		"Implementation guidance for Niconico Live Games (Akashic Engine).",
		{
			targetDir: z.string().describe("Fixed output directory path."),
			genre: z.string().optional().describe("Genre or idea (e.g. 'puzzle', 'action', 'shooting')."),
		},
		({ targetDir, genre }) => {
			const genreInfo = genre ? `Target Genre: ${genre}` : "Target Genre: Any";
			return {
				messages: [
					{
						role: "user",
						content: {
							type: "text",
							text: `あなたは**ニコ生ゲーム**の実装担当者です。以下のガイドラインに従ってください。
${genreInfo}

${apiSummaryIndexForPrompt}

## 開発ガイドライン
1. **まず調査**：実装に必要な最新の API 仕様（例：音声再生、当たり判定、乱数など）と、ニコ生ゲーム側の要件を確認するために、search_akashic_docs を使用すること。
2. **出力ディレクトリ固定**：生成物は必ずこの固定パスに出力すること：${targetDir}
3. **プロジェクト作成・確認**：プロジェクトが存在しない場合は init_project を使ってテンプレートを生成する。プロジェクトが存在する場合は read_project_files を使ってゲーム内容を確認する。
   * 明示指定がない限り、ゲーム形式に応じて templateType を選ぶ：
     * ランキング：javascript-shin-ichiba-ranking
     * マルチプレイ：javascript-multi
     * それ以外：javascript
   * プロジェクトが TypeScript の場合は skipNpmInstall を false、それ以外は true にする。
   * init_project が失敗した場合は、代わりに init_minimal_template を実行する。
4. **仕様／ルール／演出の定義**：ゲームの仕様・ルール・見せ方（演出）を要約する。未指定なら提案する。
   * **二段階生成**：Phase 1 では最小限の動くゲーム（MVP）のみ実装し、演出や追加機能は Phase 2 で明示的に依頼された場合のみ追加する。
   * 既存プロジェクトで生成履歴がない場合は、read_project_files を使ってソースコードや README から仕様を推測する。
   * 新規プロジェクトの場合、ディレクトリ構成は以下の通りとなる：
     * script：ゲームロジック（JavaScript / CommonJS）
     * image：画像
     * audio：音声
     * text：テキスト
     * game.json
   * 素材の入手元が指定されている場合は、import_local_assets を使ってプロジェクト内に配置する。
     * 新規プロジェクトの場合、画像は image ディレクトリ、音声は audio ディレクトリに配置する。
     * 既存プロジェクトの場合、game.json やディレクトリ構造を見て配置場所を推測すること
       * 画像や音声の配置場所がないときは、image ディレクトリや audioディレクトリを新規作成してそこに配置する
     * 音声追加時は、ファイル形式をニコ生ゲーム対応の形式に変換するため、directoryName に音声の配置ディレクトリのパスを指定して run_complete_audio を実行する。
   * Akashic の拡張ライブラリが指定されている場合は、akashic_install_extension を使って導入する。
5. **実装**：コードを書く際は create_game_file を使用する。
   * create_game_file の directoryName は必ず targetDir と同じ値を指定する。
   * create_game_file の filePath は project ルートからの相対パスだけを使う。
   * game.json を扱う場合、filePath は必ず game.json にする。subdir/game.json のようなネストは禁止。
   * ロジックは main.ts または main.js に実装する。
     * main.ts / main.js が 500 行を超える場合は、クラスや関数を別ファイルに分割する。
       * クラス例：シーン、エンティティ
       * 関数例：ユーティリティ関数、API
   * データやテキストは、text ディレクトリ以下に json ファイルもしくは txt ファイルとして配置する(テキストアセットとして扱う)
     * 読み込むときは、画像アセットや音声アセットと同様に g.Scene の assetPaths もしくは assetIds を利用する。詳細は以下を参照すること
       * [アセットを読み込む | Akashic Engine](https://akashic-games.github.io/reverse-reference/v3/asset/read-asset.html)
     * 対象のデータやテキスト利用時は、getText() もしくは getTextById() を利用する。詳細は以下を参照すること
     * [読み込んだアセットを取得する | Akashic Engine](https://akashic-games.github.io/reverse-reference/v3/asset/get-asset.html )
   * ランキングゲームの場合は、[ランキングゲーム | Akashic Engine](https://akashic-games.github.io/shin-ichiba/ranking/）の要件に従う。
   * 変更した JavaScript ファイルに関しては check_js_syntax で構文エラーがないか確認すること。エラーが見つかった場合は修正すること。
   * API や要件の確認が必要なら適宜 search_akashic_docs を使う。
   * 明示的に必要と言われない限り game.json を変更しない。
6. **game.json の更新**：アセット(画像・音声・スクリプト・テキスト)の新規追加・削除時のみ(画像や音声の場合は変更時も含む)、 akashic_scan_asset を使う。
7. **ゲームプロジェクトの静的検証**：validate_niconama_spec を用いて、ゲームプロジェクトがニコ生ゲームの要件を満たしているか検証する。問題がある場合は該当箇所を修正する。
8. **デバッグ**：akashic_serve を用いてゲームの動作検証をする。問題がある場合は該当箇所を修正する。
   * このデバッグ処理は時間がかかるため、以下に該当する時のみ行うこと
     * プロジェクトの新規作成時
     * プロジェクトの大規模変更時
     * ゲームが動かないといった重大なバグの修正時

## 実装上の注意
* 必要なコメントを付けること。
* JavaScript は **CommonJS** と **ES2015+** 構文を使用する。
* Akashic Engine v3 の API を使用する。
* エントリポイント(game.json の main で指定しているファイル)では、最初に実行する関数を module.exports に代入する。
* Akashic API は import を使わず、g. プレフィックスで利用する。
* g.Scene#loaded と g.Scene#update は v3 では非推奨。g.Scene#onLoad と g.Scene#onUpdate を使う。
* g.Scene には age がない。必要なら g.game.age を使う。
* g.game には onLoad() のトリガーはない。onLoad() は g.Scene のメソッド。
* g.Label は指定がなければ g.DynamicFont を生成して label.font に設定する。
  * g.DynamicFont を作るときは game、size、fontFamily を設定し、fontFamily は次のいずれかを使う：
    * "sans-serif"
    * "serif"
    * "monospace"
  * フォントデータ（フォント画像＋設定テキスト）が提供されている場合は g.BitmapFont を作成して使用する。
* g.Scene を作るときは game に g.game を設定する。
  * シーン内でアセットを使う場合は assetPaths を指定する。この時存在しないパスを指定しないこと。以下参考：
    * assetPaths にはプロジェクトからのパスを "/" から記述する(例： image/hoge.png の場合、/image/hoge.png と記述する)。
    * 音声ファイルの場合は拡張子は記述しない(例： audio/fuga.m4a と audio/fuga.ogg がある場合、/audio/fuga と記述する)。
    * assetPaths 自体はワイルドカードの利用可能なので /image/**/* や /audio/**/* といった表記が可能
    * asset の登録と利用についての詳細は以下を参照すること
      * [アセットを読み込む | Akashic Engine](https://akashic-games.github.io/reverse-reference/v3/asset/read-asset.html)
      * [読み込んだアセットを取得する | Akashic Engine](https://akashic-games.github.io/reverse-reference/v3/asset/get-asset.html)
* シーン切り替えについては以下を参照：
  * [シーンを切り替える | Akashic Engine](https://akashic-games.github.io/reverse-reference/v3/logic/scene.html)
* javascript-shin-ichiba-ranking（または script/_bootstrap.js が存在する場合）について：
  * game.json の main は変更しない。
  * script/_bootstrap.js を変更・削除しない。
  * script/main.js は次の形式でエクスポートすること：module.exports.main = function main(param) { ... }
  * 次の形式は使用しない：module.exports = function main(...) { ... }
* game.json は基本的にテンプレートまたは既存プロジェクトのまま維持する。
  * 手動編集を許可するのは以下の場合のみ：
    * 画面サイズ(width, height)を変更する
    * ゲームのFPS数(fps)を変更する
    * アセットをグローバル化する（"global": true を追加）
    * type: "audio" のアセットの systemId を変更する
      * 音声をループする(BGMにする)時のみ、systemId を "music" に変更する
    * ランキングの制限時間を変更する（environment.nicolive.preferredSessionParameters.totalTimeLimit）
      * totalTimeLimit は秒単位（例：90 は 90 秒）
    * ユーザー入力プロンプトで直接指定があった場合
  * 変更が必要な場合は以下を参照：
    * [game.json の仕様 | Akashic Engine](https://akashic-games.github.io/reference/manifest/game-json.html)
    * main キーは ./ を含める必要がある（例："./script/_bootstrap.js"）
    * type: "script" のアセットはグローバルである必要がある（"global": true）
    * environment.sandbox-runtime の値は "3" とする
* エンティティ(g.E を継承しているオブジェクト)にタップやスワイプを行う場合、そのエンティティに touchable: true を付与すること
* エンティティ(g.E を継承しているオブジェクト)を表示する時は show() メソッドを、非表示にする時は hide() メソッドを使ってください(この時に限っては modified() メソッド呼び出しは不要です)。
* g.Label は改行できないので、複数行のテキストを画面に表示する場合は、行数分の g.Label を生成すること
* g.game に onLoad は存在しないので、 g.game.onLoad にハンドラを登録する処理は禁止。
* g.Sprite の拡縮を行う場合は、g.Sprite のプロパティの width, height, srcWidth, srcHeight を利用すること
  * この時 width, height に拡縮後の値、 srcWidth, srcHeight には元の画像サイズを与えること。
* 1枚の画像でアニメーションを粉う場合は g.FrameSprite を利用すること。詳細は以下を参照：
  * [フレームアニメーション (パラパラアニメ) する | Akashic Engine](https://akashic-games.github.io/reverse-reference/v3/drawing/frame-animation.html)
* 画像の一部を表示する場合は、g.Spriteの srcWidth, srcHeight, srcX, srcY を利用すること。詳細は以下を参照：
  * [画像の一部分を表示する | Akashic Engine](https://akashic-games.github.io/reverse-reference/v3/drawing/partial-image.html)
* エンティティ(g.E を継承しているオブジェクト)をドラッグ・スワイプする場合は、g.E#onPointMove トリガーを利用すること。このトリガーに登録するハンドラの引数である PointMoveEvent の仕様は以下の通り
  * PointMoveEvent#point: 最後にonPointDownが発生した座標。座標系の原点はエンティティの座標
  * PointMoveEvent#startDelta: 最後にonPointDownが発生した座標から、現在のポイント座標までの移動量
  * PointMoveEvent#prevDelta: 最後にonPointMoveが発生した座標から、現在のポイント座標までの移動量
  * 詳細やコード例は以下を参照：
    * [ドラッグ・スワイプで動かす | Akashic Engine](https://akashic-games.github.io/reverse-reference/v3/operation/drag.html)
* g.E#onPointUp トリガーに登録するハンドラの引数である PointUpEvent の仕様は以下の通り
  * PointUpEvent#point: 最後にonPointDownが発生した座標。座標系の原点はエンティティの座標
  * PointUpEvent#startDelta: 最後にonPointDownが発生した座標から、現在のポイント座標までの移動量
* g.E#onPointDown トリガーに登録するハンドラの引数である PointDownEvent の仕様は以下の通り
  * PointDownEvent#point: onPointDownが発生した座標。座標系の原点はエンティティの座標
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
	let querySession = null;
	if (url && url.searchParams) {
		querySession = url.searchParams.get("sessionId") || url.searchParams.get("session_id");
	}
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
	warmupPlaywrightChromiumInBackground();

	const port = Number(process.env.PORT || 8080);
	const basePath = "/mcp";
	const ssePath = `${basePath}/sse`;
	const messagePath = `${basePath}/messages`;
	const proxyBasePath = "/proxy";
	const toolsPath = `${proxyBasePath}/tools`;
	const callPath = `${proxyBasePath}/call`;
	const promptsPath = `${proxyBasePath}/prompts`;
	const promptPath = `${proxyBasePath}/prompt`;
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
					const message = error && error.message ? error.message : "Failed to process MCP message.";
					console.error("MCP message error:", message);
					return sendJson(res, 400, { error: message });
				}
			}

			if (req.method === "GET" && pathname === toolsPath) {
				const client = await getProxyClient(baseUrl);
				const tools = await client.listTools();
				return sendJson(res, 200, tools);
			}

			if (req.method === "GET" && pathname === promptsPath) {
				const client = await getProxyClient(baseUrl);
				const prompts = await client.listPrompts();
				return sendJson(res, 200, prompts);
			}

			if (req.method === "POST" && pathname === promptPath) {
				const body = await readJsonBody(req);
				if (body === undefined) {
					return sendJson(res, 400, { error: "Invalid JSON body." });
				}
				if (!body || typeof body.name !== "string") {
					return sendJson(res, 400, { error: "Missing prompt name." });
				}
				const args = body.arguments && typeof body.arguments === "object" ? body.arguments : {};
				const client = await getProxyClient(baseUrl);
				const prompt = await client.getPrompt({ name: body.name, arguments: args });
				return sendJson(res, 200, prompt);
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
		console.error(`Proxy prompts endpoint: ${promptsPath}`);
		console.error(`Proxy prompt endpoint: ${promptPath}`);
		console.error(`Proxy call endpoint: ${callPath}`);
	});
}

// エラーハンドリング付きで実行
main().catch((error) => {
	console.error("Fatal error in main():", error);
	process.exit(1);
});
