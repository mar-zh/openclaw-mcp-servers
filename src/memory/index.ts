#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Define memory file path using environment variable with fallback
export const defaultMemoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.jsonl');

// Handle backward compatibility: migrate memory.json to memory.jsonl if needed
export async function ensureMemoryFilePath(): Promise<string> {
  if (process.env.MEMORY_FILE_PATH) {
    // Custom path provided, use it as-is (with absolute path resolution)
    return path.isAbsolute(process.env.MEMORY_FILE_PATH)
      ? process.env.MEMORY_FILE_PATH
      : path.join(path.dirname(fileURLToPath(import.meta.url)), process.env.MEMORY_FILE_PATH);
  }

  // No custom path set, check for backward compatibility migration
  const oldMemoryPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory.json');
  const newMemoryPath = defaultMemoryPath;

  try {
    // Check if old file exists and new file doesn't
    await fs.access(oldMemoryPath);
    try {
      await fs.access(newMemoryPath);
      // Both files exist, use new one (no migration needed)
      return newMemoryPath;
    } catch {
      // Old file exists, new file doesn't - migrate
      console.error('DETECTED: Found legacy memory.json file, migrating to memory.jsonl for JSONL format compatibility');
      await fs.rename(oldMemoryPath, newMemoryPath);
      console.error('COMPLETED: Successfully migrated memory.json to memory.jsonl');
      return newMemoryPath;
    }
  } catch {
    // Old file doesn't exist, use new path
    return newMemoryPath;
  }
}

// Initialize memory file path (will be set during startup)
let MEMORY_FILE_PATH: string;

// We are storing our memory using entities, relations, and observations in a graph structure

export interface Observation {
  content: string;
  timestamp: string | null;  // ISO-8601, null for migrated legacy entries
}

export interface Entity {
  name: string;
  entityType: string;
  observations: Observation[];
  // Mesh-aware metadata
  createdAt?: string;       // ISO-8601, set on create_entities
  createdBy?: string;       // Agent name, from AGENT_NAME env var
  lastModifiedAt?: string;  // ISO-8601, updated on add/delete observations
  tags?: string[];          // Freeform tags for categorization
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
  // Mesh-aware metadata
  createdAt?: string;   // ISO-8601
  createdBy?: string;   // Agent name
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

// Normalize a raw observation from storage (may be string for backward compat) to Observation
function normalizeLoadedObservation(obs: unknown): Observation {
  if (typeof obs === 'string') {
    return { content: obs, timestamp: null };
  }
  return obs as Observation;
}

// Normalize an observation input (string or object) to Observation with auto-timestamp
export function normalizeObservationInput(obs: string | { content: string; timestamp?: string }): Observation {
  if (typeof obs === 'string') {
    return { content: obs, timestamp: new Date().toISOString() };
  }
  return { content: obs.content, timestamp: obs.timestamp ?? new Date().toISOString() };
}

// The KnowledgeGraphManager class contains all operations to interact with the knowledge graph
export class KnowledgeGraphManager {
  constructor(private memoryFilePath: string) {}

