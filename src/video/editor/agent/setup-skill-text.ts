// Agent text from the setup thread (bd voxtale-editor-46f). PIXEL_FONT_NOTE
// replaces PIXEL_SKILL_TEXT's old font line in skill v29; MISSING_NATIVES_NOTE
// sits in the local editing guide's step 1 (local-mcp/guide.ts).

/** Pixelify Sans now ships with the renderer (apps/editor-mcp/fonts, and the Remotion sandbox image). */
export const PIXEL_FONT_NOTE = `- The renderer ships Inter, JetBrains Mono and Pixelify Sans (a pixel font, weight 400). For pixel-art text use pixelFont('Pixelify Sans', 400, size) with g.text, or fontFamily('Pixelify Sans') in a scene; in an HTML graphic, @font-face{font-family:'Pixelify Sans';src:url(./fonts/PixelifySans-Regular.ttf)}. Size it in whole grid squares and check in the stills that letters stay crisp; do not set it bold (the bold is faked and smears).`;

/** What the agent does when open or resume reports missing natives. */
export const MISSING_NATIVES_NOTE = `- If open or resume says something is "Missing on this machine", tell the creator before you edit: zooms aim at the middle without the face finder, and text goes over the speaker instead of behind without the subject mask. The fix is \`bun run setup\` in the editor repo, then restarting the server.`;
