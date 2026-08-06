-- Catalog seed: system query primitives for workflow/meta-workflow authoring.
-- Apply after creating the queries table:
--   sqlite3 data.db < Engine/schema/queries-table.sql
--   sqlite3 data.db < Engine/schema/queries-seed-system.sql
--
-- Notes:
-- - Rows are inserted with INSERT OR IGNORE, so re-running is safe.
-- - cypher/sqlite/parameters are stubbed as valid empty JSON arrays by default.
-- - A starter set of executable payloads is provided below for:
--   create_step_node, create_step_hop, read_step_node, read_sequencial_chain,
--   update_step_node, delete_step_relationship, core SCHEMA patterns,
--   and core INSTANCE patterns.

INSERT OR IGNORE INTO queries
  (id, name, kind, operation, runtime_enabled, author_selectable, cypher, sqlite, parameters)
VALUES
  ('sys_create_step_node', 'create_step_node', 'system', 'create', 1, 1, '[]', '[]', '[]'),
  ('sys_create_step_hop', 'create_step_hop', 'system', 'create', 1, 1, '[]', '[]', '[]'),
  ('sys_create_instance_node', 'create_instance_node', 'system', 'create', 1, 1, '[]', '[]', '[]'),
  ('sys_create_instance_hop', 'create_instance_hop', 'system', 'create', 1, 1, '[]', '[]', '[]'),
  ('sys_create_schema_node', 'create_schema_node', 'system', 'create', 1, 1, '[]', '[]', '[]'),
  ('sys_create_schema_hop', 'create_schema_hop', 'system', 'create', 1, 1, '[]', '[]', '[]'),
  ('sys_create_schema_property', 'create_schema_property', 'system', 'create', 1, 1, '[]', '[]', '[]'),
  ('sys_read_step_node', 'read_step_node', 'system', 'read', 1, 1, '[]', '[]', '[]'),
  ('sys_read_step_relationship', 'read_step_relationship', 'system', 'read', 1, 1, '[]', '[]', '[]'),
  ('sys_read_sequencial_chain', 'read_sequencial_chain', 'system', 'read', 1, 1, '[]', '[]', '[]'),
  ('sys_read_schema_node', 'read_schema_node', 'system', 'read', 1, 1, '[]', '[]', '[]'),
  ('sys_read_schema_relationship', 'read_schema_relationship', 'system', 'read', 1, 1, '[]', '[]', '[]'),
  ('sys_read_schema_network', 'read_schema_network', 'system', 'read', 1, 1, '[]', '[]', '[]'),
  ('sys_read_instance_node', 'read_instance_node', 'system', 'read', 1, 1, '[]', '[]', '[]'),
  ('sys_read_instance_relationship', 'read_instance_relationship', 'system', 'read', 1, 1, '[]', '[]', '[]'),
  ('sys_read_instance_network', 'read_instance_network', 'system', 'read', 1, 1, '[]', '[]', '[]'),
  ('sys_update_step_node', 'update_step_node', 'system', 'update', 1, 1, '[]', '[]', '[]'),
  ('sys_update_step_relationship', 'update_step_relationship', 'system', 'update', 1, 1, '[]', '[]', '[]'),
  ('sys_update_schema_node', 'update_schema_node', 'system', 'update', 1, 1, '[]', '[]', '[]'),
  ('sys_update_schema_relationship', 'update_schema_relationship', 'system', 'update', 1, 1, '[]', '[]', '[]'),
  ('sys_update_instance_node', 'update_instance_node', 'system', 'update', 1, 1, '[]', '[]', '[]'),
  ('sys_update_instance_relationship', 'update_instance_relationship', 'system', 'update', 1, 1, '[]', '[]', '[]'),
  ('sys_delete_step_node', 'delete_step_node', 'system', 'delete', 1, 1, '[]', '[]', '[]'),
  ('sys_delete_step_relationship', 'delete_step_relationship', 'system', 'delete', 1, 1, '[]', '[]', '[]'),
  ('sys_delete_schema_node', 'delete_schema_node', 'system', 'delete', 1, 1, '[]', '[]', '[]'),
  ('sys_delete_schema_relationship', 'delete_schema_relationship', 'system', 'delete', 1, 1, '[]', '[]', '[]'),
  ('sys_delete_instance_node', 'delete_instance_node', 'system', 'delete', 1, 1, '[]', '[]', '[]'),
  ('sys_delete_instance_relationship', 'delete_instance_relationship', 'system', 'delete', 1, 1, '[]', '[]', '[]');

