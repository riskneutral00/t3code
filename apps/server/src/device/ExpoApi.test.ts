import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { makeExpoApi, resolveExpoCredential, type ExpoCredential } from "./ExpoApi.ts";

const header = (credential: ExpoCredential) => ({
  source: credential.source,
  name: credential.header.name,
  value: Redacted.value(credential.header.value),
});

describe("Expo credentials", () => {
  it.effect("prefer the saved token, then EXPO_TOKEN, then the eas login session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-expo-home-" });
      yield* fs.makeDirectory(path.join(home, ".expo"));
      yield* fs.writeFileString(
        path.join(home, ".expo", "state.json"),
        JSON.stringify({ auth: { sessionSecret: "session-secret", username: "julius" } }),
      );
      const resolve = (saved: string, env: NodeJS.ProcessEnv) =>
        resolveExpoCredential(saved).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, env),
          Effect.map(header),
        );
      expect(yield* resolve(" saved ", { EXPO_TOKEN: "env-token" })).toEqual({
        source: "settings",
        name: "authorization",
        value: "Bearer saved",
      });
      expect(yield* resolve("", { EXPO_TOKEN: "env-token" })).toEqual({
        source: "env",
        name: "authorization",
        value: "Bearer env-token",
      });
      expect(yield* resolve("", {})).toEqual({
        source: "eas-login",
        name: "expo-session",
        value: "session-secret",
      });
      yield* fs.writeFileString(
        path.join(home, ".expo", "state.json"),
        JSON.stringify({ auth: null }),
      );
      const missing = yield* resolve("", {}).pipe(Effect.exit);
      expect(Exit.isFailure(missing) && missing.cause.toString()).toContain("eas login");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Expo API", () => {
  const credential: ExpoCredential = {
    source: "eas-login",
    header: { name: "expo-session", value: Redacted.make("session-secret") },
  };

  it.effect("sends the credential and reads session endpoints once the simulator is ready", () =>
    Effect.gen(function* () {
      const requests: Array<{ headers: Record<string, string>; body: unknown }> = [];
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const body =
            request.body._tag === "Uint8Array"
              ? (JSON.parse(new TextDecoder().decode(request.body.body)) as { variables: unknown })
              : null;
          requests.push({ headers: request.headers, body });
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              data: {
                deviceRunSessions: {
                  byId: {
                    id: "session-1",
                    status: "IN_PROGRESS",
                    remoteConfig: {
                      __typename: "AgentDeviceRunSessionRemoteConfig",
                      agentDeviceRemoteSessionUrl: "https://agent.test",
                      agentDeviceRemoteSessionToken: "agent-token",
                      webPreviewToken: "preview-token",
                      previewApiUrl: "https://preview.test?token=preview-token",
                    },
                  },
                },
              },
            }),
          );
        }),
      );
      const session = yield* makeExpoApi(http, credential).session("session-1");
      expect(requests[0]?.headers["expo-session"]).toBe("session-secret");
      expect(requests[0]?.body).toMatchObject({ variables: { id: "session-1" } });
      expect(session.status).toBe("IN_PROGRESS");
      expect(session.endpoints?.agentDevice.url).toBe("https://agent.test");
      expect(Redacted.value(session.endpoints!.agentDevice.token)).toBe("agent-token");
      expect(session.endpoints?.preview?.url).toBe("https://preview.test?token=preview-token");
      expect(Redacted.value(session.endpoints!.preview!.token)).toBe("preview-token");
    }),
  );

  it.effect("keeps the credential out of errors when Expo is unreachable", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              description: "connection reset",
            }),
          }),
        ),
      );
      const error = yield* makeExpoApi(http, credential).viewer.pipe(Effect.flip);
      expect(error.message).toContain("Expo's API is unreachable");
      expect(JSON.stringify(error)).not.toContain("session-secret");
      expect(error.cause).toBeUndefined();
    }),
  );

  it.effect("reports GraphQL errors and rejected credentials as Expo failures", () =>
    Effect.gen(function* () {
      const respond = (response: Response) =>
        HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response)));
      const graphQl = yield* makeExpoApi(
        respond(Response.json({ errors: [{ message: "Feature not enabled" }] })),
        credential,
      )
        .availability("app-1")
        .pipe(Effect.flip);
      expect(graphQl.message).toBe(
        "Expo could not check EAS Simulator access: Feature not enabled",
      );
      const rejected = yield* makeExpoApi(respond(new Response("no", { status: 401 })), credential)
        .stop("session-1")
        .pipe(Effect.flip);
      expect(rejected.message).toBe(
        "Expo could not stop a simulator session: the eas login session was rejected (HTTP 401)",
      );
    }),
  );
});
