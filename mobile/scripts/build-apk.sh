#!/usr/bin/env bash
# Builds a signed release APK of the customer app: ./gradlew assembleRelease in android/.
#
#   scripts/build-apk.sh           build
#   scripts/build-apk.sh --bump    raise versionCode in app.json by 1 first (do this for every release)
#
# On first use it installs what Android builds need (JDK 17, the Android SDK,
# build-tools, NDK) into $TOOLCHAIN_DIR, and creates the release upload key in
# $KEYS_DIR. Both live outside this repo. Back up $KEYS_DIR: every update must
# be signed with the same key or it won't install over the app already on phones.
#
#   TOOLCHAIN_DIR  default: ~/android-toolchain   (needs about 8 GB)
#   KEYS_DIR       default: ~/flezepay-keys
#   SDK_PROXY      optional host:port of an HTTPS proxy, for the SDK manager and Gradle's downloads
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOOLCHAIN_DIR="${TOOLCHAIN_DIR:-$HOME/android-toolchain}"
KEYS_DIR="${KEYS_DIR:-$HOME/flezepay-keys}"

# What this Expo SDK's Android project builds against (node_modules/react-native/gradle/libs.versions.toml).
PLATFORM="platforms;android-37.0"
BUILD_TOOLS="build-tools;37.0.0"
NDK="ndk;27.1.12297006"
CMAKE="cmake;3.22.1"
CMDLINE_TOOLS_ZIP="commandlinetools-linux-11076708_latest.zip"

export JAVA_HOME="$TOOLCHAIN_DIR/jdk"
export ANDROID_HOME="$TOOLCHAIN_DIR/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export GRADLE_USER_HOME="$TOOLCHAIN_DIR/gradle"
export ANDROID_USER_HOME="$TOOLCHAIN_DIR/android-user"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
# Java tries IPv6 first; on a network without it, the SDK manager and Gradle
# fail to download ("IO exception while downloading manifest"). Use IPv4.
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Djava.net.preferIPv4Stack=true"
SDKMANAGER_PROXY=()
if [[ -n "${SDK_PROXY:-}" ]]; then
  # The SDK manager ignores Java's proxy settings and takes its own flags; Gradle uses Java's.
  SDKMANAGER_PROXY=(--proxy=http "--proxy_host=${SDK_PROXY%:*}" "--proxy_port=${SDK_PROXY##*:}")
  export JAVA_TOOL_OPTIONS="$JAVA_TOOL_OPTIONS -Dhttps.proxyHost=${SDK_PROXY%:*} -Dhttps.proxyPort=${SDK_PROXY##*:}"
fi
mkdir -p "$TOOLCHAIN_DIR" "$GRADLE_USER_HOME" "$ANDROID_USER_HOME"

if [[ "${1:-}" == "--bump" ]]; then
  node -e "
    const fs = require('fs'); const p = '$APP_DIR/app.json'; const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    d.expo.android.versionCode = (d.expo.android.versionCode || 0) + 1;
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n'); console.log('versionCode ->', d.expo.android.versionCode);"
fi

if [[ ! -x "$JAVA_HOME/bin/java" ]]; then
  echo "== Installing JDK 17 into $JAVA_HOME"
  curl -fL --retry 3 -o "$TOOLCHAIN_DIR/jdk.tar.gz" "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
  mkdir -p "$JAVA_HOME" && tar -xzf "$TOOLCHAIN_DIR/jdk.tar.gz" -C "$JAVA_HOME" --strip-components=1 && rm "$TOOLCHAIN_DIR/jdk.tar.gz"
fi

if [[ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]]; then
  echo "== Installing the Android SDK command-line tools into $ANDROID_HOME"
  curl -fL --retry 3 -o "$TOOLCHAIN_DIR/cmdline-tools.zip" "https://dl.google.com/android/repository/$CMDLINE_TOOLS_ZIP"
  mkdir -p "$ANDROID_HOME/cmdline-tools" && rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  (cd "$ANDROID_HOME/cmdline-tools" && unzip -q "$TOOLCHAIN_DIR/cmdline-tools.zip" && mv cmdline-tools latest)
  rm "$TOOLCHAIN_DIR/cmdline-tools.zip"
fi

if [[ ! -d "$ANDROID_HOME/ndk/${NDK#ndk;}" || ! -d "$ANDROID_HOME/build-tools/${BUILD_TOOLS#build-tools;}" ]]; then
  echo "== Installing Android SDK packages (accepting the Android SDK licence)"
  yes | sdkmanager "${SDKMANAGER_PROXY[@]}" --licenses > /dev/null || true
  sdkmanager "${SDKMANAGER_PROXY[@]}" --install "platform-tools" "$PLATFORM" "$BUILD_TOOLS" "$NDK" "$CMAKE"
fi

KEYSTORE="$KEYS_DIR/flezepay-release.keystore"
KEY_PROPS="$KEYS_DIR/keystore.properties"
if [[ ! -f "$KEYSTORE" ]]; then
  echo "== Creating the release upload key in $KEYS_DIR (back this folder up)"
  mkdir -p "$KEYS_DIR" && chmod 700 "$KEYS_DIR"
  PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
  keytool -genkeypair -v -storetype PKCS12 -keystore "$KEYSTORE" -alias flezepay -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PASSWORD" -keypass "$PASSWORD" -dname "CN=FlezePay Customer, O=FlezePay, C=GH" > /dev/null 2>&1
  printf 'FLEZEPAY_UPLOAD_STORE_FILE=%s\nFLEZEPAY_UPLOAD_STORE_PASSWORD=%s\nFLEZEPAY_UPLOAD_KEY_ALIAS=flezepay\nFLEZEPAY_UPLOAD_KEY_PASSWORD=%s\n' \
    "$KEYSTORE" "$PASSWORD" "$PASSWORD" > "$KEY_PROPS"
  chmod 600 "$KEYSTORE" "$KEY_PROPS"
fi
SIGNING_ARGS=()
while IFS='=' read -r key value; do [[ -n "$key" ]] && SIGNING_ARGS+=("-P$key=$value"); done < "$KEY_PROPS"

echo "== Generating android/ from app.json"
cd "$APP_DIR"
npx expo prebuild -p android --no-install

echo "== ./gradlew assembleRelease"
cd "$APP_DIR/android"
# Patient with downloads: a dropped connection is retried rather than failing a long build.
./gradlew assembleRelease --no-daemon \
  -Dorg.gradle.internal.repository.max.retries=10 -Dorg.gradle.internal.repository.initial.backoff=2000 \
  "${SIGNING_ARGS[@]}"

VERSION="$(node -p "require('$APP_DIR/app.json').expo.version")"
CODE="$(node -p "require('$APP_DIR/app.json').expo.android.versionCode")"
OUT="$APP_DIR/FlezePay-Customer-$VERSION-$CODE.apk"
cp "$APP_DIR/android/app/build/outputs/apk/release/app-release.apk" "$OUT"
echo
echo "Built: $OUT ($(du -h "$OUT" | cut -f1))"
keytool -list -v -keystore "$KEYSTORE" -storepass "$(grep STORE_PASSWORD "$KEY_PROPS" | cut -d= -f2)" 2>/dev/null | grep -m1 "SHA256:" | sed 's/^\s*/Signing certificate /'
