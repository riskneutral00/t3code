import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const CONFIG_FILES = [
  "app.config.ts",
  "app.config.mts",
  "app.config.js",
  "app.config.mjs",
  "app.config.cjs",
];
const JSON_CONFIG_FILES = ["app.config.json", "app.json"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LITERAL_PROJECT_ID =
  /projectId["']?\s*:\s*["'`]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["'`]/gi;

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

/**
 * The project ids a directory's app config names. Read, never run: a dynamic
 * config is the project's own code, which an agent may have written. Its text
 * is taken as it is, comments included, so an old id left in a comment makes
 * the answer ambiguous rather than wrong. app.config.json and app.json count
 * only when the dynamic config never mentions a project id, since it may
 * replace theirs.
 */
const projectIdsOf = Effect.fn("easProjectId.projectIdsOf")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configFile = yield* Effect.findFirst(CONFIG_FILES, (file) =>
    fs.exists(path.join(dir, file)).pipe(Effect.orElseSucceed(() => false)),
  );
  if (Option.isSome(configFile)) {
    const source = yield* fs
      .readFileString(path.join(dir, configFile.value))
      .pipe(Effect.orElseSucceed(() => "projectId"));
    if (/projectId/i.test(source)) {
      return [...source.matchAll(LITERAL_PROJECT_ID)].map((match) => match[1]!.toLowerCase());
    }
  }
  for (const file of JSON_CONFIG_FILES) {
    const json = yield* fs.readFileString(path.join(dir, file)).pipe(Effect.option);
    const id = Option.flatMap(json, decodeAppJson).pipe(
      Option.flatMap((value) => Option.fromNullishOr(value.expo?.extra?.eas?.projectId)),
      Option.filter((id) => UUID.test(id)),
    );
    if (Option.isSome(id)) return [id.value.toLowerCase()];
  }
  return [];
});

/**
 * The EAS project of a workspace's Expo app: its root, or one app below
 * `apps/` or `packages/`. None when there is none, a config is ambiguous, or
 * the apps disagree, so the caller asks for an explicit choice instead of
 * billing the wrong project.
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
  const ids = yield* Effect.forEach(directories, projectIdsOf, { concurrency: 4 });
  const distinct = new Set(ids.flat());
  return distinct.size === 1 ? Option.some([...distinct][0]!) : Option.none<string>();
});
