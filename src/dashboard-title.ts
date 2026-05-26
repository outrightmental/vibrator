import type { ProjectModeConfig } from "./orchestrator.js";

export function resolveDashboardTitle(
  configuredTitle: string | undefined,
  repo: string,
  projectMode: ProjectModeConfig | undefined,
  projectTitle: string | undefined,
): string {
  if (configuredTitle && configuredTitle.trim() !== "") return configuredTitle;
  if (projectMode) return projectTitle && projectTitle.trim() !== "" ? projectTitle : repo;
  return repo;
}
