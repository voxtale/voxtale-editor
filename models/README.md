# Models

The first two ship in the repo; `bun run setup` checks them. The
transcription model is fetched on demand and gitignored.

| File | What | Licence | Source |
|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | Face finder (YuNet): zooms aim at the eyes | MIT | [opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) |
| `u2netp.onnx` | Subject mask (U2-Net-p): text behind the speaker | Apache-2.0 | [U-2-Net](https://github.com/xuebinqin/U-2-Net), file from [rembg](https://github.com/danielgatis/rembg/releases/tag/v0.0.0) |
| `parakeet/` (not in git) | Local transcription (Parakeet TDT 0.6B v3): MLX on Apple Silicon, int8 ONNX elsewhere | CC-BY-4.0 (NVIDIA; credit NVIDIA when shipping) | [nvidia/parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3); MLX: [mlx-community](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3) rev `ed2b7e8c`; ONNX: [sherpa-onnx asr-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) |

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

Parakeet: `tools/fetch-parakeet.sh` (`--mlx` / `--onnx`; default by machine)
fetches pinned files and checks each sha256:
- MLX `model.safetensors` `05e01c7f396c298cf7d23f61da7b504adeab698f0aaeafd9c82d198625464592`,
  `config.json` `f320f1292511f34ec47f513755fe20fd01dbfc09a925d42730e66059a6e1ef4c`
- ONNX `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` `1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9`

Code: parakeet-mlx (Apache-2.0), sherpa-onnx (Apache-2.0).
