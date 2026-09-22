import ctranslate2, sentencepiece as spm, time, statistics, json
import sacrebleu

M = "/data/benchmodels/ct2-en-zh"
sp_src = spm.SentencePieceProcessor(model_file=f"{M}/source.spm")
sp_tgt = spm.SentencePieceProcessor(model_file=f"{M}/target.spm")

# 自建小测试集：人工参考译文（英->中）。涵盖日常、技术、长句
DATA = [
    ("Hello, world.", "你好，世界。"),
    ("The quick brown fox jumps over the lazy dog.", "敏捷的棕色狐狸跳过了懒狗。"),
    ("Artificial intelligence is transforming the way we work and live.", "人工智能正在改变我们的工作和生活方式。"),
    ("Kubernetes automatically restarts containers that fail their health checks.", "Kubernetes 会自动重启未通过健康检查的容器。"),
    ("The committee postponed the decision until the quarterly earnings report was published.", "委员会将决定推迟到季度财报发布之后。"),
    ("She carefully documented the intermittent memory leak before filing the bug report.", "她在提交错误报告之前仔细记录了间歇性内存泄漏。"),
    ("Please ensure the backup completes before you upgrade the production database.", "请确保在升级生产数据库之前备份已完成。"),
    ("The system will notify you once the deployment has finished successfully.", "部署成功完成后，系统会通知你。"),
    ("Due to unforeseen circumstances, the meeting has been rescheduled to next Tuesday.", "由于不可预见的情况，会议已改期至下周二。"),
    ("This document describes the installation procedure for the software.", "本文档介绍该软件的安装步骤。"),
]
srcs = [d[0] for d in DATA]
refs = [d[1] for d in DATA]

def translate_local(sents, quant="int8", threads=4, beam=4):
    tr = ctranslate2.Translator(M, device="cpu", compute_type=quant,
                                intra_threads=threads, inter_threads=1)
    batches = [[">>cmn_Hans<<"] + sp_src.encode(s, out_type=str) for s in sents]
    tr.translate_batch(batches[:1], beam_size=beam, max_batch_size=1)
    out, lat = [], []
    for b in batches:
        t0 = time.perf_counter()
        r = tr.translate_batch([b], beam_size=beam, max_batch_size=1)
        lat.append(time.perf_counter()-t0)
        out.append(sp_tgt.decode(r[0].hypotheses[0]).replace(" ", ""))
    return out, lat

print("### 本地 OPUS-MT int8 / beam=4 ###\n")
hyps, lat = translate_local(srcs)
for s, h, r in zip(srcs, hyps, refs):
    print(f"  EN : {s}")
    print(f"  MT : {h}")
    print(f"  REF: {r}")
    print()
bleu = sacrebleu.corpus_bleu(hyps, [refs], tokenize="zh")
chrf = sacrebleu.corpus_chrf(hyps, [refs])
print(f"BLEU(zh) = {bleu.score:.2f}   chrF = {chrf.score:.2f}   平均延迟 {statistics.mean(lat)*1000:.0f} ms")
json.dump({"hyps": hyps, "bleu": bleu.score, "chrf": chrf.score, "avg_ms": statistics.mean(lat)*1000},
          open("/tmp/local_quality.json","w"), ensure_ascii=False, indent=2)
