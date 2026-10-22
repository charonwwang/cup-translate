#!/usr/bin/env python3
"""Application-managed Qwen runtime; stdout is a private JSON-lines protocol."""
import argparse
import base64
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import sys


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    temporary.replace(path)


def probe():
    result = {'python': sys.executable, 'version': sys.version.split()[0],
              'supported': (3, 10) <= sys.version_info[:2] <= (3, 12), 'ready': False, 'packages': {}}
    for package in ['qwen-tts', 'torch', 'torchaudio', 'transformers', 'accelerate', 'soundfile']:
        try:
            result['packages'][package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            pass
    expected = {'qwen-tts': '0.1.1', 'transformers': '4.57.3', 'accelerate': '1.12.0'}
    if result['supported'] and all(result['packages'].get(k) == v for k, v in expected.items()):
        try:
            # Installed metadata is not enough: incompatible native libraries must fail the check.
            with redirect_logs():
                import torch
                import soundfile
                import torchaudio
                from qwen_tts import Qwen3TTSModel
            result['ready'] = True
            result['device'] = 'mps' if torch.backends.mps.is_available() else 'cuda:0' if torch.cuda.is_available() else 'cpu'
        except Exception as error:
            result['reason'] = str(error)[-500:]
    print(json.dumps(result), flush=True)


def redirect_logs():
    from contextlib import redirect_stdout
    return redirect_stdout(sys.stderr)


def verified(directory, model):
    directory = Path(directory)
    for item in model['files']:
        path = directory / item['name']
        if not path.is_file() or path.stat().st_size != item['bytes']:
            return False
        if item.get('sha256'):
            h = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
                    h.update(chunk)
            if h.hexdigest() != item['sha256']:
                return False
    return True


def load_model(directory, device=None):
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')
    import torch
    from qwen_tts import Qwen3TTSModel
    if not device:
        device = 'mps' if torch.backends.mps.is_available() else 'cuda:0' if torch.cuda.is_available() else 'cpu'
    model = Qwen3TTSModel.from_pretrained(str(directory), device_map=device,
        dtype=torch.float16 if device.startswith('cuda') else torch.float32,
        attn_implementation='sdpa', local_files_only=True)
    return model, device


def audio(model, text, language, voice):
    import torch
    import soundfile as sf
    if not isinstance(text, str) or not text.strip() or len(text) > 2000:
        raise ValueError('Speech text must contain 1–2000 characters')
    if language.lower() not in model.get_supported_languages() or voice.lower() not in model.get_supported_speakers():
        raise ValueError('Unsupported language or voice')
    with torch.inference_mode():
        waves, rate = model.generate_custom_voice(text=text, language=language, speaker=voice, max_new_tokens=2048)
    import numpy as np
    if not len(waves[0]) or not np.isfinite(waves[0]).all() or float(np.max(np.abs(waves[0]))) < 1e-6:
        raise RuntimeError('Model produced empty or silent audio')
    output = io.BytesIO()
    sf.write(output, waves[0], rate, format='WAV', subtype='PCM_16')
    return output.getvalue()


def install(args):
    from huggingface_hub import snapshot_download, hf_hub_download
    root = Path(args.root)
    manifest = json.loads((root / 'manifest.json').read_text())
    model = next(item for item in manifest['models'] if item['id'] == args.variant)
    destination = root / ('model-' + args.variant)
    progress = root / 'progress.json'
    total = sum(item['bytes'] for item in model['files'])
    def status(stage, **values):
        atomic_json(progress, {'state': stage, 'variant': args.variant, 'total': total, **values})
    status('model', bytes=0)
    # Reuse complete, verified Hugging Face snapshots as well as application downloads.
    try:
        cached = Path(snapshot_download(model['repo'], revision=model['revision'], local_files_only=True))
        if verified(cached, model):
            destination = cached
    except Exception:
        pass
    if not verified(destination, model):
        completed = 0
        for item in model['files']:
            status('model', bytes=completed, file=item['name'])
            path = destination / item['name']
            intact = verified(destination, {'files': [item]})
            if not intact:
                hf_hub_download(model['repo'], item['name'], revision=model['revision'], local_dir=str(destination), force_download=path.exists())
            completed += item['bytes']
        status('verifying', bytes=total)
        if not verified(destination, model):
            raise RuntimeError('Model verification failed; retry installation to repair files')
    status('warming', bytes=total)
    # A downloaded directory is never marked installed until real synthesis succeeds.
    with redirect_logs():
        os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')
        import torch
        device = 'mps' if torch.backends.mps.is_available() else 'cuda:0' if torch.cuda.is_available() else 'cpu'
        runtime = None
        fallback = False
        try:
            runtime, device = load_model(destination, device)
            sample = audio(runtime, '你好，这是语音测试。 Hello.', 'Chinese', 'Vivian')
        except (RuntimeError, NotImplementedError):
            if device == 'cpu':
                raise
            fallback = True
        # Leave the exception handler before releasing the GPU model: the traceback
        # otherwise retains its tensors and can exhaust unified memory on CPU retry.
        if fallback:
            del runtime
            import gc
            gc.collect()
            if torch.backends.mps.is_available():
                torch.mps.empty_cache()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            status('warming', bytes=total, fallback='cpu')
            runtime, device = load_model(destination, 'cpu')
            sample = audio(runtime, '你好，这是语音测试。 Hello.', 'Chinese', 'Vivian')
    (root / ('preview-' + args.variant + '.wav')).write_bytes(sample)
    atomic_json(root / ('installed-' + args.variant + '.json'), {
        'python': sys.executable, 'model': str(destination), 'variant': args.variant,
        'revision': model['revision'], 'device': device,
    })
    status('ready', bytes=total)


def serve(args):
    config = json.loads(Path(args.config).read_text())
    with redirect_logs():
        runtime, device = load_model(config['model'], config.get('device'))
    print(json.dumps({'ready': True, 'device': device}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with redirect_logs():
                wav = audio(runtime, request['text'], request['language'], request['voice'])
            print(json.dumps({'audio': base64.b64encode(wav).decode('ascii')}), flush=True)
        except Exception:
            import traceback
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({'error': 'Local speech synthesis failed; see Qwen runtime log'}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['probe', 'install', 'serve'])
    parser.add_argument('--root')
    parser.add_argument('--variant', choices=['0.6B', '1.7B'], default='0.6B')
    parser.add_argument('--config')
    args = parser.parse_args()
    if args.action == 'probe':
        probe()
    elif args.action == 'install':
        install(args)
    else:
        serve(args)


if __name__ == '__main__':
    main()
