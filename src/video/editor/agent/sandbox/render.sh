# /job/in: index.html from the agent (read-only). /job/out: results.
set -u
export HYPERFRAMES_BROWSER_PATH="$(cat /app/browser-path)"
mkdir -p /tmp/proj/fonts
cp -r /job/in/. /tmp/proj/
cp /app/node_modules/gsap/dist/gsap.min.js /tmp/proj/gsap.min.js
cp /app/fonts/* /tmp/proj/fonts/ 2>/dev/null
cd /tmp/proj
hyperframes lint > /job/out/lint.txt 2>&1; echo "exit $?" >> /job/out/lint.txt
hyperframes render --workers 2 --format webm --output /job/out/graphic.webm > /job/out/render.txt 2>&1; echo "exit $?" >> /job/out/render.txt
ls /tmp/proj/fonts > /job/out/fonts.txt
