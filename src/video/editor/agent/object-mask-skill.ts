// Agent text for picked objects in the subject mask (bd voxtale-editor-8a6). Not yet in a registered skill
// version: the coordinator folds OBJECT_MASK_SKILL into the next one. Tool descriptions are live now.
// Idea and add/remove semantics from REDACTED REDACTED/subject_objects.py (Premiere's Object Mask + and −).

export const PICK_OBJECT_DESCRIPTION='Pick objects on one still of a clip, for text behind them: mode add puts the object over a graphic (a lamp, a mug, the head alone), mode remove cuts it out of the mask (a raised hand that should stay behind the text). Give points on the object (fractions of the SOURCE frame, as timeline_view shows it), a box round it, or both; exclude points mark what is not the object (the shirt under a mug). Returns the still with each object tinted, outlined and numbered, and per object its share of the frame and box: check the tint covers the object and nothing else, and pick again (more points, a tighter box, an exclude point) until it does. Then pass the same objects, with clip and t, as maskObjects to place_graphic. Needs the object model; without it this fails and says so.';

export const MASK_OBJECTS_FIELD='objects picked with pick_object (same mode, points, exclude, box; plus the clip and the source second t of the still they were picked on), added to the mask drawn back over the graphic or cut out of it. They are followed across frames both ways from t. An added object puts the graphic behind it even without behindSubject: behindSubject false with the head picked = text behind the head only. Objects on a clip the graphic does not cover do nothing';

/** Skill text, for the next skill version. */
export const OBJECT_MASK_SKILL=`
### Text behind an object, or behind the head
behindSubject cuts the whole person out over a graphic. For anything else, pick objects:
- pick_object on a still of the a-roll clip under the graphic (timeline_view first to find a clear frame, near the graphic's start). One point in the middle of the object is often enough; add a box for thin or busy objects; add an exclude point when the tint spills onto a neighbour.
- Look at the tint it returns. Pick again until it covers the object and nothing else. A tint that takes the wall or the whole person is a wrong pick: never place it.
- place_graphic with maskObjects: [{mode, clip, t, points|box, exclude?}].
  - Behind the head only: behindSubject false, one add object on the head (a box from the chin to the top of the hair).
  - Behind the speaker and a prop on the desk: behindSubject true, one add object on the prop.
  - Behind the speaker but in front of their hand: behindSubject true, one remove object on the hand.
- The object is followed from the still both ways. One that leaves the frame, or is hidden for long, drops out of the mask. Watch the stretch with watch_cut: the still there is segmented again from the same prompt, so check the object is where the prompt points.
`;
