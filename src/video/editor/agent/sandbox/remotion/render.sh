# /job/in: index.html + kit.css from the agent (read-only). /job/out: results.
set -u
B="$(cat /app/browser-path)"
node /app/render.mjs "{\"in\":\"/job/in\",\"work\":\"/tmp/proj\",\"out\":\"/job/out/graphic.webm\",\"width\":$W,\"height\":$H,\"seconds\":$S,\"gsap\":\"/app/node_modules/gsap/dist/gsap.min.js\",\"fonts\":\"/app/fonts\",\"browser\":\"$B\"}" > /job/out/render.txt 2>&1
echo "exit $?" >> /job/out/render.txt
ls /tmp/proj/public/fonts > /job/out/fonts.txt 2>/dev/null
