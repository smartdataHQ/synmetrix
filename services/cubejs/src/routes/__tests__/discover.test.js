import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractCubes,
  buildDiscoverResponse,
  resolvePartitionTeamIds,
} from "../discover.js";

// --- Helpers ---

function yamlSchema(name, cubes) {
  const lines = cubes.map((c) => {
    let entry = `  - name: ${c.name}\n    sql_table: test.${c.name}`;
    if (c.description) {
      entry = `  - name: ${c.name}\n    description: "${c.description}"\n    sql_table: test.${c.name}`;
    }
    return entry;
  });
  return { name, code: `cubes:\n${lines.join("\n")}\n` };
}

function jsCubeSchema(name, cubeName, description) {
  const descLine = description
    ? `\n  description: ${JSON.stringify(description)},`
    : "";
  return {
    name,
    code: `cube(\`${cubeName}\`, {${descLine}\n  sql_table: \`test.${cubeName}\`,\n  dimensions: {},\n  measures: {},\n});\n`,
  };
}

function makeDatasource(id, name, schemas, opts = {}) {
  return {
    id,
    name,
    db_type: opts.db_type || "clickhouse",
    team_id: opts.team_id || "team-1",
    branches: [
      {
        id: opts.branch_id || "branch-1",
        status: "active",
        versions: [
          {
            id: opts.version_id || "version-1",
            dataschemas: schemas,
          },
        ],
      },
    ],
  };
}

// --- extractCubes ---

describe("extractCubes", () => {
  it("extracts cubes from YAML with descriptions", () => {
    const schema = yamlSchema("orders.yml", [
      { name: "Orders", description: "All orders" },
      { name: "OrderItems" },
    ]);
    const cubes = extractCubes(schema);
    assert.equal(cubes.length, 2);
    assert.deepEqual(cubes[0], { name: "Orders", description: "All orders" });
    assert.deepEqual(cubes[1], { name: "OrderItems", description: null });
  });

  it("extracts cubes from JS model files", () => {
    const schema = jsCubeSchema("users.js", "Users", "User accounts");
    const cubes = extractCubes(schema);
    assert.equal(cubes.length, 1);
    assert.deepEqual(cubes[0], {
      name: "Users",
      description: "User accounts",
    });
  });

  it("returns empty array for malformed YAML", () => {
    const schema = { name: "bad.yml", code: "{{invalid yaml" };
    const cubes = extractCubes(schema);
    assert.deepEqual(cubes, []);
  });

  it("returns empty array for unparseable JS", () => {
    const schema = { name: "bad.js", code: "this is not valid cube js" };
    const cubes = extractCubes(schema);
    assert.deepEqual(cubes, []);
  });

  it("returns empty array when YAML has no cubes key", () => {
    const schema = { name: "empty.yml", code: "views:\n  - name: v1\n" };
    const cubes = extractCubes(schema);
    assert.deepEqual(cubes, []);
  });

  it("handles .yaml extension", () => {
    const schema = yamlSchema("model.yaml", [{ name: "Events" }]);
    const cubes = extractCubes(schema);
    assert.equal(cubes.length, 1);
    assert.equal(cubes[0].name, "Events");
  });

  it("handles schema with no name (defaults to JS path)", () => {
    // No .yml/.yaml extension → treated as JS
    const schema = { name: "", code: "not parseable" };
    const cubes = extractCubes(schema);
    assert.deepEqual(cubes, []);
  });
});

// --- buildDiscoverResponse ---

