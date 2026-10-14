set -e
cp ../../src-tauri/icons/icon.png cup-translate.png
cp pot.json cup-translate.json
zip -FS cup-translate.pbar cup-translate.json cup-translate.png pot.ps1
rm cup-translate.png
rm cup-translate.json
