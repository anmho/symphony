import { fetchIssueLabelNames } from "./linear.js";
import { normalizeState } from "./policy.js";
import type { EffectiveWorkflowConfig } from "./types.js";

export interface ConfigValidationWarning {
  code: "linear_label_lookup_unavailable" | "missing_repo_route_label";
  message: string;
}

export async function validateConfiguredRepoRouteLabels(
  config: EffectiveWorkflowConfig,
  fetchLabels: (config: EffectiveWorkflowConfig) => Promise<string[]> = fetchIssueLabelNames
): Promise<ConfigValidationWarning[]> {
  const expectedLabels = Object.keys(config.workspace.repoRoutes).map(
    (repoKey) => `${config.tracker.repoLabelPrefix}${repoKey}`
  );
  if (expectedLabels.length === 0) {
    return [];
  }

  let labels: string[];
  try {
    labels = await fetchLabels(config);
  } catch (error) {
    return [
      {
        code: "linear_label_lookup_unavailable",
        message: `Could not verify Linear repo route labels: ${errorMessage(error)}`
      }
    ];
  }

  const existingLabels = new Set(labels.map(normalizeState));
  return expectedLabels
    .filter((label) => !existingLabels.has(normalizeState(label)))
    .map((label) => ({
      code: "missing_repo_route_label" as const,
      message: `Missing Linear label for configured repo route: ${label}`
    }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