-- Starter implementation: create_step_node
UPDATE queries
SET
  cypher = '[ "CREATE (n:STEP {id: $id, attributive_label: $attributive_label}) RETURN n" ]',
  sqlite = '[
    "INSERT INTO entities (id, node_label, common_label, payload, creation_date, modified_date) VALUES ($id, ''STEP'', $attributive_label, json_object(''query_id'', $query_id), datetime(''now''), datetime(''now''));"
  ]',
  parameters = '[
    {"name":"id","data_type":"UID","value":""},
    {"name":"attributive_label","data_type":"string","value":""},
    {"name":"query_id","data_type":"string","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_create_step_node';

-- Starter implementation: create_step_hop
UPDATE queries
SET
  cypher = '[
    "MATCH (a:STEP {id: $from_step_id}), (b:STEP {id: $to_step_id}) CREATE (a)-[r:POINTS_TO {id: $relationship_id, attributive_label: $relationship_label, condition_type: $condition_type, condition: $condition}]->(b) RETURN r"
  ]',
  sqlite = '[
    "INSERT INTO entities (id, node_label, common_label, payload, creation_date, modified_date) VALUES ($relationship_id, ''STEP'', $relationship_label, ''{}'', datetime(''now''), datetime(''now''));"
  ]',
  parameters = '[
    {"name":"from_step_id","data_type":"UID","value":""},
    {"name":"to_step_id","data_type":"UID","value":""},
    {"name":"relationship_id","data_type":"UID","value":""},
    {"name":"relationship_label","data_type":"string","value":""},
    {"name":"condition_type","data_type":"string","value":"null"},
    {"name":"condition","data_type":"string","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_create_step_hop';

-- Starter implementation: read_step_node
UPDATE queries
SET
  cypher = '[ "MATCH (n:STEP {id: $id}) RETURN n" ]',
  sqlite = '[]',
  parameters = '[
    {"name":"id","data_type":"UID","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_read_step_node';

-- Starter implementation: read_step_relationship
UPDATE queries
SET
  cypher = '[
    "MATCH ()-[r:POINTS_TO {id: $relationship_id}]-() RETURN r"
  ]',
  sqlite = '[]',
  parameters = '[
    {"name":"relationship_id","data_type":"UID","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_read_step_relationship';

-- Starter implementation: read_sequencial_chain
UPDATE queries
SET
  cypher = '[
    "MATCH p=(root:STEP {id: $root_step_id})-[:POINTS_TO*0..]->(n:STEP) RETURN p LIMIT $limit"
  ]',
  sqlite = '[]',
  parameters = '[
    {"name":"root_step_id","data_type":"UID","value":""},
    {"name":"limit","data_type":"integer","value":100}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_read_sequencial_chain';

-- Starter implementation: update_step_node
UPDATE queries
SET
  cypher = '[
    "MATCH (n:STEP {id: $id}) SET n.attributive_label = $attributive_label RETURN n"
  ]',
  sqlite = '[
    "UPDATE entities SET common_label = $attributive_label, payload = json_object(''query_id'', $query_id), modified_date = datetime(''now'') WHERE id = $id AND node_label = ''STEP'';"
  ]',
  parameters = '[
    {"name":"id","data_type":"UID","value":""},
    {"name":"attributive_label","data_type":"string","value":""},
    {"name":"query_id","data_type":"string","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_update_step_node';

-- Starter implementation: update_step_relationship
UPDATE queries
SET
  cypher = '[
    "MATCH ()-[r:POINTS_TO {id: $relationship_id}]-() SET r.attributive_label = $relationship_label, r.condition_type = $condition_type, r.condition = $condition RETURN r"
  ]',
  sqlite = '[
    "UPDATE entities SET common_label = $relationship_label, payload = json_object(''condition_type'', $condition_type, ''condition'', $condition), modified_date = datetime(''now'') WHERE id = $relationship_id AND node_label = ''STEP'';"
  ]',
  parameters = '[
    {"name":"relationship_id","data_type":"UID","value":""},
    {"name":"relationship_label","data_type":"string","value":""},
    {"name":"condition_type","data_type":"string","value":"null"},
    {"name":"condition","data_type":"string","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_update_step_relationship';

-- Starter implementation: delete_step_node
UPDATE queries
SET
  cypher = '[
    "MATCH (n:STEP {id: $id}) DETACH DELETE n RETURN count(n) AS deleted"
  ]',
  sqlite = '[
    "DELETE FROM entities WHERE id = $id AND node_label = ''STEP'';"
  ]',
  parameters = '[
    {"name":"id","data_type":"UID","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_delete_step_node';

-- Starter implementation: delete_step_relationship
UPDATE queries
SET
  cypher = '[
    "MATCH ()-[r:POINTS_TO {id: $relationship_id}]-() DELETE r RETURN count(r) AS deleted"
  ]',
  sqlite = '[
    "DELETE FROM entities WHERE id = $relationship_id AND node_label = ''STEP'';"
  ]',
  parameters = '[
    {"name":"relationship_id","data_type":"UID","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_delete_step_relationship';

-- Starter implementation: create_schema_node
UPDATE queries
SET
  cypher = '[
    "CREATE (n:SCHEMA {id: $id, attributive_label: $attributive_label}) RETURN n"
  ]',
  sqlite = '[
    "INSERT INTO entities (id, node_label, common_label, payload, creation_date, modified_date) VALUES ($id, ''SCHEMA'', $attributive_label, json_object(''schemata'', json($schemata_json)), datetime(''now''), datetime(''now''));"
  ]',
  parameters = '[
    {"name":"id","data_type":"UID","value":""},
    {"name":"attributive_label","data_type":"string","value":""},
    {"name":"schemata_json","data_type":"string","value":"[]"}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_create_schema_node';

