#!/bin/bash
# usage: run-task.sh <id> <kind: seq|asm|rep>
set -u
id=$1; kind=$2
REPO=/Users/zokov/code/super-tale
B=$REPO/data/generate/_bench/agenticvbench
S=/private/tmp/claude-501/-Users-zokov-code-super-tale/263aa54c-693e-4781-ab67-e9ca1c8f8f85/scratchpad/bench
W=$HOME/bench-ours/$id; R=$B/results/ours/$id
rm -rf "$W"; mkdir -p "$W" "$R"
cp $B/tasks/$id/materials/*.mp4 "$W/"
cp $B/tasks/$id/instruction.md "$W/brief.md"
# keys for the MCP server only (never in the work folder)
AAI=$(grep '^ASSEMBLYAI_API_KEY=' $REPO/.env | cut -d= -f2- | tr -d '"'); ORK=$(grep '^OPENROUTER_API_KEY=' $REPO/.env | cut -d= -f2- | tr -d '"')
cat > $S/mcp-$id.json <<J
{"mcpServers":{"ve":{"command":"bun","args":["$REPO/apps/editor-mcp/src/main.ts"],
 "env":{"EDIT_FOLDER":"$W","ASSEMBLYAI_API_KEY":"$AAI","OPENROUTER_API_KEY":"$ORK",
 "SUPERTALE_FFMPEG":"/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg","SUPERTALE_FFPROBE":"/opt/homebrew/opt/ffmpeg-full/bin/ffprobe","PATH":"$PATH"}}}}
J
# roles from the speech check: <=3 words -> broll
roles=""
for f in $(ls "$W" | grep -E '^[0-9]+\.mp4$' | sort -n); do
  n=${f%.mp4}
  w=$(grep -E "^$id +$f " $B/speech-check.txt | sed -E 's/.*words= *([0-9]+).*/\1/')
  if [ "$kind" = asm ] || [ -z "$w" ] || [ "$w" -le 3 ]; then r=broll; else r=talk; fi
  roles="$roles $f ($r),"
done
roles=${roles%,}
NOTE="The brief's /workspace paths and its solution.json step do not apply here. Your deliverable is the render: final.mp4 in this folder (the render tool's default). The operator writes the manifest from your edit."
case $kind in
 seq) P="Edit with the voxtale-editor MCP tools (read editing_guide first). The clips are in this folder.

Open them all with one open call, these roles:$roles. Clips opened as broll have no speech.

Task brief, from a benchmark ($NOTE):
---
$(cat $W/brief.md)
---
Build the edit with one set_cut: one shot segment {clip} per clip (the whole clip, its own sound on), every clip exactly once, in the order you decide. No captions, zoom, text, b-roll, music or graphics. Then render.";;
 asm) P="Edit with the voxtale-editor MCP tools (read editing_guide first). The clips are in this folder.

Open them all with one open call, every clip as broll:$roles. They are silent shots.

Task brief, from a benchmark ($NOTE):
---
$(cat $W/brief.md)
---
Build the edit with one set_cut: one shot segment {clip} per storyboard slot (the whole clip), only the clips you pick, in slot order. No captions, zoom, text, b-roll, music or graphics. Then render.";;
 rep) P="Edit with the voxtale-editor MCP tools (read editing_guide first). The footage is source.mp4 in this folder: open it as talk.

Brief, from a benchmark. Its /workspace paths do not apply here: render to final.mp4 in this folder (the render tool's default); the operator delivers it as repurpose.mp4.
---
$(cat $W/brief.md)
---
Finish with a render, and check it with sheet.";;
esac
printf '%s\n' "$P" > $R/prompt.txt
echo "[$(date +%H:%M:%S)] start $id" >> $S/driver.log
cd "$W"
env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY MCP_TOOL_TIMEOUT=3600000 \
  claude -p "$P" --model claude-opus-5-5 --restricted --strict-mcp-config --mcp-config $S/mcp-$id.json \
  --allowedTools "mcp__ve" Read Glob Grep --output-format stream-json --verbose > $R/session.jsonl 2> $R/session.stderr
echo "[$(date +%H:%M:%S)] child exit $? $id" >> $S/driver.log
cp -R "$W/.edit/edit.json" $R/edit.json 2>/dev/null
[ -f "$W/final.mp4" ] && cp "$W/final.mp4" $R/solution.mp4
if [ "$kind" != rep ] && [ -f $R/solution.mp4 ]; then
  bun $S/sol.ts $R/edit.json $B/tasks/$id/materials $R/solution.mp4 $R/solution.json $kind > $R/convert.log 2>&1
  $REPO/.venv/bin/python -I $B/judges/$id/judge.py --solution $R/solution.json --solution-mp4 $R/solution.mp4 \
    --materials-dir $B/tasks/$id/materials --reward-json $R/reward.json --reward-txt $R/reward.txt > $R/judge.log 2>&1
  echo "[$(date +%H:%M:%S)] judged $id: $(cat $R/reward.txt 2>/dev/null)" >> $S/driver.log
fi
