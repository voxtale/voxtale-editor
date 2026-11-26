// Local adapters. Import this entrypoint only in a process with filesystem/media access.
export {loadEdit,validateMedia,probe} from './media';
export {transcribe,transcribeAudio,loadTranscript} from './transcript';
export {askPlanner,askVision,askWriter} from './openrouter';
export {dockerRenderer,SANDBOX_IMAGE} from './graphics/render';
export {nativeFaceFinder as findFaces} from '../native/bridge';
export {stage} from './stages';
export {produce} from './produce';
export async function render(...args:Parameters<typeof import('./render').render>) {
  return (await import('./render')).render(...args);
}
export {renderEditDoc,planRender,MissingMediaError} from './render-edit';
