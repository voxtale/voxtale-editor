import { describe, expect, test } from "bun:test";
import {
  EditDocError, PolicyError, STYLE_PRESETS, ShotDetector, acceptSuggestion, applyCreatorPatch, applyCreatorRevision, applyStagePatch,
  assertCompatibleMajor, briefBeatSchema, buildCaptions, captionWord, checkEditDoc, decisionsBetween, editStyleSchema, newEditDoc,
  packSequence, parseEditDoc, parseFps, rejectSuggestion, repeatsDeclined, replanPolicy, segmentsFromCuts, snap, sourceAt, outputTimes,
  toFcpxml, toFrame, toOtio, toSrt, upgradeEditDoc, withBrand, zoomAt, zoomKeysBetween, keyValue, EDITDOC_VERSION, captionLook, textLook,
  type ARollItem, type ZoomItem, type ClipRef, type EditDoc, type SourceWord, type StagePatch,
} from "@voxtale/editdoc";

const HASH = "a".repeat(64);
const clip = (id: string, over: Partial<ClipRef> = {}): ClipRef => ({
  id, hash: HASH, name: `${id}.mp4`, kind: "video", role: "a-roll", roleSource: "creator", duration: 60,
  hasAudio: true, timecodeStart: 0, ...over,
});
const stamp = { at: "2026-09-30T00:00:00.000Z", prompts: {} };
const aroll = (id: string, clipId: string, inS: number, outS: number, over: Partial<ARollItem> = {}): ARollItem => ({
  id, clipId, in: inS, out: outS, start: 0, end: outS - inS, owner: "agent", status: "applied", gainDb: 0, ...over,
});

const zoomItem = (over: Partial<ZoomItem> = {}): ZoomItem => ({
  id: "z", start: 0, end: 2, owner: "agent", status: "applied", scale: 2, x: 0.5, y: 0.5, target: "face", easeIn: 0.5, easeOut: 0.5, ...over,
});

function baseDoc(policy: Partial<EditDoc["policy"]> = {}): EditDoc {
  return newEditDoc({ id: "e1", name: "Test edit", clips: [clip("cam"), clip("br", { role: "b-roll", hasAudio: false })], policy });
}
/** Two applied a-roll items; `policy` takes effect after assembly. */
function assembled(policy: Partial<EditDoc["policy"]> = {}): EditDoc {
  const doc = baseDoc();
  const items = packSequence([aroll("a1", "cam", 1, 5), aroll("a2", "cam", 10, 14)], doc.fps);
  const out = applyStagePatch(doc, { stage: "assembly", tracks: { "a-roll": { upsert: items } }, stamp }).doc;
  return { ...out, policy: { ...out.policy, ...policy } };
}

