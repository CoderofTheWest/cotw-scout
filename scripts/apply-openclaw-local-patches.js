#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'node_modules', 'openclaw', 'dist');

const helperBlock = `function normalizeFinalToolFilterName(value) {
\treturn typeof value === "string" ? value.trim().toLowerCase().replaceAll("-", "_") : "";
}
function collectStringList(value) {
\treturn Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}
function collectConfiguredAlsoAllowForFinalToolFilter(params, sessionAgentId) {
\tconst config = params.config;
\tconst additions = [];
\tconst addTools = (tools) => {
\t\tadditions.push(...collectStringList(tools?.alsoAllow));
\t\tconst providerPolicies = tools?.byProvider && typeof tools.byProvider === "object" && !Array.isArray(tools.byProvider) ? tools.byProvider : void 0;
\t\tif (!providerPolicies) return;
\t\tfor (const [key, policy] of Object.entries(providerPolicies)) {
\t\t\tif (!providerToolPolicyMatchesFinalFilter({ key, params })) continue;
\t\t\tadditions.push(...collectStringList(policy?.alsoAllow));
\t\t}
\t};
\taddTools(config?.tools);
\tconst agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
\tconst agent = agents.find((entry) => typeof entry?.id === "string" && entry.id.trim() === sessionAgentId);
\taddTools(agent?.tools);
\treturn additions;
}
function providerToolPolicyMatchesFinalFilter({ key, params }) {
\tconst normalizedKey = normalizeFinalToolFilterName(key);
\tconst provider = normalizeFinalToolFilterName(params.model?.provider ?? params.modelProvider ?? "");
\tconst modelId = normalizeFinalToolFilterName(params.modelId ?? params.model?.id ?? "");
\tif (!normalizedKey || !provider) return false;
\treturn normalizedKey === provider || Boolean(modelId && normalizedKey === \`\${provider}/\${modelId}\`);
}
function buildFinalToolFilterAllowlist(params, sessionAgentId) {
\tif (!params.toolsAllow || params.toolsAllow.length === 0) return;
\tconst names = [...params.toolsAllow, ...collectConfiguredAlsoAllowForFinalToolFilter(params, sessionAgentId)];
\tconst allowlist = new Set(names.map((name) => normalizeFinalToolFilterName(name)).filter(Boolean));
\treturn allowlist.size > 0 ? allowlist : void 0;
}
`;

const buildDynamicNeedle = 'async function buildDynamicTools(input) {\n\tconst { params } = input;';
const oldFilter = '\tconst filteredTools = params.toolsAllow && params.toolsAllow.length > 0 ? visionFilteredTools.filter((tool) => params.toolsAllow?.includes(tool.name)) : visionFilteredTools;\n\treturn normalizeAgentRuntimeTools({';
const newFilter = '\tconst finalToolAllowlist = buildFinalToolFilterAllowlist(params, input.sessionAgentId);\n\tconst filteredTools = finalToolAllowlist ? visionFilteredTools.filter((tool) => finalToolAllowlist.has(normalizeFinalToolFilterName(tool.name))) : visionFilteredTools;\n\treturn normalizeAgentRuntimeTools({';
const currentFilter = '\tconst filteredTools = filterCodexDynamicToolsForAllowlist(filterToolsForVisionInputs(addSandboxShellDynamicToolsIfAvailable(filterCodexDynamicTools(allTools, input.pluginConfig), allTools, input), {\n\t\tmodelHasVision,\n\t\thasInboundImages: (params.images?.length ?? 0) > 0\n\t}), includeForcedMessageToolAllow(params.toolsAllow, params));\n\treturn normalizeAgentRuntimeTools({';
const currentFilterNew = '\tconst finalToolAllowlist = buildFinalToolFilterAllowlist(params, input.sessionAgentId);\n\tconst filteredTools = filterCodexDynamicToolsForAllowlist(filterToolsForVisionInputs(addSandboxShellDynamicToolsIfAvailable(filterCodexDynamicTools(allTools, input.pluginConfig), allTools, input), {\n\t\tmodelHasVision,\n\t\thasInboundImages: (params.images?.length ?? 0) > 0\n\t}), finalToolAllowlist ? includeForcedMessageToolAllow([...finalToolAllowlist], params) : includeForcedMessageToolAllow(params.toolsAllow, params));\n\treturn normalizeAgentRuntimeTools({';

const effectiveInventoryOldImport = 'import { i as getPluginToolMeta, t as buildPluginToolMetadataKey } from "./tools-D9CRirqH.js";';
const effectiveInventoryNewImport = 'import { i as getPluginToolMeta, r as ensureStandalonePluginToolRegistryLoaded, t as buildPluginToolMetadataKey } from "./tools-D9CRirqH.js";';
const effectiveInventoryOldAnchor = '\tconst modelCompat = resolveEffectiveModelCompat({\n\t\tcfg: params.cfg,\n\t\tmodelProvider: params.modelProvider,\n\t\tmodelId: params.modelId\n\t});\n\tconst effectiveTools = createOpenClawCodingTools({';
const effectiveInventoryNewAnchor = '\tconst modelCompat = resolveEffectiveModelCompat({\n\t\tcfg: params.cfg,\n\t\tmodelProvider: params.modelProvider,\n\t\tmodelId: params.modelId\n\t});\n\tensureStandalonePluginToolRegistryLoaded({\n\t\tcontext: {\n\t\t\tconfig: params.cfg,\n\t\t\tworkspaceDir,\n\t\t\tagentDir,\n\t\t\tagentId,\n\t\t\tsessionKey: params.sessionKey\n\t\t},\n\t\ttoolAllowlist: ["group:plugins"],\n\t\tallowGatewaySubagentBinding: true\n\t});\n\tconst effectiveTools = createOpenClawCodingTools({';
const pluginAllowlistHelper = 'function sanitizePluginToolAllowlistForResolution(allowlist) {\n\tif (!allowlist.includes("*")) return allowlist;\n\tconst specific = allowlist.filter((entry) => normalizeToolName(entry) !== "*");\n\treturn specific.length > 0 ? specific : allowlist;\n}\n';
const pluginAllowlistHelperAnchor = 'function resolveToolLoopDetectionConfig(params) {';
const pluginAllowlistHelperAnchorCurrent = 'function createOpenClawCodingTools(options) {';
const pluginAllowlistOld = '\tconst pluginToolAllowlist = collectExplicitAllowlist([\n\t\tprofilePolicyWithAlsoAllow,\n\t\tproviderProfilePolicyWithAlsoAllow,\n\t\tglobalPolicy,\n\t\tglobalProviderPolicy,\n\t\tagentPolicy,\n\t\tagentProviderPolicy,\n\t\tgroupPolicy,\n\t\tsandboxToolPolicy,\n\t\tsubagentPolicy,\n\t\toptions?.runtimeToolAllowlist ? { allow: options.runtimeToolAllowlist } : void 0\n\t]);';
const pluginAllowlistNew = '\tconst pluginToolAllowlist = sanitizePluginToolAllowlistForResolution(collectExplicitAllowlist([\n\t\tprofilePolicyWithAlsoAllow,\n\t\tproviderProfilePolicyWithAlsoAllow,\n\t\tglobalPolicy,\n\t\tglobalProviderPolicy,\n\t\tagentPolicy,\n\t\tagentProviderPolicy,\n\t\tgroupPolicy,\n\t\tsandboxToolPolicy,\n\t\tsubagentPolicy,\n\t\toptions?.runtimeToolAllowlist ? { allow: options.runtimeToolAllowlist } : void 0\n\t]));';
const pluginAllowlistCurrent = '\tconst pluginToolAllowlist = collectExplicitAllowlist([\n\t\tprofilePolicy,\n\t\tproviderProfilePolicy,\n\t\tglobalPolicy,\n\t\tglobalProviderPolicy,\n\t\tagentPolicy,\n\t\tagentProviderPolicy,\n\t\tgroupPolicy,\n\t\tsenderPolicy,\n\t\tsandboxToolPolicy,\n\t\tsubagentPolicy,\n\t\tinheritedToolPolicy,\n\t\toptions?.runtimeToolAllowlist ? { allow: options.runtimeToolAllowlist } : void 0\n\t]);';
const pluginAllowlistCurrentNew = '\tconst pluginToolAllowlist = sanitizePluginToolAllowlistForResolution(collectExplicitAllowlist([\n\t\tprofilePolicyWithAlsoAllow,\n\t\tproviderProfilePolicyWithAlsoAllow,\n\t\tglobalPolicyWithToolSearchControls,\n\t\tglobalProviderPolicyWithToolSearchControls,\n\t\tagentPolicyWithToolSearchControls,\n\t\tagentProviderPolicyWithToolSearchControls,\n\t\tgroupPolicyWithToolSearchControls,\n\t\tsenderPolicyWithToolSearchControls,\n\t\tsandboxToolPolicyWithToolSearchControls,\n\t\tsubagentPolicyWithToolSearchControls,\n\t\tinheritedToolPolicy,\n\t\toptions?.runtimeToolAllowlist ? { allow: options.runtimeToolAllowlist } : void 0\n\t]));';
const gatewayToolResolutionOldImport = 'import { i as getPluginToolMeta } from "./tools-D9CRirqH.js";';
const gatewayToolResolutionNewImport = 'import { i as getPluginToolMeta, r as ensureStandalonePluginToolRegistryLoaded } from "./tools-D9CRirqH.js";';
const gatewayToolResolutionHelper = 'function sanitizeGatewayPluginToolAllowlistForResolution(allowlist) {\n\tif (!allowlist.includes("*")) return allowlist;\n\tconst specific = allowlist.filter((entry) => typeof entry === "string" && entry.trim() !== "*");\n\treturn specific.length > 0 ? specific : allowlist;\n}\n';
const gatewayToolResolutionHelperAnchor = 'function resolveGatewayScopedTools(params) {';
const gatewayToolResolutionOldCreateAnchor = '\tconst workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId ?? resolveDefaultAgentId(params.cfg));\n\tconst policyFiltered = applyToolPolicyPipeline({';
const gatewayToolResolutionNewCreateAnchor = '\tconst workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId ?? resolveDefaultAgentId(params.cfg));\n\tensureStandalonePluginToolRegistryLoaded({\n\t\tcontext: {\n\t\t\tconfig: params.cfg,\n\t\t\tworkspaceDir,\n\t\t\tagentId,\n\t\t\tsessionKey: params.sessionKey\n\t\t},\n\t\ttoolAllowlist: ["group:plugins"],\n\t\tallowGatewaySubagentBinding: params.allowGatewaySubagentBinding\n\t});\n\tconst policyFiltered = applyToolPolicyPipeline({';
const gatewayToolResolutionCurrentLoadAnchor = '\tconst workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId ?? resolveDefaultAgentId(params.cfg));';
const gatewayToolResolutionCurrentLoadNew = '\tconst workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId ?? resolveDefaultAgentId(params.cfg));\n\tensureStandalonePluginToolRegistryLoaded({\n\t\tcontext: {\n\t\t\tconfig: params.cfg,\n\t\t\tworkspaceDir,\n\t\t\tagentId,\n\t\t\tsessionKey: params.sessionKey\n\t\t},\n\t\ttoolAllowlist: ["group:plugins"],\n\t\tallowGatewaySubagentBinding: params.allowGatewaySubagentBinding\n\t});';
const gatewayToolResolutionOldAllowlist = '\t\t\tpluginToolAllowlist: collectExplicitAllowlist([\n\t\t\t\tprofilePolicy,\n\t\t\t\tproviderProfilePolicy,\n\t\t\t\tglobalPolicy,\n\t\t\t\tglobalProviderPolicy,\n\t\t\t\tagentPolicy,\n\t\t\t\tagentProviderPolicy,\n\t\t\t\tgroupPolicy,\n\t\t\t\tsubagentPolicy\n\t\t\t])';
const gatewayToolResolutionNewAllowlist = '\t\t\tpluginToolAllowlist: sanitizeGatewayPluginToolAllowlistForResolution(collectExplicitAllowlist([\n\t\t\t\tprofilePolicyWithAlsoAllow,\n\t\t\t\tproviderProfilePolicyWithAlsoAllow,\n\t\t\t\tglobalPolicy,\n\t\t\t\tglobalProviderPolicy,\n\t\t\t\tagentPolicy,\n\t\t\t\tagentProviderPolicy,\n\t\t\t\tgroupPolicy,\n\t\t\t\tsubagentPolicy\n\t\t\t]))';
const gatewayToolResolutionCurrentAllowlist = '\t\t\tpluginToolAllowlist: collectExplicitAllowlist([\n\t\t\t\tprofilePolicy,\n\t\t\t\tproviderProfilePolicy,\n\t\t\t\tglobalPolicy,\n\t\t\t\tglobalProviderPolicy,\n\t\t\t\tagentPolicy,\n\t\t\t\tagentProviderPolicy,\n\t\t\t\tgroupPolicy,\n\t\t\t\tsubagentPolicy,\n\t\t\t\tinheritedToolPolicy,\n\t\t\t\tgatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : void 0\n\t\t\t])';
const gatewayToolResolutionCurrentAllowlistNew = '\t\t\tpluginToolAllowlist: sanitizeGatewayPluginToolAllowlistForResolution(collectExplicitAllowlist([\n\t\t\t\tprofilePolicyWithAlsoAllow,\n\t\t\t\tproviderProfilePolicyWithAlsoAllow,\n\t\t\t\tglobalPolicy,\n\t\t\t\tglobalProviderPolicy,\n\t\t\t\tagentPolicy,\n\t\t\t\tagentProviderPolicy,\n\t\t\t\tgroupPolicy,\n\t\t\t\tsubagentPolicy,\n\t\t\t\tinheritedToolPolicy,\n\t\t\t\tgatewayRequestedTools.length > 0 ? { allow: gatewayRequestedTools } : void 0\n\t\t\t]))';
const contextLoopRecoveryHelper = `function buildPreemptiveOverflowMidTurnRequest(params) {
	const estimateCache = createMessageCharEstimateCache();
	const estimatedPromptTokens = Math.max(1, Math.ceil(estimateContextChars(params.messages, estimateCache) / 4));
	const promptBudgetBeforeReserve = Math.max(1, Math.floor(params.contextWindowTokens * PREEMPTIVE_OVERFLOW_RATIO));
	const overflowTokens = Math.max(1, estimatedPromptTokens - promptBudgetBeforeReserve);
	return {
		route: "compact_only",
		estimatedPromptTokens,
		promptBudgetBeforeReserve,
		overflowTokens,
		toolResultReducibleChars: 0,
		effectiveReserveTokens: 0
	};
}
`;
const midTurnRecoveryEventHelper = `function buildMidTurnRecoveryEventData(request, extra = {}) {
	return {
		kind: "recovery",
		...extra,
		route: request?.route,
		estimatedPromptTokens: request?.estimatedPromptTokens,
		promptBudget: request?.promptBudgetBeforeReserve,
		overflowTokens: request?.overflowTokens,
		toolResultReducibleChars: request?.toolResultReducibleChars,
		effectiveReserveTokens: request?.effectiveReserveTokens
	};
}
function emitMidTurnRecoveryEvent(params, phase, data = {}) {
	const event = {
		kind: "recovery",
		phase,
		...data
	};
	emitAgentEvent({
		runId: params.runId,
		stream: "recovery",
		data: event
	});
	params.onAgentEvent?.({
		stream: "recovery",
		data: event
	});
}
`;
const midTurnRecoveryEventHelperAnchor = 'function buildPreemptiveOverflowMidTurnRequest(params) {';
const midTurnRecoveryPrecheckOld = '\t\t\t\tconst logMidTurnPrecheck = (route, extra) => {\n\t\t\t\t\tlog$5.warn(`[context-overflow-midturn-precheck] sessionKey=${params.sessionKey ?? params.sessionId} provider=${params.provider}/${params.modelId} route=${route} estimatedPromptTokens=${request.estimatedPromptTokens} promptBudgetBeforeReserve=${request.promptBudgetBeforeReserve} overflowTokens=${request.overflowTokens} toolResultReducibleChars=${request.toolResultReducibleChars} effectiveReserveTokens=${request.effectiveReserveTokens} prePromptMessageCount=${prePromptMessageCount} ` + (extra ? `${extra} ` : "") + `sessionFile=${params.sessionFile}`);\n\t\t\t\t};';
const midTurnRecoveryPrecheckNew = '\t\t\t\tconst logMidTurnPrecheck = (route, extra) => {\n\t\t\t\t\tlog$5.warn(`[context-overflow-midturn-precheck] sessionKey=${params.sessionKey ?? params.sessionId} provider=${params.provider}/${params.modelId} route=${route} estimatedPromptTokens=${request.estimatedPromptTokens} promptBudgetBeforeReserve=${request.promptBudgetBeforeReserve} overflowTokens=${request.overflowTokens} toolResultReducibleChars=${request.toolResultReducibleChars} effectiveReserveTokens=${request.effectiveReserveTokens} prePromptMessageCount=${prePromptMessageCount} ` + (extra ? `${extra} ` : "") + `sessionFile=${params.sessionFile}`);\n\t\t\t\t};\n\t\t\t\temitMidTurnRecoveryEvent(params, "mid_turn_precheck_fired", buildMidTurnRecoveryEventData(request, {\n\t\t\t\t\tprePromptMessageCount\n\t\t\t\t}));';
const midTurnRecoveryTruncatedOld = '\t\t\t\t\t\tlogMidTurnPrecheck(request.route, `handled=true truncatedCount=${truncationResult.truncatedCount}`);';
const midTurnRecoveryTruncatedNew = '\t\t\t\t\t\temitMidTurnRecoveryEvent(params, "tool_result_truncated", buildMidTurnRecoveryEventData(request, {\n\t\t\t\t\t\t\ttruncatedCount: truncationResult.truncatedCount,\n\t\t\t\t\t\t\thandled: true\n\t\t\t\t\t\t}));\n\t\t\t\t\t\tlogMidTurnPrecheck(request.route, `handled=true truncatedCount=${truncationResult.truncatedCount}`);';
const midTurnRecoveryCompactFallbackOld = '\t\t\t\t\t\tlogMidTurnPrecheck("compact_only", `truncateFallbackReason=${truncationResult.reason ?? "unknown"}`);';
const midTurnRecoveryCompactFallbackNew = '\t\t\t\t\t\temitMidTurnRecoveryEvent(params, "compaction_started", buildMidTurnRecoveryEventData(request, {\n\t\t\t\t\t\t\treason: truncationResult.reason ?? "truncate_fallback"\n\t\t\t\t\t\t}));\n\t\t\t\t\t\tlogMidTurnPrecheck("compact_only", `truncateFallbackReason=${truncationResult.reason ?? "unknown"}`);';
const midTurnRecoveryCompactOnlyOld = '\t\t\t\t\tlogMidTurnPrecheck(request.route);';
const midTurnRecoveryCompactOnlyNew = '\t\t\t\t\temitMidTurnRecoveryEvent(params, "compaction_started", buildMidTurnRecoveryEventData(request));\n\t\t\t\t\tlogMidTurnPrecheck(request.route);';
const midTurnRecoveryCompactionObservedOld = '\t\t\t\tconst compactionOccurredThisAttempt = getCompactionCount() > 0;';
const midTurnRecoveryCompactionObservedNew = '\t\t\t\tconst compactionOccurredThisAttempt = getCompactionCount() > 0;\n\t\t\t\tif (preflightRecovery && compactionOccurredThisAttempt) {\n\t\t\t\t\temitMidTurnRecoveryEvent(params, "compaction_completed", {\n\t\t\t\t\t\tkind: "recovery",\n\t\t\t\t\t\troute: preflightRecovery.route,\n\t\t\t\t\t\thandled: preflightRecovery.handled === true,\n\t\t\t\t\t\ttruncatedCount: preflightRecovery.truncatedCount\n\t\t\t\t\t});\n\t\t\t\t\temitMidTurnRecoveryEvent(params, "mid_turn_recovery_retry", {\n\t\t\t\t\t\tkind: "recovery",\n\t\t\t\t\t\troute: preflightRecovery.route\n\t\t\t\t\t});\n\t\t\t\t}';
const midTurnRecoveryResumedOld = '\t\t\treturn {\n\t\t\t\treplayMetadata,';
const midTurnRecoveryResumedNew = '\t\t\tif (preflightRecovery && !promptError && !aborted && !timedOut && !timedOutDuringCompaction) emitMidTurnRecoveryEvent(params, "mid_turn_recovery_resumed", {\n\t\t\t\tkind: "recovery",\n\t\t\t\troute: preflightRecovery.route,\n\t\t\t\thandled: preflightRecovery.handled === true,\n\t\t\t\ttruncatedCount: preflightRecovery.truncatedCount\n\t\t\t});\n\t\t\telse if (preflightRecovery && promptError) emitMidTurnRecoveryEvent(params, "mid_turn_recovery_exhausted", {\n\t\t\t\tkind: "recovery",\n\t\t\t\troute: preflightRecovery.route,\n\t\t\t\terror: formatErrorMessage(promptError)\n\t\t\t});\n\t\t\treturn {\n\t\t\t\treplayMetadata,';
const contextLoopRecoveryHelperAnchor = 'function installContextEngineLoopHook(params) {';
const contextLoopRecoveryOld = `		if (exceedsPreemptiveOverflowThreshold({
			messages: contextMessages,
			maxContextChars
		})) throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);`;