  private async loadGraph(): Promise<KnowledgeGraph> {
    try {
      const data = await fs.readFile(this.memoryFilePath, "utf-8");
      const lines = data.split("\n").filter(line => line.trim() !== "");
      return lines.reduce((graph: KnowledgeGraph, line) => {
        const item = JSON.parse(line);
        if (item.type === "entity") {
          graph.entities.push({
            name: item.name,
            entityType: item.entityType,
            observations: (item.observations as unknown[]).map(normalizeLoadedObservation),
            createdAt: item.createdAt,
            createdBy: item.createdBy,
            lastModifiedAt: item.lastModifiedAt,
            tags: item.tags,
          });
        }
        if (item.type === "relation") {
          graph.relations.push({
            from: item.from,
            to: item.to,
            relationType: item.relationType,
            createdAt: item.createdAt,
            createdBy: item.createdBy,
          });
        }
        return graph;
      }, { entities: [], relations: [] });
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as any).code === "ENOENT") {
        return { entities: [], relations: [] };
      }
      throw error;
    }
  }

  private async saveGraph(graph: KnowledgeGraph): Promise<void> {
    const lines = [
      ...graph.entities.map(e => {
        const obj: Record<string, unknown> = {
          type: "entity",
          name: e.name,
          entityType: e.entityType,
          observations: e.observations,
        };
        if (e.createdAt !== undefined) obj.createdAt = e.createdAt;
        if (e.createdBy !== undefined) obj.createdBy = e.createdBy;
        if (e.lastModifiedAt !== undefined) obj.lastModifiedAt = e.lastModifiedAt;
        if (e.tags !== undefined) obj.tags = e.tags;
        return JSON.stringify(obj);
      }),
      ...graph.relations.map(r => {
        const obj: Record<string, unknown> = {
          type: "relation",
          from: r.from,
          to: r.to,
          relationType: r.relationType,
        };
        if (r.createdAt !== undefined) obj.createdAt = r.createdAt;
        if (r.createdBy !== undefined) obj.createdBy = r.createdBy;
        return JSON.stringify(obj);
      }),
    ];
    await fs.writeFile(this.memoryFilePath, lines.join("\n"));
  }

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    const graph = await this.loadGraph();
    const now = new Date().toISOString();
    const agentName = process.env.AGENT_NAME ?? 'unknown';
    const newEntities = entities
      .filter(e => !graph.entities.some(existingEntity => existingEntity.name === e.name))
      .map(e => ({
        ...e,
        createdAt: e.createdAt ?? now,
        createdBy: e.createdBy ?? agentName,
        lastModifiedAt: e.lastModifiedAt ?? now,
      }));
    graph.entities.push(...newEntities);
    await this.saveGraph(graph);
    return newEntities;
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const graph = await this.loadGraph();
    const now = new Date().toISOString();
    const agentName = process.env.AGENT_NAME ?? 'unknown';
    const newRelations = relations
      .filter(r => !graph.relations.some(existingRelation =>
        existingRelation.from === r.from &&
        existingRelation.to === r.to &&
        existingRelation.relationType === r.relationType
      ))
      .map(r => ({
        ...r,
        createdAt: r.createdAt ?? now,
        createdBy: r.createdBy ?? agentName,
      }));
    graph.relations.push(...newRelations);
    await this.saveGraph(graph);
    return newRelations;
  }

  async addObservations(observations: { entityName: string; contents: (string | { content: string; timestamp?: string })[] }[]): Promise<{ entityName: string; addedObservations: Observation[] }[]> {
    const graph = await this.loadGraph();
    const now = new Date().toISOString();
    const results = observations.map(o => {
      const entity = graph.entities.find(e => e.name === o.entityName);
      if (!entity) {
        throw new Error(`Entity with name ${o.entityName} not found`);
      }
      const existingContents = new Set(entity.observations.map(obs => obs.content));
      const newObservations: Observation[] = [];
      for (const rawObs of o.contents) {
        const normalized = normalizeObservationInput(rawObs);
        if (!existingContents.has(normalized.content)) {
          newObservations.push(normalized);
          existingContents.add(normalized.content);
        }
      }
      entity.observations.push(...newObservations);
      entity.lastModifiedAt = now;
      return { entityName: o.entityName, addedObservations: newObservations };
    });
    await this.saveGraph(graph);
    return results;
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    const graph = await this.loadGraph();
    graph.entities = graph.entities.filter(e => !entityNames.includes(e.name));
    graph.relations = graph.relations.filter(r => !entityNames.includes(r.from) && !entityNames.includes(r.to));
    await this.saveGraph(graph);
  }

  async deleteObservations(deletions: { entityName: string; observations: string[] }[]): Promise<void> {
    const graph = await this.loadGraph();
    const now = new Date().toISOString();
    deletions.forEach(d => {
      const entity = graph.entities.find(e => e.name === d.entityName);
      if (entity) {
        const toDelete = new Set(d.observations);
        entity.observations = entity.observations.filter(o => !toDelete.has(o.content));
        entity.lastModifiedAt = now;
      }
    });
    await this.saveGraph(graph);
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    const graph = await this.loadGraph();
    graph.relations = graph.relations.filter(r => !relations.some(delRelation =>
      r.from === delRelation.from &&
      r.to === delRelation.to &&
      r.relationType === delRelation.relationType
    ));
    await this.saveGraph(graph);
  }

  async readGraph(): Promise<KnowledgeGraph> {
    return this.loadGraph();
  }

  async searchNodes(query: string, entityType?: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();

    // Filter entities by query
    let filteredEntities = graph.entities.filter(e =>
      e.name.toLowerCase().includes(query.toLowerCase()) ||
      e.entityType.toLowerCase().includes(query.toLowerCase()) ||
      e.observations.some(o => o.content.toLowerCase().includes(query.toLowerCase()))
    );

    // Apply optional entityType filter
    if (entityType) {
      filteredEntities = filteredEntities.filter(e => e.entityType === entityType);
    }

    // Create a Set of filtered entity names for quick lookup
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

    // Include relations where at least one endpoint matches the search results.
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
    );

    return { entities: filteredEntities, relations: filteredRelations };
  }

  async searchByType(entityType: string, query?: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();

    let filteredEntities = graph.entities.filter(e => e.entityType === entityType);

    if (query) {
      const lowerQuery = query.toLowerCase();
      filteredEntities = filteredEntities.filter(e =>
        e.name.toLowerCase().includes(lowerQuery) ||
        e.observations.some(o => o.content.toLowerCase().includes(lowerQuery))
      );
    }

    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
    );

    return { entities: filteredEntities, relations: filteredRelations };
  }

  async searchByTime(after?: string, before?: string, entityType?: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    const afterDate = after ? new Date(after) : null;
    const beforeDate = before ? new Date(before) : null;

    let filteredEntities = graph.entities.filter(e =>
      e.observations.some(o => {
        if (!o.timestamp) return false;
        const obsDate = new Date(o.timestamp);
        if (afterDate && obsDate < afterDate) return false;
        if (beforeDate && obsDate > beforeDate) return false;
        return true;
      })
    );

    if (entityType) {
      filteredEntities = filteredEntities.filter(e => e.entityType === entityType);
    }

    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
    );

    return { entities: filteredEntities, relations: filteredRelations };
  }

  async getRelationsOf(entityName: string, relationType?: string): Promise<{ outgoing: Relation[]; incoming: Relation[] }> {
    const graph = await this.loadGraph();

    let outgoing = graph.relations.filter(r => r.from === entityName);
    let incoming = graph.relations.filter(r => r.to === entityName);

    if (relationType) {
      outgoing = outgoing.filter(r => r.relationType === relationType);
      incoming = incoming.filter(r => r.relationType === relationType);
    }

    return { outgoing, incoming };
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();

    // Filter entities
    const filteredEntities = graph.entities.filter(e => names.includes(e.name));

    // Create a Set of filtered entity names for quick lookup
    const filteredEntityNames = new Set(filteredEntities.map(e => e.name));

    // Include relations where at least one endpoint is in the requested set.
    const filteredRelations = graph.relations.filter(r =>
      filteredEntityNames.has(r.from) || filteredEntityNames.has(r.to)
    );

    return { entities: filteredEntities, relations: filteredRelations };
  }
}

