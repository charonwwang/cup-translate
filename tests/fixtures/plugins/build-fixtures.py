"""Build reproducible source packages, never fetch network or include real credentials."""
import pathlib,json,zipfile,hashlib
root=pathlib.Path(__file__).parent
entries={
    'translate': "async function translate(text, from, to, {config}) { return `${config.prefix}:${from}:${to}:${text}`; }\n",
    'tts': "async function tts(text, lang, {config}) { return Array.from(new TextEncoder().encode(`${config.prefix}:${lang}:${text}`)); }\n",
    'recognize': "async function recognize(image, lang, {config}) { return `${config.prefix}:${lang}:${image.length}`; }\n",
    'collection': "async function collection(source, target, {config, utils}) { return utils.run('bin/record', [config.prefix, source, target]); }\n",
}
for kind,script in entries.items():
    folder=root/'deterministic'/kind;folder.mkdir(parents=True,exist_ok=True)
    info={'id':f'plugin.cup.fixture.{kind}','plugin_type':kind,'display':f'Cup {kind} fixture','homepage':'https://github.com/charonwwang/cup-translate','icon':'icon.svg','needs':[{'key':'prefix','display':'Prefix'}]}
    if kind!='collection': info['language']={'en':'en','zh_cn':'zh'}
    (folder/'info.json').write_text(json.dumps(info,indent=2)+'\n');(folder/'main.js').write_text(script)
    (folder/'icon.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>\n')
    if kind=='collection':
        (folder/'bin').mkdir(exist_ok=True);(folder/'bin'/'record').write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
packages=[]
(root/'packages').mkdir(exist_ok=True)
for folder in sorted([* (root/'deterministic').iterdir(), *(root/'upstream').iterdir()]):
    if not folder.is_dir():continue
    info=json.loads((folder/'info.json').read_text());dest=root/'packages'/(info['id']+'.potext')
    with zipfile.ZipFile(dest,'w',compression=zipfile.ZIP_DEFLATED) as z:
        for file in sorted(folder.rglob('*')):
            if not file.is_file():continue
            item=zipfile.ZipInfo(file.relative_to(folder).as_posix(),date_time=(2026,10,26,0,0,0));item.compress_type=zipfile.ZIP_DEFLATED;item.create_system=3
            item.external_attr=(0o100755 if 'bin' in file.parts else 0o100644)<<16
            z.writestr(item,file.read_bytes())
    packages.append({'id':info['id'],'kind':info['plugin_type'],'source':str(folder.relative_to(root)),'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'package':dest.name})
(root/'packages.json').write_text(json.dumps(packages,indent=2)+'\n')