const contextLoopRecoveryNew = `		if (exceedsPreemptiveOverflowThreshold({
			messages: contextMessages,
			maxContextChars
		})) {
			const request = buildPreemptiveOverflowMidTurnRequest({
				messages: contextMessages,
				contextWindowTokens
			});
			params.midTurnPrecheck?.onMidTurnPrecheck?.(request);
			throw new MidTurnPrecheckSignal(request);
		}`;
const openAiHttpEventWriterAnchor = 'function writeUsageChunk(res, params) {\n\twriteSse(res, {';
const openAiHttpEventWriterBlock = `function writeOpenClawAgentEventChunk(res, params) {
	writeSse(res, {
		id: params.runId,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1e3),
		model: params.model,
		choices: [],
		openclaw_event: params.event
	});
}
`;
const openAiHttpEventOld = '\tconst unsubscribe = onAgentEvent((evt) => {\n\t\tif (evt.runId !== runId) return;\n\t\tif (closed) return;\n\t\tif (evt.stream === "assistant") {';
const openAiHttpEventNew = '\tconst unsubscribe = onAgentEvent((evt) => {\n\t\tif (evt.runId !== runId) return;\n\t\tif (closed) return;\n\t\tif (evt.stream === "tool" || evt.stream === "item" || evt.stream === "command_output" || evt.stream === "patch" || evt.stream === "recovery" || (typeof evt.stream === "string" && evt.stream.endsWith(".item"))) writeOpenClawAgentEventChunk(res, {\n\t\t\trunId,\n\t\t\tmodel,\n\t\t\tevent: {\n\t\t\t\tstream: evt.stream,\n\t\t\t\tdata: evt.data\n\t\t\t}\n\t\t});\n\t\tif (evt.stream === "assistant") {';
const openAiHttpEventBridgeWithoutRecovery = 'evt.stream === "tool" || evt.stream === "item" || evt.stream === "command_output" || evt.stream === "patch" || (typeof evt.stream === "string" && evt.stream.endsWith(".item"))';
const openAiHttpEventBridgeWithRecovery = 'evt.stream === "tool" || evt.stream === "item" || evt.stream === "command_output" || evt.stream === "patch" || evt.stream === "recovery" || (typeof evt.stream === "string" && evt.stream.endsWith(".item"))';
const pluginRuntimeRegistryOld = `function resolvePluginToolRegistry(params) {
	const lookup = {
		env: params.loadOptions.env,
		loadOptions: params.loadOptions,
		workspaceDir: params.loadOptions.workspaceDir,
		requiredPluginIds: params.onlyPluginIds
	};
	return getLoadedRuntimePluginRegistry({
		...lookup,
		surface: "channel"
	}) ?? getLoadedRuntimePluginRegistry({
		env: lookup.env,
		workspaceDir: lookup.workspaceDir,
		requiredPluginIds: lookup.requiredPluginIds,
		surface: "active"
	});
}
`;
const pluginRuntimeRegistryNew = `function resolvePluginToolRegistry(params) {
	const lookup = {
		env: params.loadOptions.env,
		loadOptions: params.loadOptions,
		workspaceDir: params.loadOptions.workspaceDir,
		requiredPluginIds: params.onlyPluginIds
	};
	return getLoadedRuntimePluginRegistry({
		...lookup,
		surface: "channel"
	}) ?? getLoadedRuntimePluginRegistry({
		env: lookup.env,
		workspaceDir: lookup.workspaceDir,
		surface: "channel"
	}) ?? getLoadedRuntimePluginRegistry({
		env: lookup.env,
		workspaceDir: lookup.workspaceDir,
		requiredPluginIds: lookup.requiredPluginIds,
		surface: "active"
	}) ?? getLoadedRuntimePluginRegistry({
		env: lookup.env,
		workspaceDir: lookup.workspaceDir,
		surface: "active"
	});
}
`;

function main() {
  if (!fs.existsSync(distDir)) {
    throw new Error(`OpenClaw dist directory not found: ${distDir}`);
  }

  const target = findRunAttemptFile();
  let source = fs.readFileSync(target, 'utf8');
  const alreadyHasHelper = source.includes('function buildFinalToolFilterAllowlist(params, sessionAgentId)');
  const alreadyHasFilter = source.includes(newFilter) || source.includes(currentFilterNew);

  if (!alreadyHasHelper) {
    if (!source.includes(buildDynamicNeedle)) {
      throw new Error('OpenClaw run-attempt shape changed: buildDynamicTools anchor not found');
    }
    source = source.replace(buildDynamicNeedle, `${helperBlock}${buildDynamicNeedle}`);
  }

  if (!alreadyHasFilter) {
    if (source.includes(oldFilter)) {
      source = source.replace(oldFilter, newFilter);
    } else if (source.includes(currentFilter)) {
      source = source.replace(currentFilter, currentFilterNew);
    } else {
      throw new Error('OpenClaw run-attempt shape changed: final toolsAllow filter anchor not found');
    }
  }

  if (!alreadyHasHelper || !alreadyHasFilter) {
    fs.writeFileSync(target, source, 'utf8');
    console.log(`Applied OpenClaw local patch: ${path.relative(root, target)}`);
  } else {
    console.log(`OpenClaw local patch already applied: ${path.relative(root, target)}`);
  }

  applyEffectiveInventoryPatch();
  applyPluginAllowlistPatch();
  applyGatewayToolResolutionPatch();
  applyPluginRuntimeRegistryFallbackPatch();
  applyToolResultFidelityPatch();
  applyContextLoopRecoveryPatch();
  applyOpenAiHttpToolEventPatch();
  applyToolResultRangeToolPatch();
}

