/**
 * pi-hud — Heads-up display for micro-agents
 *
 * Shows a persistent widget with live agent status:
 * - Agent name, model, streaming state, message count
 * - Last response snippet per agent
 * - Error/notification indicators
 *
 * Also provides:
 * - `/hud` command: manually refresh the HUD
 * - `/hud-agents` command: full status dump (table + last responses)
 *
 * Polls agent sockets on a configurable interval.
 *
 * Usage:
 *   pi -e ./extensions/index.ts
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { connect } from "node:net";
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

interface AgentInfo {
	name: string;
	status: "idle" | "streaming" | "compacting" | "dead" | "unresponsive";
	model: string;
	streaming: boolean;
	messageCount: number;
	receivedCount: number;
	producedCount: number;
	errorCount: number;
	lastResponses: string[];
	statusText: string;
}

// ── Socket RPC helpers ─────────────────────────────────────────────────

function sendRpc(socketPath: string, command: Record<string, unknown>, timeoutMs = 2000): Promise<Record<string, unknown> | null> {
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			sock.destroy();
			resolve(null);
		}, timeoutMs);

		const sock = connect(socketPath, () => {
			sock.write(JSON.stringify(command) + "\n");
		});

		let data = "";
		sock.on("data", (chunk) => {
			data += chunk.toString();
			const lines = data.split("\n");
			data = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const parsed = JSON.parse(line);
					clearTimeout(timeout);
					sock.destroy();
					resolve(parsed);
					return;
				} catch {
					// ignore parse errors
				}
			}
		});

		sock.on("error", () => {
			clearTimeout(timeout);
			resolve(null);
		});
	});
}

// ── Workspace discovery ────────────────────────────────────────────────

function findWorkspace(): string | null {
	try {
		const tmpDir = "/tmp";
		const entries = readdirSync(tmpDir)
			.filter((e) => e.startsWith("pi-agents-"))
			.map((e) => join(tmpDir, e))
			.filter((p) => {
				try {
					return statSync(p).isDirectory();
				} catch {
					return false;
				}
			})
			.sort((a, b) => {
				try {
					return statSync(b).mtimeMs - statSync(a).mtimeMs;
				} catch {
					return 0;
				}
			});
		return entries[0] ?? null;
	} catch {
		return null;
	}
}

function readStatusText(workspace: string, agentName: string): string {
	try {
		const statusFile = join(workspace, "agents", agentName, "status_text");
		if (!existsSync(statusFile)) return "";
		return readFileSync(statusFile, "utf8").trim();
	} catch {
		return "";
	}
}

function discoverAgents(workspace: string): Array<{ name: string; socketPath: string; pid: string }> {
	const agentsDir = join(workspace, "agents");
	if (!existsSync(agentsDir)) return [];

	const agents: Array<{ name: string; socketPath: string; pid: string }> = [];
	try {
		for (const entry of readdirSync(agentsDir)) {
			const dir = join(agentsDir, entry);
			const socketFile = join(dir, "socket");
			const pidFile = join(dir, "pid");
			if (!existsSync(socketFile) || !existsSync(pidFile)) continue;

			const socketPath = readFileSync(socketFile, "utf8").trim();
			const pid = readFileSync(pidFile, "utf8").trim();
			agents.push({ name: basename(dir), socketPath, pid });
		}
	} catch {
		// ignore
	}
	return agents;
}

function isPidAlive(pid: string): boolean {
	try {
		process.kill(parseInt(pid, 10), 0);
		return true;
	} catch {
		return false;
	}
}

// ── Query agent state ──────────────────────────────────────────────────

async function queryAgent(name: string, socketPath: string, pid: string, workspace: string): Promise<AgentInfo> {
	const statusText = readStatusText(workspace, name);

	if (!isPidAlive(pid) || !existsSync(socketPath)) {
		return { name, status: "dead", model: "-", streaming: false, messageCount: 0, receivedCount: 0, producedCount: 0, errorCount: 0, lastResponses: [], statusText };
	}

	// Get state
	const stateResp = await sendRpc(socketPath, { type: "get_state" });
	if (!stateResp || !stateResp.success || !stateResp.data) {
		return { name, status: "unresponsive", model: "-", streaming: false, messageCount: 0, receivedCount: 0, producedCount: 0, errorCount: 0, lastResponses: [], statusText };
	}

	const state = stateResp.data as Record<string, unknown>;
	const model = state.model as Record<string, unknown> | undefined;
	const isStreaming = state.isStreaming as boolean;
	const isCompacting = state.isCompacting as boolean;
	const messageCount = (state.messageCount as number) ?? 0;
	const status: AgentInfo["status"] = isStreaming ? "streaming" : isCompacting ? "compacting" : "idle";
	const modelName = model?.name as string ?? "-";

	// Get messages for counts and last responses
	const msgsResp = await sendRpc(socketPath, { type: "get_messages" }, 3000);
	const lastResponses: string[] = [];
	let receivedCount = 0;
	let producedCount = 0;
	let errorCount = 0;

	if (msgsResp?.success && msgsResp.data) {
		const data = msgsResp.data as Record<string, unknown>;
		const allMsgs = (Array.isArray(data) ? data : ((data.messages as unknown[]) ?? [])) as Array<Record<string, unknown>>;

		for (const msg of allMsgs) {
			if (msg.role === "user") receivedCount++;
			else if (msg.role === "assistant") producedCount++;
			else if (msg.role === "toolResult") {
				const content = msg.content as Array<Record<string, unknown>> ?? [];
				const hasError = content.some((c) => c.type === "text" && typeof c.text === "string" && (c.text as string).startsWith("Error"));
				if (hasError || msg.isError) errorCount++;
			}
		}

		const assistantMsgs = allMsgs.filter((m) => m.role === "assistant").slice(-3);
		for (const msg of assistantMsgs) {
			const content = msg.content as Array<Record<string, unknown>> ?? [];
			const texts = content
				.filter((c) => c.type === "text")
				.map((c) => c.text as string);
			let text = texts.join("\n").trim();
			if (text.length > 200) text = text.substring(0, 197) + "...";
			if (text) lastResponses.push(text);
		}
	}

	// Apply counter reset offset if present
	try {
		const offsetFile = join(workspace, "agents", name, "counter_reset_offset");
		if (existsSync(offsetFile)) {
			const offsets = JSON.parse(readFileSync(offsetFile, "utf8"));
			receivedCount = Math.max(0, receivedCount - (offsets.received ?? 0));
			producedCount = Math.max(0, producedCount - (offsets.produced ?? 0));
			errorCount = Math.max(0, errorCount - (offsets.error ?? 0));
		}
	} catch {
		// ignore
	}

	return { name, status, model: modelName, streaming: isStreaming, messageCount, receivedCount, producedCount, errorCount, lastResponses, statusText };
}

async function queryAllAgents(): Promise<{ workspace: string | null; agents: AgentInfo[] }> {
	const workspace = findWorkspace();
	if (!workspace) return { workspace: null, agents: [] };

	const discovered = discoverAgents(workspace);
	const agents = await Promise.all(
		discovered.map((a) => queryAgent(a.name, a.socketPath, a.pid, workspace))
	);

	return { workspace, agents };
}

// ── Rendering ──────────────────────────────────────────────────────────

function renderHudWidget(agents: AgentInfo[], width: number, theme: Theme, selfName: string | null): string[] {
	if (agents.length === 0) {
		return [theme.fg("dim", "  HUD: no agents")];
	}

	const lines: string[] = [];
	const segments: string[] = [];

	for (const agent of agents) {
		const isSelf = agent.name === selfName;

		const icon =
			agent.status === "streaming" ? theme.fg("accent", "●") :
			agent.status === "compacting" ? theme.fg("warning", "◐") :
			agent.status === "dead" ? theme.fg("error", "✗") :
			agent.status === "unresponsive" ? theme.fg("warning", "?") :
			theme.fg("success", "○");

		// Dim non-self agent names so self pops visually
		const name = isSelf ? theme.fg("success", agent.name) : theme.fg("dim", agent.name);
		const recv = theme.fg("dim", `${agent.receivedCount}↓`);
		const prod = theme.fg("muted", `${agent.producedCount}↑`);
		const err = agent.errorCount > 0
			? theme.fg("error", ` ${agent.errorCount}!`)
			: "";

		segments.push(`${icon} ${name} ${recv} ${prod}${err}`);
	}

	// Show self-agent's status text as first line (above indicators)
	if (selfName) {
		const self = agents.find((a) => a.name === selfName);
		if (self?.statusText) {
			const isError = /\b(error|fail|crash|abort|unable|could not|exception|broken|denied)\b/i.test(self.statusText);
			const statusColor = isError ? "error" : "success";
			lines.push(truncateToWidth(`  ${theme.fg(statusColor, self.statusText)}`, width));
		}
	}

	lines.push(truncateToWidth(`  ${segments.join(theme.fg("dim", " │ "))}`, width));

	return lines;
}

function formatFullStatus(agents: AgentInfo[], theme: Theme): string {
	const lines: string[] = [];

	// Table
	lines.push("| Agent | Status | Model | Streaming | Messages |");
	lines.push("|-------|--------|-------|-----------|----------|");
	for (const a of agents) {
		lines.push(`| ${a.name} | ${a.status} | ${a.model} | ${a.streaming ? "yes" : "no"} | ${a.messageCount} |`);
	}
	lines.push("");

	// Per-agent responses
	for (const a of agents) {
		if (a.status === "dead" || a.status === "unresponsive") {
			lines.push(`${a.name}: (${a.status})`);
		} else if (a.lastResponses.length === 0) {
			lines.push(`${a.name}: (no responses)`);
		} else {
			lines.push(`${a.name}:`);
			if (a.statusText) lines.push(`  status: ${a.statusText}`);
			for (const r of a.lastResponses) {
				lines.push(r);
			}
		}
		lines.push("---");
		lines.push("");
	}

	return lines.join("\n");
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let lastAgents: AgentInfo[] = [];
	let selfName: string | null = null;

	const POLL_INTERVAL_MS = 5000;

	async function refreshHud(ctx: ExtensionContext) {
		const { workspace, agents } = await queryAllAgents();
		lastAgents = agents;

		if (agents.length === 0) {
			ctx.ui.setWidget("pi-hud", undefined);
			ctx.ui.setStatus("pi-hud", undefined);
			return;
		}

		// Detect which agent we are by matching our PID
		if (!selfName && workspace) {
			const selfPid = String(process.pid);
			for (const a of agents) {
				try {
					const pidFile = join(workspace, "agents", a.name, "pid");
					const storedPid = readFileSync(pidFile, "utf8").trim();
					if (storedPid === selfPid) {
						selfName = a.name;
						break;
					}
				} catch {
					// ignore
				}
			}
		}

		// Update widget
		ctx.ui.setWidget("pi-hud", (_tui, theme) => ({
			render: () => renderHudWidget(lastAgents, 80, theme, selfName),
			invalidate: () => {},
		}));

		// Update status line
		const streaming = agents.filter((a) => a.status === "streaming").length;
		const dead = agents.filter((a) => a.status === "dead").length;
		const total = agents.length;

		const theme = ctx.ui.theme;
		let status = theme.fg("dim", `agents: ${total}`);
		if (streaming > 0) status += theme.fg("accent", ` ${streaming}⚡`);
		if (dead > 0) status += theme.fg("error", ` ${dead}✗`);
		ctx.ui.setStatus("pi-hud", status);
	}

	function startPolling(ctx: ExtensionContext) {
		stopPolling();
		pollTimer = setInterval(() => refreshHud(ctx), POLL_INTERVAL_MS);
		// Initial refresh
		refreshHud(ctx);
	}

	function stopPolling() {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	// ── Lifecycle ────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		startPolling(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopPolling();
	});

	// Refresh on agent events (turns starting/ending)
	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.hasUI) refreshHud(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.hasUI) refreshHud(ctx);
	});

	// ── Commands ─────────────────────────────────────────────────────

	pi.registerCommand("hud", {
		description: "Refresh the agent HUD",
		handler: async (_args, ctx) => {
			await refreshHud(ctx);
			ctx.ui.notify("HUD refreshed", "info");
		},
	});

	pi.registerCommand("hud-reset", {
		description: "Reset HUD counters for all agents or a specific agent. Usage: /hud-reset [agent-name]",
		handler: async (args, ctx) => {
			const workspace = findWorkspace();
			if (!workspace) {
				ctx.ui.notify("No agent workspace found", "warning");
				return;
			}

			const targetAgent = args.trim() || null;
			const discovered = discoverAgents(workspace);
			let resetCount = 0;

			for (const agent of discovered) {
				if (targetAgent && agent.name !== targetAgent) continue;
				const dir = join(workspace, "agents", agent.name);

				// Clear status text
				const statusFile = join(dir, "status_text");
				if (existsSync(statusFile)) writeFileSync(statusFile, "");

				// Snapshot current raw counts to use as offset
				const info = await queryAgent(agent.name, agent.socketPath, agent.pid, workspace);
				// Read existing offset to get true raw counts
				let prevOffset = { received: 0, produced: 0, error: 0 };
				try {
					const offsetFile = join(dir, "counter_reset_offset");
					if (existsSync(offsetFile)) prevOffset = JSON.parse(readFileSync(offsetFile, "utf8"));
				} catch { /* ignore */ }

				const rawReceived = info.receivedCount + (prevOffset.received ?? 0);
				const rawProduced = info.producedCount + (prevOffset.produced ?? 0);
				const rawError = info.errorCount + (prevOffset.error ?? 0);

				writeFileSync(
					join(dir, "counter_reset_offset"),
					JSON.stringify({ received: rawReceived, produced: rawProduced, error: rawError })
				);
				resetCount++;
			}

			await refreshHud(ctx);
			ctx.ui.notify(`Reset ${resetCount} agent(s)`, "info");
		},
	});

	pi.registerCommand("hud-status", {
		description: "Show full agent status (table + last responses)",
		handler: async (_args, ctx) => {
			const { workspace, agents } = await queryAllAgents();

			if (!workspace || agents.length === 0) {
				ctx.ui.notify("No agent workspace found", "warning");
				return;
			}

			const theme = ctx.ui.theme;
			const output = formatFullStatus(agents, theme);
			ctx.ui.notify(`Workspace: ${workspace}\n\n${output}`, "info");
		},
	});
}
