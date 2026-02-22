# akashic-mcp

## 概要説明
Akashic Engine 向けの MCP サーバーです。ドキュメント検索、プロジェクト初期化、ファイル生成、アセット運用、ローカル実行チェック、仕様検証などをツールとして提供します。

## MCP利用方法
1) 依存をインストールしてサーバーを起動します。
```
npm install
npm start
```
2) MCP クライアントから SSE で接続します。
```
GET  http://localhost:8080/mcp/sse
POST http://localhost:8080/mcp/messages
```
3) 代理エンドポイントからツール一覧/実行も可能です。
```
GET  http://localhost:8080/proxy/tools
POST http://localhost:8080/proxy/call
```

## MCP詳細説明
主なツール:
- search_akashic_docs: Akashic ドキュメント検索
- create_game_file: ゲームファイル作成/上書き
- init_project: Akashic プロジェクト初期化 (akashic init + npm install)
- init_minimal_template: template/ から最小テンプレートをコピー
- akashic_scan_asset: akashic scan asset 実行
- akashic_install_extension: Akashic 拡張ライブラリを akashic install で導入
- import_local_assets: ローカル素材を image/audio に配置
- run_complete_audio: 音声をニコ生向け形式に変換し不要形式を整理
- akashic_serve: 一定時間 `akashic serve` で実行しブラウザコンソールを検査
- format_with_eslint: @akashic/eslint-config による整形
- check_js_syntax: `node --check` で JavaScript 構文を検証
- read_project_files: プロジェクト内テキストファイルを一括取得
- write_project_readme: ゲームの README.md を作成
- validate_niconama_spec: game.json/asset/モード整合性の仕様チェック

提供プロンプト:
- design_niconama_game: ニコ生ゲームの要件定義・基本設計支援
- implement_niconama_game: ニコ生ゲーム実装フローと制約に沿った実装ガイド

## 開発者向け(ビルド方法、スクリプトの説明)
起動:
```
npm install
npm start
```

主なスクリプト:
- scripts/fetch-doc.js: Akashic ドキュメントを収集して data/akashic_docs.json を生成
  - USE_WGET=1 で wget ミラー方式
- scripts/convert-wget-mirror.js: data/wget_mirror の HTML を JSON に変換

データ:
- data/akashic_docs.json: ドキュメント検索用のキャッシュ
- data/eslint-config.json: eslint-config 参照資料
- data/complete-audio.json: complete-audio 参照資料

## ライセンス
MIT License. 詳細は LICENSE を参照してください。
