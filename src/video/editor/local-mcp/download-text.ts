// Agent text for the download tool and fast export. In skill v30
// (agent/skill.ts).

export const DOWNLOAD_DESCRIPTION='Save media from a link the creator gave into <folder>/downloads/: a file (sound, video, image), or a clip of a published video (YouTube, X, TikTok, Instagram, Vimeo, Twitch or Kick replay) from start to end. '
  +'Only an https link the creator wrote in this chat; never search for or fetch footage on your own. A whole video without start and end: 15 min at most. '
  +'Times as seconds or m:ss. Returns the saved files; then open them with the footage (role broll, music, sfx…) or tell the creator where they are. yt-dlp must be installed for video pages.';

/** Skill v30: what the agent should know about downloads and fast export. */
export const DOWNLOAD_AND_EXPORT_SKILL_TEXT=`## Media from a link
When the creator gives a link to a clip they want in the edit (a reaction, a quote, a meme), call download with the start and end they name, then open the file with the rest of the footage. Ask for start and end if a video is long. Only links the creator gave: never go looking for footage yourself, and say who owns a clip from someone else's channel.

## Render speed
render uses the machine's video encoder (the Apple chip on a Mac, a graphics card elsewhere, else the CPU). render with fast: true also copies passages of untouched footage straight from the source, so a long plain talk edit renders much faster than its length; it is off by default (not yet checked in every player), so use it only when the creator asks for a quick render. Zooms, crops, grades, text and captions over a passage make it render frame by frame; that is expected, not a fault. The render result says which encoder ran and how much was copied.`;
