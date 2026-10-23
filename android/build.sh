#!/usr/bin/env bash
# Builds devdeck.apk without Gradle: web UI (bun) -> aapt2 compile/link (res + assets, R.java)
# -> javac -> d8 -> zipalign -> apksigner. Needs bun, a JDK and, from the Android SDK,
# build-tools plus a platform android.jar. By default it reuses LanPad's
# ../../phone_synaptic_trackpad/.sdk; if that is missing they are downloaded there (~150 MB)
# unless SDK / ANDROID_BUILD_TOOLS / ANDROID_JAR are set. Live mode's native WebRTC comes from a
# pinned, checksum-verified libwebrtc AAR (Maven Central), cached outside git in
# ${XDG_CACHE_HOME:-~/.cache}/devdeck-build/ (override with WEBRTC_CACHE); only its classes.jar
# and the arm64-v8a .so go into the APK.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
SDK=${SDK:-$(cd "$ROOT/.." && pwd)/phone_synaptic_trackpad/.sdk}
BT=${ANDROID_BUILD_TOOLS:-$SDK/android-37.0}
JAR=${ANDROID_JAR:-$SDK/android-11/android.jar}
WEBRTC_VERSION=144.7559.15
WEBRTC_SHA256=fc7c8d027eb33860ccbb7847988f7f942d44a92d1f575348bba6c0250cde4071
WEBRTC_CACHE=${WEBRTC_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/devdeck-build}
WEBRTC_AAR=$WEBRTC_CACHE/webrtc-sdk-android-$WEBRTC_VERSION.aar

die() {
    echo "build.sh: $*" >&2
    exit 1
}
# DEVDECK_VARIANT=plus builds a side-by-side copy: package dev.devdeckplus, label "DevDeck+",
# output devdeck-plus.apk. The Java classes stay in dev.devdeck (all intents are explicit).
VARIANT=${DEVDECK_VARIANT:-}
[[ -z $VARIANT || $VARIANT =~ ^[a-z][a-z0-9]*$ ]] || die "DEVDECK_VARIANT must be lowercase letters/digits"
APK_NAME=devdeck${VARIANT:+-$VARIANT}.apk

# 1. Web UI -> android/assets/web/ (the web build wipes and rewrites it).
command -v bun >/dev/null || PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null || die "bun not found (needed for the web UI build)"
(cd "$ROOT/web" && bun install --frozen-lockfile && bun run build) || die "web build failed"
[[ -f assets/web/index.html ]] || die "web build produced no assets/web/index.html"

if [[ ! -x $BT/d8 || ! -f $JAR ]]; then
    mkdir -p "$SDK"
    for z in build-tools_r37_linux.zip platform-30_r03.zip; do
        curl -fsSL -o "$SDK/$z" "https://dl.google.com/android/repository/$z"
        unzip -q -o "$SDK/$z" -d "$SDK"
        rm "$SDK/$z"
    done
fi

# Pinned libwebrtc AAR: downloaded once, verified on every build.
if [[ ! -f $WEBRTC_AAR ]]; then
    mkdir -p "$WEBRTC_CACHE"
    curl -fsSL -o "$WEBRTC_AAR.part" \
        "https://repo1.maven.org/maven2/io/github/webrtc-sdk/android/$WEBRTC_VERSION/android-$WEBRTC_VERSION.aar" \
        || die "downloading the WebRTC AAR $WEBRTC_VERSION failed"
    mv "$WEBRTC_AAR.part" "$WEBRTC_AAR"
fi
echo "$WEBRTC_SHA256  $WEBRTC_AAR" | sha256sum -c --quiet - \
    || { rm -f "$WEBRTC_AAR"; die "WebRTC AAR checksum mismatch (deleted; rerun to download again)"; }

OUT=build
rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/gen" "$OUT/native/lib/arm64-v8a"
unzip -p "$WEBRTC_AAR" classes.jar > "$OUT/webrtc.jar"
unzip -p "$WEBRTC_AAR" jni/arm64-v8a/libjingle_peerconnection_so.so \
    > "$OUT/native/lib/arm64-v8a/libjingle_peerconnection_so.so"

MANIFEST=AndroidManifest.xml
RENAME=()
if [[ -n $VARIANT ]]; then
    if [[ $VARIANT == plus ]]; then LABEL="DevDeck+"; else LABEL="DevDeck $VARIANT"; fi
    sed "s/android:label=\"DevDeck\"/android:label=\"$LABEL\"/g" AndroidManifest.xml > "$OUT/AndroidManifest.xml"
    MANIFEST=$OUT/AndroidManifest.xml
    RENAME=(--rename-manifest-package "dev.devdeck$VARIANT")
fi

# 2. Resources + assets; also generates R.java for the drawables the code uses.
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -I "$JAR" --manifest "$MANIFEST" "${RENAME[@]}" -R "$OUT/res.zip" -A assets \
    --java "$OUT/gen" --auto-add-overlay -o "$OUT/unsigned.apk"

# 3. Code.
javac --release 11 -nowarn -Xlint:-options -encoding UTF-8 -classpath "$JAR:$OUT/webrtc.jar" -d "$OUT/classes" \
    $(find src "$OUT/gen" -name '*.java')
"$BT/d8" --release --min-api 26 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class') \
    "$OUT/webrtc.jar"
(cd "$OUT/dex" && "$BT/aapt" add -f ../unsigned.apk classes*.dex >/dev/null)
(cd "$OUT/native" && "$BT/aapt" add -f ../unsigned.apk lib/arm64-v8a/libjingle_peerconnection_so.so >/dev/null)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

# 4. Debug-signed with the standard Android debug key (created if missing).
KS=${ANDROID_KEYSTORE:-$HOME/.android/debug.keystore}
if [[ ! -f $KS ]]; then
    mkdir -p "$(dirname "$KS")"
    keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias androiddebugkey \
        -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --v4-signing-enabled false \
    --out "$ROOT/$APK_NAME" "$OUT/aligned.apk"
rm -rf "$OUT"
echo "built $ROOT/$APK_NAME"
