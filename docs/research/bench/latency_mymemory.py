import urllib.request, urllib.parse, json, time, statistics
def mm(text):
    u=f"https://api.mymemory.translated.net/get?q={urllib.parse.quote(text)}&langpair=en|zh-CN"
    req=urllib.request.Request(u, headers={"User-Agent":"cup-translate-test"})
    t0=time.perf_counter()
    with urllib.request.urlopen(req, timeout=30) as r: json.load(r)
    return time.perf_counter()-t0

# 预热
mm("warmup")
lat=[]
for i in range(12):
    d = mm(f"The server returned an unexpected error code number {i}.")
    lat.append(d*1000)
    print(f"  req {i+1:2}: {d*1000:7.0f} ms")
print(f"\n中位数 {statistics.median(lat):.0f} ms   平均 {statistics.mean(lat):.0f} ms   最小 {min(lat):.0f}   最大 {max(lat):.0f}")