describe("buildDiscoverResponse", () => {
  it("returns datasources with cubes, IDs, and metadata", () => {
    const dataSources = [
      makeDatasource("ds-1", "analytics", [
        yamlSchema("cubes.yml", [
          { name: "Orders", description: "Order data" },
        ]),
      ]),
    ];

    const result = buildDiscoverResponse(dataSources);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "ds-1");
    assert.equal(result[0].name, "analytics");
    assert.equal(result[0].db_type, "clickhouse");
    assert.equal(result[0].team_id, "team-1");
    assert.equal(result[0].branch_id, "branch-1");
    assert.equal(result[0].version_id, "version-1");
    assert.equal(result[0].cubes.length, 1);
    assert.deepEqual(result[0].cubes[0], {
      name: "Orders",
      description: "Order data",
    });
  });

  it("selects the active branch over draft branches", () => {
    const ds = {
      id: "ds-x",
      name: "multi-branch",
      db_type: "clickhouse",
      team_id: "team-1",
      branches: [
        {
          id: "draft-branch",
          status: "draft",
          versions: [
            {
              id: "v-draft",
              dataschemas: [yamlSchema("draft.yml", [{ name: "DraftCube" }])],
            },
          ],
        },
        {
          id: "active-branch",
          status: "active",
          versions: [
            {
              id: "v-active",
              dataschemas: [
                yamlSchema("live.yml", [
                  { name: "LiveCube", description: "Production" },
                ]),
              ],
            },
          ],
        },
      ],
    };

    const result = buildDiscoverResponse([ds]);
    assert.equal(result[0].branch_id, "active-branch");
    assert.equal(result[0].version_id, "v-active");
    assert.equal(result[0].cubes[0].name, "LiveCube");
  });

  it("aggregates cubes across multiple schema files", () => {
    const schemas = [
      yamlSchema("orders.yml", [{ name: "Orders" }]),
      yamlSchema("users.yml", [{ name: "Users" }, { name: "Accounts" }]),
    ];
    const result = buildDiscoverResponse([
      makeDatasource("ds-1", "db", schemas),
    ]);
    assert.equal(result[0].cubes.length, 3);
    assert.deepEqual(
      result[0].cubes.map((c) => c.name),
      ["Orders", "Users", "Accounts"]
    );
  });

  it("handles multiple datasources across teams", () => {
    const result = buildDiscoverResponse([
      makeDatasource(
        "ds-a",
        "analytics",
        [yamlSchema("a.yml", [{ name: "Events" }])],
        { team_id: "team-1", branch_id: "br-a", version_id: "v-a" }
      ),
      makeDatasource(
        "ds-b",
        "warehouse",
        [yamlSchema("b.yml", [{ name: "Sales" }])],
        { team_id: "team-2", branch_id: "br-b", version_id: "v-b" }
      ),
    ]);

    assert.equal(result.length, 2);
    assert.equal(result[0].team_id, "team-1");
    assert.equal(result[0].cubes[0].name, "Events");
    assert.equal(result[1].team_id, "team-2");
    assert.equal(result[1].cubes[0].name, "Sales");
  });

  it("returns null IDs when no branches exist", () => {
    const ds = {
      id: "ds-empty",
      name: "no-branches",
      db_type: "postgres",
      team_id: "team-1",
      branches: [],
    };
    const result = buildDiscoverResponse([ds]);
    assert.equal(result[0].branch_id, null);
    assert.equal(result[0].version_id, null);
    assert.deepEqual(result[0].cubes, []);
  });

  it("returns null version_id when branch has no versions", () => {
    const ds = {
      id: "ds-noversion",
      name: "empty-branch",
      db_type: "postgres",
      team_id: "team-1",
      branches: [{ id: "br-1", status: "active", versions: [] }],
    };
    const result = buildDiscoverResponse([ds]);
    assert.equal(result[0].branch_id, "br-1");
    assert.equal(result[0].version_id, null);
    assert.deepEqual(result[0].cubes, []);
  });

  it("filters datasources by partition team IDs", () => {
    const dataSources = [
      makeDatasource("ds-a", "match", [yamlSchema("a.yml", [{ name: "A" }])], {
        team_id: "team-1",
      }),
      makeDatasource("ds-b", "other", [yamlSchema("b.yml", [{ name: "B" }])], {
        team_id: "team-2",
      }),
    ];
    const partitionTeamIds = new Set(["team-1"]);
    const result = buildDiscoverResponse(dataSources, partitionTeamIds);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "ds-a");
  });

  it("returns all datasources when no partitionTeamIds provided", () => {
    const dataSources = [
      makeDatasource("ds-a", "a", [], { team_id: "team-1" }),
      makeDatasource("ds-b", "b", [], { team_id: "team-2" }),
    ];
    const result = buildDiscoverResponse(dataSources, null);
    assert.equal(result.length, 2);
  });
});

// --- resolvePartitionTeamIds ---

describe("resolvePartitionTeamIds", () => {
  it("returns team IDs matching the partition", () => {
    const members = [
      { team_id: "t1", team: { settings: { partition: "blue.is" } } },
      { team_id: "t2", team: { settings: { partition: "other.co" } } },
      { team_id: "t3", team: { settings: { partition: "blue.is" } } },
    ];
    const ids = resolvePartitionTeamIds(members, "blue.is");
    assert.equal(ids.size, 2);
    assert.ok(ids.has("t1"));
    assert.ok(ids.has("t3"));
    assert.ok(!ids.has("t2"));
  });

  it("returns null when no partition in token", () => {
    const members = [
      { team_id: "t1", team: { settings: { partition: "blue.is" } } },
    ];
    assert.equal(resolvePartitionTeamIds(members, undefined), null);
    assert.equal(resolvePartitionTeamIds(members, null), null);
  });

  it("returns empty set when no teams match", () => {
    const members = [
      { team_id: "t1", team: { settings: { partition: "other.co" } } },
    ];
    const ids = resolvePartitionTeamIds(members, "blue.is");
    assert.equal(ids.size, 0);
  });

  it("handles teams with no settings", () => {
    const members = [
      { team_id: "t1", team: { settings: null } },
      { team_id: "t2", team: {} },
      { team_id: "t3" },
    ];
    const ids = resolvePartitionTeamIds(members, "blue.is");
    assert.equal(ids.size, 0);
  });
});
