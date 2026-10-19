import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { EasDeviceHostConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
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
const fakeExpo = () => {
  const calls: Array<{ operation: string; variables: Record<string, unknown> }> = [];
  let created = 0;
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      if (url.origin === "https://preview.test") {
        expect(request.headers.authorization).toBe("Bearer preview-token");
        return HttpClientResponse.fromWeb(request, Response.json({ device: "UDID-1" }));
      }
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              query: string;
              variables: Record<string, unknown>;
            })
          : { query: "", variables: {} };
      expect(request.headers.authorization).toBe("Bearer expo-token");
      const operation = /(?:query|mutation) (\w+)/.exec(body.query)?.[1] ?? "unknown";
      calls.push({ operation, variables: body.variables });
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
            : operation === "T3EasSimulatorSession"
              ? {
                  deviceRunSessions: {
                    byId: {
                      id: body.variables.id,
                      status: "IN_PROGRESS",
                      remoteConfig: {
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
  return { http, named };
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
});