describe("editdoc time + style", () => {
  test("fps parsing and frame snapping", () => {
    expect(parseFps("30000/1001")).toEqual({ num: 30000, den: 1001 });
    expect(parseFps(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(parseFps(25)).toEqual({ num: 25, den: 1 });
    expect(snap(1.01, { num: 30, den: 1 })).toBeCloseTo(1, 9);
    expect(toFrame(2, { num: 30000, den: 1001 })).toBe(60);
  });
  test("presets parse and withBrand does not mutate", () => {
    for (const s of Object.values(STYLE_PRESETS)) expect(editStyleSchema.parse(s)).toEqual(s);
    const branded = withBrand(STYLE_PRESETS.podcast, { colors: { primary: "#000000" } as never });
    expect(branded.brand.colors.primary).toBe("#000000");
    expect(branded.brand.colors.accent).toBe(STYLE_PRESETS.podcast.brand.colors.accent);
    expect(STYLE_PRESETS.podcast.brand.colors.primary).not.toBe("#000000");
  });
  test("package major check", () => {
    expect(() => assertCompatibleMajor(0)).not.toThrow();
    expect(() => assertCompatibleMajor(1)).toThrow(/major mismatch/);
  });
});

describe("editdoc validation", () => {
  test("blank doc is valid with empty tracks", () => {
    const doc = baseDoc();
    expect(doc.tracks["a-roll"]).toEqual([]);
    expect(checkEditDoc(doc)).toEqual([]);
  });
  test("errors: off-frame, overlap, range past clip, length mismatch, unknown clip, audio on video", () => {
    const doc = baseDoc();
    const bad = (items: ARollItem[], clips = doc.clips) => () => parseEditDoc({ ...doc, clips, tracks: { ...doc.tracks, "a-roll": items } });
    expect(bad([aroll("x", "cam", 0, 1.01, { end: 1.01 })])).toThrow(/frame boundaries/);
    expect(bad([aroll("x", "cam", 0, 2), aroll("y", "cam", 3, 5, { start: 1, end: 3 })])).toThrow(/overlap/);
    expect(bad([aroll("x", "cam", 50, 70)])).toThrow(/ends after the clip/);
    expect(bad([aroll("x", "cam", 0, 2, { end: 3 })])).toThrow(/Output length/);
    expect(bad([aroll("x", "nope", 0, 2)])).toThrow(/Unknown clip/);
    expect(bad([aroll("x", "mic", 0, 2)], [...doc.clips, clip("mic", { kind: "audio" })])).toThrow(/Audio clip/);
    expect(bad([aroll("x", "cam", 0, 2), aroll("x", "cam", 4, 6, { start: 2, end: 4 })])).toThrow(/Duplicate item/);
  });
  test("warnings: a-roll gap and chapter rules", () => {
    const doc = baseDoc();
    const { warnings } = parseEditDoc({
      ...doc,
      tracks: { ...doc.tracks, "a-roll": [aroll("x", "cam", 0, 2), aroll("y", "cam", 4, 6, { start: 3, end: 5 })] },
      markers: [{ id: "m1", time: 1, kind: "chapter", title: "Intro", owner: "agent", status: "applied" }],
    });
    const msgs = warnings.map(w => w.message).join("|");
    expect(msgs).toMatch(/Gap before y/);
    expect(msgs).toMatch(/First chapter/);
    expect(msgs).toMatch(/at least 3 chapters/);
  });
  test("EditDocError lists issues", () => {
    try { parseEditDoc({ ...baseDoc(), tracks: { "a-roll": [aroll("x", "nope", 0, 1)] } }); }
    catch (e) { expect(e).toBeInstanceOf(EditDocError); expect((e as EditDocError).issues.length).toBeGreaterThan(0); }
  });
});

describe("editdoc timeline", () => {
  test("packSequence ripples end to end on frames", () => {
    const items = packSequence([aroll("a", "cam", 1.004, 2.5), aroll("b", "cam", 7, 8)], { num: 30, den: 1 });
    expect(items.map(i => [i.start, i.end])).toEqual([[0, 1.5], [1.5, 2.5]]);
    expect(items[0]!.in).toBeCloseTo(1, 9);
  });
  test("source and output time mapping", () => {
    const doc = assembled();
    expect(sourceAt(doc, 4.5)).toEqual({ clipId: "cam", time: 10.5, itemId: "a2" });
    expect(outputTimes(doc, "cam", 11)).toEqual([5]);
    expect(outputTimes(doc, "cam", 7)).toEqual([]);
  });
  test("caption words drop edge punctuation, keep inner marks", () => {
    expect(["dramatically,", "it's", "3.5.", "$100,", "50%.", "\"quoted\"", "U.S.", "—"].map(captionWord))
      .toEqual(["dramatically", "it's", "3.5", "$100", "50%", "quoted", "U.S", ""]);
  });

  test("captions follow cuts, split on pause, sentence end and item boundary", () => {
    const doc = assembled();
    const w = (id: number, text: string, start: number, end: number): SourceWord => ({ clipId: "cam", id, text, start, end });
    const words = [
      w(1, "Hello", 1.2, 1.5), w(2, "there.", 1.5, 1.9), w(3, "Next", 2.0, 2.3), w(4, "bit", 3.2, 3.5),
      w(5, "cut", 6, 6.5), // removed by the edit
      w(6, "Later", 10.1, 10.5), w(7, "on", 10.5, 10.8),
    ];
    const caps = buildCaptions(doc, words, doc.styleRef.snapshot.brand.captionStyle);
    expect(caps.map(c => c.text)).toEqual(["Hello there", "Next", "bit", "Later on"]);
    expect(caps[0]!.id).toBe("cap-a1-1");
    expect(caps[3]!.start).toBeCloseTo(4.1, 9);
    expect(caps[3]!.words).toEqual(["cam:6", "cam:7"]);
    const withCaps = applyStagePatch(doc, { stage: "text", tracks: { captions: { upsert: caps } }, stamp }).doc;
    expect(toSrt(withCaps).split("\n").slice(0, 3)).toEqual(["1", "00:00:00,200 --> 00:00:00,900", "Hello there"]);
  });
  test("a kept word starting just before its frame-snapped in point still gets a caption", () => {
    const doc = assembled();
    const words: SourceWord[] = [
      { clipId: "cam", id: 1, text: "before", start: 9.6, end: 9.996 },
      { clipId: "cam", id: 2, text: "software", start: 9.996, end: 10.4 },
    ];
    const caps = buildCaptions(doc, words, doc.styleRef.snapshot.brand.captionStyle);
    expect(caps.map(c => c.text)).toEqual(["software"]);
    expect(caps[0]!.start).toBeCloseTo(4, 9);
  });
  test("segments: cuts own times, long shots split, stills at 30/70%", () => {
    const segs = segmentsFromCuts(50, [5, 5, 0, 60, 6.5]);
    expect(segs.map(s => [s.id, s.start, s.end])).toEqual([
      ["S001", 0, 5], ["S002", 5, 6.5], ["S003", 6.5, 21], ["S004", 21, 35.5], ["S005", 35.5, 50],
    ]);
    expect(segs[0]!.stills).toEqual([1.5, 3.5]);
    expect(segs[1]!.stills).toEqual([5.75]);
    expect(segs.every(s => s.end - s.start <= 20)).toBe(true);
    expect(segmentsFromCuts(0, [])).toEqual([]);
  });
});

describe("editdoc policy", () => {
  const patch = (over: Partial<StagePatch>): StagePatch => ({ stage: "assembly", stamp, ...over });
  test("auto applies, bumps revision and stamps provenance", () => {
    const doc = assembled();
    expect(doc.revision).toBe(1);
    expect(doc.provenance.map(p => [p.stage, p.revision])).toEqual([["assembly", 1]]);
    expect(doc.tracks["a-roll"].map(i => i.status)).toEqual(["applied", "applied"]);
  });
  test("refuses tracks the stage does not own, off and locked tracks", () => {
    const doc = baseDoc({ music: "off", "b-roll": "locked" });
    expect(() => applyStagePatch(baseDoc({ "a-roll": "off" }), patch({ tracks: { "a-roll": { upsert: [aroll("a", "cam", 0, 1)] } } }))).toThrow(/a-roll is off/);
    const b = packSequence([{ ...aroll("b1", "br", 0, 2), fit: "cover", muted: true, opacity: 1 } as never], doc.fps);
    expect(() => applyStagePatch(doc, patch({ tracks: { "b-roll": { upsert: b } } }))).toThrow(/does not own b-roll/);
    expect(() => applyStagePatch(doc, patch({ stage: "b-roll", tracks: { "b-roll": { upsert: b } } }))).toThrow(/b-roll is locked/);
    expect(() => applyStagePatch(doc, patch({ stage: "audio", tracks: { music: { upsert: [] } } }))).toThrow(/music is off/);
    expect(() => applyStagePatch(doc, patch({ brief: { source: "none", beats: [], coverage: [] } }))).toThrow(/cannot change the brief/);
    expect(() => applyStagePatch(doc, patch({ stage: "text", mix: { loudnessLufs: -16 } }))).toThrow(/cannot change the mix/);
  });
  test("never touches creator items; stage items must be agent-owned", () => {
    const doc = applyCreatorPatch(assembled(), { tracks: { "a-roll": { upsert: [{ ...assembled().tracks["a-roll"][0]!, in: 1.5, start: 0, end: 3.5 }] } } });
    expect(doc.tracks["a-roll"][0]!.owner).toBe("creator");
    const again = aroll("a1", "cam", 1, 5);
    expect(() => applyStagePatch(doc, patch({ tracks: { "a-roll": { upsert: [again] } } }))).toThrow(PolicyError);
    expect(() => applyStagePatch(doc, patch({ tracks: { "a-roll": { remove: ["a1"] } } }))).toThrow(/belongs to the creator/);
    expect(() => applyStagePatch(assembled(), patch({ tracks: { "a-roll": { upsert: [{ ...again, owner: "creator" }] } } }))).toThrow(/owner "agent"/);
  });
  test("creator look changes land in the style snapshot and mix", () => {
    const base = assembled();
    const doc = applyCreatorPatch(base, {
      style: { brand: { captionStyle: { size: 80, highlight: "#00FF88" }, colors: { accent: "#112233" } }, pace: { captions: "keywords" }, audio: { musicLevelDb: -20 } },
      mix: { duckingDb: -18 },
    });
    const s = doc.styleRef.snapshot;
    expect(s.brand.captionStyle).toMatchObject({ size: 80, highlight: "#00FF88", color: base.styleRef.snapshot.brand.captionStyle.color });
    expect(s.brand.colors.accent).toBe("#112233");
    expect(s.pace).toMatchObject({ captions: "keywords", targetCutsPerMinute: base.styleRef.snapshot.pace.targetCutsPerMinute });
    expect(s.audio.musicLevelDb).toBe(-20);
    expect(doc.mix).toMatchObject({ duckingDb: -18, loudnessLufs: base.mix.loudnessLufs });
    expect(doc.revision).toBe(base.revision + 1);
    expect(() => applyCreatorPatch(base, { style: { brand: { captionStyle: { size: 999 } } } })).toThrow();
    expect(() => applyCreatorPatch(base, { mix: { duckingDb: 5 } })).toThrow();
    expect(() => applyCreatorPatch(base, { style: { pace: { bogus: 1 } as never } })).toThrow();
  });
  test("a text's own look overrides its template; captions take the style's background", () => {
    const brand = STYLE_PRESETS["calm-explainer"].brand;
    const plain = textLook("callout", brand, 1080);
    expect(textLook("callout", brand, 1080, {})).toEqual(plain);
    const mine = textLook("callout", brand, 2160, { fontSize: 100, color: "#123456", backgroundColor: "none", fontWeight: 400 });
    expect(mine).toMatchObject({ fontSize: 200, color: "#123456", fontWeight: 400, fontFamily: plain.fontFamily });
    expect(mine.backgroundColor).toBeUndefined();
    const doc = applyCreatorPatch(assembled(), { style: { brand: { captionStyle: { background: "rgba(10,20,30,0.8)" } } } });
    expect(captionLook(doc).backgroundColor).toBe("rgba(10,20,30,0.8)");
    expect(() => applyCreatorPatch(assembled(), { style: { brand: { captionStyle: { background: "url(x)" } } } })).toThrow();
  });
  test("suggest mode and low confidence land as suggestions that replace on accept", () => {
    const doc = assembled({ "a-roll": "suggest" });
    const changed = { ...doc.tracks["a-roll"][0]!, reason: "tighter" };
    const r = applyStagePatch(doc, patch({ tracks: { "a-roll": { upsert: [changed] } } }));
    expect(r.suggested).toEqual(["a1~r2"]);
    expect(r.doc.tracks["a-roll"].find(i => i.id === "a1")!.status).toBe("applied");
    const accepted = acceptSuggestion(r.doc, "a1~r2");
    expect(accepted.tracks["a-roll"].map(i => i.id)).toEqual(["a1", "a2"]);
    expect(accepted.tracks["a-roll"][0]!.reason).toBe("tighter");
    expect(rejectSuggestion(r.doc, "a1~r2").tracks["a-roll"].map(i => i.id)).toEqual(["a1", "a2"]);

    const auto = assembled();
    const unsure = applyStagePatch(auto, patch({ tracks: { "a-roll": { upsert: [{ ...auto.tracks["a-roll"][1]!, confidence: 0.4 }] } } }));
    expect(unsure.suggested).toEqual(["a2~r2"]);
    const rm = applyStagePatch(assembled({ "a-roll": "suggest" }), patch({ tracks: { "a-roll": { remove: ["a2"] } } }));
    expect(rm.doc.tracks["a-roll"][1]!.status).toBe("remove-suggested");
    expect(acceptSuggestion(rm.doc, "a2").tracks["a-roll"].map(i => i.id)).toEqual(["a1"]);
  });
  test("the zoom stage owns the zoom track only", () => {
    const doc = assembled();
    const z = zoomItem({ id: "z1", start: 0, end: 2 });
    expect(() => applyStagePatch(doc, patch({ stage: "zoom", tracks: { "a-roll": { upsert: [{ ...doc.tracks["a-roll"][0]!, in: 1.5 }] } } }))).toThrow(PolicyError);
    const ok = applyStagePatch(doc, patch({ stage: "zoom", tracks: { zoom: { upsert: [z] } } }));
    expect(ok.applied).toEqual(["z1"]);
    // A creator's zoom is theirs; the stage may not move it.
    const mine = applyCreatorPatch(ok.doc, { tracks: { zoom: { upsert: [{ ...z, scale: 1.5 }] } } });
    expect(mine.tracks.zoom[0]!.owner).toBe("creator");
    expect(mine.tracks["a-roll"].every(i => i.owner === "agent")).toBe(true);
    expect(() => applyStagePatch(mine, patch({ stage: "zoom", tracks: { zoom: { remove: ["z1"] } } }))).toThrow(/belongs to the creator/);
  });
  test("replanPolicy locks tracks the creator mostly owns", () => {
    const doc = assembled();
    const mine = applyCreatorPatch(doc, { tracks: { "a-roll": { upsert: [doc.tracks["a-roll"][0]!] } } });
    expect(replanPolicy(mine)["a-roll"]).toBe("locked");
    expect(replanPolicy(doc)["a-roll"]).toBe("auto");
  });
});

describe("editdoc zoom track", () => {
  const near = (a: { scale: number; dx: number; dy: number }, b: { scale: number; dx: number; dy: number }) => {
    expect(a.scale).toBeCloseTo(b.scale, 5); expect(a.dx).toBeCloseTo(b.dx, 5); expect(a.dy).toBeCloseTo(b.dy, 5);
  };
  test("eases in from wide, holds, eases out", () => {
    const z = [zoomItem({ start: 1, end: 3, x: 0.25, y: 0.75 })];
    near(zoomAt(z, 0.5), { scale: 1, dx: 0, dy: 0 });
    near(zoomAt(z, 1.25), { scale: 1.5, dx: 0.125, dy: -0.125 }); // half way through the ease
    near(zoomAt(z, 2), { scale: 2, dx: 0.25, dy: -0.25 });
    expect(zoomAt(z, 2.9).scale).toBeLessThan(1.1);
    near(zoomAt(z, 3), { scale: 1, dx: 0, dy: 0 });
  });
  test("no ease = a cut; touching zooms glide without a dip; panTo drifts the focus", () => {
    const cut = [zoomItem({ easeIn: 0, easeOut: 0 })];
    expect(zoomAt(cut, 0).scale).toBe(2);
    expect(zoomAt(cut, 1.999).scale).toBe(2);
    const pair = [zoomItem({ id: "a", start: 0, end: 2, easeOut: 0.5 }), zoomItem({ id: "b", start: 2, end: 4, scale: 3, easeIn: 1 })];
    expect(zoomAt(pair, 1.9).scale).toBe(2); // no ease out: the next one touches
    expect(zoomAt(pair, 2.5).scale).toBeCloseTo(2.5, 5);
    const pan = [zoomItem({ easeIn: 0, easeOut: 0, x: 0, panTo: { x: 1, y: 0.5 } })];
    expect(zoomAt(pan, 0).dx).toBeCloseTo(0.5, 5);
    expect(zoomAt(pan, 1).dx).toBeCloseTo(0, 5);
  });
  test("keys per picture: relative times, a jump as two keys, ramps eased", () => {
    const z = [zoomItem({ start: 1, end: 3, easeIn: 0, easeOut: 0.5 })];
    const keys = zoomKeysBetween(z, 0, 4, { width: 1920, height: 1080 }).filter(k => k.property === "scale");
    expect(keys.map(k => [k.time, k.value])).toEqual([[0, 1], [1, 1], [1, 2], [2.5, 2], [3, 1], [4, 1]]);
    expect(keys.find(k => k.time === 2.5)!.easing).toBe("ease-in-out");
    expect(keyValue(keys, "scale", 2.75, 1)).toBeCloseTo(zoomAt(z, 2.75).scale, 3);
    expect(zoomKeysBetween(z, 3, 4, { width: 1920, height: 1080 })).toEqual([]);
    const shifted = zoomKeysBetween([zoomItem({ x: 0, easeIn: 0, easeOut: 0 })], 0, 2, { width: 1920, height: 1080 });
    expect(shifted.find(k => k.property === "position.x")!.value).toBe(960); // focus on the left edge: shift right by half the frame
  });
  test("validation: no overlap, eases fit inside the zoom", () => {
    const doc = baseDoc();
    const bad = (zoom: ZoomItem[]) => () => parseEditDoc({ ...doc, tracks: { ...doc.tracks, zoom } });
    expect(bad([zoomItem({ id: "a" }), zoomItem({ id: "b", start: 1, end: 3 })])).toThrow(/overlap/);
    expect(bad([zoomItem({ easeIn: 1.5, easeOut: 1 })])).toThrow(/longer than it lasts/);
    expect(bad([zoomItem({ scale: 5 })])).toThrow();
  });
  test("v2 a-roll zoom keys upgrade to zoom items on output time", () => {
    const doc = assembled();
    const [a1, a2] = doc.tracks["a-roll"];
    const v2 = { ...doc, version: 2, tracks: { ...doc.tracks, zoom: undefined, "a-roll": [
      { ...a1, zoom: [{ t: 0, scale: 1.2, x: 0.4, y: 0.3, ease: "hold" }] },
      { ...a2, zoom: [{ t: 0, scale: 1, x: 0.5, y: 0.5, ease: "in-out" }, { t: a2!.end - a2!.start, scale: 1.1, x: 0.5, y: 0.5, ease: "in-out" }] },
    ] } };
    const { doc: up } = parseEditDoc(v2);
    expect(up.version).toBe(EDITDOC_VERSION);
    expect(up.tracks["a-roll"].some(i => "zoom" in i)).toBe(false);
    expect(up.tracks.zoom).toMatchObject([
      { id: "a1-zoom", start: a1!.start, end: a1!.end, scale: 1.2, x: 0.4, y: 0.3, easeIn: 0, easeOut: 0 },
      { id: "a2-zoom", start: a2!.start, end: a2!.end, scale: 1.1, easeIn: a2!.end - a2!.start, easeOut: 0 },
    ]);
    expect(upgradeEditDoc(doc)).toBe(doc);
  });
  test("v2 upgrade: a locked a-roll keeps its zooms locked", () => {
    const doc = assembled();
    const v2 = { ...doc, version: 2, policy: { ...doc.policy, "a-roll": "locked", zoom: undefined }, tracks: { ...doc.tracks, zoom: undefined } };
    expect(parseEditDoc(v2).doc.policy.zoom).toBe("locked");
    const open = { ...v2, policy: { ...v2.policy, "a-roll": "auto" } };
    expect(parseEditDoc(open).doc.policy.zoom).toBe("auto");
  });
  test("a v2 client's a-roll upsert with zoom keys still applies; the keys are dropped", () => {
    const a1 = assembled().tracks["a-roll"][0]!;
    const doc = applyCreatorPatch(assembled(), { tracks: { "a-roll": { upsert: [{ ...a1, zoom: [{ t: 0, scale: 1.2, x: 0.5, y: 0.5, ease: "hold" }] } as typeof a1] } } });
    expect(doc.tracks["a-roll"].find(i => i.id === a1.id)).not.toHaveProperty("zoom");
  });
});

describe("editdoc decision log", () => {
  test("kept, changed, deleted, accepted, rejected", () => {
    const before = applyStagePatch(assembled({ markers: "suggest" }), {
      stage: "structure", stamp,
      markers: { upsert: [{ id: "c1", time: 0, kind: "chapter", title: "Intro", owner: "agent", status: "applied" }, { id: "c2", time: 4, kind: "chapter", title: "Two", owner: "agent", status: "applied" }] },
    }).doc;
    let after = acceptSuggestion(before, "c1");
    after = rejectSuggestion(after, "c2");
    after = applyCreatorPatch(after, { tracks: { "a-roll": { upsert: [{ ...after.tracks["a-roll"][0]!, gainDb: 3 }] } } });
    const d = decisionsBetween(before, after);
    const by = Object.fromEntries(d.map(x => [x.itemId, x]));
    expect(by.c1!.action).toBe("accepted");
    expect(by.c2!.action).toBe("rejected");
    expect(by.a1!.action).toBe("changed");
    expect(by.a1!.changedFields).toEqual(["gainDb"]);
    expect(by.a2!.action).toBe("kept");
    const deleted = applyCreatorPatch(after, { tracks: { "a-roll": { remove: ["a2"] } } });
    expect(decisionsBetween(after, deleted).find(x => x.itemId === "a2")!.action).toBe("deleted");
  });
  test("one creator save is one revision, logging only what changed", () => {
    const before = applyStagePatch(assembled({ markers: "suggest" }), {
      stage: "structure", stamp,
      markers: { upsert: [{ id: "c1", time: 0, kind: "chapter", title: "Intro", owner: "agent", status: "applied" }, { id: "c2", time: 4, kind: "chapter", title: "Two", owner: "agent", status: "applied" }] },
    }).doc;
    const { doc, decisions } = applyCreatorRevision(before, {
      accept: ["c1"], reject: ["c2"],
      patch: { tracks: { "a-roll": { upsert: [{ ...before.tracks["a-roll"][0]!, gainDb: 3 }] } } },
    });
    expect(doc.revision).toBe(before.revision + 1);
    expect(decisions.map(d => [d.itemId, d.action, d.toRevision])).toEqual(expect.arrayContaining([
      ["c1", "accepted", doc.revision], ["c2", "rejected", doc.revision], ["a1", "changed", doc.revision],
    ]));
    expect(decisions.some(d => d.action === "kept")).toBe(false);
    expect(() => applyCreatorRevision(before, { accept: ["nope"] })).toThrow(/Unknown item/);
  });

  test("an item the creator changed, then deleted, stays declined", () => {
    const before = assembled();
    const edited = applyCreatorRevision(before, { patch: { tracks: { "a-roll": { upsert: [{ ...before.tracks["a-roll"][0]!, gainDb: 2 }] } } } }).doc;
    expect(edited.tracks["a-roll"][0]!.owner).toBe("creator");
    const { doc, decisions } = applyCreatorRevision(edited, { patch: { tracks: { "a-roll": { remove: [edited.tracks["a-roll"][0]!.id] } } } });
    expect(decisions).toEqual([]);
    expect(doc.declined).toContain(edited.tracks["a-roll"][0]!.id);
  });
});

describe("editdoc OTIO export", () => {
  test("plain absolute paths, timecode offset, gaps, markers, no suggestions", () => {
    let doc = newEditDoc({
      id: "e2", name: "OTIO", fps: { num: 25, den: 1 },
      clips: [clip("cam", { timecodeStart: 3600, fps: { num: 25, den: 1 } }), clip("br", { role: "b-roll", hasAudio: false, fps: { num: 25, den: 1 } })],
    });
    doc = applyStagePatch(doc, { stage: "assembly", stamp, tracks: { "a-roll": { upsert: packSequence([aroll("a1", "cam", 2, 6)], doc.fps) } } }).doc;
    doc = applyStagePatch(doc, { stage: "b-roll", stamp, tracks: { "b-roll": { upsert: [{ id: "b1", clipId: "br", in: 0, out: 1, start: 2, end: 3, owner: "agent", status: "applied", fit: "cover", muted: true, opacity: 1 }] } } }).doc;
    doc = applyStagePatch(doc, { stage: "text", stamp, tracks: { text: { upsert: [{ id: "t1", start: 1, end: 3, owner: "agent", status: "applied", template: "lowerThird", text: "Jane Doe", subtext: "Host", position: "auto" }] } } }).doc;
    doc = applyStagePatch(doc, { stage: "graphics", stamp, tracks: { graphics: { upsert: [{ id: "g1", start: 0.4, end: 1, owner: "agent", status: "applied", assetId: "gfx1", assetRevision: 2, placement: "full", confidence: 0.1 }] } } }).doc;
    const otio = toOtio(doc, {
      clipPath: c => `/Volumes/Footage/${c.name}`,
      graphicPath: () => ({ path: "/tmp/g1.mov", duration: 0.6, fps: { num: 25, den: 1 } }),
    }) as any;
    const tracks = otio.tracks.children;
    expect(tracks.map((t: any) => t.name)).toEqual(["A-roll", "B-roll", "Graphics", "A-roll audio"]);
    const a1 = tracks[0].children[0];
    expect(a1.media_references.DEFAULT_MEDIA.target_url).toBe("/Volumes/Footage/cam.mp4");
    expect(a1.source_range.start_time.value).toBe((3600 + 2) * 25);
    expect(a1.media_references.DEFAULT_MEDIA.available_range.start_time.value).toBe(3600 * 25);
    expect(tracks[1].children.map((c: any) => c.OTIO_SCHEMA)).toEqual(["Gap.1", "Clip.2"]);
    expect(tracks[1].children[0].source_range.duration.value).toBe(50);
    expect(tracks[2].children).toEqual([]); // g1 is a suggestion (low confidence)
    expect(otio.tracks.markers.map((m: any) => [m.name, m.color])).toEqual([["Jane Doe", "YELLOW"]]);
    expect(() => toOtio(doc, { clipPath: c => `file:///x/${c.name}` })).toThrow(/absolute/);
    expect(() => toOtio(doc, { clipPath: c => `C:\\clips\\${c.name}` })).not.toThrow();
  });
});

describe("editdoc FCPXML export", () => {
  const rate = { num: 25, den: 1 };
  function cut(): EditDoc {
    let doc = newEditDoc({
      id: "e3", name: "Talk & cut", fps: rate,
      clips: [clip("cam", { timecodeStart: 3600, fps: rate }), clip("br", { role: "b-roll", hasAudio: false, fps: rate }), clip("song", { role: "music", kind: "audio" })],
    });
    // a1 = cam 2–6 at 0–4, a2 = cam 10–12 at 4–6.
    doc = applyStagePatch(doc, { stage: "assembly", stamp, tracks: { "a-roll": { upsert: packSequence([aroll("a1", "cam", 2, 6), aroll("a2", "cam", 10, 12, { gainDb: -3 })], doc.fps) } } }).doc;
    return doc;
  }
  const media = { clipPath: (c: ClipRef) => `/Volumes/My Footage/${c.name}` };
  /** One asset-clip with everything nested in it. */
  const clipXml = (xml: string, name: string) => {
    const from = xml.search(new RegExp(`<asset-clip [^>]*name="${name}"`));
    let depth = 0;
    for (const m of xml.slice(from).matchAll(/<(\/?)asset-clip\b[^>]*?(\/?)>/g)) {
      depth += m[1] ? -1 : m[2] ? 0 : 1;
      if (depth === 0) return xml.slice(from, from + m.index! + m[0].length);
    }
    throw new Error(`no ${name}`);
  };
  const keys = (xml: string, param: string) => [...(xml.match(new RegExp(`<param name="${param}"[^>]*>(.*?)</param>`))?.[1] ?? "").matchAll(/<keyframe time="([^"]+)" value="([^"]+)" interp="(\w+)"/g)].map(m => [m[1], m[2], m[3]]);

  test("assets as file URLs, timecode in starts, connected lanes, markers, no suggestions", () => {
    let doc = cut();
    doc = applyStagePatch(doc, { stage: "b-roll", stamp, tracks: { "b-roll": { upsert: [{ id: "b1", clipId: "br", in: 0, out: 1, start: 2, end: 3, owner: "agent", status: "applied", fit: "contain", muted: true, opacity: 1 }] } } }).doc;
    doc = applyStagePatch(doc, { stage: "audio", stamp, tracks: { music: { upsert: [{ id: "m1", clipId: "song", in: 0, out: 6, start: 0, end: 6, owner: "agent", status: "applied", gainDb: -24, fadeIn: 1, fadeOut: 2, duck: true }] } } }).doc;
    doc = applyStagePatch(doc, { stage: "text", stamp, tracks: { text: { upsert: [{ id: "t1", start: 1, end: 3, owner: "agent", status: "applied", template: "lowerThird", text: "Jane <Doe>", subtext: "Host", position: "auto" }] } } }).doc;
    doc = applyStagePatch(doc, { stage: "graphics", stamp, tracks: { graphics: { upsert: [{ id: "g1", start: 0.4, end: 1, owner: "agent", status: "applied", assetId: "gfx1", assetRevision: 2, placement: "full", confidence: 0.1 }] } } }).doc;
    doc = { ...doc, markers: [{ id: "c1", time: 5, kind: "chapter", title: "Part two", owner: "agent", status: "applied" }] };
    const xml = toFcpxml(doc, { ...media, graphicPath: () => ({ path: "/tmp/g1.mov", duration: 0.6, fps: rate }) });
    expect(xml).toStartWith('<?xml version="1.0"');
    expect(xml).toContain('<project name="Talk &amp; cut">');
    expect(xml).toContain('src="file:///Volumes/My%20Footage/cam.mp4"');
    expect(xml).toMatch(/<asset id="r\d+" name="cam.mp4" start="3600s" duration="60s" hasVideo="1"/);
    expect(xml).not.toContain("g1.mov"); // g1 is a suggestion (low confidence)
    const a1 = clipXml(xml, "a1"), a2 = clipXml(xml, "a2");
    expect(a1).toMatch(/^<asset-clip offset="0s" ref="r\d+" name="a1" start="3602s" duration="4s"/);
    expect(a2).toContain('name="a2" start="3610s" duration="2s"');
    expect(a2).toContain('<adjust-volume amount="-3dB"/>');
    // b-roll at output 2 hangs off a1 at its source time 3602 + 2.
    expect(a1).toMatch(/<asset-clip [^>]*lane="1" offset="3604s" name="b1"[^>]*srcEnable="video"/);
    expect(a1).toContain('<adjust-conform type="fit"/>');
    expect(a1).toMatch(/lane="-1" offset="3602s" name="m1"/);
    expect(a1).toContain('<adjust-volume amount="-24dB"><param name="amount"><fadeIn type="easeIn" duration="1s"/><fadeOut type="easeIn" duration="2s"/></param></adjust-volume>');
    expect(a1).toContain('<marker start="3603s" duration="1/25s" value="Jane &lt;Doe&gt;" note="lowerThird: Host (2.00s)"/>');
    expect(a2).toContain('<chapter-marker start="3611s" duration="1/25s" value="Part two" posterOffset="0s"/>');
    expect(xml).toContain('<sequence format="r1" duration="6s"');
    expect(() => toFcpxml(doc, { clipPath: c => `relative/${c.name}` })).toThrow(/absolute/);
    expect(toFcpxml(doc, { clipPath: c => `C:\\My Clips\\${c.name}` })).toContain('src="file:///C:/My%20Clips/cam.mp4"');
  });

  test("a zoom across a cut splits into keyframes on both clips, continuous at the cut", () => {
    let doc = cut();
    doc = applyStagePatch(doc, { stage: "zoom", stamp, tracks: { zoom: { upsert: [zoomItem({ id: "z1", start: 3, end: 5, x: 0.75, y: 0.5, easeIn: 0.4, easeOut: 0.4 })] } } }).doc;
    const xml = toFcpxml(doc, media);
    const a1 = clipXml(xml, "a1"), a2 = clipXml(xml, "a2");
    const s1 = keys(a1, "scale"), s2 = keys(a2, "scale");
    // a1: wide until 3, eases in to 2× by 3.4, holds to the cut. Times are a1's source time.
    expect(s1).toEqual([["3602s", "1 1", "linear"], ["3605s", "1 1", "ease"], ["18027/5s", "2 2", "linear"], ["3606s", "2 2", "linear"]]);
    expect(s2[0]![1]).toBe(s1[s1.length - 1]![1]);
    expect(s2[0]![0]).toBe("3610s");
    // Focus at 3/4 across, 2×: shift −0.25 of 1920 px = −44.44% of frame height; y up, nothing vertical.
    expect(keys(a1, "position").at(-1)![1]).toBe("-44.4444 0");
    expect(keys(a2, "position")[0]![1]).toBe("-44.4444 0");
  });

  test("a held zoom is plain attributes; a cut-in steps its closing key back one frame", () => {
    let doc = cut();
    doc = applyStagePatch(doc, { stage: "zoom", stamp, tracks: { zoom: { upsert: [
      zoomItem({ id: "z1", start: 1, end: 3, scale: 1.5, easeIn: 0, easeOut: 0 }),
      zoomItem({ id: "z2", start: 4, end: 6, scale: 1.3, y: 0.25, easeIn: 0, easeOut: 0 }),
    ] } } }).doc;
    const xml = toFcpxml(doc, media);
    // Focus a quarter down at 1.3×: the frame shifts down 0.075 of its height → y +7.5 down → −7.5 up.
    expect(clipXml(xml, "a2")).toContain('<adjust-transform position="0 -7.5" scale="1.3 1.3"/>');
    const a1 = clipXml(xml, "a1");
    expect(a1).not.toContain('name="position"');
    expect(keys(a1, "scale").map(k => [k[0], k[1]])).toEqual([
      ["3602s", "1 1"], ["90074/25s", "1 1"], ["3603s", "1.5 1.5"], ["90124/25s", "1.5 1.5"], ["3605s", "1 1"], ["3606s", "1 1"],
    ]);
  });
});

describe("editdoc shots + brief", () => {
  test("ShotDetector finds a hard cut and respects min shot length", () => {
    const frame = (r: number, g: number, b: number) => { const a = new Uint8Array(96 * 54 * 3); for (let i = 0; i < a.length; i += 3) { a[i] = r; a[i + 1] = g; a[i + 2] = b; } return a; };
    const det = new ShotDetector(30);
    for (let i = 0; i < 30; i++) det.push(frame(200, 30, 30));
    for (let i = 0; i < 5; i++) det.push(frame(30, 30, 200));
    for (let i = 0; i < 30; i++) det.push(frame(30, 200, 30)); // 5 frames after the last cut: too soon
    expect(det.cuts.map(c => c.frame)).toEqual([30]);
    expect(det.framesSeen).toBe(65);
  });
});

describe("repeatsDeclined", () => {
  test("matches the same words in another order or spelling, not a different point", () => {
    const gone = ["About $5 per TB a month", "~$5 / terabyte per month"];
    expect(repeatsDeclined("~$5 per terabyte per month", gone)).toBe(true);
    expect(repeatsDeclined("Most shows use under 100 GB/month", gone)).toBe(false);
    expect(repeatsDeclined("Welcome", ["Welcome"])).toBe(true);
    expect(repeatsDeclined("Welcome", ["Welcome back friends"])).toBe(false);
  });
});
