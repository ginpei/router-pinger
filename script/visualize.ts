#!/usr/bin/env node

const fs = require("node:fs");

const HEALTHY_CHAR = ".";
const PROBLEMATIC_CHAR = "!";
const NOT_LOGGED_CHAR = " ";
const DIVIDER_CHAR = " ";
const MINUTES_PER_HOUR = 60;

function usageAndExit(message) {
  if (message) {
    process.stderr.write(`${message}\n\n`);
  }
  process.stderr.write("Usage: node script/visualize.ts [output.txt]\n");
  process.exit(1);
}

function toHourKey(date) {
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}`;
}

function formatSlots(slots) {
  const chunks = [];
  for (let i = 0; i < MINUTES_PER_HOUR; i += 10) {
    chunks.push(slots.slice(i, i + 10).join(""));
  }
  return chunks.join(DIVIDER_CHAR);
}

function main() {
  const inputPath = process.argv[2];
  const raw = inputPath ? fs.readFileSync(inputPath, "utf8") : fs.readFileSync(0, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  const buckets = new Map();

  // Merge all logs in the same hh:mm, show '!' if any failed, '.' if all succeeded
const merged = new Map();
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  let record;
  try {
    record = JSON.parse(line);
  } catch (error) {
    usageAndExit(`Invalid JSON at line ${i + 1}: ${error.message}`);
  }

  const timestamp = new Date(record.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    usageAndExit(`Invalid timestamp at line ${i + 1}.`);
  }
  const hour = timestamp.getHours();
  const minute = timestamp.getMinutes();
  const key = toHourKey(timestamp);
  const slotKey = `${key}:${minute.toString().padStart(2, "0")}`;
  if (!merged.has(slotKey)) {
    merged.set(slotKey, []);
  }
  merged.get(slotKey).push(record.classification === "ok");
}

const buckets2 = new Map();
for (const [slotKey, results] of merged.entries()) {
  const [key, min] = slotKey.split(":");
  const minute = Number(min);
  const state = results.every((ok) => ok) ? HEALTHY_CHAR : PROBLEMATIC_CHAR;
  if (!buckets2.has(key)) {
    buckets2.set(key, new Array(MINUTES_PER_HOUR).fill(NOT_LOGGED_CHAR));
  }
  const slots = buckets2.get(key);
  slots[minute] = state;
}

  const keys = [...buckets2.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const hourLabel = key.slice(-2);
    const slots = buckets2.get(key);
    process.stdout.write(`${hourLabel} ${formatSlots(slots)}\n`);
  }
}

main();