function findRunAttemptFile() {
  const files = fs.readdirSync(distDir)
    .filter((name) => /^run-attempt-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes(buildDynamicNeedle) || source.includes('function buildFinalToolFilterAllowlist(params, sessionAgentId)')) return file;
  }
  throw new Error('Could not locate OpenClaw run-attempt dist file');
}

function applyEffectiveInventoryPatch() {
  const target = findEffectiveInventoryFile();
  let source = fs.readFileSync(target, 'utf8');
  const effectiveInventoryImportPattern = /import \{ i as getPluginToolMeta, t as buildPluginToolMetadataKey \} from "\.\/tools-[^"]+\.js";/;
  const alreadyHasImport = /import \{[^}]*ensureStandalonePluginToolRegistryLoaded[^}]*buildPluginToolMetadataKey[^}]*\} from "\.\/tools-[^"]+\.js";/.test(source);
  const alreadyHasLoad = source.includes('ensureStandalonePluginToolRegistryLoaded({\n\t\tcontext: {');

  if (!alreadyHasImport) {
    if (source.includes(effectiveInventoryOldImport)) {
      source = source.replace(effectiveInventoryOldImport, effectiveInventoryNewImport);
    } else if (effectiveInventoryImportPattern.test(source)) {
      source = source.replace(effectiveInventoryImportPattern, (line) => line.replace('i as getPluginToolMeta, t as buildPluginToolMetadataKey', 'i as getPluginToolMeta, r as ensureStandalonePluginToolRegistryLoaded, t as buildPluginToolMetadataKey'));
    } else {
      throw new Error('OpenClaw tools-effective inventory shape changed: plugin tools import anchor not found');
    }
  }

  if (!alreadyHasLoad) {
    if (!source.includes(effectiveInventoryOldAnchor)) {
      throw new Error('OpenClaw tools-effective inventory shape changed: standalone registry load anchor not found');
    }
    source = source.replace(effectiveInventoryOldAnchor, effectiveInventoryNewAnchor);
  }

  if (!alreadyHasImport || !alreadyHasLoad) {
    fs.writeFileSync(target, source, 'utf8');
    console.log(`Applied OpenClaw local patch: ${path.relative(root, target)}`);
  } else {
    console.log(`OpenClaw local patch already applied: ${path.relative(root, target)}`);
  }
}

function findEffectiveInventoryFile() {
  const files = fs.readdirSync(distDir)
    .filter((name) => /^tools-effective-inventory-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes('function resolveEffectiveToolInventory(params)')) return file;
  }
  throw new Error('Could not locate OpenClaw tools-effective inventory dist file');
}

function applyPluginAllowlistPatch() {
  const target = findPiToolsFile();
  let source = fs.readFileSync(target, 'utf8');
  const alreadyHasHelper = source.includes('function sanitizePluginToolAllowlistForResolution(allowlist)');
  const alreadyHasAllowlist = source.includes(pluginAllowlistNew) || source.includes(pluginAllowlistCurrentNew);

  if (!alreadyHasHelper) {
    if (source.includes(pluginAllowlistHelperAnchor)) {
      source = source.replace(pluginAllowlistHelperAnchor, `${pluginAllowlistHelper}${pluginAllowlistHelperAnchor}`);
    } else if (source.includes(pluginAllowlistHelperAnchorCurrent)) {
      source = source.replace(pluginAllowlistHelperAnchorCurrent, `${pluginAllowlistHelper}${pluginAllowlistHelperAnchorCurrent}`);
    } else {
      throw new Error('OpenClaw pi-tools shape changed: plugin allowlist helper anchor not found');
    }
  }

  if (!alreadyHasAllowlist) {
    if (source.includes(pluginAllowlistOld)) {
      source = source.replace(pluginAllowlistOld, pluginAllowlistNew);
    } else if (source.includes(pluginAllowlistCurrent)) {
      source = source.replace(pluginAllowlistCurrent, pluginAllowlistCurrentNew);
    } else {
      throw new Error('OpenClaw pi-tools shape changed: plugin allowlist anchor not found');
    }
  }

  if (!alreadyHasHelper || !alreadyHasAllowlist) {
    fs.writeFileSync(target, source, 'utf8');
    console.log(`Applied OpenClaw local patch: ${path.relative(root, target)}`);
  } else {
    console.log(`OpenClaw local patch already applied: ${path.relative(root, target)}`);
  }
}

function findPiToolsFile() {
  const files = fs.readdirSync(distDir)
    .filter((name) => /^pi-tools-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes('function createOpenClawCodingTools(options)')) return file;
  }
  throw new Error('Could not locate OpenClaw pi-tools dist file');
}


function applyGatewayToolResolutionPatch() {
  const target = findGatewayToolResolutionFile();
  let source = fs.readFileSync(target, 'utf8');
  const gatewayToolResolutionImportPattern = /import \{ i as getPluginToolMeta \} from "\.\/tools-[^"]+\.js";/;
  const alreadyHasImport = /import \{[^}]*getPluginToolMeta[^}]*ensureStandalonePluginToolRegistryLoaded[^}]*\} from "\.\/tools-[^"]+\.js";/.test(source);
  const alreadyHasHelper = source.includes('function sanitizeGatewayPluginToolAllowlistForResolution(allowlist)');
  const alreadyHasLoad = source.includes('ensureStandalonePluginToolRegistryLoaded({\n\t\tcontext: {\n\t\t\tconfig: params.cfg,');
  const alreadyHasAllowlist = source.includes(gatewayToolResolutionNewAllowlist) || source.includes(gatewayToolResolutionCurrentAllowlistNew);

  if (!alreadyHasImport) {
    if (source.includes(gatewayToolResolutionOldImport)) {
      source = source.replace(gatewayToolResolutionOldImport, gatewayToolResolutionNewImport);
    } else if (gatewayToolResolutionImportPattern.test(source)) {
      source = source.replace(gatewayToolResolutionImportPattern, (line) => line.replace('i as getPluginToolMeta', 'i as getPluginToolMeta, r as ensureStandalonePluginToolRegistryLoaded'));
    } else {
      throw new Error('OpenClaw gateway tool-resolution shape changed: plugin tools import anchor not found');
    }
  }

  if (!alreadyHasHelper) {
    if (!source.includes(gatewayToolResolutionHelperAnchor)) {
      throw new Error('OpenClaw gateway tool-resolution shape changed: helper anchor not found');
    }
    source = source.replace(gatewayToolResolutionHelperAnchor, `${gatewayToolResolutionHelper}${gatewayToolResolutionHelperAnchor}`);
  }

  if (!alreadyHasLoad) {
    if (source.includes(gatewayToolResolutionOldCreateAnchor)) {
      source = source.replace(gatewayToolResolutionOldCreateAnchor, gatewayToolResolutionNewCreateAnchor);
    } else if (source.includes(gatewayToolResolutionCurrentLoadAnchor)) {
      source = source.replace(gatewayToolResolutionCurrentLoadAnchor, gatewayToolResolutionCurrentLoadNew);
    } else {
      throw new Error('OpenClaw gateway tool-resolution shape changed: standalone registry load anchor not found');
    }
  }

  if (!alreadyHasAllowlist) {
    if (source.includes(gatewayToolResolutionOldAllowlist)) {
      source = source.replace(gatewayToolResolutionOldAllowlist, gatewayToolResolutionNewAllowlist);
    } else if (source.includes(gatewayToolResolutionCurrentAllowlist)) {
      source = source.replace(gatewayToolResolutionCurrentAllowlist, gatewayToolResolutionCurrentAllowlistNew);
    } else {
      throw new Error('OpenClaw gateway tool-resolution shape changed: plugin allowlist anchor not found');
    }
  }

  if (!alreadyHasImport || !alreadyHasHelper || !alreadyHasLoad || !alreadyHasAllowlist) {
    fs.writeFileSync(target, source, 'utf8');
    console.log(`Applied OpenClaw local patch: ${path.relative(root, target)}`);
  } else {
    console.log(`OpenClaw local patch already applied: ${path.relative(root, target)}`);
  }
}

function findGatewayToolResolutionFile() {
  const files = fs.readdirSync(distDir)
    .filter((name) => /^tool-resolution-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes('function resolveGatewayScopedTools(params)')) return file;
  }
  throw new Error('Could not locate OpenClaw gateway tool-resolution dist file');
}

function applyPluginRuntimeRegistryFallbackPatch() {
  const target = findPluginToolsFile();
  let source = fs.readFileSync(target, 'utf8');
  const alreadyHasFallback = source.includes('surface: "channel"\n\t}) ?? getLoadedRuntimePluginRegistry({\n\t\tenv: lookup.env,\n\t\tworkspaceDir: lookup.workspaceDir,\n\t\tsurface: "channel"') ||
    (source.includes('const channelRegistry = getLoadedRuntimePluginRegistry({') && source.includes('registryHasScopedPluginTools(channelRegistry'));

  if (!alreadyHasFallback) {
    if (!source.includes(pluginRuntimeRegistryOld)) {
      throw new Error('OpenClaw plugin tools shape changed: runtime registry fallback anchor not found');
    }
    source = source.replace(pluginRuntimeRegistryOld, pluginRuntimeRegistryNew);
    fs.writeFileSync(target, source, 'utf8');
    console.log(`Applied OpenClaw local patch: ${path.relative(root, target)}`);
  } else {
    console.log(`OpenClaw local patch already applied: ${path.relative(root, target)}`);
  }
}

function findPluginToolsFile() {
  const files = fs.readdirSync(distDir)
    .filter((name) => /^tools-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes('function resolvePluginToolRegistry(params)')) return file;
  }
  throw new Error('Could not locate OpenClaw plugin tools dist file');
}


function findCompactionFile() {
  const files = fs.readdirSync(distDir)
    .filter((name) => /^(?:compaction|preemptive-compaction)-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes('function truncateToolResultMessage(msg, maxChars, options = {})')) return file;
  }
  throw new Error('Could not locate OpenClaw compaction dist file');
}

function replaceRequired(source, oldText, newText, label) {
  if (!source.includes(oldText)) {
    throw new Error(`OpenClaw compaction shape changed: ${label} anchor not found`);
  }
  return source.replace(oldText, newText);
}

function replaceFunctionByBounds(source, functionName, nextFunctionName, newBody, label) {
  const start = source.indexOf(`function ${functionName}`);
  const end = source.indexOf(`function ${nextFunctionName}`, start);
  if (start < 0 || end < 0) throw new Error(`OpenClaw dist shape changed: ${label} function bounds not found`);
  return source.slice(0, start) + newBody + source.slice(end);
}