let knowledgeGraphManager: KnowledgeGraphManager;

// Zod schemas

const ObservationSchema = z.object({
  content: z.string().describe("The observation content"),
  timestamp: z.string().nullable().describe("ISO-8601 timestamp, null for migrated legacy entries"),
});

const ObservationInputSchema = z.union([
  z.string().describe("Observation content (will be auto-timestamped)"),
  z.object({
    content: z.string().describe("The observation content"),
    timestamp: z.string().optional().describe("Optional ISO-8601 timestamp; auto-generated if omitted"),
  }),
]);

const EntitySchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z.array(ObservationSchema).describe("Observations associated with the entity"),
  createdAt: z.string().optional().describe("ISO-8601 creation timestamp"),
  createdBy: z.string().optional().describe("Agent name that created this entity"),
  lastModifiedAt: z.string().optional().describe("ISO-8601 last modification timestamp"),
  tags: z.array(z.string()).optional().describe("Freeform tags for categorization"),
});

const EntityInputSchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z.array(ObservationInputSchema).describe("An array of observation contents (strings or objects with optional timestamps)"),
  tags: z.array(z.string()).optional().describe("Freeform tags for categorization"),
});

const RelationSchema = z.object({
  from: z.string().describe("The name of the entity where the relation starts"),
  to: z.string().describe("The name of the entity where the relation ends"),
  relationType: z.string().describe("The type of the relation"),
  createdAt: z.string().optional().describe("ISO-8601 creation timestamp"),
  createdBy: z.string().optional().describe("Agent name that created this relation"),
});

