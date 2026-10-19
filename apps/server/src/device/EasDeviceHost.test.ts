import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { EasDeviceHostConfig } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as EasDeviceHost from "./EasDeviceHost.ts";

const APP_ID = "d763fcb8-d37c-41ea-a773-b54a0ab4a454";

const config = (overrides: Partial<EasDeviceHostConfig> = {}): EasDeviceHostConfig => ({
  kind: "eas",
  id: "eas",
  label: "EAS Simulator",
  appId: APP_ID,
  accessToken: "expo-token",
  maxSessionMinutes: 25,
  idleMinutes: 5,
  maxConcurrentSessions: 2,
  ...overrides,
});

/** Expo's API and one session's preview host, recording what was asked of them. */
const fakeExpo = (
  options: {
    readonly status?: () => string;
    readonly failCreate?: boolean;
    readonly previewGate?: {
      readonly requested: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
  } = {},
) => {
  const calls: Array<{ operation: string; variables: Record<string, unknown> }> = [];
  let created = 0;
  let createdName = "";
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      if (url.origin === "https://preview.test") {
        expect(request.headers.authorization).toBe("Bearer preview-token");
        if (options.previewGate) {
          yield* Deferred.succeed(options.previewGate.requested, undefined);
          yield* Deferred.await(options.previewGate.release);
        }
        return HttpClientResponse.fromWeb(request, Response.json({ device: "UDID-1" }));
      }
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              query: string;
              variables: Record<string, { name?: string } & Record<string, unknown>>;
            })
          : { query: "", variables: {} };
      expect(request.headers.authorization).toBe("Bearer expo-token");
      const operation = /(?:query|mutation) (\w+)/.exec(body.query)?.[1] ?? "unknown";
      calls.push({ operation, variables: body.variables });
      if (operation === "T3CreateEasSimulatorSession") {
        createdName = body.variables.input?.name ?? "";
        if (options.failCreate)
          return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
      }
      const data =
        operation === "T3EasSimulatorAvailability"
          ? {
              app: {
                byId: {
                  ownerAccount: {
                    name: "pingdotgg",
                    accountFeatureGates: { "device-run-sessions": true },
                  },
                },
              },
            }
          : operation === "T3CreateEasSimulatorSession"
            ? { deviceRunSession: { createDeviceRunSession: { id: `session-${++created}` } } }
            : operation === "T3ActiveEasSimulatorSessions"
              ? {
                  app: {
                    byId: {
                      deviceRunSessionsPaginated: {
                        edges: [
                          { node: { id: "orphan", status: "NEW", name: createdName } },
                          {
                            node: {
                              id: "someone-else",
                              status: "IN_PROGRESS",
                              name: "T3 Code · EAS Simulator · 000000",
                            },
                          },
                        ],
                      },
                    },
                  },
                }
              : operation === "T3EasSimulatorSession"
                ? {
                    deviceRunSessions: {
                      byId: {
                        id: body.variables.id,
                        status: options.status?.() ?? "IN_PROGRESS",
                        remoteConfig: {
                          __typename: "AgentDeviceRunSessionRemoteConfig",
                          agentDeviceRemoteSessionUrl: "https://agent.test",
                          agentDeviceRemoteSessionToken: "agent-token",
                          webPreviewToken: "preview-token",
                          previewApiUrl: "https://preview.test?token=preview-token",
                        },
                      },
                    },
                  }
                : {
                    deviceRunSession: {
                      ensureDeviceRunSessionStopped: { id: body.variables.id, status: "STOPPED" },
                    },
                  };
      return HttpClientResponse.fromWeb(request, Response.json({ data }));
    }),
  );
  const named = (operation: string) => calls.filter((call) => call.operation === operation);
  const stopped = () => named("T3StopEasSimulatorSession").map((call) => call.variables.id);
  return { http, named, stopped };
};

