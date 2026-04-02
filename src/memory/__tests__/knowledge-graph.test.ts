import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  KnowledgeGraphManager,
  Entity,
  Relation,
  Observation,
  KnowledgeGraph,
  normalizeObservationInput,
} from '../index.js';

// Helper to create an Observation object
function obs(content: string, timestamp?: string | null): Observation {
  return { content, timestamp: timestamp !== undefined ? timestamp : expect.any(String) as any };
}

describe('KnowledgeGraphManager', () => {
  let manager: KnowledgeGraphManager;
  let testFilePath: string;

  beforeEach(async () => {
    // Create a temporary test file path
    testFilePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      `test-memory-${Date.now()}.jsonl`
    );
    manager = new KnowledgeGraphManager(testFilePath);
  });

  afterEach(async () => {
    // Clean up test file
    try {
      await fs.unlink(testFilePath);
    } catch (error) {
      // Ignore errors if file doesn't exist
    }
  });

  // Helper to build Entity with Observation objects for tests
  function makeEntity(name: string, entityType: string, contents: string[], tags?: string[]): Entity {
    return {
      name,
      entityType,
      observations: contents.map(c => ({ content: c, timestamp: new Date().toISOString() })),
      ...(tags ? { tags } : {}),
    };
  }

  describe('createEntities', () => {
    it('should create new entities with Observation objects', async () => {
      const entities: Entity[] = [
        makeEntity('Alice', 'person', ['works at Acme Corp']),
        makeEntity('Bob', 'person', ['likes programming']),
      ];

      const newEntities = await manager.createEntities(entities);
      expect(newEntities).toHaveLength(2);
      expect(newEntities[0].name).toBe('Alice');
      expect(newEntities[1].name).toBe('Bob');
      expect(newEntities[0].observations[0].content).toBe('works at Acme Corp');

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(2);
    });

    it('should stamp createdAt, createdBy, lastModifiedAt on new entities', async () => {
      const entities: Entity[] = [makeEntity('Alice', 'person', [])];
      const before = Date.now();
      const newEntities = await manager.createEntities(entities);
      const after = Date.now();

      expect(newEntities[0].createdAt).toBeDefined();
      expect(newEntities[0].createdBy).toBeDefined();
      expect(newEntities[0].lastModifiedAt).toBeDefined();

      const createdAt = new Date(newEntities[0].createdAt!).getTime();
      expect(createdAt).toBeGreaterThanOrEqual(before);
      expect(createdAt).toBeLessThanOrEqual(after);
    });

    it('should use AGENT_NAME env var for createdBy', async () => {
      const originalAgentName = process.env.AGENT_NAME;
      process.env.AGENT_NAME = 'TestAgent';
      try {
        const entities: Entity[] = [makeEntity('Alice', 'person', [])];
        const newEntities = await manager.createEntities(entities);
        expect(newEntities[0].createdBy).toBe('TestAgent');
      } finally {
        if (originalAgentName !== undefined) {
          process.env.AGENT_NAME = originalAgentName;
        } else {
          delete process.env.AGENT_NAME;
        }
      }
    });

    it('should default createdBy to "unknown" when AGENT_NAME not set', async () => {
      const originalAgentName = process.env.AGENT_NAME;
      delete process.env.AGENT_NAME;
      try {
        const entities: Entity[] = [makeEntity('Alice', 'person', [])];
        const newEntities = await manager.createEntities(entities);
        expect(newEntities[0].createdBy).toBe('unknown');
      } finally {
        if (originalAgentName !== undefined) {
          process.env.AGENT_NAME = originalAgentName;
        }
      }
    });

    it('should preserve tags on entities', async () => {
      const entities: Entity[] = [makeEntity('Ruru', 'agent', [], ['advisor', 'lead'])];
      const newEntities = await manager.createEntities(entities);
      expect(newEntities[0].tags).toEqual(['advisor', 'lead']);
    });

    it('should not create duplicate entities', async () => {
      const entities: Entity[] = [makeEntity('Alice', 'person', ['works at Acme Corp'])];

      await manager.createEntities(entities);
      const newEntities = await manager.createEntities(entities);

      expect(newEntities).toHaveLength(0);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(1);
    });

    it('should handle empty entity arrays', async () => {
      const newEntities = await manager.createEntities([]);
      expect(newEntities).toHaveLength(0);
    });
  });

  describe('createRelations', () => {
    it('should create new relations with metadata', async () => {
      await manager.createEntities([
        makeEntity('Alice', 'person', []),
        makeEntity('Bob', 'person', []),
      ]);

      const relations: Relation[] = [
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
      ];

      const before = Date.now();
      const newRelations = await manager.createRelations(relations);
      const after = Date.now();

      expect(newRelations).toHaveLength(1);
      expect(newRelations[0].from).toBe('Alice');
      expect(newRelations[0].to).toBe('Bob');
      expect(newRelations[0].relationType).toBe('knows');
      expect(newRelations[0].createdAt).toBeDefined();
      expect(newRelations[0].createdBy).toBeDefined();

      const createdAt = new Date(newRelations[0].createdAt!).getTime();
      expect(createdAt).toBeGreaterThanOrEqual(before);
      expect(createdAt).toBeLessThanOrEqual(after);

      const graph = await manager.readGraph();
      expect(graph.relations).toHaveLength(1);
    });

    it('should not create duplicate relations', async () => {
      await manager.createEntities([
        makeEntity('Alice', 'person', []),
        makeEntity('Bob', 'person', []),
      ]);

      const relations: Relation[] = [
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
      ];

      await manager.createRelations(relations);
      const newRelations = await manager.createRelations(relations);

      expect(newRelations).toHaveLength(0);

      const graph = await manager.readGraph();
      expect(graph.relations).toHaveLength(1);
    });

    it('should handle empty relation arrays', async () => {
      const newRelations = await manager.createRelations([]);
      expect(newRelations).toHaveLength(0);
    });
  });

  describe('addObservations', () => {
    it('should add string observations with auto-timestamp', async () => {
      await manager.createEntities([makeEntity('Alice', 'person', ['works at Acme Corp'])]);

      const before = Date.now();
      const results = await manager.addObservations([
        { entityName: 'Alice', contents: ['likes coffee', 'has a dog'] },
      ]);
      const after = Date.now();

      expect(results).toHaveLength(1);
      expect(results[0].entityName).toBe('Alice');
      expect(results[0].addedObservations).toHaveLength(2);
      expect(results[0].addedObservations[0].content).toBe('likes coffee');
      expect(results[0].addedObservations[1].content).toBe('has a dog');

      // Auto-timestamps should be set
      for (const obs of results[0].addedObservations) {
        expect(obs.timestamp).not.toBeNull();
        const ts = new Date(obs.timestamp!).getTime();
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(after);
      }

      const graph = await manager.readGraph();
      const alice = graph.entities.find(e => e.name === 'Alice');
      expect(alice?.observations).toHaveLength(3);
    });

    it('should add observations with explicit timestamps', async () => {
      await manager.createEntities([makeEntity('Alice', 'person', [])]);

      const explicitTs = '2026-04-01T09:53:00.000Z';
      const results = await manager.addObservations([
        { entityName: 'Alice', contents: [{ content: 'Status: APPROVED', timestamp: explicitTs }] },
      ]);

      expect(results[0].addedObservations[0].content).toBe('Status: APPROVED');
      expect(results[0].addedObservations[0].timestamp).toBe(explicitTs);
    });

    it('should update lastModifiedAt on entity when observations are added', async () => {
      await manager.createEntities([makeEntity('Alice', 'person', [])]);

      const before = Date.now();
      await manager.addObservations([
        { entityName: 'Alice', contents: ['new obs'] },
      ]);
      const after = Date.now();

      const graph = await manager.readGraph();
      const alice = graph.entities.find(e => e.name === 'Alice');
      expect(alice?.lastModifiedAt).toBeDefined();
      const ts = new Date(alice!.lastModifiedAt!).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('should not add duplicate observations (by content)', async () => {
      await manager.createEntities([makeEntity('Alice', 'person', ['works at Acme Corp'])]);

      await manager.addObservations([
        { entityName: 'Alice', contents: ['likes coffee'] },
      ]);

      const results = await manager.addObservations([
        { entityName: 'Alice', contents: ['likes coffee', 'has a dog'] },
      ]);

      expect(results[0].addedObservations).toHaveLength(1);
      expect(results[0].addedObservations[0].content).toBe('has a dog');

      const graph = await manager.readGraph();
      const alice = graph.entities.find(e => e.name === 'Alice');
      expect(alice?.observations).toHaveLength(3);
    });

    it('should throw error for non-existent entity', async () => {
      await expect(
        manager.addObservations([
          { entityName: 'NonExistent', contents: ['some observation'] },
        ])
      ).rejects.toThrow('Entity with name NonExistent not found');
    });
  });

  describe('deleteEntities', () => {
    it('should delete entities', async () => {
      await manager.createEntities([
        makeEntity('Alice', 'person', []),
        makeEntity('Bob', 'person', []),
      ]);

      await manager.deleteEntities(['Alice']);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(1);
      expect(graph.entities[0].name).toBe('Bob');
    });

    it('should cascade delete relations when deleting entities', async () => {
      await manager.createEntities([
        makeEntity('Alice', 'person', []),
        makeEntity('Bob', 'person', []),
        makeEntity('Charlie', 'person', []),
      ]);

      await manager.createRelations([
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
        { from: 'Bob', to: 'Charlie', relationType: 'knows' },
      ]);

      await manager.deleteEntities(['Bob']);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(2);
      expect(graph.relations).toHaveLength(0);
    });

    it('should handle deleting non-existent entities', async () => {
      await manager.deleteEntities(['NonExistent']);
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(0);
    });
  });

  describe('deleteObservations', () => {
    it('should delete observations by content string', async () => {
      await manager.createEntities([
        makeEntity('Alice', 'person', ['works at Acme Corp', 'likes coffee']),
      ]);

      await manager.deleteObservations([
        { entityName: 'Alice', observations: ['likes coffee'] },
      ]);

      const graph = await manager.readGraph();
      const alice = graph.entities.find(e => e.name === 'Alice');
      expect(alice?.observations).toHaveLength(1);
      expect(alice?.observations[0].content).toBe('works at Acme Corp');
    });

    it('should update lastModifiedAt when observations are deleted', async () => {
      await manager.createEntities([
        makeEntity('Alice', 'person', ['likes coffee']),
      ]);

      const before = Date.now();
      await manager.deleteObservations([
        { entityName: 'Alice', observations: ['likes coffee'] },
      ]);
      const after = Date.now();

      const graph = await manager.readGraph();
      const alice = graph.entities.find(e => e.name === 'Alice');
      expect(alice?.lastModifiedAt).toBeDefined();
      const ts = new Date(alice!.lastModifiedAt!).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('should handle deleting from non-existent entities', async () => {
      await manager.deleteObservations([
        { entityName: 'NonExistent', observations: ['some observation'] },
      ]);
      // Should not throw error
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(0);
    });
  });

  describe('deleteRelations', () => {
    it('should delete specific relations', async () => {
      await manager.createEntities([
        makeEntity('Alice', 'person', []),
        makeEntity('Bob', 'person', []),
      ]);

      await manager.createRelations([
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
        { from: 'Alice', to: 'Bob', relationType: 'works_with' },
      ]);

      await manager.deleteRelations([
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
      ]);

      const graph = await manager.readGraph();
      expect(graph.relations).toHaveLength(1);
      expect(graph.relations[0].relationType).toBe('works_with');
    });
  });

  describe('readGraph', () => {
    it('should return empty graph when file does not exist', async () => {
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(0);
      expect(graph.relations).toHaveLength(0);
    });

    it('should return complete graph with entities and relations', async () => {
      await manager.createEntities([makeEntity('Alice', 'person', ['works at Acme Corp'])]);
      await manager.createRelations([{ from: 'Alice', to: 'Alice', relationType: 'self' }]);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(1);
      expect(graph.relations).toHaveLength(1);
    });
  });

  describe('searchNodes', () => {
    beforeEach(async () => {
      await manager.createEntities([
        makeEntity('Alice', 'person', ['works at Acme Corp', 'likes programming']),
        makeEntity('Bob', 'person', ['works at TechCo']),
        makeEntity('Acme Corp', 'company', ['tech company']),
      ]);

      await manager.createRelations([
        { from: 'Alice', to: 'Acme Corp', relationType: 'works_at' },
        { from: 'Bob', to: 'Acme Corp', relationType: 'competitor' },
      ]);
    });

    it('should search by entity name', async () => {
      const result = await manager.searchNodes('Alice');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Alice');
    });

    it('should search by entity type', async () => {
      const result = await manager.searchNodes('company');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Acme Corp');
    });

    it('should search by observation content', async () => {
      const result = await manager.searchNodes('programming');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Alice');
    });

    it('should be case insensitive', async () => {
      const result = await manager.searchNodes('ALICE');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Alice');
    });

    it('should include relations where at least one endpoint matches', async () => {
      const result = await manager.searchNodes('Acme');
      expect(result.entities).toHaveLength(2); // Alice and Acme Corp
      expect(result.relations).toHaveLength(2);
    });

    it('should include outgoing relations to unmatched entities', async () => {
      const result = await manager.searchNodes('Alice');
      expect(result.entities).toHaveLength(1);
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].from).toBe('Alice');
      expect(result.relations[0].to).toBe('Acme Corp');
    });

    it('should return empty graph for no matches', async () => {
      const result = await manager.searchNodes('NonExistent');
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });

    it('should filter by entityType when provided', async () => {
      // "works" appears in both Alice and Bob observations, but only company type matches company filter
      const result = await manager.searchNodes('works', 'company');
      // "Acme Corp" is type company, but its observations say "tech company" not "works"
      // Alice and Bob are type person; they wouldn't match company filter
      expect(result.entities).toHaveLength(0);
    });

    it('should filter by entityType - person type', async () => {
      const result = await manager.searchNodes('Alice', 'person');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Alice');
    });

    it('should filter by entityType - excludes wrong type', async () => {
      // Alice matches query "Alice" but entityType filter is "company", so excluded
      const result = await manager.searchNodes('Alice', 'company');
      expect(result.entities).toHaveLength(0);
    });
  });

  describe('searchByType', () => {
    beforeEach(async () => {
      await manager.createEntities([
        makeEntity('Alice', 'person', ['works at Acme Corp']),
        makeEntity('Bob', 'person', ['works at TechCo']),
        makeEntity('Acme Corp', 'company', ['tech company']),
        makeEntity('ADL-009', 'decision', ['Status: APPROVED']),
      ]);
      await manager.createRelations([
        { from: 'Alice', to: 'Acme Corp', relationType: 'works_at' },
      ]);
    });

    it('should return all entities of a given type', async () => {
      const result = await manager.searchByType('person');
      expect(result.entities).toHaveLength(2);
      expect(result.entities.map(e => e.name)).toContain('Alice');
      expect(result.entities.map(e => e.name)).toContain('Bob');
    });

    it('should return empty graph for unknown type', async () => {
      const result = await manager.searchByType('nonexistent_type');
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });

    it('should filter by query within type', async () => {
      const result = await manager.searchByType('person', 'Acme');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Alice');
    });

    it('should filter by query against entity name', async () => {
      const result = await manager.searchByType('person', 'Bob');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Bob');
    });

    it('should include relations connected to matched entities', async () => {
      const result = await manager.searchByType('person', 'Acme');
      // Alice matched; Alice → Acme Corp relation is included
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].from).toBe('Alice');
    });

    it('should return all entities of type without query', async () => {
      const result = await manager.searchByType('company');
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Acme Corp');
    });
  });

  describe('searchByTime', () => {
    const ts1 = '2026-01-01T00:00:00.000Z';
    const ts2 = '2026-02-01T00:00:00.000Z';
    const ts3 = '2026-03-01T00:00:00.000Z';

    beforeEach(async () => {
      // Create entities with explicit timestamps
      await manager.createEntities([
        {
          name: 'Alice',
          entityType: 'person',
          observations: [
            { content: 'early observation', timestamp: ts1 },
            { content: 'later observation', timestamp: ts3 },
          ],
        },
        {
          name: 'Bob',
          entityType: 'person',
          observations: [
            { content: 'mid observation', timestamp: ts2 },
          ],
        },
        {
          name: 'LegacyEntity',
          entityType: 'system',
          observations: [
            { content: 'no timestamp', timestamp: null },
          ],
        },
      ]);
    });

    it('should find entities with observations after a timestamp', async () => {
      const result = await manager.searchByTime('2026-01-15T00:00:00.000Z');
      // Alice has ts3 (after cutoff), Bob has ts2 (after cutoff)
      const names = result.entities.map(e => e.name);
      expect(names).toContain('Alice');
      expect(names).toContain('Bob');
      expect(names).not.toContain('LegacyEntity');
    });

    it('should find entities with observations before a timestamp', async () => {
      const result = await manager.searchByTime(undefined, '2026-01-15T00:00:00.000Z');
      // Alice has ts1 (before cutoff)
      const names = result.entities.map(e => e.name);
      expect(names).toContain('Alice');
      expect(names).not.toContain('Bob');
      expect(names).not.toContain('LegacyEntity');
    });

    it('should find entities within a time range', async () => {
      const result = await manager.searchByTime('2026-01-15T00:00:00.000Z', '2026-02-15T00:00:00.000Z');
      // Only Bob has ts2 within [jan15, feb15]
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Bob');
    });

    it('should filter by entityType within time range', async () => {
      const result = await manager.searchByTime('2026-01-01T00:00:00.000Z', undefined, 'person');
      const names = result.entities.map(e => e.name);
      expect(names).toContain('Alice');
      expect(names).toContain('Bob');
      // LegacyEntity is 'system' type so excluded
      expect(names).not.toContain('LegacyEntity');
    });

    it('should exclude entities with only null timestamps', async () => {
      const result = await manager.searchByTime('2020-01-01T00:00:00.000Z');
      const names = result.entities.map(e => e.name);
      expect(names).not.toContain('LegacyEntity');
    });

    it('should return empty graph when no observations match', async () => {
      const result = await manager.searchByTime('2030-01-01T00:00:00.000Z');
      expect(result.entities).toHaveLength(0);
    });
  });

  describe('getRelationsOf', () => {
    beforeEach(async () => {
      await manager.createEntities([
        makeEntity('Alice', 'person', []),
        makeEntity('Bob', 'person', []),
        makeEntity('Charlie', 'person', []),
      ]);

      await manager.createRelations([
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
        { from: 'Alice', to: 'Charlie', relationType: 'manages' },
        { from: 'Bob', to: 'Alice', relationType: 'reports_to' },
      ]);
    });

    it('should return all outgoing and incoming relations', async () => {
      const result = await manager.getRelationsOf('Alice');
      expect(result.outgoing).toHaveLength(2);
      expect(result.incoming).toHaveLength(1);
      expect(result.outgoing.some(r => r.to === 'Bob' && r.relationType === 'knows')).toBe(true);
      expect(result.outgoing.some(r => r.to === 'Charlie' && r.relationType === 'manages')).toBe(true);
      expect(result.incoming[0].from).toBe('Bob');
    });

    it('should filter by relationType', async () => {
      const result = await manager.getRelationsOf('Alice', 'knows');
      expect(result.outgoing).toHaveLength(1);
      expect(result.outgoing[0].to).toBe('Bob');
      expect(result.incoming).toHaveLength(0);
    });

    it('should return empty arrays for entity with no relations', async () => {
      await manager.createEntities([makeEntity('Loner', 'person', [])]);
      const result = await manager.getRelationsOf('Loner');
      expect(result.outgoing).toHaveLength(0);
      expect(result.incoming).toHaveLength(0);
    });

    it('should return empty arrays for non-existent entity', async () => {
      const result = await manager.getRelationsOf('NonExistent');
      expect(result.outgoing).toHaveLength(0);
      expect(result.incoming).toHaveLength(0);
    });

    it('should filter incoming by relationType', async () => {
      const result = await manager.getRelationsOf('Alice', 'reports_to');
      expect(result.outgoing).toHaveLength(0);
      expect(result.incoming).toHaveLength(1);
      expect(result.incoming[0].from).toBe('Bob');
    });
  });

  describe('openNodes', () => {
    beforeEach(async () => {
      await manager.createEntities([
        makeEntity('Alice', 'person', []),
        makeEntity('Bob', 'person', []),
        makeEntity('Charlie', 'person', []),
      ]);

      await manager.createRelations([
        { from: 'Alice', to: 'Bob', relationType: 'knows' },
        { from: 'Bob', to: 'Charlie', relationType: 'knows' },
      ]);
    });

    it('should open specific nodes by name', async () => {
      const result = await manager.openNodes(['Alice', 'Bob']);
      expect(result.entities).toHaveLength(2);
      expect(result.entities.map(e => e.name)).toContain('Alice');
      expect(result.entities.map(e => e.name)).toContain('Bob');
    });

    it('should include all relations connected to opened nodes', async () => {
      const result = await manager.openNodes(['Alice', 'Bob']);
      // Alice → Bob (both opened) and Bob → Charlie (Bob is opened)
      expect(result.relations).toHaveLength(2);
      expect(result.relations.some(r => r.from === 'Alice' && r.to === 'Bob')).toBe(true);
      expect(result.relations.some(r => r.from === 'Bob' && r.to === 'Charlie')).toBe(true);
    });

    it('should include relations connected to opened nodes', async () => {
      const result = await manager.openNodes(['Bob']);
      // Bob has two relations: Alice → Bob and Bob → Charlie
      expect(result.relations).toHaveLength(2);
      expect(result.relations.some(r => r.from === 'Alice' && r.to === 'Bob')).toBe(true);
      expect(result.relations.some(r => r.from === 'Bob' && r.to === 'Charlie')).toBe(true);
    });

    it('should include outgoing relations to nodes not in the open set', async () => {
      const result = await manager.openNodes(['Alice']);
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe('Alice');
      // Alice → Bob relation is included because Alice is opened
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].from).toBe('Alice');
      expect(result.relations[0].to).toBe('Bob');
    });

    it('should include incoming relations from nodes not in the open set', async () => {
      const result = await manager.openNodes(['Charlie']);
      expect(result.entities).toHaveLength(1);
      // Bob → Charlie relation is included because Charlie is opened
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].from).toBe('Bob');
      expect(result.relations[0].to).toBe('Charlie');
    });

    it('should handle opening non-existent nodes', async () => {
      const result = await manager.openNodes(['NonExistent']);
      expect(result.entities).toHaveLength(0);
    });

    it('should handle empty node list', async () => {
      const result = await manager.openNodes([]);
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });
  });

  describe('backward compatibility: string observations', () => {
    it('should load legacy string observations as {content, timestamp: null}', async () => {
      // Write a legacy JSONL file with string observations
      const legacyLine = JSON.stringify({
        type: 'entity',
        name: 'LegacyEntity',
        entityType: 'system',
        observations: ['old string observation', 'another old one'],
      });
      await fs.writeFile(testFilePath, legacyLine);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(1);
      expect(graph.entities[0].observations).toHaveLength(2);
      expect(graph.entities[0].observations[0]).toEqual({ content: 'old string observation', timestamp: null });
      expect(graph.entities[0].observations[1]).toEqual({ content: 'another old one', timestamp: null });
    });

    it('should handle mix of string and object observations in file', async () => {
      const mixedLine = JSON.stringify({
        type: 'entity',
        name: 'Mixed',
        entityType: 'system',
        observations: [
          'legacy string',
          { content: 'new format', timestamp: '2026-04-01T00:00:00.000Z' },
        ],
      });
      await fs.writeFile(testFilePath, mixedLine);

      const graph = await manager.readGraph();
      expect(graph.entities[0].observations[0]).toEqual({ content: 'legacy string', timestamp: null });
      expect(graph.entities[0].observations[1]).toEqual({ content: 'new format', timestamp: '2026-04-01T00:00:00.000Z' });
    });

    it('should save migrated entities in new object format', async () => {
      // Write legacy file
      const legacyLine = JSON.stringify({
        type: 'entity',
        name: 'LegacyEntity',
        entityType: 'system',
        observations: ['old string observation'],
      });
      await fs.writeFile(testFilePath, legacyLine);

      // Load and re-save by adding an observation
      await manager.addObservations([{ entityName: 'LegacyEntity', contents: ['new obs'] }]);

      // Read raw file to verify format
      const fileContent = await fs.readFile(testFilePath, 'utf-8');
      const parsed = JSON.parse(fileContent.trim().split('\n')[0]);
      // All observations should now be in object format
      expect(typeof parsed.observations[0]).toBe('object');
      expect(parsed.observations[0]).toHaveProperty('content', 'old string observation');
      expect(parsed.observations[0]).toHaveProperty('timestamp', null);
    });

    it('should load legacy relations without metadata', async () => {
      const legacyLines = [
        JSON.stringify({ type: 'entity', name: 'A', entityType: 'person', observations: [] }),
        JSON.stringify({ type: 'entity', name: 'B', entityType: 'person', observations: [] }),
        JSON.stringify({ type: 'relation', from: 'A', to: 'B', relationType: 'knows' }),
      ].join('\n');
      await fs.writeFile(testFilePath, legacyLines);

      const graph = await manager.readGraph();
      expect(graph.relations).toHaveLength(1);
      expect(graph.relations[0].from).toBe('A');
      expect(graph.relations[0].to).toBe('B');
      // Legacy relations have no metadata - should be undefined
      expect(graph.relations[0].createdAt).toBeUndefined();
      expect(graph.relations[0].createdBy).toBeUndefined();
    });
  });

  describe('file persistence', () => {
    it('should persist data across manager instances', async () => {
      await manager.createEntities([makeEntity('Alice', 'person', ['persistent data'])]);

      // Create new manager instance with same file path
      const manager2 = new KnowledgeGraphManager(testFilePath);
      const graph = await manager2.readGraph();

      expect(graph.entities).toHaveLength(1);
      expect(graph.entities[0].name).toBe('Alice');
      expect(graph.entities[0].observations[0].content).toBe('persistent data');
    });

    it('should persist metadata across manager instances', async () => {
      process.env.AGENT_NAME = 'PersistTestAgent';
      try {
        await manager.createEntities([makeEntity('Alice', 'person', [])]);
      } finally {
        delete process.env.AGENT_NAME;
      }

      const manager2 = new KnowledgeGraphManager(testFilePath);
      const graph = await manager2.readGraph();

      expect(graph.entities[0].createdBy).toBe('PersistTestAgent');
      expect(graph.entities[0].createdAt).toBeDefined();
    });

    it('should handle JSONL format correctly', async () => {
      await manager.createEntities([makeEntity('Alice', 'person', [])]);
      await manager.createRelations([{ from: 'Alice', to: 'Alice', relationType: 'self' }]);

      // Read file directly
      const fileContent = await fs.readFile(testFilePath, 'utf-8');
      const lines = fileContent.split('\n').filter(line => line.trim());

      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toHaveProperty('type', 'entity');
      expect(JSON.parse(lines[1])).toHaveProperty('type', 'relation');
    });

    it('should strip type field from entities when loading from file', async () => {
      await manager.createEntities([
        makeEntity('Alice', 'person', ['test observation']),
        makeEntity('Bob', 'person', []),
      ]);
      await manager.createRelations([{ from: 'Alice', to: 'Bob', relationType: 'knows' }]);

      // Create new manager instance to force reload from file
      const manager2 = new KnowledgeGraphManager(testFilePath);
      const graph = await manager2.readGraph();

      // Verify loaded entities don't have type field
      expect(graph.entities).toHaveLength(2);
      graph.entities.forEach(entity => {
        expect(entity).not.toHaveProperty('type');
        expect(entity).toHaveProperty('name');
        expect(entity).toHaveProperty('entityType');
        expect(entity).toHaveProperty('observations');
      });

      // Verify loaded relations don't have type field
      expect(graph.relations).toHaveLength(1);
      graph.relations.forEach(relation => {
        expect(relation).not.toHaveProperty('type');
        expect(relation).toHaveProperty('from');
        expect(relation).toHaveProperty('to');
        expect(relation).toHaveProperty('relationType');
      });
    });

    it('should strip type field from searchNodes results', async () => {
      await manager.createEntities([makeEntity('Alice', 'person', ['works at Acme'])]);
      await manager.createRelations([{ from: 'Alice', to: 'Alice', relationType: 'self' }]);

      const manager2 = new KnowledgeGraphManager(testFilePath);
      const result = await manager2.searchNodes('Alice');

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).not.toHaveProperty('type');
      expect(result.entities[0].name).toBe('Alice');

      expect(result.relations).toHaveLength(1);
      expect(result.relations[0]).not.toHaveProperty('type');
      expect(result.relations[0].from).toBe('Alice');
    });

    it('should strip type field from openNodes results', async () => {
      await manager.createEntities([
        makeEntity('Alice', 'person', []),
        makeEntity('Bob', 'person', []),
      ]);
      await manager.createRelations([{ from: 'Alice', to: 'Bob', relationType: 'knows' }]);

      const manager2 = new KnowledgeGraphManager(testFilePath);
      const result = await manager2.openNodes(['Alice', 'Bob']);

      expect(result.entities).toHaveLength(2);
      result.entities.forEach(entity => {
        expect(entity).not.toHaveProperty('type');
      });

      expect(result.relations).toHaveLength(1);
      expect(result.relations[0]).not.toHaveProperty('type');
    });
  });
});

describe('normalizeObservationInput', () => {
  it('should convert string to Observation with auto-timestamp', () => {
    const before = Date.now();
    const result = normalizeObservationInput('hello world');
    const after = Date.now();

    expect(result.content).toBe('hello world');
    expect(result.timestamp).not.toBeNull();
    const ts = new Date(result.timestamp!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('should convert object with content to Observation with auto-timestamp when no timestamp provided', () => {
    const result = normalizeObservationInput({ content: 'hello' });
    expect(result.content).toBe('hello');
    expect(result.timestamp).not.toBeNull();
  });

  it('should preserve explicit timestamp', () => {
    const ts = '2026-04-01T09:53:00.000Z';
    const result = normalizeObservationInput({ content: 'hello', timestamp: ts });
    expect(result.content).toBe('hello');
    expect(result.timestamp).toBe(ts);
  });
});
