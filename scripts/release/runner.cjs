#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { evaluatePrerequisite } = require("./environment.cjs");

function fingerprint(command) {
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(command))
		.digest("hex");
}

function replaceSecrets(value, secrets) {
	let redacted = value;
	for (const secret of secrets)
		redacted = redacted.split(secret).join("[REDACTED]");
	return redacted;
}

function createChunkRedactor(output, secrets) {
	const maxSecretLength = secrets.reduce(
		(max, value) => Math.max(max, value.length),
		0,
	);
	let pending = "";
	return {
		write(chunk) {
			pending += chunk.toString("utf8");
			if (maxSecretLength === 0) {
				output.write(pending);
				pending = "";
				return;
			}
			const keep = Math.max(0, maxSecretLength - 1);
			if (pending.length <= keep) return;
			const redacted = replaceSecrets(pending, secrets);
			const emitLength = Math.max(0, redacted.length - keep);
			output.write(redacted.slice(0, emitLength));
			pending = redacted.slice(emitLength);
		},
		flush() {
			if (pending) output.write(replaceSecrets(pending, secrets));
			pending = "";
		},
	};
}

function runProcess(command, options) {
	return new Promise((resolve) => {
		const started = Date.now();
		const output = fs.createWriteStream(options.logFile, {
			flags: "wx",
			mode: 0o600,
		});
		const secrets = [
			...new Set(
				(options.redactValues || []).filter(
					(value) => typeof value === "string" && value.length >= 4,
				),
			),
		].sort((a, b) => b.length - a.length);
		const stdout = createChunkRedactor(output, secrets);
		const stderr = createChunkRedactor(output, secrets);
		const child = spawn(command[0], command.slice(1), {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", (chunk) => stdout.write(chunk));
		child.stderr.on("data", (chunk) => stderr.write(chunk));
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000).unref();
		}, options.timeoutMs);
		child.on("error", (error) =>
			stderr.write(`\nrunner error: ${error.message}\n`),
		);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			stdout.flush();
			stderr.flush();
			output.end(() =>
				resolve({
					code: code ?? 1,
					signal,
					timedOut,
					durationMs: Date.now() - started,
				}),
			);
		});
	});
}

async function runScenarios(scenarios, options) {
	fs.mkdirSync(options.logDir, { recursive: true });
	const results = [];
	for (const scenario of scenarios) {
		if (options.stage && scenario.stage !== options.stage) continue;
		const platform = options.platform || `${process.platform}-${process.arch}`;
		if (!scenario.platforms.includes(platform)) {
			results.push({
				id: scenario.id,
				required: scenario.required,
				status: "unsupported",
				durationMs: 0,
				exitCode: null,
				commandFingerprint: fingerprint(scenario.command),
				log: null,
				reason: `platform ${platform} is unsupported (expected ${scenario.platforms.join(", ")})`,
			});
			continue;
		}
		const unavailable = scenario.prerequisites
			.map((prerequisite) => [
				prerequisite,
				evaluatePrerequisite(prerequisite, options.env),
			])
			.filter(([, result]) => !result.ok);
		if (unavailable.length) {
			results.push({
				id: scenario.id,
				required: scenario.required,
				status: "skipped",
				durationMs: 0,
				exitCode: null,
				commandFingerprint: fingerprint(scenario.command),
				log: null,
				reason: unavailable
					.map(([prerequisite, result]) => `${prerequisite}: ${result.detail}`)
					.join("; "),
			});
			continue;
		}
		const logFile = path.join(options.logDir, `${scenario.id}.log`);
		const result = await runProcess(scenario.command, {
			cwd: options.cwd,
			env: options.env,
			timeoutMs: scenario.timeoutMs,
			logFile,
			redactValues: options.redactValues,
		});
		results.push({
			id: scenario.id,
			required: scenario.required,
			status: result.code === 0 && !result.timedOut ? "passed" : "failed",
			durationMs: result.durationMs,
			exitCode: result.code,
			signal: result.signal,
			timedOut: result.timedOut,
			commandFingerprint: fingerprint(scenario.command),
			log: path.relative(options.evidenceRoot, logFile),
		});
	}
	return results;
}

function assertRequiredPassed(results, expectedScenarios) {
	const byId = new Map(results.map((result) => [result.id, result]));
	const failures = [];
	for (const scenario of expectedScenarios.filter((item) => item.required)) {
		const result = byId.get(scenario.id);
		if (!result) failures.push(`${scenario.id}: not executed`);
		else if (result.status !== "passed")
			failures.push(
				`${scenario.id}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`,
			);
	}
	if (failures.length)
		throw new Error(
			`required release scenarios did not pass:\n${failures.join("\n")}`,
		);
}

module.exports = {
	runProcess,
	runScenarios,
	assertRequiredPassed,
	fingerprint,
};