// The server instance and tools exposed to Claude
const server = new McpServer({
  name: "openclaw-memory-server",
  version: "1.0.0",
});

// Register create_entities tool
server.registerTool(
  "create_entities",
  {
    title: "Create Entities",
    description: "Create multiple new entities in the knowledge graph",
    inputSchema: {
      entities: z.array(EntityInputSchema)
    },
    outputSchema: {
      entities: z.array(EntitySchema)
    }
  },
  async ({ entities }) => {
    const now = new Date().toISOString();
    const normalized: Entity[] = entities.map(e => ({
      name: e.name,
      entityType: e.entityType,
      observations: e.observations.map(normalizeObservationInput),
      tags: e.tags,
    }));
    const result = await knowledgeGraphManager.createEntities(normalized);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { entities: result }
    };
  }
);

// Register create_relations tool
server.registerTool(
  "create_relations",
  {
    title: "Create Relations",
    description: "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
    inputSchema: {
      relations: z.array(z.object({
        from: z.string().describe("The name of the entity where the relation starts"),
        to: z.string().describe("The name of the entity where the relation ends"),
        relationType: z.string().describe("The type of the relation"),
      }))
    },
    outputSchema: {
      relations: z.array(RelationSchema)
    }
  },
  async ({ relations }) => {
    const result = await knowledgeGraphManager.createRelations(relations);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { relations: result }
    };
  }
);

// Register add_observations tool
server.registerTool(
  "add_observations",
  {
    title: "Add Observations",
    description: "Add new observations to existing entities in the knowledge graph",
    inputSchema: {
      observations: z.array(z.object({
        entityName: z.string().describe("The name of the entity to add the observations to"),
        contents: z.array(ObservationInputSchema).describe("An array of observations to add (strings or objects with optional timestamps)")
      }))
    },
    outputSchema: {
      results: z.array(z.object({
        entityName: z.string(),
        addedObservations: z.array(ObservationSchema)
      }))
    }
  },
  async ({ observations }) => {
    const result = await knowledgeGraphManager.addObservations(observations);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { results: result }
    };
  }
);

// Register delete_entities tool
server.registerTool(
  "delete_entities",
  {
    title: "Delete Entities",
    description: "Delete multiple entities and their associated relations from the knowledge graph",
    inputSchema: {
      entityNames: z.array(z.string()).describe("An array of entity names to delete")
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string()
    }
  },
  async ({ entityNames }) => {
    await knowledgeGraphManager.deleteEntities(entityNames);
    return {
      content: [{ type: "text" as const, text: "Entities deleted successfully" }],
      structuredContent: { success: true, message: "Entities deleted successfully" }
    };
  }
);

// Register delete_observations tool
server.registerTool(
  "delete_observations",
  {
    title: "Delete Observations",
    description: "Delete specific observations from entities in the knowledge graph",
    inputSchema: {
      deletions: z.array(z.object({
        entityName: z.string().describe("The name of the entity containing the observations"),
        observations: z.array(z.string()).describe("An array of observation contents to delete")
      }))
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string()
    }
  },
  async ({ deletions }) => {
    await knowledgeGraphManager.deleteObservations(deletions);
    return {
      content: [{ type: "text" as const, text: "Observations deleted successfully" }],
      structuredContent: { success: true, message: "Observations deleted successfully" }
    };
  }
);