-- Starter implementation: create_schema_hop
UPDATE queries
SET
  cypher = '[
    "MATCH (a:SCHEMA {id: $from_schema_id}), (b:SCHEMA {id: $to_schema_id}) CREATE (a)-[r:POINTS_TO {id: $relationship_id, attributive_label: $relationship_label}]->(b) RETURN r"
  ]',
  sqlite = '[
    "INSERT INTO entities (id, node_label, common_label, payload, creation_date, modified_date) VALUES ($relationship_id, ''SCHEMA'', $relationship_label, json_object(''schemata'', json($schemata_json)), datetime(''now''), datetime(''now''));"
  ]',
  parameters = '[
    {"name":"from_schema_id","data_type":"UID","value":""},
    {"name":"to_schema_id","data_type":"UID","value":""},
    {"name":"relationship_id","data_type":"UID","value":""},
    {"name":"relationship_label","data_type":"string","value":""},
    {"name":"schemata_json","data_type":"string","value":"[]"}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_create_schema_hop';

-- Starter implementation: create_schema_property
UPDATE queries
SET
  cypher = '[
    "MATCH (n:SCHEMA {id: $id}) RETURN n"
  ]',
  sqlite = '[
    "UPDATE entities SET payload = json_object(''schemata'', json($schemata_json)), modified_date = datetime(''now'') WHERE id = $id AND node_label = ''SCHEMA'';"
  ]',
  parameters = '[
    {"name":"id","data_type":"UID","value":""},
    {"name":"schemata_json","data_type":"string","value":"[]"}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_create_schema_property';

-- Starter implementation: read_schema_node
UPDATE queries
SET
  cypher = '[
    "MATCH (n:SCHEMA {id: $id}) RETURN n"
  ]',
  sqlite = '[]',
  parameters = '[
    {"name":"id","data_type":"UID","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_read_schema_node';

-- Starter implementation: read_schema_relationship
UPDATE queries
SET
  cypher = '[
    "MATCH ()-[r:POINTS_TO {id: $relationship_id}]-() RETURN r"
  ]',
  sqlite = '[]',
  parameters = '[
    {"name":"relationship_id","data_type":"UID","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_read_schema_relationship';

-- Starter implementation: read_schema_network
UPDATE queries
SET
  cypher = '[
    "MATCH p=(root:SCHEMA {id: $root_schema_id})-[:POINTS_TO*0..]->(n:SCHEMA) RETURN p LIMIT $limit"
  ]',
  sqlite = '[]',
  parameters = '[
    {"name":"root_schema_id","data_type":"UID","value":""},
    {"name":"limit","data_type":"integer","value":100}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_read_schema_network';

