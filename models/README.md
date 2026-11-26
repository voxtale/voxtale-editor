# Models

Both ship in the repo; `bun run setup` checks them.

| File | What | Licence | Source |
|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | Face finder (YuNet): zooms aim at the eyes | MIT | [opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) |
| `u2netp.onnx` | Subject mask (U2-Net-p): text behind the speaker | Apache-2.0 | [U-2-Net](https://github.com/xuebinqin/U-2-Net), file from [rembg](https://github.com/danielgatis/rembg/releases/tag/v0.0.0) |

`u2netp.onnx` sha256: `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`
(`tools/fetch-subject-model.sh` fetches it again if lost).
