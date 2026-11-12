import { describe, expect, it } from "vitest";
import {
  normalizeParameterName,
  parseDeclaredScriptParameter,
  parseDeclaredScriptParameters,
  resolveScriptParameters,
} from "../utils/script-parameters.js";

describe("normalizeParameterName", () => {
  it("strips a single % or @ wrapper", () => {
    expect(normalizeParameterName("%reboot%")).toBe("reboot");
    expect(normalizeParameterName("@path@")).toBe("path");
    expect(normalizeParameterName("ServiceName")).toBe("ServiceName");
  });
});

describe("parseDeclaredScriptParameter", () => {
  it("treats a bare name as required", () => {
    expect(parseDeclaredScriptParameter("ServiceName")).toEqual({
      name: "ServiceName",
      raw: "ServiceName",
      required: true,
      type: "string",
    });
  });

  it("parses Name=Default and optional :type hints", () => {
    expect(parseDeclaredScriptParameter("ServiceName=Spooler")).toEqual({
      name: "ServiceName",
      raw: "ServiceName=Spooler",
      defaultValue: "Spooler",
      required: false,
      type: "string",
    });
    expect(parseDeclaredScriptParameter("retries:number=3")).toEqual({
      name: "retries",
      raw: "retries:number=3",
      defaultValue: "3",
      required: false,
      type: "number",
    });
    expect(parseDeclaredScriptParameter("%path%")).toEqual({
      name: "path",
      raw: "%path%",
      required: true,
      type: "string",
    });
  });
});

describe("resolveScriptParameters", () => {
  it("returns an empty map when the script declares nothing", () => {
    const result = resolveScriptParameters([], { extra: "1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.parameters).toEqual({ extra: "1" });
    expect(result.value.unknown_keys).toEqual(["extra"]);
  });

  it("fills defaults and accepts %name% caller keys", () => {
    const result = resolveScriptParameters(
      ["ServiceName=Spooler", "%path%", "Force=false"],
      { "%path%": "C:\\Temp" }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.parameters).toEqual({
      ServiceName: "Spooler",
      path: "C:\\Temp",
      Force: "false",
    });
    expect(result.value.filled_defaults).toEqual(["ServiceName", "Force"]);
  });

  it("reports missing required parameters without defaults", () => {
    const result = resolveScriptParameters(
      ["ServiceName", "Timeout:number=30"],
      {}
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.missing.map((p) => p.name)).toEqual(["ServiceName"]);
    expect(result.error.declared).toHaveLength(2);
  });

  it("dedupes declared names and keeps declaration order", () => {
    expect(
      parseDeclaredScriptParameters([
        "A=1",
        "%A%",
        "B",
        "A=ignored",
      ]).map((p) => p.name)
    ).toEqual(["A", "B"]);
  });

  it("preserves an explicit __proto__ parameter key", () => {
    const result = resolveScriptParameters(["__proto__=value"], {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.prototype.hasOwnProperty.call(result.value.parameters, "__proto__")).toBe(
      true
    );
    expect(result.value.parameters.__proto__).toBe("value");
  });
});
