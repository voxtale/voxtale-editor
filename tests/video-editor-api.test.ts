import { expect, test } from "bun:test";
import { EDITDOC_VERSION, newEditDoc } from "@voxtale/editdoc";
import { editorApi } from "../src/video/editor/api";
import type { UserOps } from "../src/video/editor/state";

test("an edit stored before a schema bump reaches the client upgraded", async () => {
  const doc = newEditDoc({ id: "ed1", name: "Cut", clips: [] });
  const v2 = { ...doc, version: 2, tracks: { ...doc.tracks, zoom: undefined } };
  const ops = { edit: async () => ({ name: "Cut", status: "ready", revision: 1, clipHashes: [], docKey: "k" }) } as unknown as UserOps;
  const blobs = { getText: async () => JSON.stringify(v2) } as unknown as Parameters<typeof editorApi>[0]["blobs"];
  const { doc: sent } = (await editorApi({ ops, blobs }).edit("ed1")) as { doc: { version: number; tracks: { zoom: unknown } } };
  expect(sent.version).toBe(EDITDOC_VERSION);
  expect(sent.tracks.zoom).toEqual([]);
});
