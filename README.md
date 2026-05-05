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
node dist/index.js --target ginpei.dev --output ./logs/network.jsonl
```

オプション:

- `--output`, `-o` (必須): 出力 JSONL ファイルパス
- `--interval`, `-i` (任意): 監視間隔（秒）。既定 `60`
- `--target`, `-t` (必須): 監視先ホスト
- `--ping-hops`, `-p` (任意): `traceroute` の先頭から `ping` する hop 数。既定 `3`

例:

```bash
node dist/index.js -i 30 -t ginpei.dev -o ./logs/network.jsonl
```

## 判定ロジック概要

1. `traceroute` で先頭 hop の IP を抽出（既定 3 hop）
2. 抽出した hop 群へ `ping`（全て失敗なら `router`）
3. 監視先へ `ping`（成功なら `healthy`）
4. `traceroute` 解析
   - 到達先IPまで到達していれば `destination`
   - 途中まで応答があり未到達なら `route`
   - 上記で判定不可なら `unknown`

## ログ形式 (JSONL)

1行につき1レコードを追記します。

```json
{"timestamp":"2026-04-28T18:00:00.000Z","target":"ginpei.dev","targetIp":"203.0.113.10","intervalSec":60,"classification":"route","ping":[{"ip":"192.168.1.1","ok":false,"error":"Command failed: ping -c 1 -W 2 '192.168.1.1'"},{"ip":"10.0.0.1","ok":true}],"destinationPing":{"ok":false,"error":"Command failed: ping -c 1 -W 2 'ginpei.dev'"},"traceroute":{"ok":false,"reachedTarget":false,"lastResponsiveHop":4,"timeoutHopCount":11,"error":"Command failed: traceroute -n -q 1 -w 2 -m 15 'ginpei.dev'"}}
```

## 可視化スクリプト

```bash
node script/visualize.ts [output.txt]
```

- 1行 = 1時間
- 1文字 = 1ログ（分単位）
- `.` = healthy, `!` = problematic, ` ` = not logged
- 入力ファイルを省略した場合は標準入力から受け取る
- 10分ごとに ` ` を挿入する

出力例:

```text
00 .......... .......... .......... ........... ........... ..........
01 ......   . ...!!..... !....         .....!!! !!!!!!..... ..........
```
