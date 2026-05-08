#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { exec as execCallback } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execCallback);

const DEFAULT_INTERVAL_SEC = 15;
const DEFAULT_PING_HOPS = 3;
const COMMAND_TIMEOUT_MS = 10_000;

type FailureClassification = "router" | "route" | "destination" | "unknown";
type Classification = "ok" | FailureClassification;

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
};

type TracerouteSummary = {
  ok: boolean;
  reachedTarget: boolean;
  lastResponsiveHop: number | null;
  timeoutHopCount: number;
  stdout: string;
  stderr: string;
  error?: string;
};

type ProbeRecord = {
  timestamp: string;
  target: string;
  targetIp: string | null;
  intervalSec: number;
  classification: Classification;
  ping: Array<{
    ip: string;
    ok: boolean;
    error?: string;
  }>;
  destinationPing: {
    ok: boolean;
    error?: string;
  };
  traceroute: {
    ok: boolean;
    reachedTarget: boolean;
    lastResponsiveHop: number | null;
    timeoutHopCount: number;
    error?: string;
  };
};

type CliConfig = {
  target: string;
  outputPath: string;
  intervalSec: number;
  pingHops: number;
};

function printUsageAndExit(message?: string): never {
  if (message) {
    process.stderr.write(`${message}\n\n`);
  }
  process.stderr.write(
    [
      "Usage:",
      "  router-pinger --target <host> --output <path> [--interval <seconds>] [--ping-hops <count>]",
      "  router-pinger -t <host> -o <path> [-i <seconds>] [-p <count>]",
      "  router-pinger <host> <path> [-i <seconds>] [-p <count>]",
      "",
      "Options:",
      "  --target,  -t   Required. Target hostname/IP.",
      "  --output,  -o   Required. JSONL output file path.",
      `  --interval,-i   Optional. Probe interval in seconds. Default: ${DEFAULT_INTERVAL_SEC}.`,
      `  --ping-hops,-p  Optional. Number of first traceroute hops to ping. Default: ${DEFAULT_PING_HOPS}.`,
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): CliConfig {
  let target = "";
  let outputPath = "";
  let intervalSec = DEFAULT_INTERVAL_SEC;
  let pingHops = DEFAULT_PING_HOPS;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsageAndExit();
    } else if (arg === "--interval" || arg === "-i") {
      const value = argv[i + 1];
      if (!value) {
        printUsageAndExit("Missing value for --interval/-i");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        printUsageAndExit("--interval/-i must be a positive integer.");
      }
      intervalSec = parsed;
      i += 1;
    } else if (arg === "--target" || arg === "-t") {
      const value = argv[i + 1];
      if (!value) {
        printUsageAndExit("Missing value for --target/-t");
      }
      target = value;
      i += 1;
    } else if (arg === "--output" || arg === "-o") {
      const value = argv[i + 1];
      if (!value) {
        printUsageAndExit("Missing value for --output/-o");
      }
      outputPath = value;
      i += 1;
    } else if (arg === "--ping-hops" || arg === "-p") {
      const value = argv[i + 1];
      if (!value) {
        printUsageAndExit("Missing value for --ping-hops/-p");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        printUsageAndExit("--ping-hops/-p must be a positive integer.");
      }
      pingHops = parsed;
      i += 1;
    } else if (arg.startsWith("-")) {
      printUsageAndExit(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (!target && positional.length > 0) {
    target = positional[0]!;
  }
  if (!outputPath && positional.length > 1) {
    outputPath = positional[1]!;
  }

  if (!target) {
    printUsageAndExit("--target/-t (or first positional argument) is required.");
  }
  if (!outputPath) {
    printUsageAndExit("--output/-o (or second positional argument) is required.");
  }

  return { target, outputPath, intervalSec, pingHops };
}

async function runCommand(command: string): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await exec(command, { timeout: COMMAND_TIMEOUT_MS });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      error: err.message,
    };
  }
}

async function ping(host: string): Promise<{ ok: boolean; error?: string }> {
  const result = await runCommand(`ping -c 1 -W 2 ${escapeForShell(host)}`);
  if (result.ok) {
    return { ok: true };
  }
  return { ok: false, error: result.error ?? (result.stderr.trim() || "ping failed") };
}

async function resolveTargetIp(target: string): Promise<{ ip: string | null; error?: string }> {
  try {
    const resolved = await lookup(target);
    return { ip: resolved.address };
  } catch (error) {
    return { ip: null, error: (error as Error).message };
  }
}

function escapeForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseTracerouteLine(line: string): { hop: number | null; ip: string | null; timeout: boolean } {
  const trimmed = line.trim();
  if (!trimmed) {
    return { hop: null, ip: null, timeout: false };
  }

  const hopMatch = trimmed.match(/^(\d+)\s+/);
  if (!hopMatch) {
    return { hop: null, ip: null, timeout: false };
  }

  const hop = Number(hopMatch[1]);
  const timeout = trimmed.includes("*");
  const ipMatch = trimmed.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);

  return {
    hop: Number.isNaN(hop) ? null : hop,
    ip: ipMatch?.[1] ?? null,
    timeout,
  };
}

