# router-pinger

A CLI tool for WSL/Linux that periodically diagnoses network status and logs results in JSON Lines format.  
Classifies failures as `router`, `route`, `destination`, or `unknown`.

## Setup

```bash
npm install
npm run build
```

## Usage

```bash
node dist/index.js --target ginpei.dev --output ./logs/network.jsonl
```

Options:

- `--output`, `-o` (required): Output JSONL file path
- `--interval`, `-i` (optional): Monitoring interval (seconds). Default: `60`
- `--target`, `-t` (required): Host to monitor
- `--ping-hops`, `-p` (optional): Number of hops from the start to ping in `traceroute`. Default: `3`

Example:

```bash
node dist/index.js -i 30 -t ginpei.dev -o ./logs/network.jsonl
```

## Classification Logic Overview

1. Use `traceroute` to extract the first hop IPs (default: 3 hops)
2. Ping the extracted hops (if all fail, classify as `router`)
3. Ping the target host (if successful, classify as `healthy`)
4. Analyze `traceroute`:
   - If it reaches the target IP, classify as `destination`
   - If there are responses partway but not to the target, classify as `route`
   - If none of the above, classify as `unknown`

## Log Format (JSONL)

Appends one record per line.

```json
{"timestamp":"2026-04-28T18:00:00.000Z","target":"ginpei.dev","targetIp":"203.0.113.10","intervalSec":60,"classification":"route","ping":[{"ip":"192.168.1.1","ok":false,"error":"Command failed: ping -c 1 -W 2 '192.168.1.1'"},{"ip":"10.0.0.1","ok":true}],"destinationPing":{"ok":false,"error":"Command failed: ping -c 1 -W 2 'ginpei.dev'"},"traceroute":{"ok":false,"reachedTarget":false,"lastResponsiveHop":4,"timeoutHopCount":11,"error":"Command failed: traceroute -n -q 1 -w 2 -m 15 'ginpei.dev'"}}
```

## Visualization Script

```bash
node script/visualize.ts [output.txt]
```

- 1 line = 1 hour
- 1 character = 1 log (per minute)
- `.` = healthy, `!` = problematic, ` ` = not logged
- If input file is omitted, reads from standard input
- Inserts a space every 10 minutes

Example output:

```text
00 .......... .......... .......... ........... ........... ..........
01 ......   . ...!!..... !....         .....!!! !!!!!!..... ..........
```
