import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { z } from "zod";
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
	// Tool 6: プロジェクトZIP作成 (zip_project_base64)
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
1. **情報収集**: まず 'search_akashic_docs' を使用し、実装に必要なAPI（例: 音声再生、当たり判定、乱数生成）の最新仕様を確認してください。
2. **プロジェクト作成**: プロジェクトが存在しない場合、ユーザーに確認の上 'init_project' を提案・実行してください（推奨テンプレート: typescript-shin-ichiba-ranking）。
3. **実装**: 'create_game_file' を使用してコードを作成してください。
	 - main.ts (またはmain.js) にロジックを記述します。
	   - main.ts (またはmain.js)のコード量が多くなるのであれば、エンティティやシーンなどのオブジェクトやutil関数を別ファイルに切り出してください。
	 - ランキングゲームを作成する場合は、「ランキングゲーム | Akashic Engine」(https://akashic-games.github.io/shin-ichiba/ranking/) を参考にして、そこに書かれている要求仕様を満たしてください。
4. **game.json更新**: 'akashic_scan_asset' を使用してgame.jsonを更新してください。

**コード品質:**
- 可読性の高いコードを記述してください。
- 必要なコメントを追加してください。
- エラーハンドリング（画像のロード待ちなど）を適切に行ってください。

**Akashic Engine 利用の際の注意点:**
- Akashic Engine v3系のAPIを使用してください。
- game.json については、何かしら指定がない限り基本的にはテンプレートのままで変更しないでください。
- テンプレートに script/_bootstrap.js がある場合、このファイルはテンプレートのままで変更しないでください。
- Akashic EngineのAPIを使うときはimportを使わず、接頭辞にg.をつけてください。
- g.Scene#loadedやg.Scene#updateはv3では非推奨です。g.Scene#onLoadやg.Scene#onUpdateを使用してください。また、基本的にはv3で使用可能でも非推奨のAPIは使用しないようにしてください。
- JavaScriptの場合、main.jsでは、main関数を定義して、コードの末尾に module.exports = main; を記載してください。
- JavaScriptの場合、CommonJS形式且つES2015以降の記法でコードを作成してください。
- g.Sceneにageは存在しません。ageを利用する場合はg.game.ageを利用してください。
- g.gameにonLoad()などのトリガーは存在しません。onLoad()はg.Sceneのメソッドです。
- g.Labelを使用する場合、特に指定が無ければ g.DynamicFont を生成して、g.Labelのfontプロパティに指定してください。
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
