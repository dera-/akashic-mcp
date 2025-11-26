import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

// execをPromise化して非同期処理しやすくする
const execAsync = util.promisify(exec);

// =================================================================
// 1. 事前準備: ドキュメントデータの読み込み
// =================================================================
let docsData = [];
try {
	// 実行ディレクトリと同じ場所にある akashic_docs.json を探す
	const docsPath = path.resolve('akashic_docs.json');
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
		return uniqueTemplates;

	} catch (error) {
		console.error(`[Warning] Failed to fetch templates via CLI: ${error.message}`);
		// CLIが失敗した場合やインストールされていない場合のフォールバック
		return [
			"javascript", 
			"typescript", 
			"javascript-shin-ichiba-ranking", 
			"typescript-shin-ichiba-ranking",
			"javascript-minimal",
			"typescript-minimal"
		];
	}
}

// =================================================================
// 3. メイン処理 (サーバー構築と起動)
// =================================================================
async function main() {
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
			filePath: z.string().describe("Relative path to the file (e.g., 'src/main.ts')."),
			code: z.string().describe("The full content of the file."),
		},
		async ({ filePath, code }) => {
			// セキュリティ: 親ディレクトリへの遡りを禁止
			if (filePath.includes('..') || path.isAbsolute(filePath)) {
				return { 
					content: [{ type: "text", text: "Error: Invalid file path. Use relative paths within the project." }], 
					isError: true 
				};
			}

			try {
				const fullPath = path.resolve(process.cwd(), filePath);
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
			directoryName: z.string().describe("The directory name for the new project (e.g., 'my-awesome-game')."),
			templateType: z.enum(templateEnum).describe(`Template type. Available: ${templateList.join(", ")}`),
		},
		async ({ directoryName, templateType }) => {
			if (directoryName.includes('..') || path.isAbsolute(directoryName)) {
				return { content: [{ type: "text", text: "Error: Please use a relative directory name." }], isError: true };
			}

			const targetPath = path.resolve(process.cwd(), directoryName);

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
				const command = `cd "${targetPath}" && akashic init --type ${templateType} --force && npm install`;
				await execAsync(command);

				return {
					content: [{ 
						type: "text", 
						text: `Project initialized successfully in '${directoryName}'.\nTemplate: ${templateType}\nDependencies installed.` 
					}]
				};

			} catch (error) {
				return {
					content: [{ type: "text", text: `Error during initialization: ${error.message}\nStderr: ${error.stderr}` }],
					isError: true,
				};
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
	 - **ニコ生ゲームの制約**（制限時間60秒、スコア送信 g.game.vars.gameState.score）を必ず守ってください。
	 - ランキングモード対応（セッションパラメータ mode: 'ranking'）を考慮してください。

**コード品質:**
- 可読性の高いコードを記述してください。
- 必要なコメントを追加してください。
- エラーハンドリング（画像のロード待ちなど）を適切に行ってください。`
						}
					}
				]
			};
		}
	);

	// ---------------------------------------------------------------
	// サーバー接続開始
	// ---------------------------------------------------------------
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("Akashic MCP Server running on stdio.");
}

// エラーハンドリング付きで実行
main().catch((error) => {
	console.error("Fatal error in main():", error);
	process.exit(1);
});
