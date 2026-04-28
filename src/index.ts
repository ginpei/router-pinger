#!/usr/bin/env node

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { lookup } from "node:dns/promises";
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execCallback);

const DEFAULT_TARGET = "ginpei.dev";
const DEFAULT_INTERVAL_SEC = 60;
const COMMAND_TIMEOUT_MS = 10_000;

type FailureClassification = "router" | "route" | "destination" | "unknown";
type Classification = "healthy" | FailureClassification;

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
  outputPath: string;
  intervalSec: number;
  classification: Classification;
  gateway: {
    ip: string | null;
    reachable: boolean;
    error?: string;
  };
  destinationPing: {
    reachable: boolean;
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
  outputPath: string;
  target: string;
  intervalSec: number;
};

function printUsageAndExit(message?: string): never {
  if (message) {
    process.stderr.write(`${message}\n\n`);
  }
  process.stderr.write(
    [
      "Usage:",
      "  router-pinger --output <path> [--interval <seconds>] [--target <host>]",
      "  router-pinger -o <path> [-i <seconds>] [-t <host>]",
      "",
      "Options:",
      "  --output,  -o   Required. JSONL output file path.",
      `  --interval,-i   Optional. Probe interval in seconds. Default: ${DEFAULT_INTERVAL_SEC}.`,
      `  --target,  -t   Optional. Target hostname/IP. Default: ${DEFAULT_TARGET}.`,
    ].join("\n"),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): CliConfig {
  let outputPath = "";
  let target = DEFAULT_TARGET;
  let intervalSec = DEFAULT_INTERVAL_SEC;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsageAndExit();
    } else if (arg === "--output" || arg === "-o") {
      const value = argv[i + 1];
      if (!value) {
        printUsageAndExit("Missing value for --output/-o");
      }
      outputPath = value;
      i += 1;
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
    } else if (arg.startsWith("-")) {
      printUsageAndExit(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (!outputPath && positional.length > 0) {
    outputPath = positional[0]!;
  }

  if (!outputPath) {
    printUsageAndExit("--output/-o (or first positional argument) is required.");
  }

  return { outputPath, target, intervalSec };
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

async function detectGatewayIp(): Promise<{ ip: string | null; error?: string }> {
  const route = await runCommand("ip route");
  if (!route.ok && !route.stdout) {
    return { ip: null, error: route.error ?? "failed to run ip route" };
  }

  const defaultLine = route.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("default "));
  if (!defaultLine) {
    return { ip: null, error: "default route not found" };
  }

  const tokens = defaultLine.split(/\s+/);
  const viaIndex = tokens.findIndex((token) => token === "via");
  if (viaIndex < 0 || !tokens[viaIndex + 1]) {
    return { ip: null, error: "gateway IP not found in default route" };
  }

  return { ip: tokens[viaIndex + 1] ?? null };
}

async function ping(host: string): Promise<{ reachable: boolean; error?: string }> {
  const result = await runCommand(`ping -c 1 -W 2 ${escapeForShell(host)}`);
  if (result.ok) {
    return { reachable: true };
  }
  return { reachable: false, error: result.error ?? (result.stderr.trim() || "ping failed") };
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
  gatewayReachable: boolean,
  destinationReachable: boolean,
  traceroute: TracerouteSummary,
): Classification {
  if (destinationReachable) {
    return "healthy";
  }
  if (!gatewayReachable) {
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
  const [gatewayInfo, targetIpInfo] = await Promise.all([
    detectGatewayIp(),
    resolveTargetIp(config.target),
  ]);
  const gatewayPing = gatewayInfo.ip ? await ping(gatewayInfo.ip) : { reachable: false, error: gatewayInfo.error };
  const destinationPing = await ping(config.target);
  const traceroute = await runTraceroute(config.target, targetIpInfo.ip);
  const classification = classifyFailure(gatewayPing.reachable, destinationPing.reachable, traceroute);

  return {
    timestamp: new Date().toISOString(),
    target: config.target,
    targetIp: targetIpInfo.ip,
    outputPath: config.outputPath,
    intervalSec: config.intervalSec,
    classification,
    gateway: {
      ip: gatewayInfo.ip,
      reachable: gatewayPing.reachable,
      error: gatewayInfo.error ?? gatewayPing.error,
    },
    destinationPing: {
      reachable: destinationPing.reachable,
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

  const loop = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    try {
      const record = await runProbe(config);
      await appendJsonl(config.outputPath, record);
      process.stdout.write(`${record.timestamp} ${record.classification}\n`);
    } catch (error) {
      const fallback: ProbeRecord = {
        timestamp: new Date().toISOString(),
        target: config.target,
        targetIp: null,
        outputPath: config.outputPath,
        intervalSec: config.intervalSec,
        classification: "unknown",
        gateway: { ip: null, reachable: false, error: "probe execution failed" },
        destinationPing: { reachable: false, error: "probe execution failed" },
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

    if (!stopped) {
      timer = setTimeout(() => {
        void loop();
      }, config.intervalSec * 1000);
    }
  };

  await loop();
}

void main();
