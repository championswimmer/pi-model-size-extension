/**
 * Model Size Extension for Pi
 *
 * This extension enables skills to specify a preferred model size (small, medium, large)
 * and automatically switches to an appropriate model when the skill is loaded.
 *
 * Features:
 * - Skills can specify `model_size: small|medium|large` (or S|M|L) in their frontmatter
 * - Models can have a size override in settings (models.json)
 * - Default size detection for known models (gpt-mini, haiku, gemini-flash → small, etc.)
 * - Automatic model switching when skill is loaded via `/skill:abc`
 * - Automatic restoration of original model when skill execution ends
 *
 * Usage in skill frontmatter:
 * ---
 * name: my-skill
 * description: A skill that works best with small models
 * model_size: small
 * ---
 *
 * Usage in models.json for custom model size override:
 * {
 *   "providers": {
 *     "anthropic": {
 *       "modelOverrides": {
 *         "claude-sonnet-4": { "size": "medium" }
 *       }
 *     }
 *   }
 * }
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";

// Model size types
export type ModelSize = "small" | "medium" | "large";

// Normalize size input (accepts small/medium/large or S/M/L)
function normalizeSize(size: string): ModelSize | null {
	const normalized = size.toLowerCase().trim();
	if (normalized === "small" || normalized === "s") return "small";
	if (normalized === "medium" || normalized === "m") return "medium";
	if (normalized === "large" || normalized === "l") return "large";
	return null;
}

// Default model size patterns
const DEFAULT_SMALL_PATTERNS = [
	/mini/i,
	/haiku/i,
	/flash/i,
	/turbo/i,
	/instant/i,
	/lite/i,
	/tiny/i,
	/\bnano\b/i,
	/\bsmall\b/i,
];

const DEFAULT_LARGE_PATTERNS = [
	/opus/i,
	/o1/i,
	/o3/i,
	/ultra/i,
	/max/i,
	/pro/i,
	/\blarge\b/i,
	/\bbig\b/i,
];

// Infer model size from model ID/name
function inferModelSize(model: Model): ModelSize {
	const modelId = model.id.toLowerCase();
	const modelName = (model.name || model.id).toLowerCase();

	// Check for small patterns
	for (const pattern of DEFAULT_SMALL_PATTERNS) {
		if (pattern.test(modelId) || pattern.test(modelName)) {
			return "small";
		}
	}

	// Check for large patterns
	for (const pattern of DEFAULT_LARGE_PATTERNS) {
		if (pattern.test(modelId) || pattern.test(modelName)) {
			return "large";
		}
	}

	// Default to medium
	return "medium";
}

// Model size registry - stores custom size overrides
interface ModelSizeRegistry {
	// Custom overrides from models.json
	customSizes: Map<string, ModelSize>;
}

// Parse models.json for custom size overrides
function loadCustomModelSizes(agentDir: string): Map<string, ModelSize> {
	const customSizes = new Map<string, ModelSize>();

	const modelsPath = path.join(agentDir, "models.json");
	if (!fs.existsSync(modelsPath)) {
		return customSizes;
	}

	try {
		const content = fs.readFileSync(modelsPath, "utf-8");
		const config = JSON.parse(content);

		if (config.providers) {
			for (const [providerName, providerConfig] of Object.entries(config.providers as Record<string, any>)) {
				// Check modelOverrides for size
				if (providerConfig.modelOverrides) {
					for (const [modelId, override] of Object.entries(providerConfig.modelOverrides as Record<string, any>)) {
						if (override && typeof override === "object" && "size" in override) {
							const size = normalizeSize(override.size);
							if (size) {
								customSizes.set(`${providerName}/${modelId}`, size);
							}
						}
					}
				}

				// Check models array for size
				if (providerConfig.models && Array.isArray(providerConfig.models)) {
					for (const model of providerConfig.models) {
						if (model.id && model.size) {
							const size = normalizeSize(model.size);
							if (size) {
								customSizes.set(`${providerName}/${model.id}`, size);
							}
						}
					}
				}
			}
		}
	} catch (error) {
		// Silently ignore parse errors
	}

	return customSizes;
}

// Skill frontmatter interface
interface SkillFrontmatter {
	name?: string;
	description?: string;
	model_size?: string;
	[key: string]: any;
}

// Parse skill file to extract frontmatter
function parseSkillFrontmatter(skillPath: string): SkillFrontmatter | null {
	try {
		const content = fs.readFileSync(skillPath, "utf-8");

		// Extract YAML frontmatter between --- markers
		const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (!frontmatterMatch) {
			return null;
		}

		// Parse simple YAML key-value pairs
		const frontmatter: Record<string, any> = {};
		const lines = frontmatterMatch[1].split("\n");
		for (const line of lines) {
			const colonIndex = line.indexOf(":");
			if (colonIndex === -1) continue;
			const key = line.slice(0, colonIndex).trim();
			let value: any = line.slice(colonIndex + 1).trim();

			// Remove quotes if present
			if ((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}

			frontmatter[key] = value;
		}

		return frontmatter;
	} catch (error) {
		return null;
	}
}

// State management
interface ModelState {
	// Original model before skill-based switch
	originalModel: Model | null;
	// Whether we're currently in skill mode
	inSkillMode: boolean;
	// The size preference of the current skill
	skillSize: ModelSize | null;
}

export default function modelSizeExtension(pi: ExtensionAPI) {
	// Initialize state
	const state: ModelState = {
		originalModel: null,
		inSkillMode: false,
		skillSize: null,
	};

	// Model size registry
	const registry: ModelSizeRegistry = {
		customSizes: new Map(),
	};

	// Get the effective size for a model
	function getModelSize(model: Model): ModelSize {
		const key = `${model.provider}/${model.id}`;
		const customSize = registry.customSizes.get(key);
		if (customSize) {
			return customSize;
		}
		return inferModelSize(model);
	}

	// Find a model of a specific size from available models
	async function findModelOfSize(
		targetSize: ModelSize,
		ctx: ExtensionContext
	): Promise<Model | null> {
		const available = await ctx.modelRegistry.getAvailable();

		// Filter models by size
		const matchingModels = available.filter((model) => {
			const size = getModelSize(model);
			return size === targetSize;
		});

		// Return first match
		return matchingModels[0] || null;
	}

	// Load custom model sizes on session start
	pi.on("session_start", async (_event, ctx) => {
		// Load custom sizes from models.json
		const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "", ".pi", "agent");
		registry.customSizes = loadCustomModelSizes(agentDir);

		// Log loaded custom sizes
		if (registry.customSizes.size > 0) {
			console.log(`[model-size] Loaded ${registry.customSizes.size} custom model size overrides`);
		}
	});

	// Intercept input to detect skill loading
	pi.on("input", async (event, ctx) => {
		// Only process interactive input
		if (event.source !== "interactive") {
			return { action: "continue" };
		}

		// Check for /skill:xxx pattern
		const skillMatch = event.text.match(/^\/skill:([^\s]+)/);
		if (!skillMatch) {
			// Not a skill command - continue normally
			// Model restoration is handled by agent_end when skill execution completes
			return { action: "continue" };
		}

		const skillName = skillMatch[1];

		// Find the skill file
		// Skills are discovered from multiple locations - we need to search for them
		const skillPaths = getSkillSearchPaths(ctx.cwd);

		for (const skillDir of skillPaths) {
			// Try direct file
			const directPath = path.join(skillDir, `${skillName}.md`);
			if (fs.existsSync(directPath)) {
				const frontmatter = parseSkillFrontmatter(directPath);
				if (frontmatter?.model_size) {
					await handleSkillModelSize(frontmatter.model_size, ctx);
				}
				return { action: "continue" };
			}

			// Try directory/SKILL.md
			const dirPath = path.join(skillDir, skillName, "SKILL.md");
			if (fs.existsSync(dirPath)) {
				const frontmatter = parseSkillFrontmatter(dirPath);
				if (frontmatter?.model_size) {
					await handleSkillModelSize(frontmatter.model_size, ctx);
				}
				return { action: "continue" };
			}
		}

		// Skill not found locally, continue normally
		return { action: "continue" };
	});

	// Get skill search paths
	function getSkillSearchPaths(cwd: string): string[] {
		const paths: string[] = [];

		// Global paths
		const homeDir = process.env.HOME || "";
		paths.push(path.join(homeDir, ".pi", "agent", "skills"));
		paths.push(path.join(homeDir, ".agents", "skills"));

		// Project paths (walking up from cwd)
		let currentDir = cwd;
		while (currentDir !== path.dirname(currentDir)) {
			paths.push(path.join(currentDir, ".pi", "skills"));
			paths.push(path.join(currentDir, ".agents", "skills"));
			currentDir = path.dirname(currentDir);
		}

		return paths;
	}

	// Handle model size switch for skill
	async function handleSkillModelSize(sizeInput: string, ctx: ExtensionContext): Promise<void> {
		const targetSize = normalizeSize(sizeInput);
		if (!targetSize) {
			console.log(`[model-size] Invalid model_size value: ${sizeInput}`);
			return;
		}

		// Find a model of the target size
		const targetModel = await findModelOfSize(targetSize, ctx);
		if (!targetModel) {
			ctx.ui.notify(`No model of size "${targetSize}" available`, "warning");
			return;
		}

		// Save current model
		const currentModel = ctx.model;
		if (currentModel) {
			state.originalModel = currentModel;
		}

		// Switch to target model
		const success = await pi.setModel(targetModel);
		if (success) {
			state.inSkillMode = true;
			state.skillSize = targetSize;
			ctx.ui.notify(`Switched to ${targetModel.provider}/${targetModel.id} (${targetSize})`, "info");
		}
	}

	// Restore original model after skill execution ends
	// Only restore when there are no pending messages (user hasn't queued follow-ups)
	pi.on("agent_end", async (_event, ctx) => {
		if (state.inSkillMode && state.originalModel) {
			// Check if there are pending follow-up messages
			// If so, don't restore yet - the skill task is still ongoing
			if (ctx.hasPendingMessages()) {
				console.log(`[model-size] Keeping skill model for pending messages`);
				return;
			}

			// Restore original model
			const success = await pi.setModel(state.originalModel);
			if (success) {
				ctx.ui.notify(`Restored model to ${state.originalModel.provider}/${state.originalModel.id}`, "info");
			}

			// Reset state
			state.originalModel = null;
			state.inSkillMode = false;
			state.skillSize = null;
		}
	});

	// Register command to show current model size
	pi.registerCommand("model-size", {
		description: "Show the current model size and available models by size",
		handler: async (_args, ctx) => {
			const currentModel = ctx.model;
			if (!currentModel) {
				ctx.ui.notify("No model selected", "warning");
				return;
			}

			const currentSize = getModelSize(currentModel);
			const available = await ctx.modelRegistry.getAvailable();

			// Group models by size
			const bySize: Record<string, Model[]> = {
				small: [],
				medium: [],
				large: [],
			};

			for (const model of available) {
				const size = getModelSize(model);
				bySize[size].push(model);
			}

			// Build status message
			let message = `Current: ${currentModel.provider}/${currentModel.id} (${currentSize})\n\n`;
			message += `Available models by size:\n`;
			message += `\nSmall:\n${bySize.small.map((m) => `  ${m.provider}/${m.id}`).join("\n") || "  (none)"}\n`;
			message += `\nMedium:\n${bySize.medium.map((m) => `  ${m.provider}/${m.id}`).join("\n") || "  (none)"}\n`;
			message += `\nLarge:\n${bySize.large.map((m) => `  ${m.provider}/${m.id}`).join("\n") || "  (none)"}`;

			ctx.ui.notify(message, "info");
		},
	});

	// Register command to manually set model size preference
	pi.registerCommand("set-model-size", {
		description: "Set model size preference for current session (small/medium/large or S/M/L)",
		getArgumentCompletions: (prefix: string) => {
			const sizes = ["small", "medium", "large", "S", "M", "L"];
			const filtered = sizes.filter((s) => s.toLowerCase().startsWith(prefix.toLowerCase()));
			return filtered.map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			const sizeInput = args.trim();
			const targetSize = normalizeSize(sizeInput);

			if (!targetSize) {
				ctx.ui.notify("Usage: /set-model-size <small|medium|large>", "warning");
				return;
			}

			const targetModel = await findModelOfSize(targetSize, ctx);
			if (!targetModel) {
				ctx.ui.notify(`No model of size "${targetSize}" available`, "error");
				return;
			}

			const success = await pi.setModel(targetModel);
			if (success) {
				ctx.ui.notify(`Switched to ${targetModel.provider}/${targetModel.id} (${targetSize})`, "info");
			}
		},
	});

	// Register command to end skill mode and restore original model
	pi.registerCommand("end-skill", {
		description: "End skill mode and restore the original model",
		handler: async (_args, ctx) => {
			if (!state.inSkillMode) {
				ctx.ui.notify("Not in skill mode", "warning");
				return;
			}

			if (state.originalModel) {
				const success = await pi.setModel(state.originalModel);
				if (success) {
					ctx.ui.notify(`Restored model to ${state.originalModel.provider}/${state.originalModel.id}`, "info");
				}
			}

			state.originalModel = null;
			state.inSkillMode = false;
			state.skillSize = null;
		},
	});
}