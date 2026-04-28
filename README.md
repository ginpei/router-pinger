# router-pinger

WSL/Linux でネットワーク状態を定期診断し、JSON Lines でログ記録する CLI ツールです。  
障害を `router` / `route` / `destination` / `unknown` に分類します。

## セットアップ

```bash
npm install
npm run build
```

## 使い方

```bash
node dist/index.js --output ./logs/network.jsonl
```

オプション:

- `--output`, `-o` (必須): 出力 JSONL ファイルパス
- `--interval`, `-i` (任意): 監視間隔（秒）。既定 `60`
- `--target`, `-t` (任意): 監視先ホスト。既定 `ginpei.dev`

例:

```bash
node dist/index.js -o ./logs/network.jsonl -i 30 -t ginpei.dev
```

## 判定ロジック概要

1. `ip route` でデフォルトゲートウェイを取得
2. ゲートウェイへ `ping`（失敗なら `router`）
3. 監視先へ `ping`（成功なら `healthy`）
4. `traceroute` 解析
   - 到達先IPまで到達していれば `destination`
   - 途中まで応答があり未到達なら `route`
   - 上記で判定不可なら `unknown`

## ログ形式 (JSONL)

1行につき1レコードを追記します。

```json
{"timestamp":"2026-04-28T18:00:00.000Z","target":"ginpei.dev","targetIp":"203.0.113.10","outputPath":"./logs/network.jsonl","intervalSec":60,"classification":"route","gateway":{"ip":"192.168.1.1","reachable":true},"destinationPing":{"reachable":false,"error":"Command failed: ping -c 1 -W 2 'ginpei.dev'"},"traceroute":{"ok":false,"reachedTarget":false,"lastResponsiveHop":4,"timeoutHopCount":11,"error":"Command failed: traceroute -n -q 1 -w 2 -m 15 'ginpei.dev'"}}
```
