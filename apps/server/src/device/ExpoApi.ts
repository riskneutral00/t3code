/**
 * Expo's GraphQL API for EAS Simulator sessions. The operations are the ones
 * eas-cli's hidden `simulator:*` commands use; Expo has no public schema for
 * them, so responses are decoded here instead of generated from SDL.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";

const EXPO_GRAPHQL_URL = "https://api.expo.dev/graphql";
const REQUEST_TIMEOUT = "30 seconds";

export type ExpoCredentialSource = "settings" | "env" | "eas-login";

export interface ExpoCredential {
  readonly source: ExpoCredentialSource;
  readonly header: {
    readonly name: "authorization" | "expo-session";
    readonly value: Redacted.Redacted<string>;
  };
}

export class ExpoNotSignedInError extends Schema.TaggedError<ExpoNotSignedInError>()(
  "ExpoNotSignedInError",
  {},
) {
  override get message(): string {
    return "No Expo credential on the server: save an access token for this host, set EXPO_TOKEN, or run `eas login`.";
  }
}

export class ExpoApiError extends Schema.TaggedError<ExpoApiError>()("ExpoApiError", {
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Expo could not ${this.operation}${this.detail ? `: ${this.detail}` : "."}`;
  }
}

/** `eas login` and `expo login` keep the session secret here. */
const ExpoState = Schema.fromJsonString(
  Schema.Struct({
    auth: Schema.optional(
      Schema.NullOr(
        Schema.Struct({ sessionSecret: Schema.optional(Schema.NullOr(Schema.String)) }),
      ),
    ),
  }),
);
const decodeExpoState = Schema.decodeUnknownOption(ExpoState);

