/**
 * Connector API path helper.
 */
import assert from "node:assert/strict";
import { joinApiPath } from "../App/connector/src/api-path.ts";

assert.equal(joinApiPath("/api/spaces"), "/api/spaces");
assert.equal(joinApiPath("/api/spaces", "http://localhost:8765"), "http://localhost:8765/api/spaces");
assert.equal(joinApiPath("api/spaces", "http://localhost:8765/"), "http://localhost:8765/api/spaces");

console.log("connector-api-path: ok");
