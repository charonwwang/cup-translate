#!/bin/sh

curl --fail --silent --show-error --location --data-binary "$POPCLIP_TEXT" "http://127.0.0.1:60828/translate"

if [ $? -eq 0 ]; then
    exit 0
else
    open -g -a cup-translate
    sleep 2
    curl --fail --silent --show-error --location --data-binary "$POPCLIP_TEXT" "http://127.0.0.1:60828/translate"
fi