/** A token saved for the host, then EXPO_TOKEN, then the `eas login` session. */
export const resolveExpoCredential = Effect.fn("ExpoApi.resolveExpoCredential")(function* (
  savedToken: string,
) {
  const saved = savedToken.trim();
  if (saved !== "") {
    return {
      source: "settings",
      header: { name: "authorization", value: Redacted.make(`Bearer ${saved}`) },
    } satisfies ExpoCredential;
  }
  const fromEnv = (yield* HostProcess.Environment).EXPO_TOKEN?.trim();
  if (fromEnv) {
    return {
      source: "env",
      header: { name: "authorization", value: Redacted.make(`Bearer ${fromEnv}`) },
    } satisfies ExpoCredential;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statePath = path.join(yield* HostProcess.HomeDirectory, ".expo", "state.json");
  const state = yield* fs.readFileString(statePath).pipe(Effect.option);
  const secret = Option.flatMap(state, decodeExpoState).pipe(
    Option.flatMap((value) => Option.fromNullishOr(value.auth?.sessionSecret?.trim() || null)),
  );
  if (Option.isNone(secret)) return yield* new ExpoNotSignedInError();
  return {
    source: "eas-login",
    header: { name: "expo-session", value: Redacted.make(secret.value) },
  } satisfies ExpoCredential;
});

const SessionStatus = Schema.Literals([
  "NEW",
  "QUEUED",
  "STARTING",
  "IN_PROGRESS",
  "STOPPED",
  "ERRORED",
]);
export type EasSessionStatus = typeof SessionStatus.Type;

const RemoteConfig = Schema.Struct({
  agentDeviceRemoteSessionUrl: Schema.String,
  agentDeviceRemoteSessionToken: Schema.String,
  webPreviewToken: Schema.NullOr(Schema.String),
  previewApiUrl: Schema.NullOr(Schema.String),
});

const Session = Schema.Struct({
  id: Schema.String,
  status: SessionStatus,
  remoteConfig: Schema.NullOr(Schema.Union([RemoteConfig, Schema.Struct({})])),
});

export interface EasSession {
  readonly id: string;
  readonly status: EasSessionStatus;
  /** Present once the simulator is ready; tokens grant full device control. */
  readonly endpoints: {
    readonly agentDevice: { readonly url: string; readonly token: Redacted.Redacted<string> };
    readonly preview: { readonly url: string; readonly token: Redacted.Redacted<string> } | null;
  } | null;
}

export interface EasApp {
  readonly id: string;
  readonly fullName: string;
}

export interface CreateEasSessionInput {
  readonly appId: string;
  readonly platform: "ios" | "android";
  readonly name: string;
  readonly maxRunTimeMinutes: number;
  readonly maxIdleTimeMinutes: number;
}

const QUERIES = {
  viewer: `query T3ExpoViewer {
  meActor {
    __typename
    ... on UserActor { username }
    ... on Robot { firstName }
    accounts { name appsPaginated(first: 100) { edges { node { id fullName } } } }
  }
}`,
  availability: `query T3EasSimulatorAvailability($appId: String!, $filter: [String!]) {
  app { byId(appId: $appId) { ownerAccount { name accountFeatureGates(filter: $filter) } } }
}`,
  create: `mutation T3CreateEasSimulatorSession($input: CreateDeviceRunSessionInput!) {
  deviceRunSession { createDeviceRunSession(deviceRunSessionInput: $input) { id } }
}`,
  session: `query T3EasSimulatorSession($id: ID!) {
  deviceRunSessions {
    byId(deviceRunSessionId: $id) {
      id
      status
      remoteConfig {
        ... on AgentDeviceRunSessionRemoteConfig {
          agentDeviceRemoteSessionUrl
          agentDeviceRemoteSessionToken
          webPreviewToken
          previewApiUrl
        }
      }
    }
  }
}`,
  activeSessions: `query T3ActiveEasSimulatorSessions($appId: String!, $filter: DeviceRunSessionFilterInput) {
  app { byId(appId: $appId) { deviceRunSessionsPaginated(first: 50, filter: $filter) { edges { node { id status name } } } } }
}`,
  stop: `mutation T3StopEasSimulatorSession($id: ID!) {
  deviceRunSession { ensureDeviceRunSessionStopped(deviceRunSessionId: $id) { id status } }
}`,
} as const;

const ViewerData = Schema.Struct({
  meActor: Schema.Struct({
    __typename: Schema.String,
    username: Schema.optional(Schema.String),
    firstName: Schema.optional(Schema.NullOr(Schema.String)),
    accounts: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        appsPaginated: Schema.Struct({
          edges: Schema.Array(
            Schema.Struct({ node: Schema.Struct({ id: Schema.String, fullName: Schema.String }) }),
          ),
        }),
      }),
    ),
  }),
});
const AvailabilityData = Schema.Struct({
  app: Schema.Struct({
    byId: Schema.Struct({
      ownerAccount: Schema.Struct({
        name: Schema.String,
        accountFeatureGates: Schema.Record(Schema.String, Schema.Boolean),
      }),
    }),
  }),
});
const CreateData = Schema.Struct({
  deviceRunSession: Schema.Struct({ createDeviceRunSession: Schema.Struct({ id: Schema.String }) }),
});
const SessionData = Schema.Struct({ deviceRunSessions: Schema.Struct({ byId: Session }) });
const ActiveSessionsData = Schema.Struct({
  app: Schema.Struct({
    byId: Schema.Struct({
      deviceRunSessionsPaginated: Schema.Struct({
        edges: Schema.Array(
          Schema.Struct({
            node: Schema.Struct({
              id: Schema.String,
              status: SessionStatus,
              name: Schema.NullOr(Schema.String),
            }),
          }),
        ),
      }),
    }),
  }),
});
const StopData = Schema.Struct({
  deviceRunSession: Schema.Struct({
    ensureDeviceRunSessionStopped: Schema.Struct({ id: Schema.String, status: SessionStatus }),
  }),
});

const GraphQlResponse = Schema.Struct({
  data: Schema.optional(Schema.Unknown),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});

const DEVICE_RUN_SESSIONS_GATE = "device-run-sessions";

