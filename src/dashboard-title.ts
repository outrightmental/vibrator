export const DEFAULT_DASHBOARD_TITLE = "Outright Mental";

export function resolveDashboardTitle(configuredTitle: string | undefined): string {
  if (configuredTitle && configuredTitle.trim() !== "") return configuredTitle;
  return DEFAULT_DASHBOARD_TITLE;
}
