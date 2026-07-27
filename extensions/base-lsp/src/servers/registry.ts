import type { ServerDefinition } from "../config/schema.js";

export class ServerRegistry {
  private readonly definitions: Map<string, ServerDefinition>;
  constructor(servers: Record<string, ServerDefinition>) { this.definitions = new Map(Object.entries(servers)); }
  get(id: string): ServerDefinition | undefined { return this.definitions.get(id); }
  list(): ServerDefinition[] { return [...this.definitions.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  enabled(): ServerDefinition[] { return this.list().filter((server) => server.enabled); }
}