-- Starter implementation: update_schema_node
UPDATE queries
SET
  cypher = '[
    "MATCH (n:SCHEMA {id: $id}) SET n.attributive_label = $attributive_label RETURN n"
  ]',
  sqlite = '[
    "UPDATE entities SET common_label = $attributive_label, payload = json_object(''schemata'', json($schemata_json)), modified_date = datetime(''now'') WHERE id = $id AND node_label = ''SCHEMA'';"
  ]',
  parameters = '[
    {"name":"id","data_type":"UID","value":""},
    {"name":"attributive_label","data_type":"string","value":""},
    {"name":"schemata_json","data_type":"string","value":"[]"}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_update_schema_node';

-- Starter implementation: update_schema_relationship
UPDATE queries
SET
  cypher = '[
    "MATCH ()-[r:POINTS_TO {id: $relationship_id}]-() SET r.attributive_label = $relationship_label RETURN r"
  ]',
  sqlite = '[
    "UPDATE entities SET common_label = $relationship_label, payload = json_object(''schemata'', json($schemata_json)), modified_date = datetime(''now'') WHERE id = $relationship_id AND node_label = ''SCHEMA'';"
  ]',
  parameters = '[
    {"name":"relationship_id","data_type":"UID","value":""},
    {"name":"relationship_label","data_type":"string","value":""},
    {"name":"schemata_json","data_type":"string","value":"[]"}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_update_schema_relationship';

-- Starter implementation: delete_schema_node
UPDATE queries
SET
  cypher = '[
    "MATCH (n:SCHEMA {id: $id}) DETACH DELETE n RETURN count(n) AS deleted"
  ]',
  sqlite = '[
    "DELETE FROM entities WHERE id = $id AND node_label = ''SCHEMA'';"
  ]',
  parameters = '[
    {"name":"id","data_type":"UID","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_delete_schema_node';

-- Starter implementation: delete_schema_relationship
UPDATE queries
SET
  cypher = '[
    "MATCH ()-[r:POINTS_TO {id: $relationship_id}]-() DELETE r RETURN count(r) AS deleted"
  ]',
  sqlite = '[
    "DELETE FROM entities WHERE id = $relationship_id AND node_label = ''SCHEMA'';"
  ]',
  parameters = '[
    {"name":"relationship_id","data_type":"UID","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_delete_schema_relationship';

-- Starter implementation: create_instance_node
UPDATE queries
SET
  cypher = '[
    "MATCH (s:SCHEMA {attributive_label: $schema_attributive_label}) CREATE (n:INSTANCE {id: $id, attributive_label: $schema_attributive_label}) RETURN n, s.id AS schema_id"
  ]',
  sqlite = '[
    "INSERT INTO entities (id, node_label, common_label, payload, creation_date, modified_date) VALUES ($id, ''INSTANCE'', $common_label, json_object(''properties'', json($properties_json), ''schema_attributive_label'', $schema_attributive_label), datetime(''now''), datetime(''now''));"
  ]',
  parameters = '[
    {"name":"id","data_type":"UID","value":""},
    {"name":"schema_attributive_label","data_type":"string","value":""},
    {"name":"common_label","data_type":"string","value":""},
    {"name":"properties_json","data_type":"string","value":"{}"}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_create_instance_node';

-- Starter implementation: create_instance_hop
UPDATE queries
SET
  cypher = '[
    "MATCH (a:INSTANCE {id: $from_instance_id}), (b:INSTANCE {id: $to_instance_id}), (s:SCHEMA {attributive_label: $relationship_schema_attributive_label}) CREATE (a)-[r:POINTS_TO {id: $relationship_id, attributive_label: $relationship_schema_attributive_label}]->(b) RETURN r, s.id AS schema_id"
  ]',
  sqlite = '[
    "INSERT INTO entities (id, node_label, common_label, payload, creation_date, modified_date) VALUES ($relationship_id, ''INSTANCE'', $relationship_schema_attributive_label, json_object(''properties'', json($properties_json), ''schema_attributive_label'', $relationship_schema_attributive_label), datetime(''now''), datetime(''now''));"
  ]',
  parameters = '[
    {"name":"from_instance_id","data_type":"UID","value":""},
    {"name":"to_instance_id","data_type":"UID","value":""},
    {"name":"relationship_id","data_type":"UID","value":""},
    {"name":"relationship_schema_attributive_label","data_type":"string","value":""},
    {"name":"properties_json","data_type":"string","value":"{}"}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_create_instance_hop';

