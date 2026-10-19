import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { DeviceHostConfigs, deviceToolInstallMessage } from "./device.ts";

describe("device tool install progress", () => {
  it("distinguishes a new install from an upgrade and chooses versions numerically", () => {
    expect(
      deviceToolInstallMessage("device hub", {
        requiredVersion: "0.11.0",
        installedVersions: [],
        runningVersion: null,
      }),
    ).toBe("Installing device hub 0.11.0…");
    expect(
      deviceToolInstallMessage("device hub", {
        requiredVersion: "0.11.0",
        installedVersions: ["0.9.0", "0.10.0"],
        runningVersion: null,
      }),
    ).toBe("Updating device hub from 0.10.0 to 0.11.0…");
  });
});

describe("configured device hosts", () => {
  const decode = Schema.decodeUnknownSync(DeviceHostConfigs);

  it("reads SSH hosts saved before hosts had a kind, and EAS hosts with bounded sessions", () => {
    expect(
      decode([
        { id: "mac", label: "Mac mini", target: "julius@mac" },
        { kind: "eas", id: "eas", label: "EAS Simulator" },
      ]),
    ).toEqual([
      { kind: "ssh", id: "mac", label: "Mac mini", target: "julius@mac" },
      {
        kind: "eas",
        id: "eas",
        label: "EAS Simulator",
        maxSessionMinutes: 30,
        idleMinutes: 10,
        maxConcurrentSessions: 2,
      },
    ]);
  });

  it("refuses sessions longer than EAS allows and ids shared across kinds", () => {
    expect(() =>
      decode([{ kind: "eas", id: "eas", label: "EAS", maxSessionMinutes: 600 }]),
    ).toThrow();
    expect(() =>
      decode([
        { id: "same", label: "Mac", target: "mac" },
        { kind: "eas", id: "same", label: "EAS" },
      ]),
    ).toThrow();
  });
});
