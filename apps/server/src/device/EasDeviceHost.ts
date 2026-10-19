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
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
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
  readonly name: string;
  readonly udid: string;
  readonly preview: { readonly origin: string; readonly token: Redacted.Redacted<string> };
  readonly agent: DeviceHost.AgentDaemonEndpoint;
  /** Set once a stop has been asked for but Expo has not confirmed it. */
  stopping: boolean;
}

/**
 * Every session this host may have started, recorded by its unique name before
 * Expo is asked to create it, so a server that crashes at any point can still
 * find and stop the session on its next start.
 */
const LedgerEntry = Schema.Struct({ name: Schema.String, appId: Schema.String });
type LedgerEntry = typeof LedgerEntry.Type;
const Ledger = Schema.fromJsonString(Schema.Array(LedgerEntry));
const decodeLedger = Schema.decodeUnknownEffect(Ledger);
const encodeLedger = Schema.encodeSync(Ledger);
// How often listing looks for recorded sessions this host no longer tracks.
const REAP_INTERVAL_MS = 60_000;
const decodePreviewApi = Schema.decodeUnknownEffect(Schema.Struct({ device: Schema.String }));

/** A malformed escape names no device, so the proxy answers 404 instead of failing. */
const decodePathSegment = (segment: string): string | null => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

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
  // Keyed by Expo's session id, which is also the device id: every EAS
  // simulator reports the same UDID, so the UDID cannot tell sessions apart.
  const sessions = new Map<string, RunningSession>();
  const checkedAt = new Map<string, number>();
  const startLock = yield* Semaphore.make(1);
  const ledgerLock = yield* Semaphore.make(1);
  // Starts run in the host's scope rather than the caller's: a client that
  // disconnects while a session boots leaves it running and tracked, and
  // closing the host interrupts the start, which then stops its session.
  const hostScope = yield* Effect.scope;
  let starting = 0;
  // Bumped whenever the host stops its sessions, so a start that finishes
  // afterwards stops its own session instead of leaving it untracked.
  let epoch = 0;
  let reapedAt = 0;
  let ready: DeviceHost.DeviceHostReady | null = null;

  const unavailable = (reason: string, cause?: unknown) =>
    new DeviceHostUnavailableError({
      hostId,
      hostLabel: config.label,
      reason,
      ...(cause === undefined ? {} : { cause }),
    });

  const api: Effect.Effect<ExpoApi, DeviceHostUnavailableError> = resolveExpoCredential(
    config.accessToken,
  ).pipe(
    Effect.map((credential) => makeExpoApi(http, credential)),
    Effect.provide(services),
    Effect.mapError((error) => unavailable(error.message, error)),
  );

  /** A missing ledger is empty; an unreadable one is an error, never an empty list. */
  const readLedger = fs.readFileString(ledgerPath).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed("[]"),
    ),
    Effect.flatMap(decodeLedger),
    Effect.mapError((cause) =>
      unavailable(
        `The record of running EAS sessions at ${ledgerPath} could not be read. Fix or remove it.`,
        cause,
      ),
    ),
  );
  const writeLedger = (
    update: (entries: ReadonlyArray<LedgerEntry>) => ReadonlyArray<LedgerEntry>,
  ) =>
    Effect.gen(function* () {
      const entries = update(yield* readLedger);
      yield* writeFileStringAtomically({
        filePath: ledgerPath,
        contents: encodeLedger(entries),
      }).pipe(
        Effect.provide(services),
        Effect.mapError((cause) =>
          unavailable(
            `The record of running EAS sessions at ${ledgerPath} could not be written.`,
            cause,
          ),
        ),
      );
    }).pipe(ledgerLock.withPermit);
  const forgetEntry = (name: string) =>
    writeLedger((entries) => entries.filter((entry) => entry.name !== name)).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not update the EAS session record", { name, cause }),
      ),
    );

  /** Stops a session and, once Expo confirms it, drops it from the ledger. */
  const stopSession = (expo: ExpoApi, sessionId: string, name: string) =>
    expo.stop(sessionId).pipe(
      Effect.andThen(forgetEntry(name)),
      Effect.tapError((cause) =>
        Effect.logWarning("Could not stop EAS Simulator session", { sessionId, cause }),
      ),
    );

  /** Finds recorded sessions by name, so a session whose id never arrived is found too. */
  const stopRecorded = (expo: ExpoApi, entries: ReadonlyArray<LedgerEntry>) =>
    Effect.forEach(
      [...new Set(entries.map((entry) => entry.appId))],
      (appId) =>
        expo.activeSessions(appId).pipe(
          Effect.flatMap((active) =>
            Effect.forEach(
              entries.filter((entry) => entry.appId === appId),
              (entry) => {
                const running = active.filter((session) => session.name === entry.name);
                return running.length === 0
                  ? forgetEntry(entry.name)
                  : Effect.forEach(
                      running,
                      (session) => stopSession(expo, session.id, entry.name),
                      {
                        discard: true,
                      },
                    );
              },
              { discard: true },
            ),
          ),
          Effect.ignore,
        ),
      { discard: true, concurrency: 4 },
    );

  /** Sessions a previous server, or a start that failed, recorded but nothing tracks. */
  const reapLeftovers = (expo: ExpoApi) =>
    Effect.gen(function* () {
      reapedAt = yield* Clock.currentTimeMillis;
      const tracked = new Set([...sessions.values()].map((session) => session.name));
      const entries = yield* readLedger;
      yield* stopRecorded(
        expo,
        entries.filter((entry) => !tracked.has(entry.name)),
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not stop recorded EAS Simulator sessions", { cause }),
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

  const reserveSlot = startLock.withPermit(
    Effect.suspend(() => {
      if (sessions.size + starting >= config.maxConcurrentSessions) {
        return Effect.fail(
          unavailable(
            `${config.label} is limited to ${config.maxConcurrentSessions} running ${config.maxConcurrentSessions === 1 ? "session" : "sessions"}. Close one in the Device panel first.`,
          ),
        );
      }
      starting++;
      return Effect.void;
    }),
  );

  const startSession = (
    device: DeviceHost.HostDevice,
    context: DeviceHost.DeviceOpenContext | undefined,
    startedIn: number,
  ) =>
    Effect.acquireUseRelease(
      reserveSlot,
      () =>
        Effect.gen(function* () {
          const expo = yield* api;
          const appId =
            config.appId ??
            Option.getOrUndefined(
              context?.workspaceRoot
                ? yield* findEasProjectId(context.workspaceRoot).pipe(Effect.provide(services))
                : Option.none<string>(),
            );
          if (!appId) {
            return yield* unavailable(
              "No EAS project to run the session under. Choose one for this host in Settings, or open the device from a thread whose project names extra.eas.projectId in app.json or its app config.",
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
          const name = `T3 Code · ${config.label} · ${(yield* Random.nextIntBetween(0, 0xffffff)).toString(16).padStart(6, "0")}`;
          const entry = { name, appId };
          // Recorded first: a session the ledger cannot hold is never started.
          yield* writeLedger((entries) => [...entries, entry]);
          if (epoch !== startedIn) {
            yield* forgetEntry(name);
            return yield* unavailable(`${config.label} was stopped while the session started.`);
          }
          // Create runs uninterrupted (Expo's API answers within 30 seconds) and
          // the stop below is in place before anything can interrupt the start,
          // so a session Expo made is always either tracked or stopped.
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const sessionId = yield* expo
                .create({
                  appId,
                  platform: device.platform,
                  name,
                  maxRunTimeMinutes: config.maxSessionMinutes,
                  maxIdleTimeMinutes: config.idleMinutes,
                })
                .pipe(
                  // Expo may have made the session before failing to answer.
                  Effect.tapError(() => stopRecorded(expo, [entry])),
                  Effect.mapError((error) => unavailable(error.message, error)),
                );
              return yield* restore(trackSession(expo, sessionId, name, startedIn)).pipe(
                Effect.onError(() => stopSession(expo, sessionId, name).pipe(Effect.ignore)),
              );
            }),
          );
        }),
      () => Effect.sync(() => void starting--),
    );

  /** Waits for a created session and starts tracking it. */
  const trackSession = (expo: ExpoApi, sessionId: string, name: string, startedIn: number) =>
    Effect.gen(function* () {
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
      sessions.set(sessionId, {
        sessionId,
        name,
        udid,
        preview: { origin, token: endpoints.preview.token },
        agent: {
          baseUrl: endpoints.agentDevice.url,
          token: Redacted.value(endpoints.agentDevice.token),
        },
        stopping: false,
      });
      return sessionId;
    });

  const sessionFor = (deviceId: string) => Option.fromNullishOr(sessions.get(deviceId));

  const forget = (session: RunningSession) =>
    Effect.sync(() => {
      sessions.delete(session.sessionId);
      checkedAt.delete(session.sessionId);
    });

  /**
   * Expo ends sessions on its own at their run or idle limit; stop listing
   * those. A stop that failed earlier is retried, and recorded sessions nothing
   * tracks are reaped now and then.
   */
  const dropEnded = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const stale = [...sessions.values()].filter(
      (session) =>
        session.stopping || now - (checkedAt.get(session.sessionId) ?? 0) > STATUS_TTL_MS,
    );
    const reapDue = now - reapedAt > REAP_INTERVAL_MS;
    if (stale.length === 0 && !reapDue) return;
    const expo = yield* api;
    yield* Effect.forEach(
      stale,
      (session) =>
        (session.stopping
          ? stopSession(expo, session.sessionId, session.name).pipe(Effect.andThen(forget(session)))
          : expo
              .session(session.sessionId)
              .pipe(
                Effect.flatMap((current) =>
                  current.status === "STOPPED" || current.status === "ERRORED"
                    ? forget(session).pipe(Effect.andThen(forgetEntry(session.name)))
                    : Effect.sync(() => void checkedAt.set(session.sessionId, now)),
                ),
              )
        ).pipe(Effect.ignore),
      { discard: true, concurrency: 4 },
    );
    if (reapDue) yield* reapLeftovers(expo);
  }).pipe(Effect.ignore);

  /**
   * Stops a tracked session. Until Expo confirms, it stays tracked: listed,
   * counted against the limit, and retried by the next listing.
   */
  const stopTracked = (expo: ExpoApi, session: RunningSession) =>
    Effect.suspend(() => {
      session.stopping = true;
      return stopSession(expo, session.sessionId, session.name);
    }).pipe(Effect.andThen(forget(session)));

  const devices: DeviceHost.DeviceOperations = {
    list: dropEnded.pipe(
      Effect.andThen(
        Effect.sync(() => ({
          devices: [
            ...CATALOG,
            ...[...sessions.values()].map((session): DeviceHost.HostDevice => ({
              id: session.sessionId,
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
    boot: (device, context) => {
      if (sessions.has(device.id)) return Effect.succeed(device.id);
      // Read before anything yields, so a stop that lands while the start
      // reads settings or files is seen.
      const startedIn = epoch;
      return startSession(device, context, startedIn).pipe(
        Effect.forkIn(hostScope),
        Effect.flatMap(Fiber.join),
      );
    },
    attach: () => Effect.void,
    shutdown: (device) =>
      Option.match(sessionFor(device.id), {
        onNone: () => Effect.void,
        onSome: (session) =>
          api.pipe(
            Effect.flatMap((expo) => stopTracked(expo, session)),
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
        // agent-device selects the simulator by its UDID, not the session id T3 shows.
        onSome: (session) => Effect.succeed({ ...session.agent, agentDeviceId: session.udid }),
      }),
    endsDevices: true,
  };

  /**
   * serve-sim runs at the root of each session's preview host and wants its
   * token on every request. Clients name the device by its session id; serve-sim
   * knows it by its UDID, so the id is swapped for the UDID in the path and in
   * the `device` parameter.
   */
  const upstream: NonNullable<DeviceHost.DeviceHostReady["upstream"]> = (hubPath, search) =>
    Effect.sync(() => {
      if (!hubPath.startsWith(`${SERVE_SIM_PREFIX}/`)) return null;
      const helper = /^\/vendor\/serve-sim\/helper\/([^/]+)\//.exec(hubPath);
      const deviceId = helper ? decodePathSegment(helper[1]!) : search.get("device");
      if (helper && deviceId === null) return null;
      const session =
        deviceId !== null && deviceId !== undefined
          ? sessions.get(deviceId)
          : sessions.size === 1
            ? [...sessions.values()][0]
            : undefined;
      if (!session) return null;
      const path = helper
        ? `/helper/${encodeURIComponent(session.udid)}${hubPath.slice(helper[0].length - 1)}`
        : hubPath.slice(SERVE_SIM_PREFIX.length);
      const params = new URLSearchParams(search);
      if (params.has("device")) params.set("device", session.udid);
      const query = params.size > 0 ? `?${params.toString()}` : "";
      const token = Redacted.value(session.preview.token);
      return {
        url: `${session.preview.origin}${path}${query}`,
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

  // A session whose stop fails stays tracked for the next listing to retry,
  // and stays in the ledger for the next server if this one closes first.
  const stopAll = Effect.suspend(() => {
    epoch++;
    return sessions.size === 0
      ? Effect.void
      : api.pipe(
          Effect.flatMap((expo) =>
            Effect.forEach(
              [...sessions.values()],
              (session) => stopTracked(expo, session).pipe(Effect.ignore),
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
    label: config.label,
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
