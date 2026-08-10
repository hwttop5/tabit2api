const TABBIT_ID_PREFIX = "tabbit/";

export const PRIORITY_MODEL_ALIAS = `${TABBIT_ID_PREFIX}priority`;

export const PRIORITY_ROUTE = [
  { displayName: "Claude-Opus-4.7", tier: "primary" },
  { displayName: "GPT-5.5", tier: "primary" },
  { displayName: "Claude-Sonnet-4.6", tier: "primary" },
  { displayName: "GPT-5.4", tier: "primary" },
  { displayName: "DeepSeek-V4-Pro", tier: "backup" },
  { displayName: "GLM-5.1", tier: "backup" },
  { displayName: "Gemini-3.1-Pro", tier: "backup" },
].map((route, index) => ({
  ...route,
  gatewayModelId: `${TABBIT_ID_PREFIX}${route.displayName}`,
  order: index + 1,
}));

const PRIORITY_ROUTE_BY_NAME = new Map(
  PRIORITY_ROUTE.map((route) => [route.displayName.toLowerCase(), route]),
);

const RETRYABLE_TRANSPORT_ERRORS = new Set([
  "timeout",
  "send_failed",
  "send_threw",
  "stopGenerating_without_text",
  "chatFinished_without_text",
  "model_unavailable",
]);

const LOGIN_DETAIL_PATTERNS = [
  /\blogin\b/i,
  /\bsign[\s-]?in\b/i,
  /\bsigned out\b/i,
  /\bsession expired\b/i,
  /欢迎使用\s*Tabbit\s*浏览器/i,
  /免费使用最全最先进的模型/i,
];

const INVALID_REQUEST_PATTERNS = [
  /\binvalid[_\s-]?request\b/i,
  /\bbad request\b/i,
  /\bmalformed\b/i,
  /\bunsupported\b/i,
  /\bmissing required\b/i,
  /\brequired field\b/i,
  /\bprompt is required\b/i,
  /\binput is required\b/i,
  /\bcontext length\b/i,
  /\btoken limit\b/i,
  /\btoo many input tokens\b/i,
];

const RETRYABLE_AVAILABILITY_PATTERNS = [
  /\[492\]/i,
  /\b429\b/i,
  /\b5\d{2}\b/i,
  /\brate limit\b/i,
  /\bquota\b/i,
  /\binsufficient\b/i,
  /\bcredit\b/i,
  /\bbilling\b/i,
  /\bexhausted\b/i,
  /\boverload(?:ed)?\b/i,
  /\bbusy\b/i,
  /\bcapacity\b/i,
  /\bservice unavailable\b/i,
  /\btemporarily unavailable\b/i,
  /\bserver error\b/i,
  /\bbad gateway\b/i,
  /\bgateway timeout\b/i,
  /\btimeout\b/i,
  /\btimed out\b/i,
  /\bnetwork\b/i,
  /\bconnection\b/i,
  /\bsocket\b/i,
  /\beconn/i,
  /\betimedout\b/i,
  /\benotfound\b/i,
  /\bmodel not found\b/i,
  /\bdoes not exist\b/i,
  /\bnot found\b/i,
  /\bunavailable\b/i,
  /\bupgrade\b/i,
  /\bpremium\b/i,
  /\bsubscription\b/i,
  /\bpermission\b/i,
  /\bforbidden\b/i,
  /\bnot authorized\b/i,
  /\baccess denied\b/i,
  /Service is busy\.?\s*Please try again tomorrow\.?/i,
  /AI\s*服务.*不可用/i,
  /暂时不可用/i,
  /稍后重试/i,
  /欢迎使用\s*Tabbit\s*浏览器/i,
  /免费使用最全最先进的模型/i,
];

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function decodeLatin1Utf8(value) {
  const text = cleanText(value);
  if (!text) {
    return "";
  }

  try {
    const decoded = Buffer.from(text, "latin1").toString("utf8").trim();
    return decoded && !decoded.includes("\uFFFD") ? decoded : text;
  } catch {
    return text;
  }
}

function preferredRouteForName(value) {
  const route = PRIORITY_ROUTE_BY_NAME.get(cleanText(value).toLowerCase());
  return route || null;
}

function isLikelyDefaultModel(model, index, decodedDisplayName) {
  if (cleanText(decodedDisplayName).toLowerCase() === "default") {
    return true;
  }

  return Boolean(
    index === 0 &&
      model &&
      model.model_access_type === "free_unlimited" &&
      !preferredRouteForName(decodedDisplayName),
  );
}