function applyToolResultFidelityPatch() {
  const target = findCompactionFile();
  let source = fs.readFileSync(target, 'utf8');
  let changed = false;

  if (!source.includes('import fs from "node:fs";') || !source.includes('import crypto from "node:crypto";')) {
    source = replaceRequired(source, 'import path from "node:path";\n', 'import fs from "node:fs";\nimport path from "node:path";\nimport crypto from "node:crypto";\n', 'archive imports');
    changed = true;
  }

  if (!source.includes('function archiveToolResultText(params)')) {
    const helperAnchor = 'const RECOVERY_MIN_KEEP_CHARS = 0;\nconst DEFAULT_SUFFIX = (truncatedChars) => formatContextLimitTruncationNotice(truncatedChars);\nMIN_KEEP_CHARS + DEFAULT_SUFFIX(1).length;\n';
    source = replaceRequired(source, helperAnchor, "const RECOVERY_MIN_KEEP_CHARS = 0;\nconst DEFAULT_TOOL_RESULT_AGGREGATE_CHARS = 128e3;\nconst TOOL_RESULT_ARCHIVE_SINGLE_TRIGGER_BYTES = 64 * 1024;\nconst TOOL_RESULT_ARCHIVE_AGGREGATE_TRIGGER_BYTES = 256 * 1024;\nconst DEFAULT_SUFFIX = (truncatedChars) => formatContextLimitTruncationNotice(truncatedChars);\nMIN_KEEP_CHARS + DEFAULT_SUFFIX(1).length;\nfunction getToolResultText(msg) {\n\tconst content = msg?.content;\n\tif (!Array.isArray(content)) return typeof content === \"string\" ? content : \"\";\n\treturn content.map((block) => block && typeof block === \"object\" && block.type === \"text\" && typeof block.text === \"string\" ? block.text : \"\").filter(Boolean).join(\"\\n\");\n}\nfunction classifyToolResultText(text) {\n\tconst sample = text.slice(0, 8e3);\n\tconst trimmed = sample.trimStart();\n\tif (/^(\\{|\\[)/.test(trimmed)) return \"json\";\n\tif (/\\b(AssertionError|Traceback|FAIL|FAILED|not ok|expected|actual|exit code)\\b/i.test(sample)) return \"test_output\";\n\tif (/^(.+?):\\d+(:\\d+)?:/m.test(sample)) return \"grep_search\";\n\tif (/\\b(function|class|const|let|var|import|export)\\b/.test(sample) && /[{};]/.test(sample)) return \"code_file\";\n\tif (/^\\[?\\d{4}-\\d{2}-\\d{2}[T\\s]/m.test(sample) || /\\b(INFO|WARN|ERROR|DEBUG)\\b/.test(sample)) return \"log\";\n\treturn \"mixed\";\n}\nfunction resolveToolResultNormalizationEnabled(cfg) {\n\tconst value = cfg?.agents?.defaults?.toolResultNormalization?.enabled ?? cfg?.toolResultNormalization?.enabled;\n\treturn value !== false;\n}\nfunction resolveToolResultArchiveRoot(sessionFile) {\n\tconst base = sessionFile && typeof sessionFile === \"string\" ? path.dirname(sessionFile) : process.cwd();\n\tconst day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);\n\treturn path.join(base, \"tool-results\", day);\n}\nfunction archiveToolResultText(params) {\n\tconst text = params.text;\n\tif (!text) return null;\n\tconst bytes = Buffer.byteLength(text, \"utf8\");\n\tconst aggregateBytes = params.aggregateToolResultBytes ?? bytes;\n\tif (bytes < TOOL_RESULT_ARCHIVE_SINGLE_TRIGGER_BYTES && aggregateBytes < TOOL_RESULT_ARCHIVE_AGGREGATE_TRIGGER_BYTES) return null;\n\ttry {\n\t\tconst hash = crypto.createHash(\"sha256\").update(text).digest(\"hex\");\n\t\tconst archiveRoot = resolveToolResultArchiveRoot(params.sessionFile);\n\t\tfs.mkdirSync(archiveRoot, { recursive: true });\n\t\tconst filePath = path.join(archiveRoot, `${hash.slice(0, 16)}.txt`);\n\t\tif (!fs.existsSync(filePath)) fs.writeFileSync(filePath, text, \"utf8\");\n\t\treturn {\n\t\t\tid: `toolr_${hash.slice(0, 16)}`,\n\t\t\tpath: filePath,\n\t\t\tsha256: hash,\n\t\t\tbytes,\n\t\t\tclassification: params.classification\n\t\t};\n\t} catch (err) {\n\t\tlog$2.warn(`[tool-result-truncation] Failed to archive full tool result: ${formatErrorMessage(err)}`);\n\t\treturn null;\n\t}\n}\nfunction buildToolResultArchiveSuffix(record) {\n\tif (!record) return DEFAULT_SUFFIX;\n\treturn (truncatedChars) => `[... ${Math.max(1, Math.floor(truncatedChars))} more characters truncated; full verbatim tool result archived as ${record.id}; sha256=${record.sha256}; originalBytes=${record.bytes}; classification=${record.classification ?? \"mixed\"}; strategy=truncate_with_pointer]`;\n}\n", 'tool-result archive helper');
    changed = true;
  }

  if (!source.includes('archiveToolResultText({')) {
    const start = source.indexOf('function truncateToolResultMessage');
    const end = source.indexOf('function calculateRecoveryAggregateToolResultChars', start);
    if (start < 0 || end < 0) throw new Error('OpenClaw compaction shape changed: truncateToolResultMessage function bounds not found');
    source = source.slice(0, start) + "function truncateToolResultMessage(msg, maxChars, options = {}) {\n\tconst content = msg.content;\n\tif (!Array.isArray(content)) return msg;\n\tconst totalTextChars = getToolResultTextLength(msg);\n\tif (totalTextChars <= maxChars) return msg;\n\tconst rawText = getToolResultText(msg);\n\tconst classification = classifyToolResultText(rawText);\n\tconst archiveRecord = options.normalizationEnabled === false ? null : archiveToolResultText({\n\t\ttext: rawText,\n\t\tsessionFile: options.sessionFile,\n\t\taggregateToolResultBytes: options.aggregateToolResultBytes,\n\t\tclassification\n\t});\n\tconst suffixFactory = resolveSuffixFactory(options.suffix ?? buildToolResultArchiveSuffix(archiveRecord));\n\tconst minKeepChars = resolveEffectiveMinKeepChars({\n\t\tmaxChars,\n\t\tminKeepChars: options.minKeepChars ?? MIN_KEEP_CHARS,\n\t\tsuffixFactory\n\t});\n\tconst newContent = content.map((block) => {\n\t\tif (!block || typeof block !== \"object\" || block.type !== \"text\") return block;\n\t\tconst textBlock = block;\n\t\tif (typeof textBlock.text !== \"string\") return block;\n\t\tconst blockShare = textBlock.text.length / totalTextChars;\n\t\tconst defaultSuffix = suffixFactory(Math.max(1, textBlock.text.length - Math.floor(maxChars * blockShare)));\n\t\tconst proportionalBudget = Math.floor(maxChars * blockShare);\n\t\tconst blockBudget = Math.max(1, Math.min(maxChars, Math.max(minKeepChars + defaultSuffix.length, proportionalBudget)));\n\t\treturn Object.assign({}, textBlock, { text: truncateToolResultText(textBlock.text, blockBudget, {\n\t\t\tsuffix: suffixFactory,\n\t\t\tminKeepChars\n\t\t}) });\n\t});\n\treturn {\n\t\t...msg,\n\t\tcontent: newContent\n\t};\n}\n" + source.slice(end);
    changed = true;
  }

  if (!source.includes('DEFAULT_TOOL_RESULT_AGGREGATE_CHARS')) {
    throw new Error('OpenClaw compaction shape changed: archive helper constants missing after insertion');
  }
  if (!source.includes('Math.max(DEFAULT_TOOL_RESULT_AGGREGATE_CHARS')) {
    const start = source.indexOf('function calculateRecoveryAggregateToolResultChars');
    const end = source.indexOf('function buildAggregateToolResultReplacements', start);
    if (start < 0 || end < 0) throw new Error('OpenClaw compaction shape changed: aggregate budget function bounds not found');
    source = source.slice(0, start) + "function calculateRecoveryAggregateToolResultChars(contextWindowTokens, maxCharsOverride) {\n\tconst contextBound = Math.max(1, Math.floor(contextWindowTokens * 4 * .5));\n\treturn Math.max(1, Math.min(contextBound, Math.max(DEFAULT_TOOL_RESULT_AGGREGATE_CHARS, maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens))));\n}\n" + source.slice(end);
    changed = true;
  }

  if (!source.includes('const aggregateToolResultBytes = candidates.reduce')) {
    source = replaceRequired(source,
      '\tconst totalChars = candidates.reduce((sum, item) => sum + item.textLength, 0);\n\tif (totalChars <= params.aggregateBudgetChars) return [];',
      '\tconst totalChars = candidates.reduce((sum, item) => sum + item.textLength, 0);\n\tconst aggregateToolResultBytes = candidates.reduce((sum, item) => sum + Buffer.byteLength(getToolResultText(item.message), "utf8"), 0);\n\tif (totalChars <= params.aggregateBudgetChars) return [];',
      'aggregate bytes calculation');
    changed = true;
  }

  if (!source.includes('aggregateToolResultBytes,\n\t\t\tnormalizationEnabled: params.normalizationEnabled\n\t\t});'.replaceAll('\\n', '\n').replaceAll('\\t', '\t'))) {
    source = replaceRequired(source,
      '\t\tconst truncatedMessage = truncateToolResultMessage(candidate.message, targetChars, { minKeepChars });',
      '\t\tconst truncatedMessage = truncateToolResultMessage(candidate.message, targetChars, {\n\t\t\tminKeepChars,\n\t\t\tsessionFile: params.sessionFile,\n\t\t\taggregateToolResultBytes,\n\t\t\tnormalizationEnabled: params.normalizationEnabled\n\t\t});',
      'aggregate truncation archive options');
    changed = true;
  }

  if (!source.includes('message: truncateToolResultMessage(msg, params.maxChars, {\n\t\t\t\tminKeepChars,'.replaceAll('\\n', '\n').replaceAll('\\t', '\t')) && !source.includes('const truncatedMessage = truncateToolResultMessage(msg, params.maxChars,')) {
    source = replaceRequired(source,
      '\t\treplacements.push({\n\t\t\tentryId: entry.id,\n\t\t\tmessage: truncateToolResultMessage(msg, params.maxChars, { minKeepChars })\n\t\t});',
      '\t\treplacements.push({\n\t\t\tentryId: entry.id,\n\t\t\tmessage: truncateToolResultMessage(msg, params.maxChars, {\n\t\t\t\tminKeepChars,\n\t\t\t\tsessionFile: params.sessionFile,\n\t\t\t\tnormalizationEnabled: params.normalizationEnabled\n\t\t\t})\n\t\t});',
      'oversized truncation archive options');
    changed = true;
  }

  if (!source.includes('const normalizationEnabled = resolveToolResultNormalizationEnabled(params.config);')) {
    source = source.replace(
      'function truncateOversizedToolResultsInExistingSessionManager(params) {\n\tconst { sessionManager, contextWindowTokens } = params;\n',
      'function truncateOversizedToolResultsInExistingSessionManager(params) {\n\tconst { sessionManager, contextWindowTokens } = params;\n\tconst normalizationEnabled = resolveToolResultNormalizationEnabled(params.config);\n');
    source = source.replace(
      'async function truncateOversizedToolResultsInTranscriptState(params) {\n\tconst { state, contextWindowTokens } = params;\n',
      'async function truncateOversizedToolResultsInTranscriptState(params) {\n\tconst { state, contextWindowTokens } = params;\n\tconst normalizationEnabled = resolveToolResultNormalizationEnabled(params.config);\n');
    source = source.replaceAll(
      'sessionFile: params.sessionFile\n\t});',
      'sessionFile: params.sessionFile,\n\tnormalizationEnabled\n\t});');
    source = source.replace(
      'sessionKey: params.sessionKey\n\t\t});',
      'sessionKey: params.sessionKey,\n\t\t\tconfig: params.config\n\t\t});');
    changed = true;
  }

  {
    const beforePlanThreading = source;
    source = source.replaceAll(
      '\tconst oversizedReplacements = buildOversizedToolResultReplacements({\n\t\tbranch: params.branch,\n\t\tmaxChars: params.maxChars,\n\t\tminKeepChars\n\t});',
      '\tconst oversizedReplacements = buildOversizedToolResultReplacements({\n\t\tbranch: params.branch,\n\t\tmaxChars: params.maxChars,\n\t\tminKeepChars,\n\t\tsessionFile: params.sessionFile,\n\t\tnormalizationEnabled: params.normalizationEnabled\n\t});');
    source = source.replaceAll(
      '\tconst aggregateReplacements = buildAggregateToolResultReplacements({\n\t\tbranch: oversizedTrimmedBranch,\n\t\taggregateBudgetChars: params.aggregateBudgetChars,\n\t\tminKeepChars\n\t});',
      '\tconst aggregateReplacements = buildAggregateToolResultReplacements({\n\t\tbranch: oversizedTrimmedBranch,\n\t\taggregateBudgetChars: params.aggregateBudgetChars,\n\t\tminKeepChars,\n\t\tsessionFile: params.sessionFile,\n\t\tnormalizationEnabled: params.normalizationEnabled\n\t});');
    if (source !== beforePlanThreading) changed = true;
  }


  if (!source.includes('function readArchivedToolResultRange(params)')) {
    const anchor = 'function resolveSuffixFactory(suffix) {';
    if (!source.includes(anchor)) throw new Error('OpenClaw compaction shape changed: archive range reader anchor not found');
    source = source.replace(anchor, "function extractToolResultArchiveReferences(msg) {\n\tconst text = getToolResultText(msg);\n\tconst refs = [];\n\tconst seen = new Set();\n\tconst regex = /archived as (toolr_[0-9a-f]+); sha256=([0-9a-f]{64}); originalBytes=(\\d+); classification=([^;\\]]+)/g;\n\tlet match;\n\twhile ((match = regex.exec(text))) {\n\t\tconst id = match[1];\n\t\tif (seen.has(id)) continue;\n\t\tseen.add(id);\n\t\trefs.push({\n\t\t\tid,\n\t\t\tsha256: match[2],\n\t\t\tbytes: Number(match[3]),\n\t\t\tclassification: match[4]\n\t\t});\n\t}\n\treturn refs;\n}\nfunction findArchivedToolResultPath(params) {\n\tconst id = String(params.id ?? \"\");\n\tif (!/^toolr_[0-9a-f]{16}$/.test(id)) throw new Error(\"Invalid tool result archive id\");\n\tconst shortHash = id.slice(\"toolr_\".length);\n\tconst root = resolveToolResultArchiveRoot(params.sessionFile);\n\tconst parent = path.dirname(root);\n\tif (!fs.existsSync(parent)) throw new Error(\"Tool result archive root not found\");\n\tconst stack = [parent];\n\twhile (stack.length > 0) {\n\t\tconst dir = stack.pop();\n\t\tfor (const entry of fs.readdirSync(dir, { withFileTypes: true })) {\n\t\t\tconst full = path.join(dir, entry.name);\n\t\t\tif (entry.isDirectory()) stack.push(full);\n\t\t\telse if (entry.isFile() && entry.name === `${shortHash}.txt`) return full;\n\t\t}\n\t}\n\tthrow new Error(\"Tool result archive id not found\");\n}\nfunction readArchivedToolResultRange(params) {\n\tconst filePath = findArchivedToolResultPath(params);\n\tconst raw = fs.readFileSync(filePath, \"utf8\");\n\tconst maxChars = Math.max(1, Math.floor(params.maxChars ?? 16e3));\n\tlet text;\n\tlet range;\n\tif (typeof params.startByte === \"number\") {\n\t\tconst startByte = Math.max(0, Math.floor(params.startByte));\n\t\tconst byteLength = Math.max(0, Math.floor(params.byteLength ?? maxChars));\n\t\ttext = Buffer.from(raw, \"utf8\").subarray(startByte, startByte + byteLength).toString(\"utf8\");\n\t\trange = { kind: \"byte\", startByte, byteLength: Buffer.byteLength(text, \"utf8\") };\n\t} else {\n\t\tconst lines = raw.split(/\\n/);\n\t\tconst startLine = Math.max(1, Math.floor(params.startLine ?? 1));\n\t\tconst lineCount = Math.max(1, Math.floor(params.lineCount ?? 200));\n\t\ttext = lines.slice(startLine - 1, startLine - 1 + lineCount).join(\"\\n\");\n\t\trange = { kind: \"line\", startLine, lineCount: text.length > 0 ? text.split(/\\n/).length : 0 };\n\t}\n\tif (text.length > maxChars) {\n\t\ttext = truncateToolResultText(text, maxChars, {\n\t\t\tsuffix: (truncatedChars) => `[..., ${Math.max(1, Math.floor(truncatedChars))} more characters truncated from requested archive range; request a narrower range]`\n\t\t});\n\t\trange.truncated = true;\n\t}\n\treturn {\n\t\tid: params.id,\n\t\ttotalBytes: Buffer.byteLength(raw, \"utf8\"),\n\t\ttotalLines: raw.length === 0 ? 0 : raw.split(/\\n/).length,\n\t\trange,\n\t\ttext\n\t};\n}\n" + anchor);
    changed = true;
  }

  if (!source.includes('archiveRefs: extractToolResultArchiveReferences')) {
    source = replaceFunctionByBounds(source, 'buildAggregateToolResultReplacements', 'buildOversizedToolResultReplacements', "function buildAggregateToolResultReplacements(params) {\n\tconst minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;\n\tconst minTruncatedTextChars = minKeepChars + DEFAULT_SUFFIX(1).length;\n\tconst candidates = params.branch.map((entry, index) => ({\n\t\tentry,\n\t\tindex\n\t})).filter((item) => item.entry.type === \"message\" && Boolean(item.entry.message) && item.entry.message.role === \"toolResult\").map((item) => ({\n\t\tindex: item.index,\n\t\tentryId: item.entry.id,\n\t\tmessage: item.entry.message,\n\t\ttextLength: getToolResultTextLength(item.entry.message)\n\t})).filter((item) => item.textLength > 0);\n\tif (candidates.length < 2) return [];\n\tconst totalChars = candidates.reduce((sum, item) => sum + item.textLength, 0);\n\tconst aggregateToolResultBytes = candidates.reduce((sum, item) => sum + Buffer.byteLength(getToolResultText(item.message), \"utf8\"), 0);\n\tif (totalChars <= params.aggregateBudgetChars) return [];\n\tlet remainingReduction = totalChars - params.aggregateBudgetChars;\n\tconst replacements = [];\n\tfor (const candidate of candidates.toSorted((a, b) => {\n\t\tif (a.index !== b.index) return b.index - a.index;\n\t\treturn b.textLength - a.textLength;\n\t})) {\n\t\tif (remainingReduction <= 0) break;\n\t\tconst reducibleChars = Math.max(0, candidate.textLength - minTruncatedTextChars);\n\t\tif (reducibleChars <= 0) continue;\n\t\tconst requestedReduction = Math.min(reducibleChars, remainingReduction);\n\t\tconst targetChars = Math.max(minTruncatedTextChars, candidate.textLength - requestedReduction);\n\t\tconst truncatedMessage = truncateToolResultMessage(candidate.message, targetChars, {\n\t\t\tminKeepChars,\n\t\t\tsessionFile: params.sessionFile,\n\t\t\taggregateToolResultBytes,\n\t\t\tnormalizationEnabled: params.normalizationEnabled\n\t\t});\n\t\tconst newLength = getToolResultTextLength(truncatedMessage);\n\t\tconst actualReduction = Math.max(0, candidate.textLength - newLength);\n\t\tif (actualReduction <= 0) continue;\n\t\treplacements.push({\n\t\t\tentryId: candidate.entryId,\n\t\t\tmessage: truncatedMessage,\n\t\t\tarchiveRefs: extractToolResultArchiveReferences(truncatedMessage)\n\t\t});\n\t\tremainingReduction -= actualReduction;\n\t}\n\treturn replacements;\n}\n", 'aggregate archive refs');
    source = replaceFunctionByBounds(source, 'buildOversizedToolResultReplacements', 'calculateReplacementReduction', "function buildOversizedToolResultReplacements(params) {\n\tconst minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;\n\tconst replacements = [];\n\tfor (const entry of params.branch) {\n\t\tif (entry.type !== \"message\" || !entry.message) continue;\n\t\tconst msg = entry.message;\n\t\tif (msg.role !== \"toolResult\") continue;\n\t\tif (getToolResultTextLength(msg) <= params.maxChars) continue;\n\t\tconst truncatedMessage = truncateToolResultMessage(msg, params.maxChars, {\n\t\t\tminKeepChars,\n\t\t\tsessionFile: params.sessionFile,\n\t\t\tnormalizationEnabled: params.normalizationEnabled\n\t\t});\n\t\treplacements.push({\n\t\t\tentryId: entry.id,\n\t\t\tmessage: truncatedMessage,\n\t\t\tarchiveRefs: extractToolResultArchiveReferences(truncatedMessage)\n\t\t});\n\t}\n\treturn replacements;\n}\n", 'oversized archive refs');
    source = replaceFunctionByBounds(source, 'buildToolResultReplacementPlan', 'estimateToolResultReductionPotential', "function buildToolResultReplacementPlan(params) {\n\tconst minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;\n\tconst oversizedReplacements = buildOversizedToolResultReplacements({\n\t\tbranch: params.branch,\n\t\tmaxChars: params.maxChars,\n\t\tminKeepChars,\n\t\tsessionFile: params.sessionFile,\n\t\tnormalizationEnabled: params.normalizationEnabled\n\t});\n\tconst oversizedReducibleChars = calculateReplacementReduction(params.branch, oversizedReplacements);\n\tconst oversizedTrimmedBranch = applyToolResultReplacementsToBranch(params.branch, oversizedReplacements);\n\tconst aggregateReplacements = buildAggregateToolResultReplacements({\n\t\tbranch: oversizedTrimmedBranch,\n\t\taggregateBudgetChars: params.aggregateBudgetChars,\n\t\tminKeepChars,\n\t\tsessionFile: params.sessionFile,\n\t\tnormalizationEnabled: params.normalizationEnabled\n\t});\n\tconst aggregateReducibleChars = calculateReplacementReduction(oversizedTrimmedBranch, aggregateReplacements);\n\tconst replacements = [...oversizedReplacements, ...aggregateReplacements];\n\tconst archiveRefs = [];\n\tconst seenArchiveIds = new Set();\n\tfor (const replacement of replacements) for (const ref of replacement.archiveRefs ?? []) {\n\t\tif (seenArchiveIds.has(ref.id)) continue;\n\t\tseenArchiveIds.add(ref.id);\n\t\tarchiveRefs.push(ref);\n\t}\n\treturn {\n\t\treplacements,\n\t\tarchiveRefs,\n\t\toversizedReplacementCount: oversizedReplacements.length,\n\t\taggregateReplacementCount: aggregateReplacements.length,\n\t\toversizedReducibleChars,\n\t\taggregateReducibleChars\n\t};\n}\n", 'replacement plan archive refs');
    source = replaceFunctionByBounds(source, 'truncateOversizedToolResultsInExistingSessionManager', 'truncateOversizedToolResultsInTranscriptState', "function truncateOversizedToolResultsInExistingSessionManager(params) {\n\tconst { sessionManager, contextWindowTokens } = params;\n\tconst normalizationEnabled = resolveToolResultNormalizationEnabled(params.config);\n\tconst maxChars = Math.max(1, params.maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens));\n\tconst aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(contextWindowTokens, maxChars);\n\tconst branch = sessionManager.getBranch();\n\tif (branch.length === 0) return {\n\t\ttruncated: false,\n\t\ttruncatedCount: 0,\n\t\treason: \"empty session\"\n\t};\n\tconst plan = buildToolResultReplacementPlan({\n\t\tbranch,\n\t\tmaxChars,\n\t\taggregateBudgetChars,\n\t\tminKeepChars: RECOVERY_MIN_KEEP_CHARS,\n\t\tsessionFile: params.sessionFile,\n\t\tnormalizationEnabled\n\t});\n\tif (plan.replacements.length === 0) return {\n\t\ttruncated: false,\n\t\ttruncatedCount: 0,\n\t\treason: \"no oversized or aggregate tool results\"\n\t};\n\tconst rewriteResult = rewriteTranscriptEntriesInSessionManager({\n\t\tsessionManager,\n\t\treplacements: plan.replacements\n\t});\n\tif (rewriteResult.changed && params.sessionFile) emitSessionTranscriptUpdate(params.sessionFile);\n\tlog$2.info(`[tool-result-truncation] Truncated ${rewriteResult.rewrittenEntries} tool result(s) in session (contextWindow=${contextWindowTokens} maxChars=${maxChars} aggregateBudgetChars=${aggregateBudgetChars} oversized=${plan.oversizedReplacementCount} aggregate=${plan.aggregateReplacementCount}) sessionKey=${params.sessionKey ?? params.sessionId ?? \"unknown\"}`);\n\treturn {\n\t\ttruncated: rewriteResult.changed,\n\t\ttruncatedCount: rewriteResult.rewrittenEntries,\n\t\treason: rewriteResult.reason,\n\t\tarchivedCount: plan.archiveRefs.length,\n\t\tarchiveIds: plan.archiveRefs.map((ref) => ref.id),\n\t\tarchiveRefs: plan.archiveRefs\n\t};\n}\nasync ", 'session manager archive refs');
    source = replaceFunctionByBounds(source, 'truncateOversizedToolResultsInTranscriptState', 'truncateOversizedToolResultsInSessionManager', "function truncateOversizedToolResultsInTranscriptState(params) {\n\tconst { state, contextWindowTokens } = params;\n\tconst normalizationEnabled = resolveToolResultNormalizationEnabled(params.config);\n\tconst maxChars = Math.max(1, params.maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens));\n\tconst aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(contextWindowTokens, maxChars);\n\tconst branch = state.getBranch();\n\tif (branch.length === 0) return {\n\t\ttruncated: false,\n\t\ttruncatedCount: 0,\n\t\treason: \"empty session\"\n\t};\n\tconst plan = buildToolResultReplacementPlan({\n\t\tbranch,\n\t\tmaxChars,\n\t\taggregateBudgetChars,\n\t\tminKeepChars: RECOVERY_MIN_KEEP_CHARS,\n\t\tsessionFile: params.sessionFile,\n\t\tnormalizationEnabled\n\t});\n\tif (plan.replacements.length === 0) return {\n\t\ttruncated: false,\n\t\ttruncatedCount: 0,\n\t\treason: \"no oversized or aggregate tool results\"\n\t};\n\tconst rewriteResult = rewriteTranscriptEntriesInState({\n\t\tstate,\n\t\treplacements: plan.replacements\n\t});\n\tif (rewriteResult.changed) {\n\t\tawait persistTranscriptStateMutation({\n\t\t\tsessionFile: params.sessionFile,\n\t\t\tstate,\n\t\t\tappendedEntries: rewriteResult.appendedEntries\n\t\t});\n\t\temitSessionTranscriptUpdate(params.sessionFile);\n\t}\n\tlog$2.info(`[tool-result-truncation] Truncated ${rewriteResult.rewrittenEntries} tool result(s) in session (contextWindow=${contextWindowTokens} maxChars=${maxChars} aggregateBudgetChars=${aggregateBudgetChars} oversized=${plan.oversizedReplacementCount} aggregate=${plan.aggregateReplacementCount}) sessionKey=${params.sessionKey ?? params.sessionId ?? \"unknown\"}`);\n\treturn {\n\t\ttruncated: rewriteResult.changed,\n\t\ttruncatedCount: rewriteResult.rewrittenEntries,\n\t\treason: rewriteResult.reason,\n\t\tarchivedCount: plan.archiveRefs.length,\n\t\tarchiveIds: plan.archiveRefs.map((ref) => ref.id),\n\t\tarchiveRefs: plan.archiveRefs\n\t};\n}\n", 'transcript state archive refs');
    changed = true;
  }

  if (!source.includes('readArchivedToolResultRange as q')) {
    if (source.includes('truncateOversizedToolResultsInSessionManager as p, computeAdaptiveChunkRatio as r')) {
      source = source.replace(
        'truncateOversizedToolResultsInSessionManager as p, computeAdaptiveChunkRatio as r',
        'truncateOversizedToolResultsInSessionManager as p, readArchivedToolResultRange as q, computeAdaptiveChunkRatio as r');
      changed = true;
    } else if (source.includes('truncateOversizedToolResultsInSession as p, SAFETY_MARGIN as r')) {
      source = source.replace(
        'truncateOversizedToolResultsInSession as p, SAFETY_MARGIN as r',
        'truncateOversizedToolResultsInSession as p, readArchivedToolResultRange as q, SAFETY_MARGIN as r');
      changed = true;
    } else {
      throw new Error('OpenClaw compaction shape changed: archive range export anchor not found');
    }
  }



  if (changed) {
    fs.writeFileSync(target, source, 'utf8');
    console.log(`Applied OpenClaw local patch: ${path.relative(root, target)}`);
  } else {
    console.log(`OpenClaw local patch already applied: ${path.relative(root, target)}`);
  }
}


