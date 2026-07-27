import type { ServerDefinition } from "../config/schema.js";
import type { RootResolution } from "./roots.js";
import { RootDetector } from "./roots.js";
import { matchesServerFile } from "../workspace/files.js";

export interface Route { server: ServerDefinition; root: string; resolution: RootResolution; specificity: number }
export interface RouteResult { primary?: Route; diagnostics: Route[]; ambiguous?: string[] }

export async function routeFile(filePath: string, boundary: string, servers: ServerDefinition[], roots: RootDetector, explicit?: string): Promise<RouteResult> {
  const candidates = servers.filter((server) => server.enabled && matchesServerFile(server, filePath) && (!explicit || server.id === explicit));
  const routes: Route[] = [];
  for (const server of candidates) {
    const resolution = await roots.find(server, filePath, boundary);
    if (!resolution.root) continue;
    routes.push({ server, root: resolution.root, resolution, specificity: matchSpecificity(server, filePath) });
  }
  routes.sort((a, b) => compareRouteRank(a, b) || a.server.id.localeCompare(b.server.id));
  const primaryRoutes = routes.filter((route) => route.server.role === "primary");
  const diagnostics = routes.filter((route) => route.server.role === "diagnostic");
  const first = primaryRoutes[0];
  const second = primaryRoutes[1];
  if (first && second && compareRouteRank(first, second) === 0) {
    const ambiguous = primaryRoutes.filter((route) => compareRouteRank(first, route) === 0).map((route) => route.server.id);
    return { diagnostics, ambiguous };
  }
  return { ...(first ? { primary: first } : {}), diagnostics };
}

function matchSpecificity(server: ServerDefinition, path: string): number {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  if (server.filenames?.includes(name)) return 10_000 + name.length;
  return Math.max(0, ...server.extensions.filter((extension) => name.endsWith(extension)).map((extension) => extension.length));
}
function compareRouteRank(a: Route, b: Route): number {
  return a.resolution.distance - b.resolution.distance || a.resolution.markerPriority - b.resolution.markerPriority || b.specificity - a.specificity || b.server.priority - a.server.priority;
}
