#!/bin/bash

INPUT=$1
ENTITLEMENTS=$2

echo "=== Local Signing for $INPUT ==="

if [[ "$OSTYPE" == "darwin"* ]]; then
    # We are on macOS
    IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
    echo "Signing with identity: $IDENTITY"
    if [ -f "$ENTITLEMENTS" ]; then
        codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$INPUT"
    else
        codesign --force --options runtime --sign "$IDENTITY" "$INPUT"
    fi
else
    echo "Not on macOS, skipping codesign."
fi