function normalizeCatalogDisplayName(model, index) {
  const rawDisplayName = cleanText(model?.display_name);
  const decodedDisplayName = decodeLatin1Utf8(rawDisplayName);
  const preferredRoute =
    preferredRouteForName(decodedDisplayName) ||
    preferredRouteForName(rawDisplayName);

  if (preferredRoute) {
    return preferredRoute.displayName;
  }

  if (isLikelyDefaultModel(model, index, decodedDisplayName)) {
    return "Default";
  }

  return decodedDisplayName || rawDisplayName;
}

export function normalizeRequestedModelId(requestedModel) {
  const trimmed = cleanText(requestedModel);
  if (!trimmed) {
    return PRIORITY_MODEL_ALIAS;
  }

  const lowered = trimmed.toLowerCase();
  if (lowered === PRIORITY_MODEL_ALIAS || lowered === "priority") {
    return PRIORITY_MODEL_ALIAS;
  }

  if (lowered.startsWith(TABBIT_ID_PREFIX)) {
    const suffix = trimmed.slice(TABBIT_ID_PREFIX.length);
    const preferredRoute = preferredRouteForName(suffix);
    if (preferredRoute) {
      return preferredRoute.gatewayModelId;
    }

    if (suffix.toLowerCase() === "default") {
      return `${TABBIT_ID_PREFIX}Default`;
    }

    return `${TABBIT_ID_PREFIX}${suffix}`;
  }

  const preferredRoute = preferredRouteForName(trimmed);
  if (preferredRoute) {
    return preferredRoute.gatewayModelId;
  }

  if (lowered === "default") {
    return `${TABBIT_ID_PREFIX}Default`;
  }

  return `${TABBIT_ID_PREFIX}${trimmed}`;
}

export function toGatewayModelId(displayName) {
  return `${TABBIT_ID_PREFIX}${displayName}`;
}

function modelDescriptorFromCatalogModel(model, index) {
  const displayName = normalizeCatalogDisplayName(model, index);
  return {
    id: toGatewayModelId(displayName),
    displayName,
    selectedModel: cleanText(model?.display_name) || displayName,
    tabbit_display_name: cleanText(model?.display_name) || displayName,
    supports_images: Boolean(model?.supports_images),
    supports_tools: Boolean(model?.supports_tools),
    support_thinking: Boolean(model?.support_thinking),
    model_access_type: model?.model_access_type || null,
    available_in_tabbit_catalog: true,
    source: "tabbit",
    priority_group: null,
    priority_rank: null,
  };
}

function staticRouteDescriptor(route, catalogMatch) {
  return {
    id: route.gatewayModelId,
    displayName: route.displayName,
    selectedModel: catalogMatch?.selectedModel || route.displayName,
    tabbit_display_name: catalogMatch?.tabbit_display_name || route.displayName,
    supports_images:
      catalogMatch?.supports_images ??
      (route.tier === "primary" || route.displayName === "Gemini-3.1-Pro"),
    supports_tools: catalogMatch?.supports_tools ?? true,
    support_thinking:
      catalogMatch?.support_thinking ??
      route.displayName !== "GPT-5.5",
    model_access_type: catalogMatch?.model_access_type || null,
    available_in_tabbit_catalog: Boolean(catalogMatch),
    source: "priority_route",
    priority_group: route.tier,
    priority_rank: route.order,
  };
}

function virtualPriorityDescriptor() {
  return {
    id: PRIORITY_MODEL_ALIAS,
    displayName: "priority",
    selectedModel: null,
    tabbit_display_name: "priority",
    supports_images: true,
    supports_tools: true,
    support_thinking: true,
    model_access_type: "virtual_priority",
    available_in_tabbit_catalog: true,
    source: "virtual",
    priority_group: "virtual",
    priority_rank: 0,
  };
}

export function buildGatewayCatalogBundle(rawModels) {
  const catalogModels = rawModels.map(modelDescriptorFromCatalogModel);
  const catalogById = new Map(catalogModels.map((model) => [model.id, model]));
  const seenIds = new Set();
  const models = [];

  const pushModel = (model) => {
    if (!model || seenIds.has(model.id)) {
      return;
    }

    seenIds.add(model.id);
    models.push(model);
  };

  pushModel(virtualPriorityDescriptor());

  for (const route of PRIORITY_ROUTE) {
    pushModel(staticRouteDescriptor(route, catalogById.get(route.gatewayModelId)));
  }

  for (const model of catalogModels) {
    pushModel(model);
  }

  return {
    models,
    catalogModels,
    byId: new Map(models.map((model) => [model.id, model])),
    byDisplayName: new Map(
      models.map((model) => [model.displayName.toLowerCase(), model]),
    ),
    bySelectedModel: new Map(
      models
        .filter((model) => model.selectedModel)
        .map((model) => [model.selectedModel.toLowerCase(), model]),
    ),
    catalogAvailable: rawModels.length > 0,
  };
}

