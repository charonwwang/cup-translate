import urllib.request, urllib.parse, json, time, statistics, sacrebleu

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

def mm(text, pair="en|zh-CN"):
    u = f"https://api.mymemory.translated.net/get?q={urllib.parse.quote(text)}&langpair={pair}"
    req = urllib.request.Request(u, headers={"User-Agent":"cup-translate-test"})
    with urllib.request.urlopen(req, timeout=25) as r:
        d = json.load(r)
    return (d.get("responseData") or {}).get("translatedText",""), d.get("responseData",{}).get("match")

hyps, refs, lats = [], [], []
print("### MyMemory 免 key ###\n")
for s, r in DATA:
    t0=time.perf_counter()
    try:
        h, m = mm(s)
    except Exception as e:
        h, m = f"ERROR {e}", None
    lats.append(time.perf_counter()-t0)
    h = (h or "").replace(" ", "")
    hyps.append(h); refs.append(r)
    print(f"  EN : {s}")
    print(f"  MM : {h}   (match={m})")
    print(f"  REF: {r}\n")

bleu = sacrebleu.corpus_bleu(hyps, [refs], tokenize="zh")
chrf = sacrebleu.corpus_chrf(hyps, [refs])
print(f"BLEU(zh) = {bleu.score:.2f}   chrF = {chrf.score:.2f}   平均延迟 {statistics.mean(lats)*1000:.0f} ms")
json.dump({"bleu":bleu.score,"chrf":chrf.score,"avg_ms":statistics.mean(lats)*1000},
          open("/tmp/mm_quality.json","w"))
