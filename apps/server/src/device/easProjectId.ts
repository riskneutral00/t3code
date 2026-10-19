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
// Good enough for config files: a `//` inside a string literal is rare, and
// a missed comment only makes the answer ambiguous, never wrong.
const COMMENTS = /\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm;

/** The one project id a config's code names; none when it names several. */
const literalProjectId = (source: string) => {
  const ids = new Set(
    [...source.replace(COMMENTS, "$1").matchAll(LITERAL_PROJECT_ID)].map((match) =>
      match[1]!.toLowerCase(),
    ),
  );
  return ids.size === 1 ? Option.some([...ids][0]!) : Option.none<string>();
};

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
 * Read, never run: a dynamic config is the project's own code, which an agent
 * may have written, so only a literal `projectId` in it, outside comments, or
 * in app.config.json or app.json counts.
 */
const projectIdOf = Effect.fn("easProjectId.projectIdOf")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configFile = yield* Effect.findFirst(CONFIG_FILES, (file) =>
    fs.exists(path.join(dir, file)).pipe(Effect.orElseSucceed(() => false)),
  );
  if (Option.isSome(configFile)) {
    const source = yield* fs
      .readFileString(path.join(dir, configFile.value))
      .pipe(Effect.orElseSucceed(() => ""));
    const literal = literalProjectId(source);
    if (Option.isSome(literal)) return literal;
  }
  for (const file of JSON_CONFIG_FILES) {
    const json = yield* fs.readFileString(path.join(dir, file)).pipe(Effect.option);
    const id = Option.flatMap(json, decodeAppJson).pipe(
      Option.flatMap((value) => Option.fromNullishOr(value.expo?.extra?.eas?.projectId)),
      Option.filter((id) => UUID.test(id)),
    );
    if (Option.isSome(id)) return id;
  }
  return Option.none<string>();
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
