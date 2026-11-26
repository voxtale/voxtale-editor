// Runtime globals every target has (Node 17+, Bun, browsers, Electron), kept
// out of `lib` so the package does not pull in DOM types.
declare function structuredClone<T>(value: T): T;