function extractFirstHopIps(tracerouteOutput: string, hopLimit: number): string[] {
  const ipsByHop = new Map<number, string>();

  for (const line of tracerouteOutput.split("\n")) {
    const parsed = parseTracerouteLine(line);
    if (parsed.hop === null || parsed.ip === null || parsed.hop > hopLimit) {
      continue;
    }
    if (!ipsByHop.has(parsed.hop)) {
      ipsByHop.set(parsed.hop, parsed.ip);
    }
  }

  return [...ipsByHop.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ip]) => ip);
}

async function pingHosts(hosts: string[]): Promise<ProbeRecord["ping"]> {
  return Promise.all(
    hosts.map(async (host) => {
      const result = await ping(host);
      return {
        ip: host,
        ok: result.ok,
        error: result.error,
      };
    }),
  );
}

async function runTraceroute(target: string, targetIp: string | null): Promise<TracerouteSummary> {
  const result = await runCommand(`traceroute -n -q 1 -w 2 -m 15 ${escapeForShell(target)}`);
  if (!result.ok && !result.stdout) {
    return {
      ok: false,
      reachedTarget: false,
      lastResponsiveHop: null,
      timeoutHopCount: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error ?? "traceroute failed",
    };
  }

  let reachedTarget = false;
  let lastResponsiveHop: number | null = null;
  let timeoutHopCount = 0;

  for (const line of result.stdout.split("\n")) {
    const parsed = parseTracerouteLine(line);
    if (parsed.hop === null) {
      continue;
    }
    if (parsed.timeout) {
      timeoutHopCount += 1;
    }
    if (parsed.ip && parsed.hop !== null) {
      lastResponsiveHop = parsed.hop;
      if (targetIp && parsed.ip === targetIp) {
        reachedTarget = true;
      }
    }
  }

  return {
    ok: result.ok,
    reachedTarget,
    lastResponsiveHop,
    timeoutHopCount,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.ok ? undefined : result.error ?? "traceroute returned non-zero",
  };
}

function classifyFailure(
  edgeReachable: boolean,
  destinationReachable: boolean,
  traceroute: TracerouteSummary,
): Classification {
  if (destinationReachable) {
    return "ok";
  }
  if (!edgeReachable) {
    return "router";
  }
  if (traceroute.reachedTarget) {
    return "destination";
  }
  if (traceroute.lastResponsiveHop !== null || traceroute.timeoutHopCount > 0) {
    return "route";
  }
  return "unknown";
}

async function appendJsonl(path: string, record: ProbeRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

async function runProbe(config: CliConfig): Promise<ProbeRecord> {
  const targetIpInfo = await resolveTargetIp(config.target);
  const destinationPing = await ping(config.target);
  const traceroute = await runTraceroute(config.target, targetIpInfo.ip);
  const edgePing = await pingHosts(extractFirstHopIps(traceroute.stdout, config.pingHops));
  const edgeReachable = edgePing.some((node) => node.ok);
  const classification = classifyFailure(edgeReachable, destinationPing.ok, traceroute);

  return {
    timestamp: new Date().toISOString(),
    target: config.target,
    targetIp: targetIpInfo.ip,
    intervalSec: config.intervalSec,
    classification,
    ping: edgePing,
    destinationPing: {
      ok: destinationPing.ok,
      error: destinationPing.error,
    },
    traceroute: {
      ok: traceroute.ok,
      reachedTarget: traceroute.reachedTarget,
      lastResponsiveHop: traceroute.lastResponsiveHop,
      timeoutHopCount: traceroute.timeoutHopCount,
      error: traceroute.error,
    },
  };
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let lastProbeTime: number | null = null;

  const loop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    const now = Date.now();
    if (lastProbeTime === null || now - lastProbeTime >= config.intervalSec * 1000) {
      try {
        let record = await runProbe(config);
        // If route issue, immediately re-check in case it's actually a router issue
        if (record.classification === "route") {
          const recheck = await runProbe(config);
          if (recheck.classification === "router") {
            record = recheck;
            process.stdout.write("[recheck] Detected router issue after route.\n");
          }
        }
        await appendJsonl(config.outputPath, record);
        const d = new Date(record.timestamp);
        const pad = (n: number) => n.toString().padStart(2, '0');
        const localTime = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        process.stdout.write(`${localTime} ${record.classification}\n`);
      } catch (error) {
        const fallback: ProbeRecord = {
          timestamp: new Date().toISOString(),
          target: config.target,
          targetIp: null,
          intervalSec: config.intervalSec,
          classification: "unknown",
          ping: [],
          destinationPing: { ok: false, error: "probe execution failed" },
          traceroute: {
            ok: false,
            reachedTarget: false,
            lastResponsiveHop: null,
            timeoutHopCount: 0,
            error: (error as Error).message,
          },
        };
        await appendJsonl(config.outputPath, fallback);
        process.stderr.write(`${fallback.timestamp} unknown ${(error as Error).message}\n`);
      }
      lastProbeTime = now;
    }

    if (!stopped) {
      timer = setTimeout(() => {
        void loop();
      }, 1000);
    }
  };

  await loop();
}

void main();
