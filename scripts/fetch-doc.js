// scripts/fetch-docs.js
const axios = require('axios');
const cheerio = require('cheerio');
const TurndownService = require('turndown');
const fs = require('fs');
const path = require('path');
const urlParser = require('url');

// 設定
const BASE_URL = 'https://akashic-games.github.io/';
const OUTPUT_FILE = 'data/akashic_docs.json';
const DELAY_MS = 500; // サーバー負荷軽減のための待機時間

// Markdown変換器の初期化
const turndownService = new TurndownService({
	headingStyle: 'atx',
	codeBlockStyle: 'fenced'
});

// 訪問済みURL管理
const visited = new Set();
const queue = [BASE_URL];
const docs = [];

// 指定時間待機する関数
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// URLを正規化する関数
function normalizeUrl(link, currentUrl) {
	try {
		const absoluteUrl = new URL(link, currentUrl).href;
		// アンカー(#)を除去
		return absoluteUrl.split('#')[0];
	} catch (e) {
		return null;
	}
}

async function crawl() {
	console.log(`Crawler started for: ${BASE_URL}`);

	while (queue.length > 0) {
		const currentUrl = queue.shift();

		if (visited.has(currentUrl)) continue;
		visited.add(currentUrl);

		// ドメイン外には出ない & 特定の拡張子は無視
		if (!currentUrl.startsWith(BASE_URL)) continue;
		if (currentUrl.match(/\.(png|jpg|jpeg|gif|zip|pdf)$/i)) continue;

		try {
			console.log(`Fetching: ${currentUrl} (Queue: ${queue.length})`);
			
			const response = await axios.get(currentUrl, {
				headers: { 'User-Agent': 'AkashicMCP-Bot/1.0' }
			});

			// コンテンツタイプがHTMLでない場合はスキップ
			const contentType = response.headers['content-type'];
			if (!contentType || !contentType.includes('text/html')) continue;

			const $ = cheerio.load(response.data);

			// 不要な要素（ナビゲーション、フッター、スクリプト）を削除
			$('nav, footer, script, style, noscript, iframe, .site-header, .site-footer').remove();

			// メインコンテンツの抽出 (サイト構造に合わせて調整可能)
			// Akashic公式サイトは特定のIDやクラスで囲まれていない場合もあるためbody全体から取得しつつ、不要タグを消す戦略
			const title = $('title').text().trim();
			const htmlContent = $('body').html();

			if (htmlContent) {
				// Markdownに変換
				const markdown = turndownService.turndown(htmlContent);
				
				// データを保存用配列に追加
				docs.push({
					url: currentUrl,
					title: title,
					content: markdown
				});
			}

			// ページ内のリンクを収集してキューに追加
			$('a').each((_, element) => {
				const href = $(element).attr('href');
				if (href) {
					const nextUrl = normalizeUrl(href, currentUrl);
					if (nextUrl && !visited.has(nextUrl) && nextUrl.startsWith(BASE_URL)) {
						queue.push(nextUrl);
					}
				}
			});

			// サーバーに負荷をかけないよう待機
			await sleep(DELAY_MS);

		} catch (error) {
			console.error(`Error fetching ${currentUrl}: ${error.message}`);
		}
	}

	// JSONファイルとして書き出し
	console.log(`\nCompleted! Saving ${docs.length} pages to ${OUTPUT_FILE}...`);
	fs.writeFileSync(OUTPUT_FILE, JSON.stringify(docs, null, 2), 'utf-8');
	console.log('Done.');
}

crawl();