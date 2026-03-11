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
 * - Prompt prefix `/w:S` or `/w:L` to use small or large model for a single prompt
 *
 * Usage in skill frontmatter:
 * ---
 * name: my-skill
 * description: A skill that works best with small models
 * model_size: small
 * ---
 *
 * Usage in prompts:
 * /w:S explain this code briefly    → Uses small model
 * /w:L analyze this architecture    → Uses large model
 * /w:M balance speed and quality    → Uses medium model
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
// Note: Using word boundaries (\b) to avoid matching substrings (e.g., "mini" in "gemini")
const DEFAULT_SMALL_PATTERNS = [
	/\bmini\b/i,
	/\bhaiku\b/i,
	/\bflash\b/i,
	/\bturbo\b/i,
	/\binstant\b/i,
	/\blite\b/i,
	/\btiny\b/i,
	/\bnano\b/i,
	/\bsmall\b/i,
];

const DEFAULT_LARGE_PATTERNS = [
	/\bopus\b/i,
	/\bo1\b/i,
	/\bo3\b/i,
	/\bultra\b/i,
	/\bmax\b/i,
	/\bpro\b/i,
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

// Model size registry - stores custom size overrides and preferred models
interface ModelSizeRegistry {
	// Custom overrides from models.json
	customSizes: Map<string, ModelSize>;
	// User's preferred models for each size (persisted)
	preferredModels: Map<ModelSize, string>; // size -> "provider/modelId"
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

// Load preferred models from JSON file
function loadPreferredModels(agentDir: string): Map<ModelSize, string> {
	const preferredModels = new Map<ModelSize, string>();

	const prefsPath = path.join(agentDir, "model-preferences.json");
	if (!fs.existsSync(prefsPath)) {
		return preferredModels;
	}

	try {
		const content = fs.readFileSync(prefsPath, "utf-8");
		const prefs = JSON.parse(content);

		if (prefs.preferredModels) {
			for (const [size, modelRef] of Object.entries(prefs.preferredModels as Record<string, string>)) {
				const normalizedSize = normalizeSize(size);
				if (normalizedSize && typeof modelRef === "string") {
					preferredModels.set(normalizedSize, modelRef);
				}
			}
		}
	} catch (error) {
		// Silently ignore parse errors
	}

	return preferredModels;
}

// Save preferred models to JSON file
function savePreferredModels(agentDir: string, preferredModels: Map<ModelSize, string>): void {
	const prefsPath = path.join(agentDir, "model-preferences.json");

	try {
		// Ensure directory exists
		const dir = path.dirname(prefsPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		const prefs: Record<string, any> = {
			preferredModels: {}
		};

		for (const [size, modelRef] of preferredModels) {
			prefs.preferredModels[size] = modelRef;
		}

		fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2));
	} catch (error) {
		console.error(`[model-size] Failed to save preferred models: ${error}`);
	}
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
	// Whether we're currently in prompt mode (via /w:S or /w:L)
	inPromptMode: boolean;
}

export default function modelSizeExtension(pi: ExtensionAPI) {
	// Initialize state
	const state: ModelState = {
		originalModel: null,
		inSkillMode: false,
		skillSize: null,
		inPromptMode: false,
	};

	// Model size registry
	const registry: ModelSizeRegistry = {
		customSizes: new Map(),
		preferredModels: new Map(),
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

		// Check if there's a preferred model for this size
		const preferredRef = registry.preferredModels.get(targetSize);
		if (preferredRef) {
			const [provider, ...modelIdParts] = preferredRef.split("/");
			const modelId = modelIdParts.join("/");
			const preferredModel = available.find(
				(m) => m.provider === provider && m.id === modelId
			);
			if (preferredModel) {
				return preferredModel;
			}
			// If preferred model not found, fall through to first match
		}

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
		const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "", ".pi", "agent");
		
		// Load custom sizes from models.json
		registry.customSizes = loadCustomModelSizes(agentDir);

		// Load preferred models from model-preferences.json
		registry.preferredModels = loadPreferredModels(agentDir);

		// Log loaded custom sizes
		if (registry.customSizes.size > 0) {
			console.log(`[model-size] Loaded ${registry.customSizes.size} custom model size overrides`);
		}

		// Log preferred models
		if (registry.preferredModels.size > 0) {
			const prefs = Array.from(registry.preferredModels.entries())
				.map(([size, ref]) => `${size}: ${ref}`)
				.join(", ");
			console.log(`[model-size] Preferred models: ${prefs}`);
		}
	});

	// Intercept input to detect skill loading or model size prefix
	pi.on("input", async (event, ctx) => {
		// Only process interactive input
		if (event.source !== "interactive") {
			return { action: "continue" };
		}

		// Check for /w:S or /w:L prefix (with small/large model)
		const withSizeMatch = event.text.match(/^\/w:([SMLsml])(?:\s+)?(.*)/s);
		if (withSizeMatch) {
			const sizeChar = withSizeMatch[1];
			const remainingText = withSizeMatch[2];

			const targetSize = normalizeSize(sizeChar);
			if (targetSize) {
				// Find a model of the target size
				const targetModel = await findModelOfSize(targetSize, ctx);
				if (targetModel) {
					// Save current model
					const currentModel = ctx.model;
					if (currentModel) {
						state.originalModel = currentModel;
					}

					// Switch to target model
					const success = await pi.setModel(targetModel);
					if (success) {
						state.inPromptMode = true;
						ctx.ui.notify(`Using ${targetModel.provider}/${targetModel.id} (${targetSize})`, "info");
					}
				} else {
					ctx.ui.notify(`No model of size "${targetSize}" available`, "warning");
				}
			}

			// Return the remaining text (stripped of /w:X prefix)
			return { action: "continue", text: remainingText };
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

	// Restore original model after skill execution or prompt with size ends
	// Only restore when there are no pending messages (user hasn't queued follow-ups)
	pi.on("agent_end", async (_event, ctx) => {
		if ((state.inSkillMode || state.inPromptMode) && state.originalModel) {
			// Check if there are pending follow-up messages
			// If so, don't restore yet - the task is still ongoing
			if (ctx.hasPendingMessages()) {
				console.log(`[model-size] Keeping switched model for pending messages`);
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
			state.inPromptMode = false;
		}
	});

	// Register /w command for autocomplete (supports both /w:S prompt and /w S prompt)
	pi.registerCommand("w", {
		description: "Use a specific model size for this prompt (S/M/L)",
		getArgumentCompletions: (prefix: string) => {
			const sizes = [
				{ value: "S", label: "S - small model (fast)" },
				{ value: "M", label: "M - medium model (balanced)" },
				{ value: "L", label: "L - large model (capable)" },
			];
			return sizes.filter((s) => s.value.toLowerCase().startsWith(prefix.toLowerCase()));
		},
		handler: async (args, ctx) => {
			// Parse args: could be "S some prompt" or "S:some prompt"
			const match = args.match(/^([SMLsml])[:\s]\s*(.*)/s);
			if (!match) {
				ctx.ui.notify(
					"Usage: /w:S <prompt>, /w:M <prompt>, or /w:L <prompt>\n" +
					"Example: /w:S explain this code briefly",
					"info"
				);
				return;
			}

			const sizeChar = match[1];
			const remainingText = match[2];

			const targetSize = normalizeSize(sizeChar);
			if (!targetSize) {
				ctx.ui.notify("Invalid size. Use S, M, or L.", "warning");
				return;
			}

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
				state.inPromptMode = true;
				ctx.ui.notify(`Using ${targetModel.provider}/${targetModel.id} (${targetSize})`, "info");
			}

			// Send the remaining text as a user message
			if (remainingText.trim()) {
				pi.sendUserMessage(remainingText.trim(), { deliverAs: "steer" });
			}
		},
	});

	// Register command to show current model size
	pi.registerCommand("model-size", {
		description: "Show the current model size, preferred models, and available models by size",
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
			
			// Show preferred models
			message += `Preferred models:\n`;
			for (const size of ["small", "medium", "large"] as ModelSize[]) {
				const preferred = registry.preferredModels.get(size);
				const marker = preferred ? `→ ${preferred}` : "(not set)";
				message += `  ${size}: ${marker}\n`;
			}
			
			message += `\nAvailable models by size:\n`;
			message += `\nSmall:\n${bySize.small.map((m) => `  ${m.provider}/${m.id}`).join("\n") || "  (none)"}\n`;
			message += `\nMedium:\n${bySize.medium.map((m) => `  ${m.provider}/${m.id}`).join("\n") || "  (none)"}\n`;
			message += `\nLarge:\n${bySize.large.map((m) => `  ${m.provider}/${m.id}`).join("\n") || "  (none)"}`;

			ctx.ui.notify(message, "info");
		},
	});

	// Register command to set preferred model for a size
	pi.registerCommand("set-model-size", {
		description: "Set preferred model for a size category (e.g., /set-model-size small claude-haiku-4-5)",
		getArgumentCompletions: async (prefix: string, fullArgs: string, ctx: ExtensionContext) => {
			const args = fullArgs.trim();
			const parts = args.split(/\s+/);
			
			// First argument: size
			if (parts.length === 0 || (parts.length === 1 && !args.includes(" "))) {
				const sizes = ["small", "medium", "large", "S", "M", "L"];
				const filtered = sizes.filter((s) => s.toLowerCase().startsWith(prefix.toLowerCase()));
				return filtered.map((s) => ({ value: s, label: s }));
			}
			
			// Second argument: model name
			if (parts.length >= 1) {
				const sizeInput = parts[0];
				const targetSize = normalizeSize(sizeInput);
				
				if (!targetSize) {
					return [];
				}
				
				// Get available models of this size
				const available = await ctx.modelRegistry.getAvailable();
				const matchingModels = available.filter((model) => {
					const size = getModelSize(model);
					return size === targetSize;
				});
				
				// Model prefix is everything after the size and space
				const modelPrefix = parts.slice(1).join(" ").toLowerCase();
				
				const completions = matchingModels
					.filter((m) => {
						const ref = `${m.provider}/${m.id}`.toLowerCase();
						return ref.includes(modelPrefix) || m.id.toLowerCase().includes(modelPrefix);
					})
					.map((m) => ({
						value: `${m.provider}/${m.id}`,
						label: `${m.provider}/${m.id}`,
						description: m.name || m.id,
					}));
				
				return completions;
			}
			
			return [];
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			
			if (parts.length < 2) {
				ctx.ui.notify(
					"Usage: /set-model-size <size> <model>\n" +
					"Size: small, medium, large (or S, M, L)\n" +
					"Example: /set-model-size small claude-haiku-4-5",
					"info"
				);
				return;
			}
			
			const sizeInput = parts[0];
			const modelRef = parts.slice(1).join(" "); // Handle model names with spaces
			
			const targetSize = normalizeSize(sizeInput);
			
			if (!targetSize) {
				ctx.ui.notify(`Invalid size: ${sizeInput}. Use small, medium, or large.`, "warning");
				return;
			}
			
			// Parse model reference (provider/modelId or just modelId)
			let provider: string | undefined;
			let modelId: string;
			
			if (modelRef.includes("/")) {
				const slashIndex = modelRef.indexOf("/");
				provider = modelRef.slice(0, slashIndex);
				modelId = modelRef.slice(slashIndex + 1);
			} else {
				modelId = modelRef;
			}
			
			// Find the model in available models
			const available = await ctx.modelRegistry.getAvailable();
			let targetModel: Model | undefined;
			
			if (provider) {
				targetModel = available.find((m) => m.provider === provider && m.id === modelId);
			} else {
				// Try to find by model ID alone
				const matches = available.filter((m) => m.id === modelId);
				if (matches.length === 1) {
					targetModel = matches[0];
				} else if (matches.length > 1) {
					ctx.ui.notify(
						`Multiple providers for model "${modelId}". Use provider/modelId format.\n` +
						`Available: ${matches.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
						"warning"
					);
					return;
				}
			}
			
			if (!targetModel) {
				ctx.ui.notify(`Model not found: ${modelRef}`, "error");
				return;
			}
			
			// Verify the model matches the target size (or warn)
			const actualSize = getModelSize(targetModel);
			if (actualSize !== targetSize) {
				ctx.ui.notify(
					`Warning: ${targetModel.provider}/${targetModel.id} is detected as "${actualSize}", not "${targetSize}".\n` +
					`Setting as preferred ${targetSize} model anyway.`,
					"warning"
				);
			}
			
			// Set as preferred model for this size
			const fullRef = `${targetModel.provider}/${targetModel.id}`;
			registry.preferredModels.set(targetSize, fullRef);
			
			// Persist to file
			const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "", ".pi", "agent");
			savePreferredModels(agentDir, registry.preferredModels);
			
			ctx.ui.notify(
				`Set preferred ${targetSize} model: ${fullRef}\n` +
				`This will be used when selecting ${targetSize} models.`,
				"info"
			);
		},
	});

	// Register command to end skill/prompt mode and restore original model
	pi.registerCommand("end-skill", {
		description: "End skill/prompt mode and restore the original model",
		handler: async (_args, ctx) => {
			if (!state.inSkillMode && !state.inPromptMode) {
				ctx.ui.notify("Not in skill or prompt mode", "warning");
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
			state.inPromptMode = false;
		},
	});
}