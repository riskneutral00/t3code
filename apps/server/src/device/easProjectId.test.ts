import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { findEasProjectId } from "./easProjectId.ts";

const ID_A = "d763fcb8-d37c-41ea-a773-b54a0ab4a454";
const ID_B = "54d70eaf-b0a3-477a-a9cd-2cf81a5c84c9";

const workspace = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-eas-project-" });
    for (const [file, content] of Object.entries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
      yield* fs.writeFileString(path.join(root, file), content);
    }
    return root;
  });

const layer = NodeServices.layer;

it.effect("reads a literal project id from an app config without running it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* workspace({});
    const marker = path.join(root, "config-ran");
    yield* fs.makeDirectory(path.join(root, "apps/mobile"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, "apps/mobile/app.config.ts"),
      `import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(marker)}, "");
      export default { extra: { eas: { projectId: "${ID_A}" } } };`,
    );
    expect(yield* findEasProjectId(root)).toEqual(Option.some(ID_A));
    expect(yield* fs.exists(marker)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("falls back to app.json, and does not compute a project id a config builds", () =>
  Effect.gen(function* () {
    const staticOnly = yield* workspace({
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    });
    expect(yield* findEasProjectId(staticOnly)).toEqual(Option.some(ID_B));
    const computed = yield* workspace({
      "app.config.ts": `const parts = ${JSON.stringify(ID_A.split("-"))};
        export default { extra: { eas: { projectId: parts.join("-") } } };`,
    });
    expect(yield* findEasProjectId(computed)).toEqual(Option.none());
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect.each([
  {
    case: "skips a project id in a comment",
    config: `// projectId: "${ID_B}" (the old production project)
      /* extra: { eas: { projectId: "${ID_B}" } } */
      export default { extra: { eas: { projectId: "${ID_A}" } }, url: "https://expo.dev" };`,
    expected: Option.some(ID_A),
  },
  {
    case: "gives no answer when the config names two projects",
    config: `export default ({ config }) => ({
        extra: { eas: { projectId: process.env.PROD ? "${ID_A}" : "${ID_B}" } },
      });`,
    expected: Option.none(),
  },
])("$case", ({ config, expected }) =>
  Effect.gen(function* () {
    expect(yield* findEasProjectId(yield* workspace({ "app.config.js": config }))).toEqual(
      expected,
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("reads app.config.json like app.json", () =>
  Effect.gen(function* () {
    const root = yield* workspace({
      "app.config.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    });
    expect(yield* findEasProjectId(root)).toEqual(Option.some(ID_B));
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("does not guess between apps that name different EAS projects", () =>
  Effect.gen(function* () {
    const root = yield* workspace({
      "apps/one/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_A } } } }),
      "apps/two/app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    });
    expect(yield* findEasProjectId(root)).toEqual(Option.none());
    expect(yield* findEasProjectId(yield* workspace({ "README.md": "no app" }))).toEqual(
      Option.none(),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
