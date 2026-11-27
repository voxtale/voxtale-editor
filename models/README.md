# Models

Both ship in the repo; `bun run setup` checks them.

| File | What | Licence | Source |
|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | Face finder (YuNet): zooms aim at the eyes | MIT | [opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) |
| `u2netp.onnx` | Subject mask (U2-Net-p): text behind the speaker | Apache-2.0 | [U-2-Net](https://github.com/xuebinqin/U-2-Net), file from [rembg](https://github.com/danielgatis/rembg/releases/tag/v0.0.0) |

`u2netp.onnx` sha256: `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`
(`tools/fetch-subject-model.sh` fetches it again if lost).

Optional, not in git (44 MB): object picks in the subject mask (text behind any picked object or the head;
objects cut out of the mask). `tools/fetch-object-model.sh` fetches them, sha256-checked, from Acly/MobileSAM at
commit `0d3b403339b4674a82493d5e97964dd78089ddc8`. Needs `onnxruntime` (in `requirements.txt`).

| File | What | Licence | Source |
|---|---|---|---|
| `mobile_sam_image_encoder.onnx` | MobileSAM image encoder | Apache-2.0 weights ([MobileSAM](https://github.com/ChaoningZhang/MobileSAM)), MIT export | [Acly/MobileSAM](https://huggingface.co/Acly/MobileSAM) |
| `sam_mask_decoder_single.onnx` | SAM mask decoder, one mask | Apache-2.0 ([segment-anything](https://github.com/facebookresearch/segment-anything)), MIT export | same |

sha256: encoder `580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749`,
decoder `93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d`.