function applyContextLoopRecoveryPatch() {
  const target = findSelectionFile();
  let source = fs.readFileSync(target, 'utf8');
  const originalSource = source;
  let changed = false;
  const alreadyHasHelper = source.includes('function buildPreemptiveOverflowMidTurnRequest(params)');
  const alreadyHasEventHelper = source.includes('function emitMidTurnRecoveryEvent(params, phase, data = {})');
  const alreadyHasRecovery = source.includes('throw new MidTurnPrecheckSignal(request)');
  const hasNativeMidTurnPrecheck = source.includes('function toMidTurnPrecheckRequest(') && source.includes('const handleMidTurnPrecheckRequest = (request) => {');
  const midTurnResumeManifestHelpers = "function resolveMidTurnRecoveryBudget(config) {\n\tconst raw = config?.agents?.defaults?.midTurnResumeManifest?.recoveryBudget?.maxAttempts ?? config?.midTurnResumeManifest?.recoveryBudget?.maxAttempts ?? 3;\n\tconst maxAttempts = Math.max(1, Math.min(10, Math.floor(Number(raw) || 3)));\n\treturn { maxAttempts };\n}\nfunction buildMidTurnRecoveryManifest(params) {\n\treturn {\n\t\tid: `mtr_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,\n\t\tkind: \"mid_turn_resume_manifest\",\n\t\tcreatedAt: (/* @__PURE__ */ new Date()).toISOString(),\n\t\trunId: params.runId,\n\t\tsessionId: params.sessionId,\n\t\tsessionKey: params.sessionKey,\n\t\trecoveryBudget: params.recoveryBudget,\n\t\tprePromptMessageCount: params.prePromptMessageCount,\n\t\texpectedNext: \"resume_normal_continuation_after_recovery\"\n\t};\n}\nfunction midTurnRecoveryManifestEventData(manifest, attempt) {\n\treturn manifest ? {\n\t\tmanifestId: manifest.id,\n\t\tattempt,\n\t\trecoveryBudget: manifest.recoveryBudget,\n\t\texpectedNext: manifest.expectedNext\n\t} : {};\n}\n";

  if (!alreadyHasEventHelper) {
    if (source.includes(midTurnRecoveryEventHelperAnchor)) {
      source = source.replace(midTurnRecoveryEventHelperAnchor, `${midTurnRecoveryEventHelper}${midTurnRecoveryEventHelperAnchor}`);
    } else if (hasNativeMidTurnPrecheck && source.includes('\t\t\tconst hookAgentId = sessionAgentId;')) {
      source = source.replace('\t\t\tconst hookAgentId = sessionAgentId;', `${midTurnRecoveryEventHelper}${midTurnResumeManifestHelpers}\t\t\tconst hookAgentId = sessionAgentId;`);
    } else {
      throw new Error('OpenClaw selection shape changed: mid-turn recovery event helper anchor not found');
    }
    changed = true;
  }

  if (!alreadyHasHelper) {
    if (hasNativeMidTurnPrecheck) {
      // OpenClaw 2026.5.x moved overflow request construction into toMidTurnPrecheckRequest.
    } else if (!source.includes(contextLoopRecoveryHelperAnchor)) {
      throw new Error('OpenClaw selection shape changed: context-loop recovery helper anchor not found');
    } else {
      source = source.replace(contextLoopRecoveryHelperAnchor, `${contextLoopRecoveryHelper}${contextLoopRecoveryHelperAnchor}`);
      changed = true;
    }
  }

  if (!alreadyHasRecovery) {
    if (hasNativeMidTurnPrecheck) {
      // Native tool-result guard already throws MidTurnPrecheckSignal(request).
    } else if (!source.includes(contextLoopRecoveryOld)) {
      throw new Error('OpenClaw selection shape changed: context-loop recovery threshold anchor not found');
    } else {
      source = source.replace(contextLoopRecoveryOld, contextLoopRecoveryNew);
      changed = true;
    }
  }

  if (!hasNativeMidTurnPrecheck && !source.includes('emitMidTurnRecoveryEvent(params, "mid_turn_precheck_fired"')) {
    if (!source.includes(midTurnRecoveryPrecheckOld)) {
      throw new Error('OpenClaw selection shape changed: mid-turn precheck event anchor not found');
    }
    source = source.replace(midTurnRecoveryPrecheckOld, midTurnRecoveryPrecheckNew);
    changed = true;
  }

  if (!hasNativeMidTurnPrecheck && !source.includes('emitMidTurnRecoveryEvent(params, "tool_result_truncated"')) {
    if (!source.includes(midTurnRecoveryTruncatedOld)) {
      throw new Error('OpenClaw selection shape changed: tool-result truncated event anchor not found');
    }
    source = source.replace(midTurnRecoveryTruncatedOld, midTurnRecoveryTruncatedNew);
    changed = true;
  }

  if (!hasNativeMidTurnPrecheck && !source.includes('reason: truncationResult.reason ?? "truncate_fallback"')) {
    if (!source.includes(midTurnRecoveryCompactFallbackOld)) {
      throw new Error('OpenClaw selection shape changed: compaction fallback event anchor not found');
    }
    source = source.replace(midTurnRecoveryCompactFallbackOld, midTurnRecoveryCompactFallbackNew);
    changed = true;
  }

  if (!hasNativeMidTurnPrecheck && !source.includes('emitMidTurnRecoveryEvent(params, "compaction_started", buildMidTurnRecoveryEventData(request));')) {
    if (!source.includes(midTurnRecoveryCompactOnlyOld)) {
      throw new Error('OpenClaw selection shape changed: compact-only event anchor not found');
    }
    source = source.replace(midTurnRecoveryCompactOnlyOld, midTurnRecoveryCompactOnlyNew);
    changed = true;
  }

  if (!hasNativeMidTurnPrecheck && !source.includes('emitMidTurnRecoveryEvent(params, "compaction_completed"')) {
    if (!source.includes(midTurnRecoveryCompactionObservedOld)) {
      throw new Error('OpenClaw selection shape changed: compaction-completed event anchor not found');
    }
    source = source.replace(midTurnRecoveryCompactionObservedOld, midTurnRecoveryCompactionObservedNew);
    changed = true;
  }

  if (!hasNativeMidTurnPrecheck && !source.includes('emitMidTurnRecoveryEvent(params, "mid_turn_recovery_exhausted"')) {
    if (!source.includes(midTurnRecoveryResumedOld)) {
      throw new Error('OpenClaw selection shape changed: recovery-resumed event anchor not found');
    }
    source = source.replace(midTurnRecoveryResumedOld, midTurnRecoveryResumedNew);
    changed = true;
  }


  if (!source.includes('function resolveMidTurnRecoveryBudget(config)')) {
    const anchor = 'function buildPreemptiveOverflowMidTurnRequest(params) {';
    if (!source.includes(anchor)) throw new Error('OpenClaw selection shape changed: resume-manifest helper anchor not found');
    source = source.replace(anchor, "function resolveMidTurnRecoveryBudget(config) {\n\tconst raw = config?.agents?.defaults?.midTurnResumeManifest?.recoveryBudget?.maxAttempts ?? config?.midTurnResumeManifest?.recoveryBudget?.maxAttempts ?? 3;\n\tconst maxAttempts = Math.max(1, Math.min(10, Math.floor(Number(raw) || 3)));\n\treturn { maxAttempts };\n}\nfunction buildMidTurnRecoveryManifest(params) {\n\treturn {\n\t\tid: `mtr_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`,\n\t\tkind: \"mid_turn_resume_manifest\",\n\t\tcreatedAt: (/* @__PURE__ */ new Date()).toISOString(),\n\t\trunId: params.runId,\n\t\tsessionId: params.sessionId,\n\t\tsessionKey: params.sessionKey,\n\t\trecoveryBudget: params.recoveryBudget,\n\t\tprePromptMessageCount: params.prePromptMessageCount,\n\t\texpectedNext: \"resume_normal_continuation_after_recovery\"\n\t};\n}\nfunction midTurnRecoveryManifestEventData(manifest, attempt) {\n\treturn manifest ? {\n\t\tmanifestId: manifest.id,\n\t\tattempt,\n\t\trecoveryBudget: manifest.recoveryBudget,\n\t\texpectedNext: manifest.expectedNext\n\t} : {};\n}\n" + anchor);
    changed = true;
  }

  if (!source.includes('const midTurnRecoveryBudget = resolveMidTurnRecoveryBudget(params.config);')) {
    const start = source.indexOf('			let preflightRecovery;');
    const end = source.indexOf('			let skipPromptSubmission = false;', start);
    if (start < 0 || end < 0) throw new Error('OpenClaw selection shape changed: resume manifest handler bounds not found');
    source = source.slice(0, start) + "\t\t\tlet preflightRecovery;\n\t\t\tlet promptErrorSource = null;\n\t\t\tconst midTurnRecoveryBudget = resolveMidTurnRecoveryBudget(params.config);\n\t\t\tlet midTurnRecoveryAttempt = 0;\n\t\t\tlet midTurnRecoveryManifest = null;\n\t\t\tconst ensureMidTurnRecoveryManifest = (request) => {\n\t\t\t\tif (!midTurnRecoveryManifest) midTurnRecoveryManifest = buildMidTurnRecoveryManifest({\n\t\t\t\t\trunId: params.runId,\n\t\t\t\t\tsessionId: params.sessionId,\n\t\t\t\t\tsessionKey: params.sessionKey,\n\t\t\t\t\trecoveryBudget: midTurnRecoveryBudget,\n\t\t\t\t\tprePromptMessageCount,\n\t\t\t\t\trequest\n\t\t\t\t});\n\t\t\t\treturn midTurnRecoveryManifest;\n\t\t\t};\n\t\t\tconst currentMidTurnRecoveryEventData = () => midTurnRecoveryManifestEventData(midTurnRecoveryManifest, midTurnRecoveryAttempt);\n\t\t\tconst handleMidTurnPrecheckRequest = (request) => {\n\t\t\t\tensureMidTurnRecoveryManifest(request);\n\t\t\t\tmidTurnRecoveryAttempt += 1;\n\t\t\t\tif (midTurnRecoveryAttempt > midTurnRecoveryBudget.maxAttempts) {\n\t\t\t\t\tpreflightRecovery = {\n\t\t\t\t\t\troute: request.route,\n\t\t\t\t\t\tsource: \"mid-turn\",\n\t\t\t\t\t\texhausted: true\n\t\t\t\t\t};\n\t\t\t\t\tpromptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);\n\t\t\t\t\tpromptErrorSource = \"precheck\";\n\t\t\t\t\temitMidTurnRecoveryEvent(params, \"mid_turn_recovery_exhausted\", buildMidTurnRecoveryEventData(request, {\n\t\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\t\treason: \"recovery_budget_exhausted\"\n\t\t\t\t\t}));\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tconst logMidTurnPrecheck = (route, extra) => {\n\t\t\t\t\tlog$5.warn(`[context-overflow-midturn-precheck] sessionKey=${params.sessionKey ?? params.sessionId} provider=${params.provider}/${params.modelId} route=${route} estimatedPromptTokens=${request.estimatedPromptTokens} promptBudgetBeforeReserve=${request.promptBudgetBeforeReserve} overflowTokens=${request.overflowTokens} toolResultReducibleChars=${request.toolResultReducibleChars} effectiveReserveTokens=${request.effectiveReserveTokens} prePromptMessageCount=${prePromptMessageCount} ` + (extra ? `${extra} ` : \"\") + `sessionFile=${params.sessionFile}`);\n\t\t\t\t};\n\t\t\t\temitMidTurnRecoveryEvent(params, \"mid_turn_precheck_fired\", buildMidTurnRecoveryEventData(request, {\n\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\tprePromptMessageCount\n\t\t\t\t}));\n\t\t\t\tif (request.route === \"truncate_tool_results_only\") {\n\t\t\t\t\tconst contextTokenBudget = params.contextTokenBudget ?? 2e5;\n\t\t\t\t\tconst truncationResult = truncateOversizedToolResultsInSessionManager({\n\t\t\t\t\t\tsessionManager: activeSessionManager,\n\t\t\t\t\t\tcontextWindowTokens: contextTokenBudget,\n\t\t\t\t\t\tmaxCharsOverride: resolveLiveToolResultMaxChars({\n\t\t\t\t\t\t\tcontextWindowTokens: contextTokenBudget,\n\t\t\t\t\t\t\tcfg: params.config,\n\t\t\t\t\t\t\tagentId: sessionAgentId\n\t\t\t\t\t\t}),\n\t\t\t\t\t\tsessionFile: params.sessionFile,\n\t\t\t\t\t\tsessionId: params.sessionId,\n\t\t\t\t\t\tsessionKey: params.sessionKey,\n\t\t\t\t\t\tconfig: params.config\n\t\t\t\t\t});\n\t\t\t\t\tif (truncationResult.truncated) {\n\t\t\t\t\t\tpreflightRecovery = {\n\t\t\t\t\t\t\troute: \"truncate_tool_results_only\",\n\t\t\t\t\t\t\tsource: \"mid-turn\",\n\t\t\t\t\t\t\thandled: true,\n\t\t\t\t\t\t\ttruncatedCount: truncationResult.truncatedCount\n\t\t\t\t\t\t};\n\t\t\t\t\t\tconst sessionContext = activeSessionManager.buildSessionContext();\n\t\t\t\t\t\tactiveSession.agent.state.messages = sessionContext.messages;\n\t\t\t\t\t\temitMidTurnRecoveryEvent(params, \"tool_result_truncated\", buildMidTurnRecoveryEventData(request, {\n\t\t\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\t\t\ttruncatedCount: truncationResult.truncatedCount,\n\t\t\t\t\t\t\thandled: true\n\t\t\t\t\t\t}));\n\t\t\t\t\t\tif ((truncationResult.archiveIds?.length ?? 0) > 0) emitMidTurnRecoveryEvent(params, \"tool_result_archived\", buildMidTurnRecoveryEventData(request, {\n\t\t\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\t\t\tarchivedCount: truncationResult.archivedCount ?? truncationResult.archiveIds.length,\n\t\t\t\t\t\t\tarchiveIds: truncationResult.archiveIds,\n\t\t\t\t\t\t\tarchiveRefs: truncationResult.archiveRefs\n\t\t\t\t\t\t}));\n\t\t\t\t\t\tlogMidTurnPrecheck(request.route, `handled=true truncatedCount=${truncationResult.truncatedCount}`);\n\t\t\t\t\t} else {\n\t\t\t\t\t\tpreflightRecovery = {\n\t\t\t\t\t\t\troute: \"compact_only\",\n\t\t\t\t\t\t\tsource: \"mid-turn\"\n\t\t\t\t\t\t};\n\t\t\t\t\t\tpromptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);\n\t\t\t\t\t\tpromptErrorSource = \"precheck\";\n\t\t\t\t\t\temitMidTurnRecoveryEvent(params, \"compaction_started\", buildMidTurnRecoveryEventData(request, {\n\t\t\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\t\t\treason: truncationResult.reason ?? \"truncate_fallback\"\n\t\t\t\t\t\t}));\n\t\t\t\t\t\tlogMidTurnPrecheck(\"compact_only\", `truncateFallbackReason=${truncationResult.reason ?? \"unknown\"}`);\n\t\t\t\t\t}\n\t\t\t\t} else {\n\t\t\t\t\tpreflightRecovery = {\n\t\t\t\t\t\troute: request.route,\n\t\t\t\t\t\tsource: \"mid-turn\"\n\t\t\t\t\t};\n\t\t\t\t\tpromptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);\n\t\t\t\t\tpromptErrorSource = \"precheck\";\n\t\t\t\t\temitMidTurnRecoveryEvent(params, \"compaction_started\", buildMidTurnRecoveryEventData(request, currentMidTurnRecoveryEventData()));\n\t\t\t\t\tlogMidTurnPrecheck(request.route);\n\t\t\t\t}\n\t\t\t};\n" + source.slice(end);
    changed = true;
  }

  if (!source.includes('emitMidTurnRecoveryEvent(params, "tool_result_archived"')) {
    const start = source.indexOf('			let preflightRecovery;');
    const end = source.indexOf('			let skipPromptSubmission = false;', start);
    if (start < 0 || end < 0) throw new Error('OpenClaw selection shape changed: archive event handler bounds not found');
    source = source.slice(0, start) + "\t\t\tlet preflightRecovery;\n\t\t\tlet promptErrorSource = null;\n\t\t\tconst midTurnRecoveryBudget = resolveMidTurnRecoveryBudget(params.config);\n\t\t\tlet midTurnRecoveryAttempt = 0;\n\t\t\tlet midTurnRecoveryManifest = null;\n\t\t\tconst ensureMidTurnRecoveryManifest = (request) => {\n\t\t\t\tif (!midTurnRecoveryManifest) midTurnRecoveryManifest = buildMidTurnRecoveryManifest({\n\t\t\t\t\trunId: params.runId,\n\t\t\t\t\tsessionId: params.sessionId,\n\t\t\t\t\tsessionKey: params.sessionKey,\n\t\t\t\t\trecoveryBudget: midTurnRecoveryBudget,\n\t\t\t\t\tprePromptMessageCount,\n\t\t\t\t\trequest\n\t\t\t\t});\n\t\t\t\treturn midTurnRecoveryManifest;\n\t\t\t};\n\t\t\tconst currentMidTurnRecoveryEventData = () => midTurnRecoveryManifestEventData(midTurnRecoveryManifest, midTurnRecoveryAttempt);\n\t\t\tconst handleMidTurnPrecheckRequest = (request) => {\n\t\t\t\tensureMidTurnRecoveryManifest(request);\n\t\t\t\tmidTurnRecoveryAttempt += 1;\n\t\t\t\tif (midTurnRecoveryAttempt > midTurnRecoveryBudget.maxAttempts) {\n\t\t\t\t\tpreflightRecovery = {\n\t\t\t\t\t\troute: request.route,\n\t\t\t\t\t\tsource: \"mid-turn\",\n\t\t\t\t\t\texhausted: true\n\t\t\t\t\t};\n\t\t\t\t\tpromptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);\n\t\t\t\t\tpromptErrorSource = \"precheck\";\n\t\t\t\t\temitMidTurnRecoveryEvent(params, \"mid_turn_recovery_exhausted\", buildMidTurnRecoveryEventData(request, {\n\t\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\t\treason: \"recovery_budget_exhausted\"\n\t\t\t\t\t}));\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\tconst logMidTurnPrecheck = (route, extra) => {\n\t\t\t\t\tlog$5.warn(`[context-overflow-midturn-precheck] sessionKey=${params.sessionKey ?? params.sessionId} provider=${params.provider}/${params.modelId} route=${route} estimatedPromptTokens=${request.estimatedPromptTokens} promptBudgetBeforeReserve=${request.promptBudgetBeforeReserve} overflowTokens=${request.overflowTokens} toolResultReducibleChars=${request.toolResultReducibleChars} effectiveReserveTokens=${request.effectiveReserveTokens} prePromptMessageCount=${prePromptMessageCount} ` + (extra ? `${extra} ` : \"\") + `sessionFile=${params.sessionFile}`);\n\t\t\t\t};\n\t\t\t\temitMidTurnRecoveryEvent(params, \"mid_turn_precheck_fired\", buildMidTurnRecoveryEventData(request, {\n\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\tprePromptMessageCount\n\t\t\t\t}));\n\t\t\t\tif (request.route === \"truncate_tool_results_only\") {\n\t\t\t\t\tconst contextTokenBudget = params.contextTokenBudget ?? 2e5;\n\t\t\t\t\tconst truncationResult = truncateOversizedToolResultsInSessionManager({\n\t\t\t\t\t\tsessionManager: activeSessionManager,\n\t\t\t\t\t\tcontextWindowTokens: contextTokenBudget,\n\t\t\t\t\t\tmaxCharsOverride: resolveLiveToolResultMaxChars({\n\t\t\t\t\t\t\tcontextWindowTokens: contextTokenBudget,\n\t\t\t\t\t\t\tcfg: params.config,\n\t\t\t\t\t\t\tagentId: sessionAgentId\n\t\t\t\t\t\t}),\n\t\t\t\t\t\tsessionFile: params.sessionFile,\n\t\t\t\t\t\tsessionId: params.sessionId,\n\t\t\t\t\t\tsessionKey: params.sessionKey,\n\t\t\t\t\t\tconfig: params.config\n\t\t\t\t\t});\n\t\t\t\t\tif (truncationResult.truncated) {\n\t\t\t\t\t\tpreflightRecovery = {\n\t\t\t\t\t\t\troute: \"truncate_tool_results_only\",\n\t\t\t\t\t\t\tsource: \"mid-turn\",\n\t\t\t\t\t\t\thandled: true,\n\t\t\t\t\t\t\ttruncatedCount: truncationResult.truncatedCount\n\t\t\t\t\t\t};\n\t\t\t\t\t\tconst sessionContext = activeSessionManager.buildSessionContext();\n\t\t\t\t\t\tactiveSession.agent.state.messages = sessionContext.messages;\n\t\t\t\t\t\temitMidTurnRecoveryEvent(params, \"tool_result_truncated\", buildMidTurnRecoveryEventData(request, {\n\t\t\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\t\t\ttruncatedCount: truncationResult.truncatedCount,\n\t\t\t\t\t\t\thandled: true\n\t\t\t\t\t\t}));\n\t\t\t\t\t\tif ((truncationResult.archiveIds?.length ?? 0) > 0) emitMidTurnRecoveryEvent(params, \"tool_result_archived\", buildMidTurnRecoveryEventData(request, {\n\t\t\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\t\t\tarchivedCount: truncationResult.archivedCount ?? truncationResult.archiveIds.length,\n\t\t\t\t\t\t\tarchiveIds: truncationResult.archiveIds,\n\t\t\t\t\t\t\tarchiveRefs: truncationResult.archiveRefs\n\t\t\t\t\t\t}));\n\t\t\t\t\t\tlogMidTurnPrecheck(request.route, `handled=true truncatedCount=${truncationResult.truncatedCount}`);\n\t\t\t\t\t} else {\n\t\t\t\t\t\tpreflightRecovery = {\n\t\t\t\t\t\t\troute: \"compact_only\",\n\t\t\t\t\t\t\tsource: \"mid-turn\"\n\t\t\t\t\t\t};\n\t\t\t\t\t\tpromptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);\n\t\t\t\t\t\tpromptErrorSource = \"precheck\";\n\t\t\t\t\t\temitMidTurnRecoveryEvent(params, \"compaction_started\", buildMidTurnRecoveryEventData(request, {\n\t\t\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\t\t\treason: truncationResult.reason ?? \"truncate_fallback\"\n\t\t\t\t\t\t}));\n\t\t\t\t\t\tlogMidTurnPrecheck(\"compact_only\", `truncateFallbackReason=${truncationResult.reason ?? \"unknown\"}`);\n\t\t\t\t\t}\n\t\t\t\t} else {\n\t\t\t\t\tpreflightRecovery = {\n\t\t\t\t\t\troute: request.route,\n\t\t\t\t\t\tsource: \"mid-turn\"\n\t\t\t\t\t};\n\t\t\t\t\tpromptError = new Error(PREEMPTIVE_OVERFLOW_ERROR_TEXT);\n\t\t\t\t\tpromptErrorSource = \"precheck\";\n\t\t\t\t\temitMidTurnRecoveryEvent(params, \"compaction_started\", buildMidTurnRecoveryEventData(request, currentMidTurnRecoveryEventData()));\n\t\t\t\t\tlogMidTurnPrecheck(request.route);\n\t\t\t\t}\n\t\t\t};\n" + source.slice(end);
    changed = true;
  }


  if (!source.includes('mid_turn_recovery_retry') || !source.includes('currentMidTurnRecoveryEventData()')) {
    const start = source.indexOf('\t\t\t\tif (preflightRecovery && compactionOccurredThisAttempt) {');
    const end = source.indexOf('\t\t\t\tappendAttemptCacheTtlIfNeeded', start);
    if (start >= 0 && end >= 0) {
      source = source.slice(0, start) + "\t\t\t\tif (preflightRecovery && compactionOccurredThisAttempt) {\n\t\t\t\t\temitMidTurnRecoveryEvent(params, \"compaction_completed\", {\n\t\t\t\t\t\tkind: \"recovery\",\n\t\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\t\troute: preflightRecovery.route,\n\t\t\t\t\t\thandled: preflightRecovery.handled === true,\n\t\t\t\t\t\ttruncatedCount: preflightRecovery.truncatedCount\n\t\t\t\t\t});\n\t\t\t\t\temitMidTurnRecoveryEvent(params, \"mid_turn_recovery_retry\", {\n\t\t\t\t\t\tkind: \"recovery\",\n\t\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\t\troute: preflightRecovery.route\n\t\t\t\t\t});\n\t\t\t\t}\n" + source.slice(end);
    } else if (hasNativeMidTurnPrecheck && source.includes('\t\t\t\t\tcompactionOccurredThisAttempt = getCompactionCount() > 0;')) {
      source = source.replace('\t\t\t\t\tcompactionOccurredThisAttempt = getCompactionCount() > 0;', "\t\t\t\t\tcompactionOccurredThisAttempt = getCompactionCount() > 0;\n\t\t\t\t\tif (preflightRecovery && compactionOccurredThisAttempt) {\n\t\t\t\t\t\temitMidTurnRecoveryEvent(params, \"compaction_completed\", {\n\t\t\t\t\t\t\tkind: \"recovery\",\n\t\t\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\t\t\troute: preflightRecovery.route,\n\t\t\t\t\t\t\thandled: preflightRecovery.handled === true,\n\t\t\t\t\t\t\ttruncatedCount: preflightRecovery.truncatedCount\n\t\t\t\t\t\t});\n\t\t\t\t\t\temitMidTurnRecoveryEvent(params, \"mid_turn_recovery_retry\", {\n\t\t\t\t\t\t\tkind: \"recovery\",\n\t\t\t\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\t\t\t\troute: preflightRecovery.route\n\t\t\t\t\t\t});\n\t\t\t\t\t}");
    } else throw new Error('OpenClaw selection shape changed: compaction event bounds not found');
    changed = true;
  }

  if (!source.includes('mid_turn_recovery_resumed') || !source.includes('currentMidTurnRecoveryEventData()')) {
    const start = source.indexOf('\t\t\tif (preflightRecovery && !promptError');
    const end = source.indexOf('\t\t\treturn {\n\t\t\t\treplayMetadata,', start);
    const completionEvents = "\t\t\tif (preflightRecovery && !promptError && !aborted && !timedOut && !timedOutDuringCompaction) emitMidTurnRecoveryEvent(params, \"mid_turn_recovery_resumed\", {\n\t\t\t\tkind: \"recovery\",\n\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\troute: preflightRecovery.route,\n\t\t\t\thandled: preflightRecovery.handled === true,\n\t\t\t\ttruncatedCount: preflightRecovery.truncatedCount\n\t\t\t});\n\t\t\telse if (preflightRecovery && promptError) emitMidTurnRecoveryEvent(params, \"mid_turn_recovery_exhausted\", {\n\t\t\t\tkind: \"recovery\",\n\t\t\t\t...currentMidTurnRecoveryEventData(),\n\t\t\t\troute: preflightRecovery.route,\n\t\t\t\terror: formatErrorMessage(promptError)\n\t\t\t});\n";
    if (start >= 0 && end >= 0) {
      source = source.slice(0, start) + completionEvents + source.slice(end);
    } else if (hasNativeMidTurnPrecheck && source.includes('\t\t\treturn {\n\t\t\t\treplayMetadata,')) {
      source = source.replace('\t\t\treturn {\n\t\t\t\treplayMetadata,', completionEvents + '\t\t\treturn {\n\t\t\t\treplayMetadata,');
    } else throw new Error('OpenClaw selection shape changed: recovery completion event bounds not found');
    changed = true;
  }

  const duplicateCompactOnlyEvent = '\t\t\t\t\temitMidTurnRecoveryEvent(params, "compaction_started", buildMidTurnRecoveryEventData(request, currentMidTurnRecoveryEventData()));\n\t\t\t\t\temitMidTurnRecoveryEvent(params, "compaction_started", buildMidTurnRecoveryEventData(request));';
  if (source.includes(duplicateCompactOnlyEvent)) {
    source = source.replace(duplicateCompactOnlyEvent, '\t\t\t\t\temitMidTurnRecoveryEvent(params, "compaction_started", buildMidTurnRecoveryEventData(request, currentMidTurnRecoveryEventData()));');
    changed = true;
  }

  const duplicateExhaustedGuardOld = '\t\t\telse if (preflightRecovery && promptError) emitMidTurnRecoveryEvent(params, "mid_turn_recovery_exhausted", {';
  const duplicateExhaustedGuardNew = '\t\t\telse if (preflightRecovery && promptError && preflightRecovery.exhausted !== true) emitMidTurnRecoveryEvent(params, "mid_turn_recovery_exhausted", {';
  if (source.includes(duplicateExhaustedGuardOld)) {
    source = source.replace(duplicateExhaustedGuardOld, duplicateExhaustedGuardNew);
    changed = true;
  }

  if (changed && source !== originalSource) {
    fs.writeFileSync(target, source, 'utf8');
    console.log(`Applied OpenClaw local patch: ${path.relative(root, target)}`);
  } else {
    console.log(`OpenClaw local patch already applied: ${path.relative(root, target)}`);
  }
}

