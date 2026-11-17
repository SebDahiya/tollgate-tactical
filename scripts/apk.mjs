// Builds an installable debug APK: bundles the game, syncs it into the Android project,
// then runs Gradle with Android Studio's bundled Java. Output: Tollgate-Tactical.apk in the project root.
import { execSync } from 'child_process';
import fs from 'fs'; import path from 'path'; import os from 'os';
const studio = ['C:/Program Files/Android/Android Studio', path.join(os.homedir(), 'AppData/Local/Programs/Android Studio')].find(p => fs.existsSync(p));
const javaHome = process.env.JAVA_HOME || (studio && ['jbr', 'jre'].map(d => path.join(studio, d)).find(p => fs.existsSync(path.join(p, 'bin', 'java.exe'))));
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'AppData/Local/Android/Sdk');
const problems = [];
if (!javaHome) problems.push('Java not found - install Android Studio (it bundles Java): https://developer.android.com/studio');
if (!fs.existsSync(sdk)) problems.push(`Android SDK not found at ${sdk} - open Android Studio once and finish its setup wizard (it downloads the SDK).`);
if (problems.length) { console.error('\nCannot build the APK yet:\n - ' + problems.join('\n - ') + '\n'); process.exit(1); }
const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
fs.writeFileSync('android/local.properties', `sdk.dir=${sdk.split(path.sep).join('/')}\n`);
const run = (cmd, cwd = '.') => { console.log(`\n> ${cmd}`); execSync(cmd, { stdio: 'inherit', env, cwd }); };
run('node build.mjs');
run('npx cap sync android');
run(process.platform === 'win32' ? 'gradlew.bat assembleDebug' : './gradlew assembleDebug', 'android');
const apk = 'android/app/build/outputs/apk/debug/app-debug.apk';
fs.copyFileSync(apk, 'Tollgate-Tactical.apk');
console.log(`\nAPK ready: ${path.resolve('Tollgate-Tactical.apk')} (${(fs.statSync(apk).size / 1048576).toFixed(1)} MB)`);
