import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateFormat } from "../src/utils/formatValidator.js";

describe("validateFormat", () => {
  it('returns "json" for format "json"', () => {
    assert.equal(validateFormat("json"), "json");
  });

  it('returns "csv" for format "csv"', () => {
    assert.equal(validateFormat("csv"), "csv");
  });

  it('returns "jsonstat" for format "jsonstat"', () => {
    assert.equal(validateFormat("jsonstat"), "jsonstat");
  });

  it('returns "json" when format is undefined', () => {
    assert.equal(validateFormat(undefined), "json");
  });

  it('returns "json" when format is null', () => {
    assert.equal(validateFormat(null), "json");
  });

  it('returns "json" when format is empty string', () => {
    assert.equal(validateFormat(""), "json");
  });

  it("throws 400 for unsupported format", () => {
    try {
      validateFormat("xml");
      assert.fail("Expected an error to be thrown");
    } catch (err) {
      assert.match(err.message, /Supported formats: json, csv, jsonstat/);
      assert.equal(err.status, 400);
    }
  });

  it("rejects uppercase format (case-sensitive)", () => {
    try {
      validateFormat("CSV");
      assert.fail("Expected an error to be thrown");
    } catch (err) {
      assert.match(err.message, /Supported formats: json, csv, jsonstat/);
      assert.equal(err.status, 400);
    }
  });
});
