#!/bin/bash

INPUT=$1
APP_ID=$2

echo "=== Local Notarization for $INPUT ==="

if [[ "$OSTYPE" == "darwin"* ]]; then
    if [ -n "$APPLE_NOTARIZATION_KEYCHAIN_PROFILE" ] || { [ -n "$APPLE_ID" ] && [ -n "$APPLE_PASSWORD" ] && [ -n "$APPLE_TEAM_ID" ]; }; then
        echo "Xcode notarization credentials detected. Proceeding with xcrun notarytool submit..."
        
        # If folder/app bundle, zip it first as notarytool requires a zip or dmg
        ZIP_NEEDED=false
        if [ -d "$INPUT" ]; then
            ZIP_NEEDED=true
            zip -r -q -y to_notarize.zip "$INPUT"
            FILE_TO_NOTARIZE="to_notarize.zip"
        else
            FILE_TO_NOTARIZE="$INPUT"
        fi

        if [ -n "$APPLE_NOTARIZATION_KEYCHAIN_PROFILE" ]; then
            xcrun notarytool submit "$FILE_TO_NOTARIZE" --keychain-profile "$APPLE_NOTARIZATION_KEYCHAIN_PROFILE" --wait
        else
            xcrun notarytool submit "$FILE_TO_NOTARIZE" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
        fi

        if [ "$ZIP_NEEDED" = true ]; then
            rm -f to_notarize.zip
            # Staple the app bundle
            xcrun stapler staple "$INPUT"
        else
            xcrun stapler staple "$INPUT"
        fi
    else
        echo "No local Apple notarization credentials found. Skipping notarization."
    fi
else
    echo "Not on macOS, skipping notarization."
fi
