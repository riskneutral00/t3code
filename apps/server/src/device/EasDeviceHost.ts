/**
 * Cloud simulators from EAS Simulator. A device exists only while a session
 * runs, and every session bills the Expo account until it stops, so this host
 * bounds each one, stops all of them when it stops, and stops sessions a
 * previous server left behind. It never touches sessions it did not start.
 */
import {
  DeviceBootError,
  type DeviceHostSummary,
  DeviceHostUnavailableError,
  DeviceOperationError,
  type DevicePlatform,
  type EasDeviceHostConfig,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { findEasProjectId } from "./easProjectId.ts";
import { type ExpoApi, makeExpoApi, resolveExpoCredential } from "./ExpoApi.ts";

const POLL_INTERVAL = Duration.seconds(5);
// How stale a running session's status may get before listing rechecks it.
const STATUS_TTL_MS = 15_000;
// Expo's own CLI waits this long once a worker picks the session up.
const START_TIMEOUT = Duration.minutes(15);
const PREVIEW_TIMEOUT = Duration.seconds(20);
const SERVE_SIM_PREFIX = "/vendor/serve-sim";

/** EAS picks the simulator model; one entry starts a session. */
const CATALOG: ReadonlyArray<DeviceHost.HostDevice> = [
  {
    id: "eas-ios",
    platform: "ios",
    name: "iPhone (EAS Simulator)",
    version: "Cloud",
    booted: false,
    physical: false,
  },
];

interface RunningSession {
  readonly sessionId: string;
  readonly udid: string;
  readonly preview: { readonly origin: string; readonly token: Redacted.Redacted<string> };
  readonly agent: DeviceHost.AgentDaemonEndpoint;
}

const Ledger = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeLedger = Schema.decodeUnknownOption(Ledger);
const encodeLedger = Schema.encodeSync(Ledger);
const decodePreviewApi = Schema.decodeUnknownEffect(Schema.Struct({ device: Schema.String }));

export const make = Effect.fn("EasDeviceHost.make")(function* (config: EasDeviceHostConfig) {
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* ServerConfig.ServerConfig;
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | Effect.Services<ReturnType<typeof findEasProjectId>>
  >();
  const hostId = config.id;
  const ledgerPath = path.join(server.stateDir, "device", "eas", `${hostId}.json`);
  const sessions = new Map<string, RunningSession>();
  const checkedAt = new Map<string, number>();
  const startLock = yield* Semaphore.make(1);
  const ledgerLock = yield* Semaphore.make(1);
  let starting = 0;
  // Bumped whenever the host stops its sessions, so a start that finishes
  // afterwards stops its own session instead of leaving it untracked.
  let epoch = 0;
  let ready: DeviceHost.DeviceHostReady | null = null;

  const unavailable = (reason: string, cause?: unknown) =>
    new DeviceHostUnavailableError({ hostId, reason, ...(cause === undefined ? {} : { cause }) });

  const api: Effect.Effect<ExpoApi, DeviceHostUnavailableError> = resolveExpoCredential(
    config.accessToken,
  ).pipe(
    Effect.map((credential) => makeExpoApi(http, credential)),
    Effect.provide(services),
    Effect.mapError((error) => unavailable(error.message, error)),
  );

  const readLedger = fs.readFileString(ledgerPath).pipe(
    Effect.map((text) => Option.getOrElse(decodeLedger(text), () => [])),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  const writeLedger = (update: (ids: ReadonlyArray<string>) => ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const next = update(yield* readLedger);
      yield* fs.makeDirectory(path.dirname(ledgerPath), { recursive: true });
      yield* fs.writeFileString(ledgerPath, encodeLedger([...new Set(next)]));
    }).pipe(Effect.ignore, ledgerLock.withPermit);

  const stopSession = (expo: ExpoApi, sessionId: string) =>
    expo.stop(sessionId).pipe(
      Effect.andThen(writeLedger((ids) => ids.filter((id) => id !== sessionId))),
      Effect.tapError((cause) =>
        Effect.logWarning("Could not stop EAS Simulator session", { sessionId, cause }),
      ),
    );

  /** Sessions a previous server started and could not stop still bill until stopped. */
  const reapLeftovers = (expo: ExpoApi) =>
    readLedger.pipe(
      Effect.flatMap((ids) =>
        Effect.forEach(
          ids.filter((id) => ![...sessions.values()].some((session) => session.sessionId === id)),
          (id) => stopSession(expo, id).pipe(Effect.ignore),
          { discard: true, concurrency: 4 },
        ),
      ),
    );

  const previewDevice = (origin: string, token: Redacted.Redacted<string>) =>
    http
      .execute(
        HttpClientRequest.get(`${origin}/api`).pipe(
          HttpClientRequest.bearerToken(Redacted.value(token)),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.flatMap(decodePreviewApi),
        Effect.map((api) => api.device),
        Effect.scoped,
        Effect.timeout(PREVIEW_TIMEOUT),
      );

  const awaitRunning = (expo: ExpoApi, sessionId: string) =>
    Effect.gen(function* () {
      for (;;) {
        const session = yield* expo
          .session(sessionId)
          .pipe(Effect.mapError((error) => unavailable(error.message, error)));
        if (session.status === "STOPPED" || session.status === "ERRORED") {
          return yield* new DeviceBootError({
            hostId,
            deviceId: sessionId,
            reason: "launch_failed",
            cause: new Error(`EAS Simulator session ended (${session.status}) before it was ready`),
          });
        }
        if (session.status === "IN_PROGRESS" && session.endpoints) return session.endpoints;
        yield* Effect.sleep(POLL_INTERVAL);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: START_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new DeviceBootError({
              hostId,
              deviceId: sessionId,
              reason: "timeout",
              cause: new Error("EAS Simulator session did not start in time"),
            }),
          ),
      }),
    );

  const startSession = (device: DeviceHost.HostDevice, context?: DeviceHost.DeviceOpenContext) =>
    Effect.gen(function* () {
      const expo = yield* api;
      const startedIn = epoch;
      const reserved = yield* startLock.withPermit(
        Effect.sync(() => {
          if (sessions.size + starting >= config.maxConcurrentSessions) return false;
          starting++;
          return true;
        }),
      );
      if (!reserved) {
        return yield* unavailable(
          `${config.label} is limited to ${config.maxConcurrentSessions} running ${config.maxConcurrentSessions === 1 ? "session" : "sessions"}. Close one in the Device panel first.`,
        );
      }
      return yield* Effect.gen(function* () {
        const appId =
          config.appId ??
          Option.getOrUndefined(
            context?.workspaceRoot
              ? yield* findEasProjectId(context.workspaceRoot).pipe(Effect.provide(services))
              : Option.none<string>(),
          );
        if (!appId) {
          return yield* unavailable(
            "No EAS project to run the session under. Choose one for this host in Settings, or open the device from a thread whose project has an Expo app config with extra.eas.projectId.",
          );
        }
        const access = yield* expo
          .availability(appId)
          .pipe(Effect.mapError((error) => unavailable(error.message, error)));
        if (!access.available) {
          return yield* unavailable(
            `EAS Simulator is not enabled for the ${access.account} Expo account.`,
          );
        }
        // A unique name finds this session again if creating it fails after Expo made it.
        const name = `T3 Code · ${config.label} · ${(yield* Random.nextIntBetween(0, 0xffffff)).toString(16).padStart(6, "0")}`;
        const sessionId = yield* expo
          .create({
            appId,
            platform: device.platform,
            name,
            maxRunTimeMinutes: config.maxSessionMinutes,
            maxIdleTimeMinutes: config.idleMinutes,
          })
          .pipe(
            Effect.tapError(() =>
              expo.activeSessions(appId).pipe(
                Effect.flatMap((active) =>
                  Effect.forEach(
                    active.filter((session) => session.name === name),
                    (session) => stopSession(expo, session.id),
                    { discard: true },
                  ),
                ),
                Effect.ignore,
              ),
            ),
            Effect.mapError((error) => unavailable(error.message, error)),
          );
        yield* writeLedger((ids) => [...ids, sessionId]);
        return yield* Effect.gen(function* () {
          const endpoints = yield* awaitRunning(expo, sessionId);
          if (!endpoints.preview) {
            return yield* new DeviceBootError({
              hostId,
              deviceId: sessionId,
              reason: "launch_failed",
              cause: new Error("EAS Simulator returned no preview endpoint"),
            });
          }
          const origin = new URL(endpoints.preview.url).origin;
          const udid = yield* previewDevice(origin, endpoints.preview.token).pipe(
            Effect.mapError(
              (cause) =>
                new DeviceBootError({
                  hostId,
                  deviceId: sessionId,
                  reason: "launch_failed",
                  cause,
                }),
            ),
          );
          if (epoch !== startedIn) {
            return yield* unavailable(`${config.label} was stopped while the session started.`);
          }
          sessions.set(udid, {
            sessionId,
            udid,
            preview: { origin, token: endpoints.preview.token },
            agent: {
              baseUrl: endpoints.agentDevice.url,
              token: Redacted.value(endpoints.agentDevice.token),
            },
          });
          return udid;
        }).pipe(Effect.onError(() => stopSession(expo, sessionId).pipe(Effect.ignore)));
      }).pipe(Effect.ensuring(Effect.sync(() => void starting--)));
    });

  const sessionFor = (udid: string) => Option.fromNullishOr(sessions.get(udid));

  const forget = (session: RunningSession) =>
    Effect.sync(() => {
      sessions.delete(session.udid);
      checkedAt.delete(session.udid);
    });

  /** Expo ends sessions on its own at their run or idle limit; stop listing those. */
  const dropEnded = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const stale = [...sessions.values()].filter(
      (session) => now - (checkedAt.get(session.udid) ?? 0) > STATUS_TTL_MS,
    );
    if (stale.length === 0) return;
    const expo = yield* api;
    yield* Effect.forEach(
      stale,
      (session) =>
        expo.session(session.sessionId).pipe(
          Effect.flatMap((current) =>
            current.status === "STOPPED" || current.status === "ERRORED"
              ? forget(session).pipe(
                  Effect.andThen(
                    writeLedger((ids) => ids.filter((id) => id !== session.sessionId)),
                  ),
                )
              : Effect.sync(() => void checkedAt.set(session.udid, now)),
          ),
          Effect.ignore,
        ),
      { discard: true, concurrency: 4 },
    );
  }).pipe(Effect.ignore);

  const devices: DeviceHost.DeviceOperations = {
    list: dropEnded.pipe(
      Effect.andThen(
        Effect.sync(() => ({
          devices: [
            ...CATALOG,
            ...[...sessions.values()].map((session): DeviceHost.HostDevice => ({
              id: session.udid,
              platform: "ios",
              name: "iPhone (EAS Simulator)",
              version: "Cloud",
              booted: true,
              physical: false,
            })),
          ],
          detail: undefined,
        })),
      ),
    ),
    boot: (device, context) =>
      sessions.has(device.id) ? Effect.succeed(device.id) : startSession(device, context),
    attach: () => Effect.void,
    shutdown: (device) =>
      Option.match(sessionFor(device.id), {
        onNone: () => Effect.void,
        // Forgotten even if stopping fails: the ledger keeps it for the next start to stop.
        onSome: (session) =>
          api.pipe(
            Effect.flatMap((expo) => stopSession(expo, session.sessionId)),
            Effect.ensuring(forget(session)),
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new DeviceOperationError({
                  operation: "shutdown",
                  reason: "request_failed",
                  cause,
                }),
            ),
          ),
      }),
    screenshot: (device) =>
      Option.match(sessionFor(device.id), {
        onNone: () =>
          Effect.fail(
            new DeviceOperationError({
              operation: "screenshot",
              reason: "request_failed",
              cause: new Error("The EAS Simulator session is not running"),
            }),
          ),
        onSome: (session) =>
          http
            .execute(
              HttpClientRequest.post(
                `${session.preview.origin}/api/screenshot?device=${encodeURIComponent(session.udid)}`,
              ).pipe(HttpClientRequest.bearerToken(Redacted.value(session.preview.token))),
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap((response) => response.arrayBuffer),
              Effect.map((buffer) => new Uint8Array(buffer)),
              Effect.scoped,
              Effect.timeout(PREVIEW_TIMEOUT),
              Effect.mapError(
                (cause) =>
                  new DeviceOperationError({
                    operation: "screenshot",
                    reason: "request_failed",
                    cause,
                  }),
              ),
            ),
      }),
    agentEndpoint: (deviceId) =>
      Option.match(sessionFor(deviceId), {
        onNone: () => Effect.fail(unavailable("This EAS Simulator device is no longer running.")),
        onSome: (session) => Effect.succeed(session.agent),
      }),
  };

  /** serve-sim runs at the root of each session's preview host and wants its token on every request. */
  const upstream: NonNullable<DeviceHost.DeviceHostReady["upstream"]> = (hubPath, search) =>
    Effect.sync(() => {
      if (!hubPath.startsWith(`${SERVE_SIM_PREFIX}/`)) return null;
      const fromPath = /^\/vendor\/serve-sim\/helper\/([^/]+)\//.exec(hubPath)?.[1];
      const udid = fromPath ? decodeURIComponent(fromPath) : search.get("device");
      const session =
        udid !== null && udid !== undefined
          ? sessions.get(udid)
          : sessions.size === 1
            ? [...sessions.values()][0]
            : undefined;
      if (!session) return null;
      const query = search.size > 0 ? `?${search.toString()}` : "";
      const token = Redacted.value(session.preview.token);
      return {
        url: `${session.preview.origin}${hubPath.slice(SERVE_SIM_PREFIX.length)}${query}`,
        headers: { authorization: `Bearer ${token}` },
        protocols: [`serve-sim.token.${token}`],
      };
    });

  const nodePath = yield* HostProcess.ExecutablePath;
  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = () =>
    Effect.gen(function* () {
      if (ready) return ready;
      const expo = yield* api.pipe(
        Effect.mapError(
          (cause) => new DeviceHost.DeviceHostError({ hostId, step: "signing in to Expo", cause }),
        ),
      );
      yield* reapLeftovers(expo);
      ready = {
        nodePath,
        hub: { origin: "https://api.expo.dev" },
        devices,
        upstream,
        // Device settings run simctl on the simulator's own machine, which EAS does not expose.
        run: () =>
          Effect.succeed({
            stdout: "",
            stderr: "EAS Simulator devices cannot run host commands.",
            code: 127,
          }),
        helpers: { serveSimAxSettings: null, serveSimCli: null },
      };
      return ready;
    });

  const stopAll = Effect.suspend(() => {
    epoch++;
    return sessions.size === 0
      ? Effect.void
      : api.pipe(
          Effect.flatMap((expo) =>
            Effect.forEach(
              [...sessions.values()],
              (session) =>
                stopSession(expo, session.sessionId).pipe(
                  Effect.ensuring(forget(session)),
                  Effect.ignore,
                ),
              { discard: true, concurrency: 4 },
            ),
          ),
          Effect.ignore,
        );
  });
  yield* Effect.addFinalizer(() => stopAll);

  const platformAvailability = (platform: DevicePlatform) =>
    Effect.succeed(
      platform === "ios"
        ? { platform, available: true }
        : {
            platform,
            available: false,
            reason: "EAS Simulator Android emulators are not supported yet.",
          },
    );

  const summary: Effect.Effect<DeviceHostSummary> = Effect.all([
    platformAvailability("ios"),
    platformAvailability("android"),
  ]).pipe(
    Effect.map((platforms) => ({
      id: hostId,
      label: config.label,
      kind: "eas" as const,
      platforms,
      // Nothing to install: the hub and agent-device daemon run in each session.
      hubInstalled: true,
      agentDeviceInstalled: true,
    })),
  );

  return DeviceHost.DeviceHost.of({
    id: hostId,
    summary,
    platformAvailability,
    ensureReady,
    ensureAgentReady: (onPhase) =>
      ensureReady(onPhase).pipe(Effect.map((value) => ({ ...value, agentDevice: null }))),
    current: Effect.sync(() => ready),
    stopAgent: Effect.void,
    // Unlike machines the user owns, every running session here is billed.
    stop: stopAll,
  });
});
