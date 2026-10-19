import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
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

const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.effect("evaluates a TypeScript app config in a monorepo app without its dependencies", () =>
  Effect.gen(function* () {
    const root = yield* workspace({
      "apps/mobile/app.config.ts": `
        import type { ExpoConfig } from "expo/config";
        const parts: string[] = ${JSON.stringify(ID_A.split("-"))};
        export default ({ config }: { config: ExpoConfig }): ExpoConfig => ({
          ...config,
          extra: { eas: { projectId: parts.join("-") } },
        });`,
      "apps/mobile/app.json": JSON.stringify({ expo: { name: "Mobile", slug: "mobile" } }),
    });
    expect(yield* findEasProjectId(root)).toEqual(Option.some(ID_A));
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("falls back to a literal project id when the config cannot run, and to app.json", () =>
  Effect.gen(function* () {
    const unrunnable = yield* workspace({
      "app.config.js": `import missing from "not-installed";\nexport default { extra: { eas: { projectId: "${ID_A}" } } };`,
    });
    expect(yield* findEasProjectId(unrunnable)).toEqual(Option.some(ID_A));
    const staticOnly = yield* workspace({
      "app.json": JSON.stringify({ expo: { extra: { eas: { projectId: ID_B } } } }),
    });
    expect(yield* findEasProjectId(staticOnly)).toEqual(Option.some(ID_B));
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