-- Starter implementation: read_instance_node
UPDATE queries
SET
  cypher = '[
    "MATCH (n:INSTANCE {id: $id}) RETURN n"
  ]',
  sqlite = '[]',
  parameters = '[
    {"name":"id","data_type":"UID","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_read_instance_node';

-- Starter implementation: read_instance_relationship
UPDATE queries
SET
  cypher = '[
    "MATCH ()-[r:POINTS_TO {id: $relationship_id}]-() RETURN r"
  ]',
  sqlite = '[]',
  parameters = '[
    {"name":"relationship_id","data_type":"UID","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_read_instance_relationship';

-- Starter implementation: read_instance_network
UPDATE queries
SET
  cypher = '[
    "MATCH p=(root:INSTANCE {id: $root_instance_id})-[:POINTS_TO*0..]->(n:INSTANCE) RETURN p LIMIT $limit"
  ]',
  sqlite = '[]',
  parameters = '[
    {"name":"root_instance_id","data_type":"UID","value":""},
    {"name":"limit","data_type":"integer","value":100}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_read_instance_network';

-- Starter implementation: update_instance_node
UPDATE queries
SET
  cypher = '[
    "MATCH (n:INSTANCE {id: $id}) SET n.attributive_label = $schema_attributive_label RETURN n"
  ]',
  sqlite = '[
    "UPDATE entities SET common_label = $common_label, payload = json_object(''properties'', json($properties_json), ''schema_attributive_label'', $schema_attributive_label), modified_date = datetime(''now'') WHERE id = $id AND node_label = ''INSTANCE'';"
  ]',
  parameters = '[
    {"name":"id","data_type":"UID","value":""},
    {"name":"schema_attributive_label","data_type":"string","value":""},
    {"name":"common_label","data_type":"string","value":""},
    {"name":"properties_json","data_type":"string","value":"{}"}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_update_instance_node';

-- Starter implementation: update_instance_relationship
UPDATE queries
SET
  cypher = '[
    "MATCH ()-[r:POINTS_TO {id: $relationship_id}]-() SET r.attributive_label = $relationship_schema_attributive_label RETURN r"
  ]',
  sqlite = '[
    "UPDATE entities SET common_label = $relationship_schema_attributive_label, payload = json_object(''properties'', json($properties_json), ''schema_attributive_label'', $relationship_schema_attributive_label), modified_date = datetime(''now'') WHERE id = $relationship_id AND node_label = ''INSTANCE'';"
  ]',
  parameters = '[
    {"name":"relationship_id","data_type":"UID","value":""},
    {"name":"relationship_schema_attributive_label","data_type":"string","value":""},
    {"name":"properties_json","data_type":"string","value":"{}"}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_update_instance_relationship';

-- Starter implementation: delete_instance_node
UPDATE queries
SET
  cypher = '[
    "MATCH (n:INSTANCE {id: $id}) DETACH DELETE n RETURN count(n) AS deleted"
  ]',
  sqlite = '[
    "DELETE FROM entities WHERE id = $id AND node_label = ''INSTANCE'';"
  ]',
  parameters = '[
    {"name":"id","data_type":"UID","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_delete_instance_node';

-- Starter implementation: delete_instance_relationship
UPDATE queries
SET
  cypher = '[
    "MATCH ()-[r:POINTS_TO {id: $relationship_id}]-() DELETE r RETURN count(r) AS deleted"
  ]',
  sqlite = '[
    "DELETE FROM entities WHERE id = $relationship_id AND node_label = ''INSTANCE'';"
  ]',
  parameters = '[
    {"name":"relationship_id","data_type":"UID","value":""}
  ]',
  modified_date = datetime('now')
WHERE id = 'sys_delete_instance_relationship';
