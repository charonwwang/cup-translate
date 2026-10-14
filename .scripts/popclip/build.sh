set -e
rm -f cup-translate.popclipextz
mkdir cup-translate.popclipext
cp Config.plist cup-translate.popclipext
cp ../../src-tauri/icons/icon.png cup-translate.popclipext/cup-translate.png
cp Pot.sh cup-translate.popclipext/cup-translate.sh
chmod +x cup-translate.popclipext/cup-translate.sh
zip -r cup-translate.popclipextz cup-translate.popclipext
rm -r cup-translate.popclipext