function routeAttempt(model, priorityGroup, priorityRank) {
  return {
    gatewayModelId: model.id,
    displayName: model.displayName,
    selectedModel: model.selectedModel || model.displayName,
    availableInTabbitCatalog: model.available_in_tabbit_catalog,
    priorityGroup,
    priorityRank,
  };
}

function priorityRouteAttempts(catalogBundle) {
  if (!catalogBundle.catalogAvailable) {
    return PRIORITY_ROUTE.map((route) => {
      const model =
        catalogBundle.byId.get(route.gatewayModelId) ||
        staticRouteDescriptor(route, null);
      return routeAttempt(model, route.tier, route.order);
    });
  }

  const attempts = [];
  const seenIds = new Set();
  const pushAttempt = (model, priorityGroup) => {
    if (!model || seenIds.has(model.id)) {
      return;
    }
    seenIds.add(model.id);
    attempts.push(routeAttempt(model, priorityGroup, attempts.length + 1));
  };

  for (const route of PRIORITY_ROUTE) {
    const model = catalogBundle.byId.get(route.gatewayModelId);
    if (model?.available_in_tabbit_catalog) {
      pushAttempt(model, route.tier);
    }
  }

  const catalogModels = catalogBundle.catalogModels || [];
  for (const model of catalogModels) {
    if (
      model.displayName.toLowerCase() !== "default" &&
      /^free(?:_|$)/i.test(cleanText(model.model_access_type))
    ) {
      pushAttempt(model, "catalog_free");
    }
  }

  const defaultModel = catalogModels.find(
    (model) => model.displayName.toLowerCase() === "default",
  );
  pushAttempt(defaultModel, "catalog_default");

  if (attempts.length === 0) {
    pushAttempt(catalogModels[0], "catalog_fallback");
  }

  return attempts;
}

export function resolveRoutePlan(requestedModel, catalogBundle) {
  const requestedModelAlias = normalizeRequestedModelId(requestedModel);

  if (requestedModelAlias === PRIORITY_MODEL_ALIAS) {
    return {
      ok: true,
      kind: "priority_chain",
      requestedModelAlias,
      attempts: priorityRouteAttempts(catalogBundle),
    };
  }

  const exactModel =
    catalogBundle.byId.get(requestedModelAlias) ||
    catalogBundle.byDisplayName.get(
      requestedModelAlias.slice(TABBIT_ID_PREFIX.length).toLowerCase(),
    ) ||
    catalogBundle.bySelectedModel.get(
      requestedModelAlias.slice(TABBIT_ID_PREFIX.length).toLowerCase(),
    );

  if (!exactModel) {
    return {
      ok: false,
      result: {
        ok: false,
        error: "invalid_request",
        detail: `Unknown model '${requestedModel}'. Use GET /v1/models to list supported ids.`,
        requestedModelAlias,
        attemptedModels: [],
        fallbackHappened: false,
      },
    };
  }

  return {
    ok: true,
    kind: "direct",
    requestedModelAlias: exactModel.id,
    attempts: [
      {
        gatewayModelId: exactModel.id,
        displayName: exactModel.displayName,
        selectedModel: exactModel.selectedModel || exactModel.displayName,
        availableInTabbitCatalog: exactModel.available_in_tabbit_catalog,
        priorityGroup: exactModel.priority_group,
        priorityRank: exactModel.priority_rank,
      },
    ],
  };
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifyAttemptFailure(result) {
  if (result.ok) {
    return { retryable: false, reason: "success" };
  }

  const error = cleanText(result.error);
  const detail = cleanText(result.detail);

  if (error === "login_required") {
    return { retryable: false, reason: "login_required" };
  }

  if (error === "invalid_request") {
    return { retryable: false, reason: "invalid_request" };
  }

  if (error === "model_unavailable") {
    return { retryable: true, reason: "upstream_unavailable" };
  }

  if (RETRYABLE_TRANSPORT_ERRORS.has(error)) {
    return { retryable: true, reason: error };
  }

  if (matchesAny(detail, LOGIN_DETAIL_PATTERNS)) {
    return { retryable: false, reason: "login_required" };
  }

  if (matchesAny(detail, INVALID_REQUEST_PATTERNS)) {
    return { retryable: false, reason: "invalid_request" };
  }

  if (matchesAny(detail, RETRYABLE_AVAILABILITY_PATTERNS)) {
    return { retryable: true, reason: "upstream_unavailable" };
  }

  return { retryable: false, reason: error || "tabbit_error" };
}