function findSelectionFile() {
  const files = fs.readdirSync(distDir)
    .filter((name) => /^selection-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes('function installToolResultContextGuard(params)')) return file;
  }
  throw new Error('Could not locate OpenClaw selection dist file');
}

function applyOpenAiHttpToolEventPatch() {
  const target = findOpenAiHttpFile();
  let source = fs.readFileSync(target, 'utf8');
  const alreadyHasWriter = source.includes('function writeOpenClawAgentEventChunk(res, params)');
  const alreadyHasBridge = source.includes('openclaw_event: params.event') && source.includes('evt.stream === "tool" || evt.stream === "item" || evt.stream === "command_output" || evt.stream === "patch" || evt.stream === "recovery"');

  if (!alreadyHasWriter) {
    if (!source.includes(openAiHttpEventWriterAnchor)) {
      throw new Error('OpenClaw openai-http shape changed: usage chunk writer anchor not found');
    }
    const insertAfter = source.indexOf('function asMessages(val) {');
    if (insertAfter < 0) {
      throw new Error('OpenClaw openai-http shape changed: asMessages anchor not found');
    }
    source = source.slice(0, insertAfter) + openAiHttpEventWriterBlock + source.slice(insertAfter);
  }

  if (!alreadyHasBridge) {
    if (source.includes(openAiHttpEventBridgeWithoutRecovery)) {
      source = source.replace(openAiHttpEventBridgeWithoutRecovery, openAiHttpEventBridgeWithRecovery);
    } else {
      if (!source.includes(openAiHttpEventOld)) {
        throw new Error('OpenClaw openai-http shape changed: agent event subscription anchor not found');
      }
      source = source.replace(openAiHttpEventOld, openAiHttpEventNew);
    }
  }

  if (!alreadyHasWriter || !alreadyHasBridge) {
    fs.writeFileSync(target, source, 'utf8');
    console.log(`Applied OpenClaw local patch: ${path.relative(root, target)}`);
  } else {
    console.log(`OpenClaw local patch already applied: ${path.relative(root, target)}`);
  }
}

