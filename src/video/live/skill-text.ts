// Agent text for the finished-live tools, NOT registered as a skill version:
// the coordinator folds it into the next editor skill version at merge.
export const LIVE_SKILL_TEXT=`## A finished livestream → vertical clips

When the creator gives a long live (a file or a URL, often 8-12 h) and wants clips:
1. live_scan with the live, plus its chat and markers files if they have them. It transcribes in 30-min pieces (paid; pieces already done are never paid again) and lists candidate moments from local hints: loudness, chat spikes, laughter, markers, most replayed. Say the cost before the first scan of a new live.
2. live_candidates: the list. Read the promising ones with live_candidates id (their words). Hints are clues, never filters: a moment with none can be the best.
3. live_rate the ones you pick: a rating, exact bounds (15-90 s, on sentence edges, setup and payoff inside), what happens and why it works.
4. live_make_clip per pick, strongest first. Each becomes its own project, already 9:16: webcam on top and game below when the webcam sits in a corner, a crop that follows the face when it fills the frame. Check the contact sheets; fix a wrong webcam box or a missed corner change with live_layout. Never set_frame on a live clip (it drops the layout).
5. Edit each clip as usual (set_cut trims the margins, captions, hook title off the face), render, look at one still.
6. Report per clip: its folder, the hook, a TikTok caption and a Shorts title in the live's language. Never publish.`;
