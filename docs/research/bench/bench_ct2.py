import ctranslate2, sentencepiece as spm, time, os, statistics, json, resource

M = "/data/benchmodels/ct2-en-zh"
sp_src = spm.SentencePieceProcessor(model_file=f"{M}/source.spm")
sp_tgt = spm.SentencePieceProcessor(model_file=f"{M}/target.spm")

SENTS = [
    "Hello, world.",
    "The quick brown fox jumps over the lazy dog.",
    "Artificial intelligence is transforming the way we work and live.",
    "Kubernetes automatically restarts containers that fail their health checks.",
    "The committee postponed the decision until the quarterly earnings report was published.",
    "She carefully documented the intermittent memory leak before filing the bug report.",
    "The compiler emitted a warning about an unused variable in the recursive function.",
    "Please ensure the backup completes before you upgrade the production database.",
]
TOK = [">>cmn_Hans<<"] + []

def rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024

def bench(quant, threads):
    tr = ctranslate2.Translator(M, device="cpu", compute_type=quant,
                                intra_threads=threads, inter_threads=1)
    batches = [[">>cmn_Hans<<"] + sp_src.encode(s, out_type=str) for s in SENTS]
    tr.translate_batch(batches[:2], beam_size=4, max_batch_size=1)  # warmup
    lat = []
    for b in batches:
        t0 = time.perf_counter()
        tr.translate_batch([b], beam_size=4, max_batch_size=1)
        lat.append(time.perf_counter() - t0)
    return lat, rss_mb()

print(f"{'quant':9} {'thr':>3} {'avg ms':>8} {'p50 ms':>8} {'p95 ms':>8} {'max ms':>8} {'峰值RSS MB':>10}")
print("-"*62)
results = {}
for quant in ["int8", "int16", "float32"]:
    for threads in [1, 2, 4, 8]:
        try:
            lat, rss = bench(quant, threads)
            avg = statistics.mean(lat)*1000; p50 = statistics.median(lat)*1000
            p95 = sorted(lat)[int(len(lat)*0.95)-1]*1000; mx = max(lat)*1000
            print(f"{quant:9} {threads:>3} {avg:>8.1f} {p50:>8.1f} {p95:>8.1f} {mx:>8.1f} {rss:>10.1f}")
            results[f"{quant}/{threads}"] = dict(avg=avg, p50=p50, p95=p95, max=mx, rss=rss)
        except Exception as e:
            print(f"{quant:9} {threads:>3}   ERROR: {e}")
json.dump(results, open("/tmp/ct2_bench.json","w"), indent=2)