const layer = Layer.mergeAll(
  ProcessRunner.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-eas-host-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const makeHost = (
  expo: ReturnType<typeof fakeExpo>,
  hostConfig: EasDeviceHostConfig,
  scope: Scope.Scope,
) =>
  EasDeviceHost.make(hostConfig).pipe(
    Effect.provideService(HttpClient.HttpClient, expo.http),
    Effect.provideService(Scope.Scope, scope),
  );

describe("EAS Simulator host", () => {
  it.effect("starts a bounded session and routes its stream and agent to that session", () =>
    Effect.gen(function* () {
      const expo = fakeExpo();
      const scope = yield* Scope.make();
      const host = yield* makeHost(expo, config(), scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      const catalog = (yield* ready.devices.list).devices;
      expect(catalog.map((device) => [device.id, device.booted])).toEqual([["eas-ios", false]]);

      expect(yield* ready.devices.boot(catalog[0]!)).toBe("UDID-1");
      expect(expo.named("T3CreateEasSimulatorSession")[0]?.variables.input).toMatchObject({
        appId: APP_ID,
        platform: "IOS",
        type: "AGENT_DEVICE",
        maxRunTimeMinutes: 25,
        maxIdleTimeMinutes: 5,
      });
      const listed = (yield* ready.devices.list).devices;
      expect(listed.find((device) => device.id === "UDID-1")?.booted).toBe(true);
      expect(yield* ready.devices.agentEndpoint!("UDID-1")).toEqual({
        baseUrl: "https://agent.test",
        token: "agent-token",
      });

      const routed = yield* ready.upstream!(
        "/vendor/serve-sim/helper/UDID-1/webrtc/offer",
        new URLSearchParams("hostId=eas"),
      );
      expect(routed).toEqual({
        url: "https://preview.test/helper/UDID-1/webrtc/offer?hostId=eas",
        headers: { authorization: "Bearer preview-token" },
        protocols: ["serve-sim.token.preview-token"],
      });
      expect(
        yield* ready.upstream!("/vendor/serve-sim/helper/ws", new URLSearchParams("device=UDID-1")),
      ).toMatchObject({ url: "https://preview.test/helper/ws?device=UDID-1" });
      expect(yield* ready.upstream!("/vendor/serve-emu/ws", new URLSearchParams())).toBeNull();

      yield* Scope.close(scope, Exit.void);
      expect(expo.named("T3StopEasSimulatorSession").map((call) => call.variables.id)).toEqual([
        "session-1",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("refuses to start past its session limit", () =>
    Effect.gen(function* () {
      const expo = fakeExpo();
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!);
      const refused = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(refused.message).toContain("limited to 1 running session");
      expect(expo.named("T3CreateEasSimulatorSession")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops only the sessions a previous server left behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* ServerConfig.ServerConfig;
      const ledger = path.join(server.stateDir, "device", "eas", "eas.json");
      yield* fs.makeDirectory(path.dirname(ledger), { recursive: true });
      yield* fs.writeFileString(ledger, JSON.stringify(["left-behind"]));
      const expo = fakeExpo();
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      yield* host.ensureReady(() => Effect.void);
      expect(expo.named("T3StopEasSimulatorSession").map((call) => call.variables.id)).toEqual([
        "left-behind",
      ]);
      expect(JSON.parse(yield* fs.readFileString(ledger))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("asks for an EAS project before starting anything when none can be found", () =>
    Effect.gen(function* () {
      const expo = fakeExpo();
      const host = yield* makeHost(expo, config({ appId: undefined }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const failure = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(failure.message).toContain("Choose one for this host in Settings");
      expect(expo.named("T3CreateEasSimulatorSession")).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect("stops listing sessions Expo already ended", () =>
    Effect.gen(function* () {
      let status = "IN_PROGRESS";
      const expo = fakeExpo({ status: () => status });
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!);
      status = "STOPPED";
      yield* TestClock.adjust("20 seconds");
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual(["eas-ios"]);
      expect(yield* ready.devices.agentEndpoint!("UDID-1").pipe(Effect.flip)).toMatchObject({
        reason: "This EAS Simulator device is no longer running.",
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops a session that finishes starting after the host stopped", () =>
    Effect.gen(function* () {
      const previewGate = {
        requested: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      const expo = fakeExpo({ previewGate });
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const booting = yield* ready.devices.boot(catalogDevice!).pipe(Effect.forkChild);
      yield* Deferred.await(previewGate.requested);
      yield* host.stop;
      yield* Deferred.succeed(previewGate.release, undefined);
      const failure = yield* Fiber.join(booting).pipe(Effect.flip);
      expect(failure.message).toContain("was stopped while the session started");
      expect(expo.stopped()).toEqual(["session-1"]);
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual(["eas-ios"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops only its own session when creating one fails after Expo made it", () =>
    Effect.gen(function* () {
      const expo = fakeExpo({ failCreate: true });
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(expo.stopped()).toEqual(["orphan"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
