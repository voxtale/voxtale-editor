// Static gate for generated graphic modules: allow-listed imports only, no
// network/file/process/eval/time/random, required exports present.
import ts from 'typescript';
const ALLOWED_IMPORTS = new Set(['react', 'remotion', './kit']);
const BANNED_IDENTIFIERS = new Set(['eval', 'Function', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'process', 'require', 'globalThis', 'window', 'document', 'self', 'navigator', 'localStorage', 'sessionStorage', 'indexedDB', 'importScripts', 'Worker', 'SharedWorker', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'Date', 'performance', 'crypto', 'Buffer', 'module', 'exports', '__dirname', '__filename', 'staticFile', 'delayRender', 'continueRender', 'OffthreadVideo', 'Video', 'Audio', 'Img', 'IFrame', 'prefetch']);
const BANNED_PROPERTIES = new Set(['constructor', '__proto__', 'prototype', 'defineProperty', 'getPrototypeOf', 'setPrototypeOf', '__defineGetter__', '__lookupGetter__']);
const BANNED_TAGS = new Set(['img', 'video', 'audio', 'iframe', 'script', 'link', 'object', 'embed', 'style', 'image', 'foreignObject', 'use']);
export interface GateResult { ok: boolean; errors: string[] }
/** `imports`: the module specifiers allowed (default react, remotion, ./kit). */
export function gate(source: string, {imports = ALLOWED_IMPORTS}: {imports?: ReadonlySet<string>} = {}): GateResult {
  const errors: string[] = [];
  const file = ts.createSourceFile('graphic.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const at = (n: ts.Node) => `line ${file.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const exported = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const spec = n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : null;
      if (spec !== null && !imports.has(spec)) errors.push(`${at(n)}: import from "${spec}" not allowed`);
    }
    if (ts.isImportDeclaration(n) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings))
      for (const el of n.importClause.namedBindings.elements) if (BANNED_IDENTIFIERS.has((el.propertyName ?? el.name).text)) errors.push(`${at(el)}: "${(el.propertyName ?? el.name).text}" not allowed`);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) errors.push(`${at(n)}: dynamic import not allowed`);
    if (ts.isIdentifier(n) && BANNED_IDENTIFIERS.has(n.text)) {
      const p = n.parent;
      const isPropName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || ts.isJsxAttribute(p) || (ts.isImportSpecifier(p));
      if (!isPropName) errors.push(`${at(n)}: "${n.text}" not allowed`);
    }
    if (ts.isIdentifier(n) && BANNED_PROPERTIES.has(n.text)) errors.push(`${at(n)}: "${n.text}" not allowed`);
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && [...BANNED_PROPERTIES].some(b => n.text.includes(b))) errors.push(`${at(n)}: string names a banned property`);
    if (ts.isPropertyAccessExpression(n) && n.getText() === 'Math.random') errors.push(`${at(n)}: Math.random not allowed (use random(seed) from the kit)`);
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && BANNED_TAGS.has(n.tagName.getText())) errors.push(`${at(n)}: <${n.tagName.getText()}> not allowed`);
    if (ts.isJsxAttribute(n) && ['dangerouslySetInnerHTML', 'href', 'xlinkHref', 'src', 'srcSet'].includes(n.name.getText())) errors.push(`${at(n)}: attribute ${n.name.getText()} not allowed`);
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && /(https?:|data:|blob:|file:|\/\/[a-z]|url\s*\(|@import)/i.test(n.text)) errors.push(`${at(n)}: URL-like string not allowed`);
    if (ts.isElementAccessExpression(n)) {
      const e = n.argumentExpression;
      if (!(ts.isNumericLiteral(e) || ts.isIdentifier(e) || ts.isStringLiteral(e) || ts.isBinaryExpression(e) || ts.isPropertyAccessExpression(e) || ts.isPrefixUnaryExpression(e) || ts.isCallExpression(e))) errors.push(`${at(n)}: computed access not allowed`);
      if (ts.isStringLiteral(e) && BANNED_IDENTIFIERS.has(e.text)) errors.push(`${at(n)}: "${e.text}" not allowed`);
    }
    if (ts.isVariableStatement(n) && n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) for (const d of n.declarationList.declarations) if (ts.isIdentifier(d.name)) exported.add(d.name.text);
    if (ts.isFunctionDeclaration(n) && n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) exported.add(n.modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : n.name?.text ?? '');
    if (ts.isExportAssignment(n)) exported.add('default');
    ts.forEachChild(n, visit);
  };
  visit(file);
  for (const name of ['schema', 'defaultProps', 'default']) if (!exported.has(name)) errors.push(`missing export: ${name}`);
  const syntax = (file as any).parseDiagnostics as ts.Diagnostic[] | undefined;
  for (const d of syntax ?? []) errors.push(`syntax: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  return {ok: errors.length === 0, errors};
}
if (import.meta.main) { const r = gate(await Bun.file(process.argv[2]!).text()); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
