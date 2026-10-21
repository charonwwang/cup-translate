HY-MT and Kokoro local backends

llama.cpp (MIT), through llama-cpp-2 0.1.160:
https://github.com/ggml-org/llama.cpp
https://github.com/utilityai/llama-cpp-rs

sherpa-onnx 1.13.8 (Apache-2.0), official shared CPU releases:
https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.8
The matching C ABI declarations in src/kokoro_ffi.rs derive from sherpa-rs.
ONNX Runtime licenses and third-party notices are supplied in piper-notices/.
eSpeak NG is GPL-3.0; its sources, Unicode and GPL notices are also referenced there.

Model weights download only on request, separately from the application:
HY-MT1.5-1.8B-GGUF: Tencent Hunyuan Community License.
https://huggingface.co/tencent/HY-MT1.5-1.8B-GGUF
The pinned License.txt accompanies each downloaded specification.
Kokoro-82M v1.0: Apache-2.0.
https://huggingface.co/hexgrad/Kokoro-82M
Sherpa's multilingual INT8 package includes the model LICENSE.
Piper remains separately licensed by voice; see each model card before downloading.
