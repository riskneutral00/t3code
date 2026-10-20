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
// A `projectId` whose whole value is one quoted string: the entry ends at the
// quote, then after any space and comments a separator or the end of the
// file; an operator may follow a line break or a comment. A comment is
// matched whole (a line comment through its line break), so a separator
// inside one cannot end the entry. An EAS project id is a UUID; another
// service's (Firebase's, say) is not, and names no EAS project.
const QUOTED_PROJECT_ID =
  /\bprojectId["']?\s*:\s*["'`]([^"'`\n]*)["'`](?=(?:\s|\/\/[^\n\r\u2028\u2029]*(?:[\n\r\u2028\u2029]|$)|\/\*(?:[^*]|\*(?!\/))*\*\/)*(?:[,;})\]]|$))/gi;
const PROJECT_ID_MENTION = /\bprojectId\b/gi;

/** Whether a spread follows the entry at `from` in its object, which may replace it. */
const spreadFollows = (source: string, from: number): boolean => {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const char = source[i];
    if (char === "{" || char === "(" || char === "[") depth++;
    else if (char === "}" || char === ")" || char === "]") {
      if (depth === 0) return false;
      depth--;
    } else if (depth === 0 && source.startsWith("...", i)) return true;
  }
  return false;
};

const Extra = Schema.optional(
  Schema.Struct({
    eas: Schema.optional(Schema.Struct({ projectId: Schema.optional(Schema.String) })),
  }),
);
// Expo reads a static config wrapped in `expo` or not, and as JSON5; one
// this cannot decode (comments, say) still names a project, unknown here.
const decodeAppJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ expo: Schema.optional(Schema.Struct({ extra: Extra })), extra: Extra }),
  ),
);

/**
 * The project ids a directory's app config names. Read, never run: a dynamic
 * config is the project's own code, which an agent may have written. Its text
 * is taken as it is, comments included, so an old id left in a comment makes
 * the answer ambiguous rather than wrong. app.config.json or app.json count
 * too: a dynamic config may only replace theirs on some builds. Null when
 * the project is unknown: the config sets or changes it some other way than
 * a literal, or a config cannot be read.
 */
const projectIdsOf = Effect.fn("easProjectId.projectIdsOf")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ids: Array<string> = [];
  const configFile = yield* Effect.findFirst(CONFIG_FILES, (file) =>
    fs.exists(path.join(dir, file)).pipe(Effect.orElseSucceed(() => false)),
  );
  if (Option.isSome(configFile)) {
    const source = yield* fs
      .readFileString(path.join(dir, configFile.value))
      .pipe(Effect.orElseSucceed(() => "projectId"));
    // Every mention of `projectId` must be a quoted entry: one set from a
    // variable, or assigned later, could be any project, and makes the
    // answer unknown.
    const mentions = source.match(PROJECT_ID_MENTION)?.length ?? 0;
    const entries = [...source.matchAll(QUOTED_PROJECT_ID)];
    const quoted = entries.map((match) => match[1]!);
    // A template that interpolates could be any project too, and so could a
    // spread after the entry in its object.
    if (
      quoted.length !== mentions ||
      quoted.some((id) => id.includes("${")) ||
      entries.some((match) => spreadFollows(source, match.index + match[0].length))
    ) {
      return null;
    }
    ids.push(...quoted.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()));
  }
  for (const file of JSON_CONFIG_FILES) {
    const json = yield* fs.readFileString(path.join(dir, file)).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.succeed(error.reason._tag === "NotFound" ? Option.none<string>() : null),
      ),
    );
    // A config that is there but cannot be read could name any project.
    if (json === null) return null;
    if (Option.isNone(json)) continue;
    const decoded = decodeAppJson(json.value);
    if (Option.isNone(decoded)) return null;
    const id = (decoded.value.expo ?? decoded.value).extra?.eas?.projectId;
    if (id !== undefined && UUID.test(id)) ids.push(id.toLowerCase());
    // Expo reads only the first static config it finds.
    break;
  }
  return ids;
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
  const isDirectory = (child: string) =>
    fs.stat(child).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
  // Only a directory can be an app; a README or .DS_Store beside them is not one.
  const children = (parent: string) =>
    fs.readDirectory(path.join(workspaceRoot, parent)).pipe(
      Effect.map((names) => names.map((name) => path.join(workspaceRoot, parent, name))),
      Effect.flatMap((paths) =>
        Effect.forEach(paths, (child) =>
          Effect.map(isDirectory(child), (directory) => (directory ? [child] : [])),
        ),
      ),
      Effect.map((kept) => kept.flat()),
      Effect.orElseSucceed(() => []),
    );
  const directories = [
    workspaceRoot,
    ...(yield* children("apps")),
    ...(yield* children("packages")),
  ];
  const ids = yield* Effect.forEach(directories, projectIdsOf, { concurrency: 4 });
  // An app whose project is unknown could be the one the thread works on.
  if (ids.some((found) => found === null)) return Option.none<string>();
  const distinct = new Set(ids.flatMap((found) => found ?? []));
  return distinct.size === 1 ? Option.some([...distinct][0]!) : Option.none<string>();
});
