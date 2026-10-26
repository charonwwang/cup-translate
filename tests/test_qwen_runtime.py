"""Managed runtime verification and private worker protocol; no weight downloads."""
import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch


def runtime():
    spec = importlib.util.spec_from_file_location('qwen_runtime', Path(__file__).parents[1] / 'scripts/qwen-runtime.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RuntimeTest(unittest.TestCase):
    def test_legacy_mps_install_uses_cpu_with_bounded_threads(self):
        app = runtime()
        threads = []
        loads = []
        torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False), float32='fp32', float16='fp16', set_num_threads=threads.append)
        model_type = types.SimpleNamespace(from_pretrained=lambda path, **kw: loads.append((path, kw)) or object())
        with patch.dict(app.sys.modules, {'torch': torch, 'qwen_tts': types.SimpleNamespace(Qwen3TTSModel=model_type)}), patch.object(app.os, 'cpu_count', return_value=16):
            _, device = app.load_model('/local/model', 'mps')
        self.assertEqual(device, 'cpu')
        self.assertEqual(threads, [4])
        self.assertEqual(loads[0][1]['device_map'], 'cpu')
        self.assertEqual(loads[0][1]['dtype'], 'fp32')

    def test_single_word_uses_aligned_text_and_rejects_runaway_audio(self):
        app = runtime()
        calls = []
        duration = [1]
        class Model:
            def get_supported_languages(self): return ['english']
            def get_supported_speakers(self): return ['vivian']
            def generate_custom_voice(self, **kwargs):
                calls.append(kwargs)
                return [[.25] * (24000 * duration[0])], 24000
        numpy = types.SimpleNamespace(isfinite=lambda _v: types.SimpleNamespace(all=lambda: True), max=max, abs=lambda v: [abs(x) for x in v])
        torch = types.SimpleNamespace(inference_mode=contextlib.nullcontext)
        sf = types.SimpleNamespace(write=lambda stream, *_args, **_kwargs: stream.write(b'RIFFtest'))
        with patch.dict(app.sys.modules, {'torch': torch, 'numpy': numpy, 'soundfile': sf}):
            self.assertEqual(app.audio(Model(), 'performance', 'English', 'Vivian'), b'RIFFtest')
            self.assertEqual(calls[-1]['text'], 'performance.')
            self.assertTrue(calls[-1]['non_streaming_mode'])
            self.assertFalse(calls[-1]['do_sample'])
            self.assertFalse(calls[-1]['subtalker_dosample'])
            self.assertEqual(calls[-1]['max_new_tokens'], 60)
            duration[0] = 5
            with self.assertRaisesRegex(RuntimeError, 'audio discarded'):
                app.audio(Model(), 'performance', 'English', 'Vivian')

    def test_probe_does_not_claim_missing_dependencies_are_reusable(self):
        app = runtime()
        with patch.object(app.importlib.metadata, 'version', side_effect=app.importlib.metadata.PackageNotFoundError), contextlib.redirect_stdout(io.StringIO()) as output:
            app.probe()
        result = json.loads(output.getvalue())
        self.assertFalse(result['ready'])
        self.assertEqual(result['packages'], {})

    def test_model_verification_rejects_corrupt_same_size_weights(self):
        app = runtime()
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'model.safetensors'
            file.write_bytes(b'good')
            manifest = {'files': [{'name': file.name, 'bytes': 4, 'sha256': app.hashlib.sha256(b'good').hexdigest()}]}
            self.assertTrue(app.verified(directory, manifest))
            file.write_bytes(b'evil')
            self.assertFalse(app.verified(directory, manifest))

    def test_failed_gpu_test_releases_model_before_cpu_retry_and_readiness(self):
        import weakref
        app = runtime()
        class Model:
            pass
        released = []
        devices = []
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_dir = root / 'model-0.6B'
            model_dir.mkdir()
            (model_dir / 'model.bin').write_bytes(b'good')
            manifest = {'models': [{'id': '0.6B', 'repo': 'test', 'revision': 'pinned', 'files': [{'name': 'model.bin', 'bytes': 4, 'sha256': app.hashlib.sha256(b'good').hexdigest()}]}]}
            (root / 'manifest.json').write_text(json.dumps(manifest))
            references = []
            def load(_directory, device):
                devices.append(device)
                if device == 'cpu':
                    self.assertIsNone(references[0](), 'GPU tensors must be released before loading CPU weights')
                model = Model()
                references.append(weakref.ref(model))
                return model, device
            def synthesize(model, *_args):
                self.assertFalse((root / 'installed-0.6B.json').exists())
                if len(devices) == 1:
                    raise RuntimeError('Invalid GPU probability tensor')
                return b'RIFFtestWAVE'
            torch = types.SimpleNamespace(backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False)), mps=types.SimpleNamespace(empty_cache=lambda: released.append(True)), cuda=types.SimpleNamespace(is_available=lambda: True, empty_cache=lambda: released.append(True)))
            hub = types.SimpleNamespace(snapshot_download=lambda *_args, **_kwargs: str(model_dir), hf_hub_download=lambda *_args, **_kwargs: self.fail('Verified weights must be reused'))
            with patch.dict(app.sys.modules, {'torch': torch, 'huggingface_hub': hub}), patch.object(app, 'load_model', load), patch.object(app, 'audio', synthesize):
                app.install(types.SimpleNamespace(root=str(root), variant='0.6B'))
            self.assertEqual(devices, ['cuda:0', 'cpu'])
            self.assertTrue(released)
            self.assertEqual(json.loads((root / 'installed-0.6B.json').read_text())['device'], 'cpu')
            self.assertEqual(json.loads((root / 'progress.json').read_text())['state'], 'ready')

    def test_worker_loads_once_and_handles_multiple_private_requests(self):
        app = runtime()
        events = []
        model = object()
        def load(path, device):
            events.append((path, device))
            return model, 'cpu'
        def audio(value, text, language, voice):
            self.assertIs(value, model)
            if language == 'invalid':
                raise ValueError('Invalid language')
            return b'RIFFtestWAVE'
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'installed.json'
            config.write_text(json.dumps({'model': '/local/verified/model', 'device': 'cpu'}))
            requests = '\n'.join(json.dumps({'text': 'Hello', 'language': language, 'voice': 'Vivian'}) for language in ['English', 'invalid', 'Chinese']) + '\n'
            with patch.object(app, 'load_model', side_effect=load), patch.object(app, 'audio', side_effect=audio), patch.object(app.sys, 'stdin', io.StringIO(requests)), contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
                app.serve(types.SimpleNamespace(config=str(config)))
            replies = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertTrue(replies[0]['ready'])
            self.assertEqual(replies[1]['text_hash'], app.hashlib.sha256(b'Hello').hexdigest())
            self.assertEqual(replies[1]['language'], 'English')
            self.assertEqual(base64.b64decode(replies[1]['audio']), b'RIFFtestWAVE')
            self.assertIn('error', replies[2])
            self.assertIn('audio', replies[3])
            self.assertEqual(len(events), 1)

    def test_worker_reuses_audio_and_evicts_old_entries(self):
        app = runtime()
        calls = []
        def audio(_model, text, language, voice, **kwargs):
            calls.append((text, language, voice, kwargs))
            return b'RIFF' + text.encode()
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'installed.json'
            config.write_text(json.dumps({'model': '/local/model', 'device': 'cpu'}))
            def req(text, voice='Vivian', preview=False):
                return json.dumps({'text': text, 'language': 'Chinese', 'voice': voice, 'preview': preview})
            lines = [req('one'), req('one'), req('one', 'Ryan'), req('one', preview=True)]
            lines += [req(str(i)) for i in range(8)] + [req('one')]
            with patch.object(app, 'load_model', return_value=(object(), 'cpu')), patch.object(app, 'audio', side_effect=audio), patch.object(app.sys, 'stdin', io.StringIO('\n'.join(lines))), contextlib.redirect_stdout(io.StringIO()) as output:
                app.serve(types.SimpleNamespace(config=str(config)))
            replies = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(replies[1], replies[2])
            self.assertEqual(len(calls), len(lines) - 1)
            self.assertEqual(calls[2][-1], {'max_tokens': 192})
            self.assertEqual(calls[-1][0], 'one', 'An evicted phrase must synthesize again')

    def test_cached_audio_is_always_bound_to_the_current_request_identity(self):
        app = runtime()
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'installed.json'
            config.write_text(json.dumps({'model': '/local/model', 'device': 'cpu'}))
            requests = [dict(request_id=str(i), text='performance', language='English', voice='Vivian') for i in range(2)]
            requests.append(dict(request_id='2', text='表现', language='Chinese', voice='Vivian'))
            with patch.object(app, 'load_model', return_value=(object(), 'cpu')), patch.object(app, 'audio', side_effect=[b'english', b'chinese']) as synth, patch.object(app.sys, 'stdin', io.StringIO('\n'.join(json.dumps(r) for r in requests))), contextlib.redirect_stdout(io.StringIO()) as output:
                app.serve(types.SimpleNamespace(config=str(config)))
            replies = [json.loads(line) for line in output.getvalue().splitlines()][1:]
            self.assertEqual(synth.call_count, 2)
            for request, reply in zip(requests, replies):
                self.assertEqual(reply['request_id'], request['request_id'])
                self.assertEqual(reply['language'], request['language'])
                self.assertEqual(reply['text_hash'], app.hashlib.sha256(request['text'].encode()).hexdigest())
            self.assertEqual(base64.b64decode(replies[0]['audio']), b'english')
            self.assertEqual(base64.b64decode(replies[1]['audio']), b'english')
            self.assertEqual(base64.b64decode(replies[2]['audio']), b'chinese')


if __name__ == '__main__':
    unittest.main()