// Register delete_relations tool
server.registerTool(
  "delete_relations",
  {
    title: "Delete Relations",
    description: "Delete multiple relations from the knowledge graph",
    inputSchema: {
      relations: z.array(z.object({
        from: z.string().describe("The name of the entity where the relation starts"),
        to: z.string().describe("The name of the entity where the relation ends"),
        relationType: z.string().describe("The type of the relation"),
      })).describe("An array of relations to delete")
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string()
    }
  },
  async ({ relations }) => {
    await knowledgeGraphManager.deleteRelations(relations);
    return {
      content: [{ type: "text" as const, text: "Relations deleted successfully" }],
      structuredContent: { success: true, message: "Relations deleted successfully" }
    };
  }
);

// Register read_graph tool
server.registerTool(
  "read_graph",
  {
    title: "Read Graph",
    description: "Read the entire knowledge graph",
    inputSchema: {},
    outputSchema: {
      entities: z.array(EntitySchema),
      relations: z.array(RelationSchema)
    }
  },
  async () => {
    const graph = await knowledgeGraphManager.readGraph();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

// Register search_nodes tool
server.registerTool(
  "search_nodes",
  {
    title: "Search Nodes",
    description: "Search for nodes in the knowledge graph based on a query",
    inputSchema: {
      query: z.string().describe("The search query to match against entity names, types, and observation content"),
      entityType: z.string().optional().describe("Optional entity type filter to narrow results"),
    },
    outputSchema: {
      entities: z.array(EntitySchema),
      relations: z.array(RelationSchema)
    }
  },
  async ({ query, entityType }) => {
    const graph = await knowledgeGraphManager.searchNodes(query, entityType);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

// Register open_nodes tool
server.registerTool(
  "open_nodes",
  {
    title: "Open Nodes",
    description: "Open specific nodes in the knowledge graph by their names",
    inputSchema: {
      names: z.array(z.string()).describe("An array of entity names to retrieve")
    },
    outputSchema: {
      entities: z.array(EntitySchema),
      relations: z.array(RelationSchema)
    }
  },
  async ({ names }) => {
    const graph = await knowledgeGraphManager.openNodes(names);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

// Register search_by_type tool
server.registerTool(
  "search_by_type",
  {
    title: "Search By Type",
    description: "Search for entities filtered by entity type, with an optional query to further narrow results",
    inputSchema: {
      entityType: z.string().describe("The entity type to filter by (e.g. 'agent', 'decision', 'system')"),
      query: z.string().optional().describe("Optional query to filter within the results by name or observation content"),
    },
    outputSchema: {
      entities: z.array(EntitySchema),
      relations: z.array(RelationSchema)
    }
  },
  async ({ entityType, query }) => {
    const graph = await knowledgeGraphManager.searchByType(entityType, query);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

// Register search_by_time tool
server.registerTool(
  "search_by_time",
  {
    title: "Search By Time",
    description: "Search for entities that have observations within a specified time range",
    inputSchema: {
      after: z.string().optional().describe("ISO-8601 timestamp; return entities with observations after this time"),
      before: z.string().optional().describe("ISO-8601 timestamp; return entities with observations before this time"),
      entityType: z.string().optional().describe("Optional entity type filter"),
    },
    outputSchema: {
      entities: z.array(EntitySchema),
      relations: z.array(RelationSchema)
    }
  },
  async ({ after, before, entityType }) => {
    const graph = await knowledgeGraphManager.searchByTime(after, before, entityType);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

// Register get_relations_of tool
server.registerTool(
  "get_relations_of",
  {
    title: "Get Relations Of",
    description: "Get all relations for a specific entity (both inbound and outbound), with an optional relation type filter",
    inputSchema: {
      entityName: z.string().describe("The name of the entity to get relations for"),
      relationType: z.string().optional().describe("Optional relation type filter"),
    },
    outputSchema: {
      outgoing: z.array(RelationSchema),
      incoming: z.array(RelationSchema),
    }
  },
  async ({ entityName, relationType }) => {
    const result = await knowledgeGraphManager.getRelationsOf(entityName, relationType);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: result
    };
  }
);

async function main() {
  // Initialize memory file path with backward compatibility
  MEMORY_FILE_PATH = await ensureMemoryFilePath();

  // Initialize knowledge graph manager with the memory file path
  knowledgeGraphManager = new KnowledgeGraphManager(MEMORY_FILE_PATH);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