function findOpenAiHttpFile() {
  const files = fs.readdirSync(distDir)
    .filter((name) => /^openai-http-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes('async function handleOpenAiHttpRequest')) return file;
  }
  throw new Error('Could not locate OpenClaw openai-http dist file');
}


function findOpenClawToolsFile() {
  const files = fs.readdirSync(distDir)
    .filter((name) => /^openclaw-tools-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name));
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes('function collectPresentOpenClawTools(candidates)') && source.includes('function createSessionStatusTool(opts)')) return file;
  }
  throw new Error('Could not locate OpenClaw tools dist file');
}

function applyToolResultRangeToolPatch() {
  const target = findOpenClawToolsFile();
  const compactionFile = path.basename(findCompactionFile());
  let source = fs.readFileSync(target, 'utf8');
  let changed = false;

  const importLine = `import { q as readArchivedToolResultRange } from "./${compactionFile}";\n`;
  if (!source.includes('readArchivedToolResultRange')) {
    const firstImportEnd = source.indexOf('\n');
    if (firstImportEnd < 0) throw new Error('OpenClaw tools shape changed: import anchor not found');
    source = source.slice(0, firstImportEnd + 1) + importLine + source.slice(firstImportEnd + 1);
    changed = true;
  }

  if (!source.includes('function createToolResultRangeTool(opts)')) {
    const anchor = 'function createUpdatePlanTool() {';
    if (!source.includes(anchor)) throw new Error('OpenClaw tools shape changed: update-plan anchor not found');
    const block = `const ToolResultRangeSchema = Type.Object({\n\tid: Type.String(),\n\tstartLine: Type.Optional(Type.Number({ minimum: 1 })),\n\tlineCount: Type.Optional(Type.Number({ minimum: 1 })),\n\tstartByte: Type.Optional(Type.Number({ minimum: 0 })),\n\tbyteLength: Type.Optional(Type.Number({ minimum: 1 })),\n\tmaxChars: Type.Optional(Type.Number({ minimum: 1 }))\n});\nfunction resolveCurrentToolResultSessionFile(opts) {\n\tconst sessionId = opts?.sessionId;\n\tif (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Current session id unavailable for tool-result archive range recall");\n\tconst cfg = opts?.config ?? getRuntimeConfig();\n\tconst agentId = opts?.agentId ?? (opts?.agentSessionKey ? resolveAgentIdFromSessionKey(opts.agentSessionKey) : DEFAULT_AGENT_ID);\n\tconst storePath = resolveStorePath(cfg.session?.store, { agentId });\n\tconst filePathOpts = resolveSessionFilePathOptions({\n\t\tagentId,\n\t\tstorePath\n\t});\n\treturn resolveSessionFilePath(sessionId, void 0, filePathOpts);\n}\nfunction clampIntegerParam(value, fallback, min, max) {\n\tconst raw = typeof value === "number" && Number.isFinite(value) ? value : fallback;\n\treturn Math.max(min, Math.min(max, Math.floor(raw)));\n}\nfunction createToolResultRangeTool(opts) {\n\treturn {\n\t\tlabel: "Tool Result Range",\n\t\tname: "tool_result_range",\n\t\tdescription: "Read an exact bounded range from a verbatim archived tool result in the current session. Use when a tool output was archived as toolr_... and you need specific lines/bytes without reinjecting the full payload.",\n\t\tparameters: ToolResultRangeSchema,\n\t\texecute: async (_toolCallId, args) => {\n\t\t\tconst params = asToolParamsRecord(args);\n\t\t\tconst id = readStringParam$1(params, "id", { required: true });\n\t\t\tconst maxChars = clampIntegerParam(readNumberParam(params, "maxChars"), 16e3, 1, 64e3);\n\t\t\tconst request = {\n\t\t\t\tid,\n\t\t\t\tsessionFile: resolveCurrentToolResultSessionFile(opts),\n\t\t\t\tmaxChars\n\t\t\t};\n\t\t\tconst startByte = readNumberParam(params, "startByte");\n\t\t\tif (typeof startByte === "number") {\n\t\t\t\trequest.startByte = clampIntegerParam(startByte, 0, 0, Number.MAX_SAFE_INTEGER);\n\t\t\t\trequest.byteLength = clampIntegerParam(readNumberParam(params, "byteLength"), maxChars, 1, 64e3);\n\t\t\t} else {\n\t\t\t\trequest.startLine = clampIntegerParam(readNumberParam(params, "startLine"), 1, 1, Number.MAX_SAFE_INTEGER);\n\t\t\t\trequest.lineCount = clampIntegerParam(readNumberParam(params, "lineCount"), 200, 1, 2e3);\n\t\t\t}\n\t\t\treturn jsonResult(readArchivedToolResultRange(request));\n\t\t}\n\t};\n}\n`;
    source = source.replace(anchor, block + anchor);
    changed = true;
  }

  const registrationAnchor = '\t\tcreateSessionStatusTool({\n\t\t\tagentSessionKey: options?.agentSessionKey,\n\t\t\tconfig: resolvedConfig,\n\t\t\tsandboxed: options?.sandboxed\n\t\t}),';
  const currentRegistrationAnchor = '\t\tcreateSessionStatusTool({\n\t\t\tagentSessionKey: options?.agentSessionKey,\n\t\t\trunSessionKey: options?.runSessionKey,\n\t\t\tconfig: resolvedConfig,\n\t\t\tsandboxed: options?.sandboxed,\n\t\t\tactiveModelProvider: options?.modelProvider,\n\t\t\tactiveModelId: options?.modelId\n\t\t}),';
  if (!source.includes('createToolResultRangeTool({')) {
    if (source.includes(registrationAnchor)) {
      source = source.replace(registrationAnchor, `${registrationAnchor}\n\t\tcreateToolResultRangeTool({\n\t\t\tagentSessionKey: options?.agentSessionKey,\n\t\t\tsessionId: options?.sessionId,\n\t\t\tconfig: resolvedConfig,\n\t\t\tagentId: sessionAgentId\n\t\t}),`);
    } else if (source.includes(currentRegistrationAnchor)) {
      source = source.replace(currentRegistrationAnchor, `${currentRegistrationAnchor}\n\t\tcreateToolResultRangeTool({\n\t\t\tagentSessionKey: options?.agentSessionKey,\n\t\t\tsessionId: options?.sessionId,\n\t\t\tconfig: resolvedConfig,\n\t\t\tagentId: sessionAgentId\n\t\t}),`);
    } else throw new Error('OpenClaw tools shape changed: session-status registration anchor not found');
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(target, source, 'utf8');
    console.log(`Applied OpenClaw local patch: ${path.relative(root, target)}`);
  } else {
    console.log(`OpenClaw local patch already applied: ${path.relative(root, target)}`);
  }
}


main();