/** Typed calls against Expo's API with one resolved credential. */
export const makeExpoApi = (http: HttpClient.HttpClient, credential: ExpoCredential) => {
  const client = http.pipe(HttpClient.withScope);
  const call = <A, I>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
    data: Schema.Codec<A, I>,
  ) => {
    const failure = (detail?: string, cause?: unknown) =>
      new ExpoApiError({
        operation,
        ...(detail === undefined ? {} : { detail }),
        ...(cause === undefined ? {} : { cause }),
      });
    return Effect.gen(function* () {
      const request = yield* HttpClientRequest.post(EXPO_GRAPHQL_URL).pipe(
        HttpClientRequest.setHeader(
          credential.header.name,
          Redacted.value(credential.header.value),
        ),
        HttpClientRequest.bodyJson({ query, variables }),
        // HTTP errors hold the request, whose credential header must not reach logs.
        Effect.mapError(() => failure("the request could not be encoded")),
      );
      const response = yield* client
        .execute(request)
        .pipe(
          Effect.mapError((error) => failure(`Expo's API is unreachable (${error.reason._tag})`)),
        );
      if (response.status === 401 || response.status === 403) {
        const what = credential.source === "eas-login" ? "eas login session" : "access token";
        return yield* failure(`the ${what} was rejected (HTTP ${response.status})`);
      }
      const body = yield* HttpClientResponse.schemaBodyJson(GraphQlResponse)(response).pipe(
        Effect.mapError(() => failure(`unexpected response (HTTP ${response.status})`)),
      );
      if (body.errors?.length) {
        return yield* failure(body.errors.map((error) => error.message).join("; "));
      }
      return yield* Schema.decodeUnknownEffect(data)(body.data).pipe(
        Effect.mapError((cause) => failure("unexpected response", cause)),
      );
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(failure("Expo's API did not answer in time")),
      }),
      Effect.withSpan(`ExpoApi.${operation}`),
    );
  };

  const toSession = (session: typeof Session.Type): EasSession => {
    const remote = session.remoteConfig;
    return {
      id: session.id,
      status: session.status,
      endpoints:
        remote && "agentDeviceRemoteSessionUrl" in remote
          ? {
              agentDevice: {
                url: remote.agentDeviceRemoteSessionUrl,
                token: Redacted.make(remote.agentDeviceRemoteSessionToken),
              },
              preview:
                remote.previewApiUrl && remote.webPreviewToken
                  ? { url: remote.previewApiUrl, token: Redacted.make(remote.webPreviewToken) }
                  : null,
            }
          : null,
    };
  };

  return {
    credential,
    viewer: call("read the signed-in account", QUERIES.viewer, {}, ViewerData).pipe(
      Effect.map(({ meActor }) => ({
        name: meActor.username ?? meActor.firstName ?? meActor.__typename,
        apps: meActor.accounts.flatMap((account) =>
          account.appsPaginated.edges.map(({ node }): EasApp => node),
        ),
      })),
    ),
    availability: (appId: string) =>
      call(
        "check EAS Simulator access",
        QUERIES.availability,
        { appId, filter: [DEVICE_RUN_SESSIONS_GATE] },
        AvailabilityData,
      ).pipe(
        Effect.map(({ app }) => ({
          account: app.byId.ownerAccount.name,
          available: app.byId.ownerAccount.accountFeatureGates[DEVICE_RUN_SESSIONS_GATE] === true,
        })),
      ),
    create: (input: CreateEasSessionInput) =>
      call(
        "start a simulator session",
        QUERIES.create,
        {
          input: {
            appId: input.appId,
            platform: input.platform === "ios" ? "IOS" : "ANDROID",
            type: "AGENT_DEVICE",
            name: input.name,
            maxRunTimeMinutes: input.maxRunTimeMinutes,
            maxIdleTimeMinutes: input.maxIdleTimeMinutes,
            // Expo only issues the preview host's API URL when preview access is configured.
            corsOrigins: ["http://localhost"],
          },
        },
        CreateData,
      ).pipe(Effect.map(({ deviceRunSession }) => deviceRunSession.createDeviceRunSession.id)),
    session: (id: string) =>
      call("read a simulator session", QUERIES.session, { id }, SessionData).pipe(
        Effect.map(({ deviceRunSessions }) => toSession(deviceRunSessions.byId)),
      ),
    activeSessions: (appId: string) =>
      call(
        "list simulator sessions",
        QUERIES.activeSessions,
        { appId, filter: { statuses: ["NEW", "QUEUED", "STARTING", "IN_PROGRESS"] } },
        ActiveSessionsData,
      ).pipe(
        Effect.map(({ app }) => app.byId.deviceRunSessionsPaginated.edges.map(({ node }) => node)),
      ),
    stop: (id: string) =>
      call("stop a simulator session", QUERIES.stop, { id }, StopData).pipe(
        Effect.map(({ deviceRunSession }) => deviceRunSession.ensureDeviceRunSessionStopped.status),
      ),
  };
};

export type ExpoApi = ReturnType<typeof makeExpoApi>;
