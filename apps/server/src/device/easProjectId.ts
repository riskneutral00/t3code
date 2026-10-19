import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";

import * as ProcessRunner from "../processRunner.ts";

const CONFIG_FILES = [
  "app.config.ts",
  "app.config.mts",
  "app.config.js",
  "app.config.mjs",
  "app.config.cjs",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LITERAL_PROJECT_ID =
  /projectId["']?\s*:\s*["'`]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["'`]/i;
const EVALUATION_TIMEOUT = Duration.seconds(10);

/**
 * Runs the app config the way Expo does (app.json as the base, then the
 * dynamic config's default export) but skips plugin resolution, so a checkout
 * with stale dependencies still answers. Node strips TypeScript types itself.
 */
const EVALUATE = `
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const [dir, file] = process.argv.slice(-2);
const json = join(dir, "app.json");
const base = existsSync(json) ? JSON.parse(readFileSync(json, "utf8")) : {};
const baseConfig = base.expo ?? base;
const mod = await import(pathToFileURL(join(dir, file)).href);
const exported = mod.default ?? mod;
let config = typeof exported === "function" ? await exported({ config: baseConfig, projectRoot: dir }) : exported;
config = config?.expo ?? config;
process.stdout.write(JSON.stringify({ projectId: config?.extra?.eas?.projectId ?? null }));
`;

const decodeEvaluated = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ projectId: Schema.NullOr(Schema.String) })),
);
const decodeAppJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      expo: Schema.optional(
        Schema.Struct({
          extra: Schema.optional(
            Schema.Struct({
              eas: Schema.optional(Schema.Struct({ projectId: Schema.optional(Schema.String) })),
            }),
          ),
        }),
      ),
    }),
  ),
);

const projectIdOf = Effect.fn("easProjectId.projectIdOf")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const configFile = yield* Effect.findFirst(CONFIG_FILES, (file) =>
    fs.exists(path.join(dir, file)).pipe(Effect.orElseSucceed(() => false)),
  );
  if (Option.isSome(configFile)) {
    const node = yield* resolveNodeExecutable("Device automation").pipe(Effect.option);
    const environment = yield* HostProcess.Environment;
    const evaluated = Option.isNone(node)
      ? Option.none()
      : yield* runner
          .run({
            command: node.value,
            args: ["--input-type=module", "--eval", EVALUATE, dir, configFile.value],
            cwd: dir,
            // The config is the project's own code; it gets no server credentials.
            env: {
              PATH: environment.PATH,
              HOME: environment.HOME,
              USERPROFILE: environment.USERPROFILE,
              NODE_NO_WARNINGS: "1",
            },
            timeout: EVALUATION_TIMEOUT,
            timeoutBehavior: "timedOutResult",
          })
          .pipe(
            Effect.map((result) =>
              result.code === 0 && !result.timedOut
                ? decodeEvaluated(result.stdout).pipe(
                    Option.flatMap((value) => Option.fromNullishOr(value.projectId)),
                  )
                : Option.none(),
            ),
            Effect.orElseSucceed(() => Option.none<string>()),
          );
    if (Option.isSome(evaluated) && UUID.test(evaluated.value)) return evaluated;
    const source = yield* fs
      .readFileString(path.join(dir, configFile.value))
      .pipe(Effect.orElseSucceed(() => ""));
    const literal = LITERAL_PROJECT_ID.exec(source)?.[1];
    if (literal) return Option.some(literal);
  }
  const appJson = yield* fs.readFileString(path.join(dir, "app.json")).pipe(Effect.option);
  return Option.flatMap(appJson, decodeAppJson).pipe(
    Option.flatMap((value) => Option.fromNullishOr(value.expo?.extra?.eas?.projectId)),
    Option.filter((id) => UUID.test(id)),
  );
});

/**
 * The EAS project of a workspace's Expo app: its root, or one app below
 * `apps/` or `packages/`. None when there is none or the apps disagree, so the
 * caller asks for an explicit choice instead of billing the wrong project.
 */
export const findEasProjectId = Effect.fn("easProjectId.findEasProjectId")(function* (
  workspaceRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const children = (parent: string) =>
    fs.readDirectory(path.join(workspaceRoot, parent)).pipe(
      Effect.map((names) => names.map((name) => path.join(workspaceRoot, parent, name))),
      Effect.orElseSucceed(() => []),
    );
  const directories = [
    workspaceRoot,
    ...(yield* children("apps")),
    ...(yield* children("packages")),
  ];
  const ids = yield* Effect.forEach(directories, projectIdOf, { concurrency: 4 });
  const distinct = new Set(
    ids.flatMap((id) => (Option.isSome(id) ? [id.value.toLowerCase()] : [])),
  );
  return distinct.size === 1 ? Option.some([...distinct][0]!) : Option.none();
});
