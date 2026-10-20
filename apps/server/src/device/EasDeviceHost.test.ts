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

interface Gate {
  readonly requested: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}
const makeGate = Effect.all({
  requested: Deferred.make<void>(),
  release: Deferred.make<void>(),
});

/** Expo's API and one session's preview host, recording what was asked of them. */
const fakeExpo = (
  options: {
    readonly status?: () => string;
    readonly failCreate?: boolean;
    readonly failStop?: () => boolean;
    readonly active?: ReadonlyArray<{ id: string; status: string; name: string }>;
    readonly previewGate?: Gate;
    readonly createGate?: Gate;
    readonly activeIncludesCreated?: boolean;
    readonly failPreview?: boolean;
  } = {},
) => {
  const calls: Array<{ operation: string; variables: Record<string, unknown> }> = [];
  let created = 0;
  let createdName = "";
  let previewFails = options.failPreview ?? false;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      if (url.origin === "https://preview.test") {
        expect(request.headers.authorization).toBe("Bearer preview-token");
        if (options.previewGate) {
          yield* Deferred.succeed(options.previewGate.requested, undefined);
          yield* Deferred.await(options.previewGate.release);
        }
        if (previewFails) {
          return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
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
        if (options.createGate) {
          yield* Deferred.succeed(options.createGate.requested, undefined);
          yield* Deferred.await(options.createGate.release);
        }
        if (options.failCreate)
          return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
      }
      if (operation === "T3StopEasSimulatorSession" && options.failStop?.()) {
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
                          ...(options.active ?? []).map((node) => ({ node })),
                          ...(options.activeIncludesCreated && created > 0
                            ? [
                                {
                                  node: {
                                    id: `session-${created}`,
                                    status: "STARTING",
                                    name: createdName,
                                  },
                                },
                              ]
                            : []),
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
  const allowPreview = () => {
    previewFails = false;
  };
  return { http, named, stopped, allowPreview };
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

      expect(yield* ready.devices.boot(catalog[0]!)).toBe("session-1");
      expect(expo.named("T3CreateEasSimulatorSession")[0]?.variables.input).toMatchObject({
        appId: APP_ID,
        platform: "IOS",
        type: "AGENT_DEVICE",
        maxRunTimeMinutes: 25,
        maxIdleTimeMinutes: 5,
      });
      const listed = (yield* ready.devices.list).devices;
      expect(listed.find((device) => device.id === "session-1")?.booted).toBe(true);
      expect(yield* ready.devices.agentEndpoint!("session-1")).toEqual({
        baseUrl: "https://agent.test",
        token: "agent-token",
        agentDeviceId: "UDID-1",
      });

      const routed = yield* ready.upstream!(
        "/vendor/serve-sim/helper/session-1/webrtc/offer",
        new URLSearchParams("hostId=eas"),
      );
      expect(routed).toEqual({
        url: "https://preview.test/helper/UDID-1/webrtc/offer?hostId=eas",
        headers: { authorization: "Bearer preview-token" },
        protocols: ["serve-sim.token.preview-token"],
      });
      expect(
        yield* ready.upstream!(
          "/vendor/serve-sim/helper/ws",
          new URLSearchParams("device=session-1"),
        ),
      ).toMatchObject({ url: "https://preview.test/helper/ws?device=UDID-1" });
      expect(yield* ready.upstream!("/vendor/serve-emu/ws", new URLSearchParams())).toBeNull();
      expect(
        yield* ready.upstream!("/vendor/serve-sim/helper/%E0/config", new URLSearchParams()),
      ).toBeNull();

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
      expect(refused.message).toBe(
        "EAS Simulator is unavailable: EAS Simulator is limited to 1 running session. Close one in the Device panel first.",
      );
      expect(expo.named("T3CreateEasSimulatorSession")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("tells concurrent sessions apart although EAS gives each the same UDID", () =>
    Effect.gen(function* () {
      const expo = fakeExpo();
      const scope = yield* Scope.make();
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 2 }), scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-1");
      expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-2");
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual([
        "eas-ios",
        "session-1",
        "session-2",
      ]);
      expect(
        yield* ready.upstream!(
          "/vendor/serve-sim/api",
          new URLSearchParams("device=session-2&hostId=eas"),
        ),
      ).toMatchObject({ url: "https://preview.test/api?device=UDID-1&hostId=eas" });

      yield* ready.devices.shutdown({ id: "session-1", platform: "ios" });
      expect(expo.stopped()).toEqual(["session-1"]);
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual([
        "eas-ios",
        "session-2",
      ]);
      yield* Scope.close(scope, Exit.void);
      expect(expo.stopped()).toEqual(["session-1", "session-2"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops only the sessions a previous server recorded, found by name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* ServerConfig.ServerConfig;
      const ledger = path.join(server.stateDir, "device", "eas", "eas.json");
      yield* fs.makeDirectory(path.dirname(ledger), { recursive: true });
      yield* fs.writeFileString(
        ledger,
        JSON.stringify([
          { name: "T3 Code · EAS Simulator · left", appId: APP_ID, recordedAt: 0 },
          // Recorded long enough ago that Expo has ended it, so the record goes.
          { name: "T3 Code · EAS Simulator · gone", appId: APP_ID, recordedAt: -121 * 60_000 },
          // Recorded just now and not listed yet: kept for a later sweep.
          { name: "T3 Code · EAS Simulator · new", appId: APP_ID, recordedAt: 0 },
        ]),
      );
      const expo = fakeExpo({
        active: [
          { id: "left-behind", status: "IN_PROGRESS", name: "T3 Code · EAS Simulator · left" },
        ],
      });
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      yield* host.ensureReady(() => Effect.void);
      // The sweep runs in the background, so readiness does not wait on Expo.
      const ledgerNames = Effect.map(
        Effect.flatMap(fs.readFileString(ledger), (text) =>
          Effect.try(() => JSON.parse(text) as ReadonlyArray<{ name: string }>),
        ),
        (entries) => entries.map((entry) => entry.name),
      );
      yield* Effect.eventually(
        Effect.flatMap(ledgerNames, (names) =>
          names.length === 1 ? Effect.void : Effect.fail("not swept yet"),
        ),
      );
      expect(expo.stopped()).toEqual(["left-behind"]);
      expect(yield* ledgerNames).toEqual(["T3 Code · EAS Simulator · new"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("records a session before creating it and refuses to start without the record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* ServerConfig.ServerConfig;
      // A directory where the ledger file should be: it can be neither read nor written.
      yield* fs.makeDirectory(path.join(server.stateDir, "device", "eas", "eas.json"), {
        recursive: true,
      });
      const expo = fakeExpo();
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const failure = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(failure.message).toContain("could not be read");
      expect(expo.named("T3CreateEasSimulatorSession")).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps a session tracked when the open that started it is interrupted", () =>
    Effect.gen(function* () {
      const createGate = yield* makeGate;
      const expo = fakeExpo({ createGate });
      const scope = yield* Scope.make();
      const host = yield* makeHost(expo, config(), scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const opening = yield* ready.devices.boot(catalogDevice!).pipe(Effect.forkChild);
      yield* Deferred.await(createGate.requested);
      yield* Fiber.interrupt(opening);
      yield* Deferred.succeed(createGate.release, undefined);
      // The start goes on in the host and tracks its session.
      yield* Effect.eventually(
        ready.devices.list.pipe(
          Effect.flatMap(({ devices }) =>
            devices.some((device) => device.id === "session-1")
              ? Effect.void
              : Effect.fail("not tracked yet"),
          ),
        ),
      );
      yield* Scope.close(scope, Exit.void);
      expect(expo.stopped()).toEqual(["session-1"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps a session it could not stop counted, listed, and retried", () =>
    Effect.gen(function* () {
      let stopFails = true;
      const expo = fakeExpo({ failStop: () => stopFails });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!);
      yield* ready.devices.shutdown({ id: "session-1", platform: "ios" }).pipe(Effect.flip);
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toContain("session-1");
      const refused = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(refused.message).toContain("limited to 1 running session");
      stopFails = false;
      yield* ready.devices.list;
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual(["eas-ios"]);
      expect(expo.stopped().filter((id) => id === "session-1").length).toBeGreaterThanOrEqual(2);
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
      expect(yield* ready.devices.agentEndpoint!("session-1").pipe(Effect.flip)).toMatchObject({
        reason: "This EAS Simulator device is no longer running.",
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops a session that is still starting when the host stops", () =>
    Effect.gen(function* () {
      const previewGate = yield* makeGate;
      const expo = fakeExpo({ previewGate });
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const booting = yield* ready.devices.boot(catalogDevice!).pipe(Effect.forkChild);
      yield* Deferred.await(previewGate.requested);
      // Never released: stopping must not wait for the session to become ready.
      yield* host.stop;
      expect(expo.stopped()).toEqual(["session-1"]);
      const failure = yield* Fiber.join(booting).pipe(Effect.flip);
      expect(failure.message).toContain("was stopped while the session started");
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual(["eas-ios"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("leaves a start in progress to its owner when the sweep runs", () =>
    Effect.gen(function* () {
      const previewGate = yield* makeGate;
      // Expo lists the starting session by name, as it does while it boots.
      const expo = fakeExpo({ previewGate, activeIncludesCreated: true });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* ServerConfig.ServerConfig;
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const booting = yield* ready.devices.boot(catalogDevice!).pipe(Effect.forkChild);
      yield* Deferred.await(previewGate.requested);
      yield* TestClock.adjust("61 seconds");
      yield* ready.devices.list;
      expect(expo.stopped()).toEqual([]);
      const ledger = path.join(server.stateDir, "device", "eas", "eas.json");
      expect(JSON.parse(yield* fs.readFileString(ledger))).toHaveLength(1);
      yield* Deferred.succeed(previewGate.release, undefined);
      expect(yield* Fiber.join(booting)).toBe("session-1");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps a session counted when its start fails and stopping it fails too", () =>
    Effect.gen(function* () {
      let stopFails = true;
      const expo = fakeExpo({ failPreview: true, failStop: () => stopFails });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      // The preview probe is retried a few seconds apart before the start gives up.
      const failing = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip, Effect.forkChild);
      while (failing.pollUnsafe() === undefined) yield* TestClock.adjust("1 second");
      yield* Fiber.join(failing);
      const refused = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(refused.message).toContain("failed and is being retried");
      expect(expo.named("T3CreateEasSimulatorSession")).toHaveLength(1);
      stopFails = false;
      yield* ready.devices.list;
      expect(expo.stopped().at(-1)).toBe("session-1");
      expo.allowPreview();
      expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-2");
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
