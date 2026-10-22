#!/usr/bin/env bash
# Builds devdeck.apk without Gradle: web UI (bun) -> aapt2 compile/link (res + assets, R.java)
# -> javac -> d8 -> zipalign -> apksigner. Needs bun, a JDK and, from the Android SDK,
# build-tools plus a platform android.jar. By default it reuses LanPad's
# ../../phone_synaptic_trackpad/.sdk; if that is missing they are downloaded there (~150 MB)
# unless SDK / ANDROID_BUILD_TOOLS / ANDROID_JAR are set.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
SDK=${SDK:-$(cd "$ROOT/.." && pwd)/phone_synaptic_trackpad/.sdk}
BT=${ANDROID_BUILD_TOOLS:-$SDK/android-37.0}
JAR=${ANDROID_JAR:-$SDK/android-11/android.jar}

die() {
    echo "build.sh: $*" >&2
    exit 1
}

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

OUT=build
rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/gen"

# 2. Resources + assets; also generates R.java for the drawables the code uses.
"$BT/aapt2" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2" link -I "$JAR" --manifest AndroidManifest.xml -R "$OUT/res.zip" -A assets \
    --java "$OUT/gen" --auto-add-overlay -o "$OUT/unsigned.apk"

# 3. Code.
javac --release 11 -nowarn -Xlint:-options -encoding UTF-8 -classpath "$JAR" -d "$OUT/classes" \
    $(find src "$OUT/gen" -name '*.java')
"$BT/d8" --release --min-api 26 --lib "$JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && "$BT/aapt" add -f ../unsigned.apk classes.dex >/dev/null)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

# 4. Debug-signed with the standard Android debug key (created if missing).
KS=${ANDROID_KEYSTORE:-$HOME/.android/debug.keystore}
if [[ ! -f $KS ]]; then
    mkdir -p "$(dirname "$KS")"
    keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias androiddebugkey \
        -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --v4-signing-enabled false \
    --out "$ROOT/devdeck.apk" "$OUT/aligned.apk"
rm -rf "$OUT"
echo "built $ROOT/devdeck.apk"
