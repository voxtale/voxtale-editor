// Who labels footage on the local MCP: one setting, VOXTALE_EDITOR_VISION.
//   openrouter  a vision model through OpenRouter labels b-roll and screen
//               clips at open (default when OPENROUTER_API_KEY is set; Gemini
//               unless VIDEO_INDEX_MODEL names another). Paid, a few cents per
//               minute of footage; best on video.
//   harness     the server calls no model: label_footage hands the agent
//               contact sheets, save_labels keeps its labels (default with no
//               key). Free here; costs the agent's own context.

export type VisionMode='openrouter'|'harness';
export const VISION_MODES=['openrouter','harness'] as const;

/** The mode, and a warning when the setting could not be honoured. */
export function visionMode(env:Record<string,string|undefined>=process.env):{mode:VisionMode;warning?:string} {
  const want=env.VOXTALE_EDITOR_VISION?.trim().toLowerCase();
  const key=!!env.OPENROUTER_API_KEY;
  if(!want)return {mode:key?'openrouter':'harness'};
  if(want==='harness')return {mode:'harness'};
  if(want==='openrouter')return key?{mode:'openrouter'}:{mode:'harness',warning:'VOXTALE_EDITOR_VISION=openrouter needs OPENROUTER_API_KEY: using harness (the agent labels footage)'};
  return {mode:key?'openrouter':'harness',warning:`VOXTALE_EDITOR_VISION=${want} is not one of ${VISION_MODES.join(', ')}: ignored`};
}
