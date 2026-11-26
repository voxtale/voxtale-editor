// @voxtale/editdoc: the edit document shared by the cloud planner and
// VoxTale Desktop. Pure: no I/O, no prompts, no model calls.
export * from "./time";
export * from "./style";
export * from "./schema";
export * from "./grade";
export * from "./sync";
export * from "./camera-log";
export * from "./timeline";
export * from "./validate";
export * from "./policy";
export * from "./creator";
export * from "./keep";
export * from "./export-model";
export * from "./export-port";
export * from "./otio";
export * from "./fcpxml";
export * from "./xmeml";
export * from "./shots";
export * from "./segments";
export * from "./clip-index";
export * from "./create";
export * from "./render";
export * from "./motion";

/** Major of this package; desktop and cloud refuse to talk across majors. */
export const PACKAGE_MAJOR = 0;

export function assertCompatibleMajor(remote: number): void {
  if (remote !== PACKAGE_MAJOR) throw new Error(`@voxtale/editdoc major mismatch: local ${PACKAGE_MAJOR}, remote ${remote}`);
}
